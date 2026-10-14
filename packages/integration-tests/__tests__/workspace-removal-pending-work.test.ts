// MVP-36: what a Build collaborator leaves behind when the owner removes them from a shared
// workspace W. Local and synthetic; it asserts the existing caller and session checks and adds no
// authority.
//
// 1. D2, a write they submitted: it stays pending and unchanged across the removal's restart. They
//    can no longer open W to decide it. The owner approves it, and it applies exactly once, resolved
//    by the owner (the approval runs under the approver's profile, `Overseer.approveAction`).
// 2. D4 class 3, their own Operate state: their page and event log are their own records and stay
//    readable, inert. Every action that reaches W re-reads it through their own (now absent)
//    access and is refused: console navigation `consoleChanged`, a flow start `flowUnavailable`, a
//    board `boardUnavailable`. Their session seq does not advance.
//
// The fixture gatekeeper supplies W's connection: the held write (its ApprovalQueue funnel) and
// the board reference the session reaches. Each removal restarts W, so the owner reopens it.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import {
  getOpenGadgetErrorCode, getOperateSessionErrorCode, OPEN_GADGET_ERROR_CODES,
  OPERATE_SESSION_ERROR_CODES,
  type ActionLogEntry, type AuthenticatedApi, type OperateSession, type OperateSessionUpdate,
  type Overseer,
} from "@gadgets/workshop-shared/api";
import type { OperateEvent, OperateSessionSnapshot } from "@gadgets/workshop-shared/operate-session";
import {
  startHarness, TEST_GATEKEEPER_BINDING, TEST_GATEKEEPER_DIR, TEST_VENDOR_ID, testActionState,
  type Harness,
} from "../src/harness.js";
import type { TestSession } from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import {
  accountLabel, callbackStubFor, connect, listConnectedAccounts, logIn, MAX_OBSERVER_PROMPTS,
  nextUsernames, ObserverConfigRecorder, signUp, stubFor, waitFor, type ConnectedAccount,
} from "../src/rpc-client.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";

let harness: Harness;
const network = new NetworkInterceptor();
const connections = new DisposableStack();

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [{ binding: TEST_GATEKEEPER_BINDING, dir: TEST_GATEKEEPER_DIR }],
    patchWorkshop(config) {
      config.vars = { ...config.vars, COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true" };
    },
  });
});

