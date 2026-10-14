import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getOperateSessionErrorCode, OPERATE_SESSION_ERROR_CODES,
  type AuthenticatedApi, type OperateSession, type OperateSessionUpdate, type Overseer, type PublicApi,
} from "@gadgets/workshop-shared/api";
import type { OperateConsole } from "@gadgets/workshop-shared/operate-console";
import type { OperateFlow } from "@gadgets/workshop-shared/operate-flow";
import type { OperateEvent, OperateSessionSnapshot } from "@gadgets/workshop-shared/operate-session";
import { startHarness, type Harness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { callbackStubFor, connect, nextUsernames, signUp } from "../src/rpc-client.js";

// Flows in a published console (MVP-37 F2): a use-role employee runs only the flows a builder froze
// into the console they have open, and every person's startFlow is checked against an authoritative
// definition (the open published console's snapshot, or the caller's own role-scoped flow store)
// before it is recorded. Each refusal leaves every session, the flow store and the published
// console exactly as they were.

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

const { conflict, flowUnavailable, invalidEvent } = OPERATE_SESSION_ERROR_CODES;
const denied = /Unauthorized: this collaborator only has permission to use/;

/** The page a fresh window onto `session` shows: the first snapshot its subscription delivers. */
async function currentPage(session: RpcStub<OperateSession>): Promise<OperateSessionSnapshot> {
  const first = Promise.withResolvers<OperateSessionUpdate>();
  using subscriber = callbackStubFor((update: OperateSessionUpdate) => { first.resolve(update); });
  using _subscription = await session.subscribe(subscriber);
  const { seq, state } = await first.promise;
  return { seq, state };
}

/** One person's operate session, tracking the seq of the page they last saw. */
class Person {
  seq = 0;
  constructor(readonly username: string, readonly api: RpcStub<AuthenticatedApi>,
      readonly session: RpcStub<OperateSession>) {}
  async send(event: OperateEvent): Promise<OperateSessionSnapshot> {
    const snapshot = await this.session.dispatch(event, this.seq);
    this.seq = snapshot.seq;
    return snapshot;
  }
  /** The refusal code of `event` at the current seq, or "accepted". */
  async refusal(event: OperateEvent): Promise<string> {
    try {
      this.seq = (await this.session.dispatch(event, this.seq)).seq;
      return "accepted";
    } catch (error) {
      return getOperateSessionErrorCode(error) ?? `uncoded: ${(error as Error).message}`;
    }
  }
  async observe() {
    const page = await currentPage(this.session);
    return { seq: page.seq, flow: page.state.flow, events: await this.session.listEvents(0, 50) };
  }
}

async function person(prefix: string): Promise<Person> {
  const username = nextUsernames(prefix)[0]!;
  const api = await signUp(publicApi, username);
  return new Person(username, api, await api.getOperateSession());
}

const startOf = (workspaceId: string, flow: Pick<OperateFlow, "id" | "title" | "steps">): OperateEvent =>
  ({ type: "startFlow", workspaceId, flowId: flow.id, title: flow.title, steps: flow.steps });

/**
 * The amended F2 fixture: owner amy, Build collaborator ben, use-only cara and dan; workspace
 * "Intake desk" with screens Intake, Triage, Confirm and Notes; flows "Intake" [Intake, Triage,
 * Confirm] and "Private" [Intake, Notes]; console "Intake console" over the first three screens,
 * listing "Intake", published.
 */
async function intakeDesk() {
  const [amy, ben, cara, dan] = [await person("f2amy"), await person("f2ben"), await person("f2cara"),
    await person("f2dan")];
  const workspace: RpcStub<Overseer> = await amy.api.newGadget();
  await workspace.newChat("Intake desk", null);
  const workspaceId = (await workspace.getMetadata()).id;
  const screen = (title: string) => workspace.createCanvas({ title, sections: [] });
  const [intake, triage, confirm, notes] =
      [await screen("Intake"), await screen("Triage"), await screen("Confirm"), await screen("Notes")];
  const intakeFlow = await workspace.createFlow({ title: "Intake", steps: [intake.id, triage.id, confirm.id] });
  const privateFlow = await workspace.createFlow({ title: "Private", steps: [intake.id, notes.id] });
  const draft = await workspace.createConsole({
    title: "Intake console", fullChat: "off",
    views: [
      { id: "intake", title: "Intake", type: "screen", screen: intake.id },
      { id: "triage", title: "Triage", type: "screen", screen: triage.id },
      { id: "confirm", title: "Confirm", type: "screen", screen: confirm.id },
    ],
    flows: [intakeFlow.id],
  });
  const published = await workspace.publishConsole(draft.id, draft.revision);
  for (const [who, role] of [[ben, "build"], [cara, "use"], [dan, "use"]] as const) {
    if (!await workspace.addCollaborator(who.username, role)) throw new Error(`Failed to share with ${who.username}`);
  }
  const openConsole = (revision = published.revision): OperateEvent => ({
    type: "openConsole", workspaceId, consoleId: draft.id, title: "Intake console", source: "published",
    revision, fullChat: "off", viewId: "intake",
  });
  /** Everything a refusal must leave unchanged. */
  const observe = async (...people: Person[]) => ({
    people: await Promise.all(people.map(who => who.observe())),
    store: await workspace.listFlows(),
    published: await workspace.getConsole(draft.id, "published"),
  });
  return { amy, ben, cara, dan, workspace, workspaceId, screens: { intake, triage, confirm, notes },
    intakeFlow, privateFlow, console: published, openConsole, observe };
}

const snapshotFlows = (console: OperateConsole | null) => console?.published?.flows ?? [];

/** A person's flow events in order, as `actor:type`. */
const flowEvents = async (who: Person) => (await who.session.listEvents(0, 50))
  .filter(record => ["startFlow", "goToStep", "exitFlow"].includes(record.event.type))
  .map(record => `${record.actor}:${record.event.type}`);

describe("a published console's flows", () => {
  it("are frozen at publish and are all a use-role employee can see of the flows (F2+1, N-5)", async () => {
    const desk = await intakeDesk();
    expect(snapshotFlows(desk.console)).toEqual([{
      id: desk.intakeFlow.id, revision: desk.intakeFlow.revision, title: "Intake", steps: desk.intakeFlow.steps,
    }]);
    using shared = await desk.cara.api.openGadget(desk.workspaceId);
    expect(await shared.getMetadata()).toMatchObject({ role: "use" });
    const seen = await shared.getConsole(desk.console.id, "published");
    expect(snapshotFlows(seen).map(flow => flow.title)).toEqual(["Intake"]);
    expect((await shared.listConsoles()).flatMap(listed => snapshotFlows(listed).map(flow => flow.id)))
      .toEqual([desk.intakeFlow.id]);

    // N-5: no other way in. The store is byte-equal afterwards.
    const store = await desk.workspace.listFlows();
    await expect(shared.listFlows()).rejects.toThrow(denied);
    await expect(shared.createFlow({ title: "Mine", steps: [desk.screens.intake.id] })).rejects.toThrow(denied);
    await expect(shared.replaceFlow(desk.intakeFlow.id, desk.intakeFlow.revision,
      { title: "Changed", steps: [desk.screens.intake.id] })).rejects.toThrow(denied);
    await expect(shared.deleteFlow(desk.privateFlow.id, desk.privateFlow.revision)).rejects.toThrow(denied);
    expect(await desk.workspace.listFlows()).toEqual(store);
  });

  it("run for a use-role employee from the snapshot, independently of another (F2+2, F2+3)", async () => {
    const desk = await intakeDesk();
    const [snapshot] = snapshotFlows(desk.console);
    const { cara, dan } = desk;
    await cara.send(desk.openConsole());
    await dan.send(desk.openConsole());
    expect((await cara.send(startOf(desk.workspaceId, snapshot!))).state.flow)
      .toMatchObject({ flowId: desk.intakeFlow.id, steps: desk.intakeFlow.steps, index: 0 });
    await cara.send({ type: "goToStep", index: 1 });
    await dan.send(startOf(desk.workspaceId, snapshot!));

    // A reload is a new window onto cara's session: still at her second step, dan at his first.
    using reloaded = await desk.cara.api.getOperateSession();
    expect((await currentPage(reloaded)).state.flow?.index).toBe(1);
    expect((await dan.observe()).flow?.index).toBe(0);
    await dan.send({ type: "goToStep", index: 2 });
    expect((await cara.observe()).flow?.index).toBe(1);
    expect((await cara.send({ type: "exitFlow" })).state.flow).toBeNull();
    expect((await dan.observe()).flow?.index).toBe(2);

    expect(await flowEvents(cara)).toEqual(["person:startFlow", "person:goToStep", "person:exitFlow"]);
    expect(await flowEvents(dan)).toEqual(["person:startFlow", "person:goToStep"]);
  });
});

describe("an owner or Build collaborator's start", () => {
  it("is accepted from their own stored flows with no console open (C-1)", async () => {
    const desk = await intakeDesk();
    for (const who of [desk.amy, desk.ben]) {
      expect(await who.refusal(startOf(desk.workspaceId, desk.intakeFlow))).toBe("accepted");
    }
  });

  it("is accepted for a stored, unlisted flow with the published console open (C-2, C-3)", async () => {
    const desk = await intakeDesk();
    for (const who of [desk.amy, desk.ben]) {
      await who.send(desk.openConsole());
      expect(await who.refusal(startOf(desk.workspaceId, desk.privateFlow))).toBe("accepted");
    }
  });

  it("matches a listed flow's current stored definition, newer than the open snapshot (C-4)", async () => {
    const desk = await intakeDesk();
    const { intake, triage } = desk.screens;
    for (const who of [desk.amy, desk.ben, desk.cara]) await who.send(desk.openConsole());
    const edited = await desk.workspace.replaceFlow(desk.intakeFlow.id, desk.intakeFlow.revision,
      { title: "Intake", steps: [intake.id, triage.id] });
    for (const who of [desk.amy, desk.ben]) {
      expect(await who.refusal(startOf(desk.workspaceId, edited))).toBe("accepted");
      await who.send({ type: "exitFlow" });
    }
    // Only the snapshot applies to a use-role employee, so the new steps are not hers to start.
    const before = await desk.observe(desk.cara);
    expect(await desk.cara.refusal(startOf(desk.workspaceId, edited))).toBe(invalidEvent);
    expect(await desk.observe(desk.cara)).toEqual(before);
  });
});

describe("a start without an authoritative definition", () => {
  it("is refused for a use-role employee's forged private flow, with or without a console (N-1)", async () => {
    const desk = await intakeDesk();
    const forged = { ...startOf(desk.workspaceId, desk.privateFlow), title: "Forged",
      steps: ["forged-step-1", "forged-step-2"] };
    for (const open of [false, true]) {
      if (open) await desk.cara.send(desk.openConsole());
      for (const event of [forged, startOf(desk.workspaceId, desk.privateFlow)]) {
        const before = await desk.observe(desk.cara);
        expect(await desk.cara.refusal(event)).toBe(flowUnavailable);
        expect(await desk.observe(desk.cara)).toEqual(before);
      }
    }
  });

  it("is refused when it differs from the snapshot in title or steps (N-2)", async () => {
    const desk = await intakeDesk();
    const [snapshot] = snapshotFlows(desk.console);
    const { intake, triage, confirm } = desk.screens;
    await desk.cara.send(desk.openConsole());
    const valid = startOf(desk.workspaceId, snapshot!);
    for (const event of [
      { ...valid, title: "Intake (forged)" },
      { ...valid, title: " Intake" },
      { ...valid, steps: [...snapshot!.steps, intake.id] },
      { ...valid, steps: [confirm.id, triage.id, intake.id] },
      { ...valid, steps: [intake.id, triage.id] },
    ]) {
      const before = await desk.observe(desk.cara);
      expect(await desk.cara.refusal(event)).toBe(invalidEvent);
      expect(await desk.observe(desk.cara)).toEqual(before);
    }
  });

  it("is refused for stale steps when only the store applies, and accepted when they are the snapshot (N-3)",
    async () => {
      const desk = await intakeDesk();
      const { intake, triage } = desk.screens;
      await desk.workspace.replaceFlow(desk.intakeFlow.id, desk.intakeFlow.revision,
        { title: "Intake", steps: [intake.id, triage.id] });
      const stale = startOf(desk.workspaceId, desk.intakeFlow);
      const before = await desk.observe(desk.amy);
      expect(await desk.amy.refusal(stale)).toBe(invalidEvent);
      expect(await desk.observe(desk.amy)).toEqual(before);
      await desk.amy.send(desk.openConsole());
      expect(await desk.amy.refusal(stale)).toBe("accepted");
    });

  it("is refused for another workspace's flow while the console is open (N-4)", async () => {
    const desk = await intakeDesk();
    using elsewhere = await desk.amy.api.newGadget();
    const elsewhereId = (await elsewhere.getMetadata()).id;
    const screen = await elsewhere.createCanvas({ title: "Elsewhere", sections: [] });
    const foreign = await elsewhere.createFlow({ title: "Elsewhere", steps: [screen.id] });
    await desk.cara.send(desk.openConsole());
    for (const event of [startOf(elsewhereId, foreign), startOf(desk.workspaceId, foreign),
      { ...startOf(elsewhereId, foreign), flowId: desk.intakeFlow.id }]) {
      const before = await desk.observe(desk.cara);
      expect(await desk.cara.refusal(event)).toBe(flowUnavailable);
      expect(await desk.observe(desk.cara)).toEqual(before);
    }
  });

  it("is checked against the page at the expected seq, refusing a stale one as a conflict", async () => {
    const desk = await intakeDesk();
    await desk.cara.send(desk.openConsole());
    const [snapshot] = snapshotFlows(desk.console);
    const before = await desk.observe(desk.cara);
    await expect(desk.cara.session.dispatch(startOf(desk.workspaceId, snapshot!), 0))
      .rejects.toSatisfy((caught: unknown) => getOperateSessionErrorCode(caught) === conflict);
    expect(await desk.observe(desk.cara)).toEqual(before);
  });
});

describe("publishing a console's flows", () => {
  it("refuses a listed flow with a step the console does not show, publishing nothing (P-1)", async () => {
    const desk = await intakeDesk();
    const draft = await desk.workspace.getConsole(desk.console.id, "draft");
    const listed = await desk.workspace.replaceConsole(desk.console.id, draft!.revision,
      { ...draft!, flows: [desk.intakeFlow.id, desk.privateFlow.id] });
    const before = await desk.workspace.getConsole(desk.console.id, "published");
    await expect(desk.workspace.publishConsole(desk.console.id, listed.revision)).rejects.toThrow(/Private/);
    expect(await desk.workspace.getConsole(desk.console.id, "published")).toEqual(before);
  });

  it("refuses saving a draft that lists a flow the workspace does not have, and limits the list (P-2)",
    async () => {
      const desk = await intakeDesk();
      const draft = (await desk.workspace.getConsole(desk.console.id, "draft"))!;
      for (const flows of [["no-such-flow"], [desk.intakeFlow.id, desk.intakeFlow.id]]) {
        await expect(desk.workspace.replaceConsole(desk.console.id, draft.revision, { ...draft, flows }))
          .rejects.toThrow();
        await expect(desk.workspace.createConsole({ ...draft, flows })).rejects.toThrow();
      }
      expect(await desk.workspace.getConsole(desk.console.id, "draft")).toEqual(draft);
      // Absent keeps the saved list (as for host boards), and [] is the same as listing none.
      const { flows: _, ...withoutFlows } = draft;
      const kept = await desk.workspace.replaceConsole(desk.console.id, draft.revision, withoutFlows);
      expect(kept.flows).toEqual([desk.intakeFlow.id]);
      const cleared = await desk.workspace.replaceConsole(desk.console.id, kept.revision, { ...draft, flows: [] });
      const republished = await desk.workspace.publishConsole(desk.console.id, cleared.revision);
      expect(snapshotFlows(republished)).toEqual([]);
    });
});

describe("a running flow", () => {
  it("keeps its copied steps when the flow is edited and republished; a new start uses the new snapshot (R-1)",
    async () => {
      const desk = await intakeDesk();
      const [old] = snapshotFlows(desk.console);
      const { intake, triage, confirm } = desk.screens;
      await desk.cara.send(desk.openConsole());
      await desk.cara.send(startOf(desk.workspaceId, old!));
      await desk.cara.send({ type: "goToStep", index: 1 });

      await desk.workspace.replaceFlow(desk.intakeFlow.id, desk.intakeFlow.revision,
        { title: "Intake", steps: [confirm.id, triage.id, intake.id] });
      const draft = (await desk.workspace.getConsole(desk.console.id, "draft"))!;
      const republished = await desk.workspace.publishConsole(desk.console.id, draft.revision);
      const [fresh] = snapshotFlows(republished);
      expect(fresh!.steps).toEqual([confirm.id, triage.id, intake.id]);
      expect((await desk.cara.observe()).flow).toMatchObject({ steps: old!.steps, index: 1 });

      await desk.cara.send(desk.openConsole(republished.revision));
      expect(await desk.cara.refusal(startOf(desk.workspaceId, old!))).toBe(invalidEvent);
      expect((await desk.cara.observe()).flow).toMatchObject({ steps: old!.steps, index: 1 });
      expect(await desk.cara.refusal(startOf(desk.workspaceId, fresh!))).toBe("accepted");
      expect((await desk.cara.observe()).flow).toMatchObject({ steps: fresh!.steps, index: 0 });
    });

  it("carries its step to every connection of one person", async () => {
    const desk = await intakeDesk();
    using tabB = await desk.amy.api.getOperateSession();
    let sawStep = () => {};
    const stepped = new Promise<void>(resolve => { sawStep = resolve; });
    let latest: OperateSessionUpdate | undefined;
    using subscriber = callbackStubFor((update: OperateSessionUpdate) => {
      latest = update;
      if (update.seq === 2) sawStep();
    });
    using _subscription = await tabB.subscribe(subscriber);
    await desk.amy.send(startOf(desk.workspaceId, desk.intakeFlow));
    await desk.amy.send({ type: "goToStep", index: 1 });
    await stepped;
    expect(latest?.state.flow).toMatchObject({ flowId: desk.intakeFlow.id, index: 1, steps: desk.intakeFlow.steps });
    expect(await desk.amy.refusal({ type: "goToStep", index: 3 })).toBe(invalidEvent);
    expect((await desk.amy.send({ type: "exitFlow" })).state.flow).toBeNull();
  });
});
