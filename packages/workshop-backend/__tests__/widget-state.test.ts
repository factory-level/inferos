// A widget's local state (FAC-86) in the person's user DO: a transition moves only the widget, never
// the operate page; it is refused predictably with a stable code and nothing stored; and a
// person-persisted state is recovered on the next read, apart for each console revision.
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { OperateEvent } from "@gadgets/workshop-shared/operate-session";
import {
  WIDGET_STATE_ERROR_CODES, widgetStateKey, type WidgetStateMachine,
} from "@gadgets/workshop-shared/widget-state";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const MACHINE: WidgetStateMachine = {
  version: 1, initial: "viewing", persistence: "person",
  states: ["viewing", "editing", "submitting", "failed"],
  transitions: [
    { event: "edit", from: "viewing", to: "editing" },
    { event: "cancel", from: "editing", to: "viewing" },
    { event: "submit", from: "editing", to: "submitting" },
    { event: "fail", from: "submitting", to: "failed" },
    { event: "retry", from: "failed", to: "submitting" },
  ],
};
const REF = { workspaceId: "console-ws", consoleId: "intake", revision: "3", gadgetId: 41 };
const KEY = widgetStateKey(REF);
const CHAT_OPEN: OperateEvent = { type: "setChatOpen", open: true };

const code = async (operation: PromiseLike<unknown>) => {
  try { await operation; return "accepted"; } catch (error) { return /^(?:\w*Error: )?([A-Z_]+):/.exec(String((error as Error).message))?.[1] ?? "uncoded"; }
};

describe("a widget's local state", () => {
  it("moves along its declared transitions, including retry, and never changes the operate page", async () => {
    let user = env.TEST_USER.getByName(crypto.randomUUID());
    let page = await user.getOperatePage();
    let events = await user.listOperateEvents(0, 50);
    expect(await user.readWidgetState(KEY, MACHINE)).toEqual({ state: "viewing", seq: 0, events: ["edit"] });
    let s = await user.transitionWidgetState(KEY, MACHINE, "edit", 0);
    s = await user.transitionWidgetState(KEY, MACHINE, "submit", s.seq);
    s = await user.transitionWidgetState(KEY, MACHINE, "fail", s.seq);
    s = await user.transitionWidgetState(KEY, MACHINE, "retry", s.seq);
    expect(s).toEqual({ state: "submitting", seq: 4, events: ["fail"] });
    // The page and its log are exactly as they were: no event, no sequence change.
    expect(await user.getOperatePage()).toEqual(page);
    expect(await user.listOperateEvents(0, 50)).toEqual(events);
  });

  it("is untouched by a page change, as the page is by it", async () => {
    let user = env.TEST_USER.getByName(crypto.randomUUID());
    await user.transitionWidgetState(KEY, MACHINE, "edit", 0);
    let before = await user.getOperatePage();
    let after = await user.dispatchOperateEvent(CHAT_OPEN, before.seq, "person");
    expect(after.seq).toBe(before.seq + 1);
    expect(await user.readWidgetState(KEY, MACHINE)).toEqual({ state: "editing", seq: 1, events: ["cancel", "submit"] });
  });

  it("refuses an undeclared event, one not permitted now, and a stale sequence, storing nothing", async () => {
    let user = env.TEST_USER.getByName(crypto.randomUUID());
    expect(await code(user.transitionWidgetState(KEY, MACHINE, "launch", 0))).toBe(WIDGET_STATE_ERROR_CODES.unknownEvent);
    expect(await code(user.transitionWidgetState(KEY, MACHINE, "submit", 0))).toBe(WIDGET_STATE_ERROR_CODES.notPermitted);
    await user.transitionWidgetState(KEY, MACHINE, "edit", 0);
    expect(await code(user.transitionWidgetState(KEY, MACHINE, "cancel", 0))).toBe(WIDGET_STATE_ERROR_CODES.conflict);
    expect(await user.readWidgetState(KEY, MACHINE)).toEqual({ state: "editing", seq: 1, events: ["cancel", "submit"] });
  });

  it("is recovered on the next read, for that person and that console revision only", async () => {
    let id = crypto.randomUUID();
    await env.TEST_USER.getByName(id).transitionWidgetState(KEY, MACHINE, "edit", 0);
    // A fresh stub of the same person reads it back.
    expect((await env.TEST_USER.getByName(id).readWidgetState(KEY, MACHINE)).state).toBe("editing");
    // Another person, and a republished console (another revision's frozen install), start fresh.
    expect((await env.TEST_USER.getByName(crypto.randomUUID()).readWidgetState(KEY, MACHINE)).state).toBe("viewing");
    let republished = widgetStateKey({ ...REF, revision: "4", gadgetId: 52 });
    expect((await env.TEST_USER.getByName(id).readWidgetState(republished, MACHINE)).state).toBe("viewing");
  });
});