afterAll(async () => {
  try {
    connections.dispose();
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

/** A fresh connection, closed after the suite. */
const fresh = () => connections.use(connect(harness.url));

async function provisionAccount(api: RpcStub<AuthenticatedApi>): Promise<ConnectedAccount> {
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  return waitFor("the test account to be provisioned", async () =>
    (await listConnectedAccounts(api)).find(a => a.vendorId === TEST_VENDOR_ID) ?? null);
}

type Workspace = {
  overseer: RpcStub<Overseer>;
  session: RpcStub<TestSession>;
  gatekeeperId: number;
  label: string;
  owner: string;
  workspaceId: string;
  /** The connection's resource URL, which the Operate session reaches as a board reference. */
  boardRef: string;
};

/** The owner's shared workspace W, with one fixture connection on the owner's account. */
async function newWorkspace(thingName: string): Promise<Workspace> {
  const [owner] = nextUsernames("owner");
  const api = await signUp(fresh(), owner!);
  const account = await provisionAccount(api);
  const overseer = await api.newGadget();
  await overseer.newChat("Shared desk", null);
  const boardRef = `https://gadgets-test.example/things/${thingName}`;
  const gatekeeper = await overseer.newGatekeeper(account.id, boardRef);
  if (!gatekeeper) throw new Error("Failed to create the test connection");
  return {
    overseer,
    session: await gatekeeper.openSession() as RpcStub<TestSession>,
    gatekeeperId: await gatekeeper.getId(),
    label: accountLabel(account),
    owner: owner!,
    workspaceId: (await overseer.getMetadata()).id,
    boardRef,
  };
}

type Collaborator = {
  name: string;
  /** Open W on a fresh connection, choosing their own fixture account for its observers. */
  open(): Promise<RpcStub<Overseer>>;
  /** Their own API on a fresh connection. */
  api(): Promise<RpcStub<AuthenticatedApi>>;
};

/** Someone the owner adds to W directly with Build. */
async function buildCollaborator(ws: Workspace): Promise<Collaborator> {
  const [name] = nextUsernames("builder");
  const account = await provisionAccount(await signUp(fresh(), name!));
  if (!await ws.overseer.addCollaborator(name!, "build")) throw new Error(`Failed to share with ${name}`);
  return {
    name: name!,
    async open() {
      const api = await logIn(fresh(), name!);
      using callback = stubFor(
          new ObserverConfigRecorder().alwaysChoose(account.id, MAX_OBSERVER_PROMPTS));
      return await api.openGadget(ws.workspaceId, undefined, callback);
    },
    api: () => logIn(fresh(), name!),
  };
}

async function listWrites(overseer: RpcStub<Overseer>, gatekeeperId: number)
    : Promise<Array<ActionLogEntry & { type: "action" }>> {
  const { entries } = await overseer.listActions();
  return entries.filter(
      (a): a is ActionLogEntry & { type: "action" } => a.type === "action" && a.gatekeeperId === gatekeeperId)
      .toSorted((a, b) => a.id - b.id);
}

/** The drain runs after submit via waitUntil: one more round trip plus a beat outlasts it. */
async function settle(overseer: RpcStub<Overseer>): Promise<void> {
  await overseer.listActions();
  await new Promise(resolve => setTimeout(resolve, 300));
}

/** The removal restarts W: wait for the old instance to fall, then reopen it as the owner. */
async function reopenAfterRestart(ws: Workspace): Promise<Workspace> {
  await waitFor("the restart to fell the old workspace instance", () =>
    ws.session.readValue().then(() => null, () => true));
  return waitFor("the workspace to come back after the restart", async () => {
    try {
      const overseer = await (await logIn(fresh(), ws.owner)).openGadget(ws.workspaceId);
      const session = await (await overseer.getGatekeeperById(ws.gatekeeperId)).openSession() as
          RpcStub<TestSession>;
      await session.readValue();
      return { ...ws, overseer, session };
    } catch {
      return null;
    }
  });
}

const decision = (write: ActionLogEntry & { type: "action" }) =>
  ({ state: write.state, autoApproved: write.autoApproved, resolvedBy: write.resolvedBy?.id });

/** The page a fresh window onto `session` shows: the first snapshot its subscription delivers. */
async function currentPage(session: RpcStub<OperateSession>): Promise<OperateSessionSnapshot> {
  const first = Promise.withResolvers<OperateSessionUpdate>();
  using subscriber = callbackStubFor((update: OperateSessionUpdate) => { first.resolve(update); });
  using _subscription = await session.subscribe(subscriber);
  const { seq, state } = await first.promise;
  return { seq, state };
}

/** The refusal code of `event` at `seq`, or "accepted". */
async function refusal(session: RpcStub<OperateSession>, event: OperateEvent, seq: number)
    : Promise<string> {
  try {
    await session.dispatch(event, seq);
    return "accepted";
  } catch (error) {
    return getOperateSessionErrorCode(error) ?? `uncoded: ${(error as Error).message}`;
  }
}

const { boardUnavailable, consoleChanged, flowUnavailable } = OPERATE_SESSION_ERROR_CODES;

describe("after the owner removes a Build collaborator from a shared workspace", () => {
  it("D2: their pending write stays unchanged, they cannot decide it, and the owner's approval applies it once",
      async () => {
    const ws = await newWorkspace("removed-submitter");
    const submitter = await buildCollaborator(ws);

    // The collaborator submits a manual write through W's connection; it is held for a decision.
    // Not awaited: the promise outlives the instance the removal restarts.
    const theirs = await submitter.open();
    const theirSession = await (await theirs.getGatekeeperById(ws.gatekeeperId)).openSession() as
        RpcStub<TestSession>;
    theirSession.writeValue(7).catch(() => {});
    const [held] = await waitFor("the collaborator's write to be held", async () => {
      const writes = await listWrites(ws.overseer, ws.gatekeeperId);
      return writes.length === 1 ? writes : null;
    });
    await settle(ws.overseer);
    const before = (await listWrites(ws.overseer, ws.gatekeeperId))[0]!;
    expect(before.id).toBe(held!.id);
    expect(decision(before)).toEqual({ state: "pending", autoApproved: undefined, resolvedBy: undefined });
    await expect(testActionState(harness, ws.label)).resolves.toEqual(
        { pending: [{ id: 1, value: 7 }], applyCount: 0 });

    await ws.overseer.removeCollaborator(submitter.name, []);
    const reopened = await reopenAfterRestart(ws);

    // Unchanged across the removal: the same record, still pending, nothing applied.
    expect(await listWrites(reopened.overseer, ws.gatekeeperId)).toEqual([before]);
    await expect(testActionState(harness, ws.label)).resolves.toEqual(
        { pending: [{ id: 1, value: 7 }], applyCount: 0 });

    // The removed submitter cannot reach W to decide it, and the record is still untouched.
    await expect(submitter.open()).rejects.toSatisfy((caught: unknown) =>
      getOpenGadgetErrorCode(caught) === OPEN_GADGET_ERROR_CODES.workspaceAccessDenied);
    expect(await listWrites(reopened.overseer, ws.gatekeeperId)).toEqual([before]);

    // The current owner approves it: it applies exactly once, resolved by the owner.
    await reopened.overseer.approveAction(before.id);
    const applied = await waitFor("the held write to be applied", async () => {
      const [write] = await listWrites(reopened.overseer, ws.gatekeeperId);
      return write?.state === "approved" ? write : null;
    });
    await settle(reopened.overseer);
    expect(decision(applied)).toEqual({ state: "approved", autoApproved: false, resolvedBy: ws.owner });
    expect(await listWrites(reopened.overseer, ws.gatekeeperId)).toEqual([applied]);
    await expect(testActionState(harness, ws.label)).resolves.toEqual(
        { pending: [], value: 7, applyCount: 1 });
  });

  it("D4: their own Operate page and event log stay readable and inert; every action into the workspace is refused",
      async () => {
    const ws = await newWorkspace("removed-operator");
    const screen = (title: string) => ws.overseer.createCanvas({ title, sections: [] });
    const [intake, triage] = [await screen("Intake"), await screen("Triage")];
    const flow = await ws.overseer.createFlow({ title: "Intake", steps: [intake.id, triage.id] });
    const draft = await ws.overseer.createConsole({
      title: "Shared console", fullChat: "off",
      views: [
        { id: "intake", title: "Intake", type: "screen", screen: intake.id },
        { id: "triage", title: "Triage", type: "screen", screen: triage.id },
      ],
      flows: [flow.id],
    });
    const published = await ws.overseer.publishConsole(draft.id, draft.revision);
    const [snapshot] = published.published?.flows ?? [];
    const operator = await buildCollaborator(ws);
    // Their first open answers W's observer prompts, as their console use requires.
    (await operator.open())[Symbol.dispose]();

    const startFlow: OperateEvent = {
      type: "startFlow", workspaceId: ws.workspaceId, flowId: snapshot!.id, title: snapshot!.title,
      steps: snapshot!.steps,
    };
    const events = {
      openView: { type: "openView", viewId: "triage" },
      showScreen: { type: "showScreen", screenId: triage.id },
      startFlow,
      openBoard: { type: "openBoard", board: { workspaceId: ws.workspaceId, boardRef: ws.boardRef } },
    } satisfies Record<string, OperateEvent>;

    // Before the removal: their page shows W's published console, a flow they ran, and W's board.
    const session = await (await operator.api()).getOperateSession();
    let seq = 0;
    const send = async (event: OperateEvent) => { seq = (await session.dispatch(event, seq)).seq; };
    await send({
      type: "openConsole", workspaceId: ws.workspaceId, consoleId: draft.id, title: "Shared console",
      source: "published", revision: published.revision, fullChat: "off", viewId: "intake",
    });
    await send(events.openView);
    await send(events.showScreen);
    await send(events.startFlow);
    await send({ type: "exitFlow" });
    await send(events.openBoard);
    const page = await currentPage(session);
    const log = await session.listEvents(0, 50);
    expect(page.seq).toBe(seq);
    expect(page.state.console).toMatchObject({ workspaceId: ws.workspaceId, consoleId: draft.id });
    expect(page.state.board).toEqual({ workspaceId: ws.workspaceId, boardRef: ws.boardRef, issueId: null });
    expect(log.map(record => `${record.actor}:${record.event.type}`)).toEqual([
      "person:openConsole", "person:openView", "person:showScreen", "person:startFlow",
      "person:exitFlow", "person:openBoard",
    ]);

    await ws.overseer.removeCollaborator(operator.name, []);
    await reopenAfterRestart(ws);

    // Their own records, on a fresh connection: the same page at the same seq, the same log.
    const after = await (await operator.api()).getOperateSession();
    expect(await currentPage(after)).toEqual(page);
    expect(await after.listEvents(0, 50)).toEqual(log);

    // Every action that reaches W is refused through their own access, and records nothing.
    const refused = {
      openView: await refusal(after, events.openView, seq),
      showScreen: await refusal(after, events.showScreen, seq),
      startFlow: await refusal(after, events.startFlow, seq),
      openBoard: await refusal(after, events.openBoard, seq),
    };
    expect(refused).toEqual({
      openView: consoleChanged, showScreen: consoleChanged, startFlow: flowUnavailable,
      openBoard: boardUnavailable,
    });
    expect(await currentPage(after)).toEqual(page);
    expect(await after.listEvents(0, 50)).toEqual(log);
  });
});
