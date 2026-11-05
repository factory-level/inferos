import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getOperateSessionErrorCode, OPERATE_SESSION_ERROR_CODES,
  type AuthenticatedApi, type OperateSession, type OperateSessionUpdate, type Overseer, type PublicApi,
} from "@gadgets/workshop-shared/api";
import type { OperateFlow, OperateFlowContent } from "@gadgets/workshop-shared/operate-flow";
import type { OperateEvent, OperateFlowPage, OperateSessionSnapshot } from "@gadgets/workshop-shared/operate-session";
import { startHarness, type Harness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { callbackStubFor, connect, nextUsernames, signUp } from "../src/rpc-client.js";

// FAC-87: a flow that names its pages runs by their routes (branch, retry, return) and back
// through its history. Every target is checked on the server: a route must lead to a page of the
// same flow when the flow is saved, a start must match the authoritative pages, a move must be one
// of the current page's routes, and the destination's screen must still be one the runner may open
// through their own access. A refusal names no page and no workspace, and changes nothing.

let harness: Harness;
let publicApi: RpcStub<PublicApi>;
const network = new NetworkInterceptor();

beforeAll(async () => {
  network.install();
  harness = await startHarness({ gatekeepers: [], patchWorkshop(config) {
    config.vars = { ...config.vars, COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true" };
  } });
  publicApi = connect(harness.url);
});

afterAll(async () => {
  try {
    publicApi?.[Symbol.dispose]();
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

const { flowPageUnavailable, invalidEvent } = OPERATE_SESSION_ERROR_CODES;

async function currentPage(session: RpcStub<OperateSession>): Promise<OperateSessionSnapshot> {
  const first = Promise.withResolvers<OperateSessionUpdate>();
  using subscriber = callbackStubFor((update: OperateSessionUpdate) => { first.resolve(update); });
  using _subscription = await session.subscribe(subscriber);
  const { seq, state } = await first.promise;
  return { seq, state };
}

class Person {
  seq = 0;
  constructor(readonly username: string, readonly api: RpcStub<AuthenticatedApi>,
      readonly session: RpcStub<OperateSession>) {}
  async send(event: OperateEvent): Promise<OperateSessionSnapshot> {
    const snapshot = await this.session.dispatch(event, this.seq);
    this.seq = snapshot.seq;
    return snapshot;
  }
  /** The refusal code of `event` and its message, or "accepted". */
  async refusal(event: OperateEvent): Promise<string> {
    try {
      this.seq = (await this.session.dispatch(event, this.seq)).seq;
      return "accepted";
    } catch (error) {
      lastMessage = (error as Error).message;
      return getOperateSessionErrorCode(error) ?? `uncoded: ${(error as Error).message}`;
    }
  }
  async observe() {
    const page = await currentPage(this.session);
    return { seq: page.seq, flow: page.state.flow, events: await this.session.listEvents(0, 50) };
  }
}
let lastMessage = "";

async function person(prefix: string): Promise<Person> {
  const username = nextUsernames(prefix)[0]!;
  const api = await signUp(publicApi, username);
  return new Person(username, api, await api.getOperateSession());
}

const startOf = (workspaceId: string, flow: Pick<OperateFlow, "id" | "title" | "steps" | "pages">): OperateEvent =>
  ({ type: "startFlow", workspaceId, flowId: flow.id, title: flow.title, steps: flow.steps,
    ...(flow.pages === undefined ? {} : { pages: flow.pages }) });

const PAGES: OperateFlowPage[] = [
  { name: "intake", states: ["empty", "filled"], routes: [{ label: "Review", to: "review" }] },
  { name: "review", routes: [{ label: "Approve", to: "done" }, { label: "Send back", to: "intake" },
    { label: "Look again", to: "review" }] },
  { name: "done", routes: [{ label: "Start over", to: "intake" }] },
];

/**
 * Owner amy and use-only cara; workspace "Claims desk" with screens Intake, Review and Done; flow
 * "Claims" naming those three pages; console "Claims console" over all three, listing it, published.
 */
async function claimsDesk() {
  const [amy, cara] = [await person("f87amy"), await person("f87cara")];
  const workspace: RpcStub<Overseer> = await amy.api.newGadget();
  await workspace.newChat("Claims desk", null);
  const workspaceId = (await workspace.getMetadata()).id;
  const screen = (title: string) => workspace.createCanvas({ title, sections: [] });
  const [intake, review, done] = [await screen("Intake"), await screen("Review"), await screen("Done")];
  const content: OperateFlowContent = { title: "Claims", steps: [intake.id, review.id, done.id], pages: PAGES };
  const flow = await workspace.createFlow(content);
  const draft = await workspace.createConsole({
    title: "Claims console", fullChat: "off",
    views: [
      { id: "intake", title: "Intake", type: "screen", screen: intake.id },
      { id: "review", title: "Review", type: "screen", screen: review.id },
      { id: "done", title: "Done", type: "screen", screen: done.id },
    ],
    flows: [flow.id],
  });
  const published = await workspace.publishConsole(draft.id, draft.revision);
  if (!await workspace.addCollaborator(cara.username, "use")) throw new Error("Failed to share with cara");
  const openConsole = (revision = published.revision): OperateEvent => ({
    type: "openConsole", workspaceId, consoleId: draft.id, title: "Claims console", source: "published",
    revision, fullChat: "off", viewId: "intake",
  });
  const [snapshot] = published.published?.flows ?? [];
  return { amy, cara, workspace, workspaceId, screens: { intake, review, done }, content, flow, draft,
    published, snapshot: snapshot!, openConsole };
}

const flowEvents = async (who: Person) => (await who.session.listEvents(0, 50))
  .filter(record => ["startFlow", "navigateFlow", "backFlow", "setFlowPageState"].includes(record.event.type))
  .map(record => `${record.actor}:${record.event.type}`);

describe("a flow with named pages", () => {
  it("publishes its pages, and a use-role employee branches, retries and returns along its history", async () => {
    const desk = await claimsDesk();
    expect(desk.snapshot.pages).toEqual(PAGES);
    const { cara } = desk;
    await cara.send(desk.openConsole());
    expect((await cara.send(startOf(desk.workspaceId, desk.snapshot))).state.flow)
      .toMatchObject({ index: 0, history: [], pageState: "empty" });
    await cara.send({ type: "setFlowPageState", state: "filled" });
    await cara.send({ type: "navigateFlow", to: "review" });
    await cara.send({ type: "navigateFlow", to: "intake" }); // retry
    expect((await cara.observe()).flow).toMatchObject({ index: 0, history: [0, 1], pageState: "empty" });
    await cara.send({ type: "navigateFlow", to: "review" });
    await cara.send({ type: "navigateFlow", to: "done" });
    expect((await cara.send({ type: "backFlow" })).state.flow).toMatchObject({ index: 1, history: [0, 1, 0] });

    // A reload is a new window onto the same run.
    using reloaded = await cara.api.getOperateSession();
    expect((await currentPage(reloaded)).state.flow).toMatchObject({ index: 1, history: [0, 1, 0] });
    expect(await flowEvents(cara)).toEqual(["person:startFlow", "person:setFlowPageState", "person:navigateFlow",
      "person:navigateFlow", "person:navigateFlow", "person:navigateFlow", "person:backFlow"]);
  });

  it("refuses a move to an unknown page, a screen id, a page its page doesn't lead to, and a step index", async () => {
    const desk = await claimsDesk();
    const { cara } = desk;
    await cara.send(desk.openConsole());
    await cara.send(startOf(desk.workspaceId, desk.snapshot));
    for (const event of [
      { type: "navigateFlow", to: "nowhere" },
      { type: "navigateFlow", to: desk.screens.review.id },
      { type: "navigateFlow", to: "done" },
      { type: "goToStep", index: 2 },
      { type: "setFlowPageState", state: "approved" },
      { type: "backFlow" },
    ] satisfies OperateEvent[]) {
      const before = await cara.observe();
      expect(await cara.refusal(event)).toBe(invalidEvent);
      expect(await cara.observe()).toEqual(before);
    }
  });

  it("refuses a start whose pages differ from the definition, or that drops them", async () => {
    const desk = await claimsDesk();
    const { cara } = desk;
    await cara.send(desk.openConsole());
    const valid = startOf(desk.workspaceId, desk.snapshot) as Extract<OperateEvent, { type: "startFlow" }>;
    const { pages: _, ...withoutPages } = valid;
    for (const event of [
      withoutPages,
      { ...valid, pages: [{ ...PAGES[0]!, routes: [{ label: "Done", to: "done" }] }, PAGES[1]!, PAGES[2]!] },
      { ...valid, pages: [{ ...PAGES[0]!, states: ["filled"] }, PAGES[1]!, PAGES[2]!] },
    ] satisfies OperateEvent[]) {
      const before = await cara.observe();
      expect(await cara.refusal(event)).toBe(invalidEvent);
      expect(await cara.observe()).toEqual(before);
    }
    expect(await cara.refusal(valid)).toBe("accepted");
  });
});

describe("saving a flow with named pages", () => {
  it("refuses a route to an unknown page, a misnamed page and another workspace's screen", async () => {
    const desk = await claimsDesk();
    using elsewhere = await desk.amy.api.newGadget();
    const foreign = await elsewhere.createCanvas({ title: "Elsewhere", sections: [] });
    const { intake, review, done } = desk.screens;
    const before = await desk.workspace.listFlows();
    for (const content of [
      { ...desk.content, pages: [{ ...PAGES[0]!, routes: [{ label: "Go", to: "nowhere" }] }, PAGES[1]!, PAGES[2]!] },
      { ...desk.content, pages: [{ ...PAGES[0]!, name: review.id }, PAGES[1]!, PAGES[2]!] },
      { ...desk.content, steps: [intake.id, foreign.id, done.id] },
    ] satisfies OperateFlowContent[]) {
      await expect(desk.workspace.createFlow(content)).rejects.toThrow();
      await expect(desk.workspace.replaceFlow(desk.flow.id, desk.flow.revision, content)).rejects.toThrow();
    }
    expect(await desk.workspace.listFlows()).toEqual(before);
  });
});

describe("a move to a page the runner may no longer open", () => {
  it("is refused once the page's screen is deleted, naming neither page nor workspace", async () => {
    const desk = await claimsDesk();
    const { amy } = desk;
    await amy.send(startOf(desk.workspaceId, desk.flow));
    await amy.send({ type: "navigateFlow", to: "review" });
    // Keep the console from pinning the screen: the published console is the use role's, not amy's.
    await desk.workspace.deleteCanvas(desk.screens.done.id, desk.screens.done.revision);
    const before = await amy.observe();
    expect(await amy.refusal({ type: "navigateFlow", to: "done" })).toBe(flowPageUnavailable);
    for (const leak of ["done", "Done", "Claims desk", desk.screens.done.id, desk.workspaceId]) {
      expect(lastMessage).not.toContain(leak);
    }
    expect(await amy.observe()).toEqual(before);
    expect(await amy.refusal({ type: "navigateFlow", to: "intake" })).toBe("accepted");
  });

  it("is refused for a use-role employee once no published console shows the page's screen", async () => {
    const desk = await claimsDesk();
    const { cara } = desk;
    await cara.send(desk.openConsole());
    await cara.send(startOf(desk.workspaceId, desk.snapshot));
    await cara.send({ type: "navigateFlow", to: "review" });
    // Republish without the Done screen (and so without the flow, which needs it).
    const draft = (await desk.workspace.getConsole(desk.draft.id, "draft"))!;
    const narrowed = await desk.workspace.replaceConsole(desk.draft.id, draft.revision,
      { ...draft, views: draft.views.filter(view => view.id !== "done"), flows: [] });
    await desk.workspace.publishConsole(desk.draft.id, narrowed.revision);
    const before = await cara.observe();
    expect(await cara.refusal({ type: "navigateFlow", to: "done" })).toBe(flowPageUnavailable);
    expect(await cara.observe()).toEqual(before);
    expect(await cara.refusal({ type: "navigateFlow", to: "intake" })).toBe("accepted");
  });
});