// FAC-86 round 2 (r2 on #343): two transitions naming the same seq, run at once through the
// operate session, while each awaits the published machine. Exactly one may win.
describe("concurrent transitions", () => {
  async function session(persistence: "person" | "session") {
    let { OperateSessionImpl } = await import("../src/server.js");
    let machine = { ...MACHINE, persistence };
    let userStub = env.TEST_USER.getByName(crypto.randomUUID());
    // The published machine arrives after a tick, as an RPC to the console's workspace would.
    let workspace = {
      getConsoleWidgetStates: async () => { await new Promise(resolve => setTimeout(resolve, 5)); return machine; },
      [Symbol.dispose]: () => {},
    };
    let impl = new OperateSessionImpl(() => userStub as never, async () => ({}) as never,
      async () => workspace as never, () => userStub as never, () => ({}) as never, {} as never);
    return impl;
  }

  for (let persistence of ["session", "person"] as const) {
    it(`let exactly one of two same-seq ${persistence} transitions succeed`, async () => {
      let impl = await session(persistence);
      let results = await Promise.allSettled([
        impl.transitionWidget(REF, "edit", 0), impl.transitionWidget(REF, "edit", 0),
      ]);
      let won = results.filter(r => r.status === "fulfilled");
      let lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(String(lost[0]!.reason?.message ?? lost[0]!.reason)).toContain(WIDGET_STATE_ERROR_CODES.conflict);
      expect(await impl.getWidgetState(REF)).toMatchObject({ state: "editing", seq: 1 });
    });
  }
});

// FAC-86 part 2 (QA on #343): a malformed widget reference is refused before any console workspace
// is asked for the widget's states, and extra fields are never read.
describe("a malformed widget reference", () => {
  it("is refused before anything is read, whatever is wrong with it", async () => {
    let { OperateSessionImpl } = await import("../src/server.js");
    let asked = 0;
    let workspace = { getConsoleWidgetStates: async () => { asked++; return MACHINE; }, [Symbol.dispose]: () => {} };
    let impl = new OperateSessionImpl(() => env.TEST_USER.getByName(crypto.randomUUID()) as never, async () => ({}) as never,
      async () => workspace as never, () => ({}) as never, () => ({}) as never, {} as never);
    const bad: unknown[] = [
      null, "console-ws/intake/3/41", { ...REF, workspaceId: "" }, { ...REF, consoleId: 7 },
      { ...REF, revision: "r".repeat(129) }, { ...REF, gadgetId: -1 }, { ...REF, gadgetId: 1.5 },
      { ...REF, gadgetId: "41" }, { workspaceId: "console-ws", consoleId: "intake", revision: "3" },
    ];
    for (let ref of bad) {
      await expect(Promise.resolve().then(() => impl.getWidgetState(ref as never)), JSON.stringify(ref)).rejects.toThrow();
      await expect(Promise.resolve().then(() => impl.transitionWidget(ref as never, "edit", 0)), JSON.stringify(ref)).rejects.toThrow();
    }
    expect(asked).toBe(0);
    // Extra fields aren't read: the workspace is asked with the four checked ones only.
    let seen: unknown[] = [];
    workspace.getConsoleWidgetStates = async (...args: unknown[]) => { seen = args; asked++; return MACHINE; };
    await impl.getWidgetState({ ...REF, tenant: "other-company", gadgetId: REF.gadgetId } as never);
    expect(seen).toEqual([REF.consoleId, REF.revision, REF.gadgetId]);
  });
});
