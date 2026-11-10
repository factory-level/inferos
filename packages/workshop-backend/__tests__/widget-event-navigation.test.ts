// A widget event wired to a page effect, at runtime (FAC-94): when a person's widget transition
// raises an event the published page they are shown wires to `navigate`, the session moves to that
// screen through the person's own checked dispatch (showScreen within the view, else the view that
// shows it). An unwired event stays local, as FAC-86 requires: the page and its log are unchanged.
// A widget the page doesn't place, a console that isn't open at that revision, or a running flow
// navigates nothing. The console workspace is a stand-in returning the published console and page;
// the person's user DO is real.
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { parseCanvasPage } from "@gadgets/workshop-shared/canvas-model";
import type { OperateConsole } from "@gadgets/workshop-shared/operate-console";
import type { OperateEvent } from "@gadgets/workshop-shared/operate-session";
import type { WidgetStateMachine } from "@gadgets/workshop-shared/widget-state";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

const MACHINE: WidgetStateMachine = {
  version: 1, initial: "editing", persistence: "session", states: ["editing", "submitted"],
  transitions: [{ event: "submit", from: "editing", to: "submitted" }, { event: "reopen", from: "submitted", to: "editing" }],
};
const REF = { workspaceId: "console-ws", consoleId: "intake", revision: "3", gadgetId: 41 };
const CONSOLE = {
  id: "intake", revision: "3", title: "Intake", fullChat: "off", published: null,
  views: [
    { id: "v-form", title: "Form", type: "rollup", screens: ["form", "review"] },
    { id: "v-done", title: "Done", type: "screen", screen: "done" },
  ],
} as unknown as OperateConsole;
const OPEN: OperateEvent = { type: "openConsole", workspaceId: "console-ws", consoleId: "intake", title: "Intake",
  source: "published", revision: "3", fullChat: "off", viewId: "v-form" };

/** Screen "form": widget 41 sends "submit" to `to`, and nothing on "reopen", plus any `extra` attachments. */
const formPage = (to: string, extra: unknown[] = []) => parseCanvasPage({
  schemaVersion: 2, id: "form", revision: "0", title: "Form", children: ["main"], attachments: [], nodes: [
    { nodeType: "object", id: "main", title: "Main", columns: 1, children: ["w41"], attachments: [] },
    { nodeType: "widget", id: "w41", kind: "inferos.gadget", version: 1, targetRef: "gadget:41", size: "normal", params: {},
      attachments: [{ id: "next", version: 1, on: "submit", effect: { kind: "navigate", page: to } }, ...extra] },
  ],
});

async function session(to = "done", setUp: OperateEvent[] = [OPEN, { type: "showScreen", screenId: "form" }], extra: unknown[] = []) {
  let { OperateSessionImpl } = await import("../src/server.js");
  let user = env.TEST_USER.getByName(crypto.randomUUID());
  for (let event of setUp) {
    let { seq } = await user.getOperatePage();
    await user.dispatchOperateEvent(event, seq, "person");
  }
  let workspace = {
    getConsoleWidgetStates: async () => MACHINE,
    getConsole: async () => CONSOLE,
    getConsolePage: async (_consoleId: string, screenId: string) => screenId === "form" ? formPage(to, extra) : null,
    [Symbol.dispose]: () => {},
  };
  let impl = new OperateSessionImpl(() => user as never, async () => ({}) as never,
    async () => workspace as never, () => user as never, () => ({}) as never, {} as never);
  return { impl, user };
}

describe("a widget event wired to navigate (FAC-94)", () => {
  it("moves the session to a screen of another view through the person's dispatch", async () => {
    let { impl, user } = await session("done");
    let snapshot = await impl.transitionWidget(REF, "submit", 0);
    expect(snapshot).toMatchObject({ state: "submitted", navigation: { screenId: "done", outcome: "shown" } });
    expect((await user.getOperatePage()).state.console).toMatchObject({ viewId: "v-done", screenId: null });
    expect((await user.listOperateEvents(0, 50)).at(-1)!.event).toEqual({ type: "openView", viewId: "v-done" });
  });

  it("shows a screen of the same view in place", async () => {
    let { impl, user } = await session("review");
    expect(await impl.transitionWidget(REF, "submit", 0)).toMatchObject({ navigation: { screenId: "review", outcome: "shown" } });
    expect((await user.getOperatePage()).state.console).toMatchObject({ viewId: "v-form", screenId: "review" });
  });

  it("leaves the page and its log as they were for an unwired event", async () => {
    let { impl, user } = await session("done");
    let s = await impl.transitionWidget(REF, "submit", 0);
    let page = await user.getOperatePage();
    let events = await user.listOperateEvents(0, 50);
    let reopened = await impl.transitionWidget(REF, "reopen", s.seq);
    expect(reopened).toEqual({ state: "editing", seq: 2, events: ["submit"] });
    expect(await user.getOperatePage()).toEqual(page);
    expect(await user.listOperateEvents(0, 50)).toEqual(events);
  });

  it("navigates nothing for a widget the shown page doesn't place, another revision, or a running flow", async () => {
    for (let [ref, setUp] of [
      [{ ...REF, gadgetId: 42 }, undefined],
      [{ ...REF, revision: "2" }, undefined],
      [REF, [OPEN, { type: "showScreen", screenId: "form" },
        { type: "startFlow", workspaceId: "console-ws", flowId: "f", title: "F", steps: ["form"] }]],
    ] as const) {
      let { impl, user } = await session("done", setUp as OperateEvent[] | undefined);
      let page = await user.getOperatePage();
      let snapshot = await impl.transitionWidget(ref, "submit", 0);
      expect(snapshot).not.toHaveProperty("navigation");
      expect(await user.getOperatePage()).toEqual(page);
    }
  });

  it("says it was refused, changing nothing else, when the console doesn't show the target", async () => {
    let { impl, user } = await session("elsewhere");
    let page = await user.getOperatePage();
    expect(await impl.transitionWidget(REF, "submit", 0))
      .toMatchObject({ state: "submitted", navigation: { screenId: "elsewhere", outcome: "refused" } });
    expect(await user.getOperatePage()).toEqual(page);
  });
});

// FAC-98: a widget event wired to `insert-prompt` returns the prompt to the transitioning session
// alone, for its own person's chat. Nothing is written to the operate page or its log, so no other
// session or person receives it, and the prompt carries no target of its own.
const prompt = (id: string, text: string, submit?: true) =>
  ({ id, version: 1, on: "submit", effect: { kind: "insert-prompt", text, ...(submit ? { submit } : {}) } });

describe("a widget event wired to insert a prompt (FAC-98)", () => {
  it("returns a draft prompt to the transitioning session, writing nothing to the page or its log", async () => {
    let { impl, user } = await session("elsewhere", undefined, [prompt("ask", "Summarise this intake")]);
    let page = await user.getOperatePage();
    let events = await user.listOperateEvents(0, 50);
    let snapshot = await impl.transitionWidget(REF, "submit", 0);
    expect(snapshot).toMatchObject({ state: "submitted", prompt: { text: "Summarise this intake", submit: false } });
    expect(await user.getOperatePage()).toEqual(page);
    expect(await user.listOperateEvents(0, 50)).toEqual(events);
  });

  it("says a submitted prompt is to be sent, beside the navigation the same event runs", async () => {
    let { impl } = await session("done", undefined, [prompt("ask", "File the intake", true)]);
    expect(await impl.transitionWidget(REF, "submit", 0)).toMatchObject({
      navigation: { screenId: "done", outcome: "shown" }, prompt: { text: "File the intake", submit: true } });
  });

  it("returns only the first wired prompt", async () => {
    let { impl } = await session("done", undefined, [prompt("one", "First"), prompt("two", "Second", true)]);
    expect((await impl.transitionWidget(REF, "submit", 0)).prompt).toEqual({ text: "First", submit: false });
  });

  it("returns none for an unwired event, another revision, or a running flow", async () => {
    let { impl } = await session("done", undefined, [prompt("ask", "Summarise")]);
    let s = await impl.transitionWidget(REF, "submit", 0);
    expect(await impl.transitionWidget(REF, "reopen", s.seq)).not.toHaveProperty("prompt");
    for (let [ref, setUp] of [
      [{ ...REF, revision: "2" }, undefined],
      [REF, [OPEN, { type: "showScreen", screenId: "form" },
        { type: "startFlow", workspaceId: "console-ws", flowId: "f", title: "F", steps: ["form"] }]],
    ] as const) {
      let other = await session("done", setUp as OperateEvent[] | undefined, [prompt("ask", "Summarise")]);
      expect(await other.impl.transitionWidget(ref, "submit", 0)).not.toHaveProperty("prompt");
    }
  });
});
