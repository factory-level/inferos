// Operate subjects (#64), end to end: the session's subject is the board it shows, a handover shares
// that subject and a note into another person's session without granting anything, and the
// per-subject audit is readable only through the reader's own access to the subject.
//
// The real Workshop and InferOps gatekeeper Worker against the fake InferLab and InferOps
// (src/inferops-fake.ts), with per-person accounts from the real connect flow.

import { afterAll, beforeAll, expect, it } from "vitest";
import { resolve } from "node:path";
import type { RpcStub } from "capnweb";
import {
  getOperateSessionErrorCode, OPERATE_SESSION_ERROR_CODES, type AuthenticatedApi, type OperateSession,
  type OperateSessionErrorCode, type Overseer,
} from "@gadgets/workshop-shared/api";
import type { InferOpsProjectSession } from "../../../custom-gatekeepers/gatekeeper-inferops/src/types.js";
import { startHarness, type Harness } from "../src/harness.js";
import {
  INFERLAB_ORIGIN, INFEROPS_ORIGIN, InferOpsFake, boardUrl, type WorkspaceSlug,
} from "../src/inferops-fake.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, nextUsernames, signUp, waitFor, type ConnectedAccount,
} from "../src/rpc-client.js";

const INFEROPS_GATEKEEPER_DIR =
  resolve(import.meta.dirname, "../../../custom-gatekeepers/gatekeeper-inferops");
const GATEKEEPER_WORKER = "gatekeeper-inferops";
const VENDOR = "inferops";
const ENG_BOARD = boardUrl("operations", "ENG");
const WEB_BOARD = boardUrl("operations", "WEB");

const fake = new InferOpsFake();
const network = new NetworkInterceptor({ handlers: [fake.handler] });
let harness: Harness;

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [{
      binding: "INFEROPS",
      dir: INFEROPS_GATEKEEPER_DIR,
      patch: config => {
        if (process.env.WORKSHOP_INTEGRATION_PREBUILT === "1") delete config.build;
        config.vars = {
          ...config.vars,
          INFERLAB_AUTH_ORIGIN: INFERLAB_ORIGIN,
          INFEROPS_BASE_URL: INFEROPS_ORIGIN,
          BASE_URL: "http://workshop.test/gatekeeper/inferops",
        };
      },
    }],
    patchWorkshop(config) {
      config.vars = { ...config.vars, COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true" };
    },
  });
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

type Operator = {
  username: string;
  api: RpcStub<AuthenticatedApi>;
  account: ConnectedAccount;
  session: RpcStub<OperateSession>;
  own: RpcStub<Overseer>;
  workspaceId: string;
};

/** A Workshop user with their own InferOps account (holding `workspaces`) and operate session. */
async function newOperator(prefix: string, workspaces: WorkspaceSlug[]): Promise<Operator> {
  const [username] = nextUsernames(prefix);
  const api = await signUp(connect(harness.url), username!);
  const person = fake.addPerson(username!, workspaces);
  const { url, nonce } = await api.connectAccount(VENDOR);
  const start = await harness.fetchWorker(GATEKEEPER_WORKER, url, { redirect: "manual" });
  const done = await harness.fetchWorker(GATEKEEPER_WORKER, fake.authorize(start.headers.get("location")!, person));
  const literal = /var ticket = (".*?");\n/.exec(await done.text());
  if (!literal) throw new Error("The handoff page carried no ticket");
  await api.completeConnectHandoff(JSON.parse(literal[1]!), nonce);
  const account = await waitFor("the connected InferOps account", async () =>
    (await listConnectedAccounts(api)).find(a => a.vendorId === VENDOR && a.description.uniqueName === person.email) ?? null);
  const session = await api.getOperateSession();
  const own: RpcStub<Overseer> = await session.getWorkspace();
  const { id: workspaceId } = await own.getMetadata();
  return { username: username!, api, account, session, own, workspaceId };
}

/** Connects `boardRef` in the operator's own session workspace and returns a board session over it. */
async function connectBoard(operator: Operator, boardRef: string) {
  const connection = await operator.own.newGatekeeper(operator.account.id, boardRef);
  if (!connection) throw new Error(`Could not connect ${boardRef}`);
  return await connection.openSession() as RpcStub<InferOpsProjectSession>;
}

const refusedWith = (code: OperateSessionErrorCode) => (caught: unknown) => {
  expect(getOperateSessionErrorCode(caught)).toBe(code);
  return true;
};

const seqOf = async (operator: Operator) => (await operator.session.listEvents(0, 200)).length;

it("a handover shares the subject and a note into another session, is recorded in both, and grants nothing", async () => {
  const alice = await newOperator("handoversender", ["operations"]);
  const bob = await newOperator("handoverpeer", ["operations"]);
  const carol = await newOperator("handoveroutsider", ["knowledge"]);
  const board = await connectBoard(alice, ENG_BOARD);
  const [eng1] = (await board.readBoard()).columns.flatMap(column => column.issues);

  // Nothing to hand over until a board is shown.
  await expect(alice.session.handOver(bob.username, "Yours"))
    .rejects.toSatisfy(refusedWith(OPERATE_SESSION_ERROR_CODES.invalidEvent));
  let page = await alice.session.dispatch({ type: "openBoard", board: { workspaceId: alice.workspaceId, boardRef: ENG_BOARD } }, 0);
  page = await alice.session.dispatch({ type: "openIssue", issueId: eng1!.id }, page.seq);
  expect(page.state.subject).toBe(ENG_BOARD);

  // Only someone who exists, and isn't the sender, can receive one.
  for (const recipient of ["nosuchoperator", alice.username]) {
    await expect(alice.session.handOver(recipient, "Yours"))
      .rejects.toSatisfy(refusedWith(OPERATE_SESSION_ERROR_CODES.recipientUnavailable));
  }
  // No session can record a handover itself.
  const forged = {
    id: "forged", from: { id: bob.username, name: "Bob" }, to: { id: alice.username, name: "Alice" },
    boardRef: ENG_BOARD, issueId: null, note: "",
  };
  for (const type of ["handoverReceived", "handoverSent"] as const) {
    await expect(alice.session.dispatch({ type, handover: forged }, page.seq))
      .rejects.toSatisfy(refusedWith(OPERATE_SESSION_ERROR_CODES.invalidEvent));
  }

  // Handed to Carol, who has no access to ENG: she receives the reference and the note...
  const toCarol = await alice.session.handOver(carol.username, "Can you look at this one?");
  expect(toCarol).toMatchObject({
    from: { id: alice.username }, to: { id: carol.username }, boardRef: ENG_BOARD, issueId: eng1!.id,
    note: "Can you look at this one?",
  });
  const carolLog = await carol.session.listEvents(0, 200);
  expect(carolLog).toEqual([expect.objectContaining({
    event: { type: "handoverReceived", handover: toCarol }, actor: "person", subject: ENG_BOARD,
  })]);
  const aliceLog = await alice.session.listEvents(0, 200);
  expect(aliceLog.at(-1)).toMatchObject({ event: { type: "handoverSent", handover: toCarol }, subject: ENG_BOARD });
  // ...but neither the board nor its audit: the handover granted her nothing.
  const carolBoard = { workspaceId: carol.workspaceId, boardRef: ENG_BOARD };
  await expect(carol.session.dispatch({ type: "openBoard", board: carolBoard }, 1))
    .rejects.toSatisfy(refusedWith(OPERATE_SESSION_ERROR_CODES.boardUnavailable));
  await expect(carol.own.newGatekeeper(carol.account.id, ENG_BOARD)).rejects.toThrow(/No InferOps project ENG/);
  await expect(carol.session.listSubjectAudit(carolBoard))
    .rejects.toSatisfy(refusedWith(OPERATE_SESSION_ERROR_CODES.boardUnavailable));
  // Nor the sender's workspace, which the handover never names.
  await expect(carol.session.listSubjectAudit({ workspaceId: alice.workspaceId, boardRef: ENG_BOARD }))
    .rejects.toSatisfy(refusedWith(OPERATE_SESSION_ERROR_CODES.boardUnavailable));
  expect(JSON.stringify(toCarol)).not.toContain(alice.workspaceId);
  // She can still dismiss it.
  const dismissed = await carol.session.dispatch({ type: "dismissHandover", id: toCarol.id }, 1);
  expect(dismissed.state.handovers).toEqual([]);

  // Handed to Bob, who holds ENG through his own account: he opens it in his own session.
  const toBob = await alice.session.handOver(bob.username, "Over to you");
  await connectBoard(bob, ENG_BOARD);
  const bobBoard = { workspaceId: bob.workspaceId, boardRef: ENG_BOARD };
  const opened = await bob.session.dispatch({ type: "openBoard", board: bobBoard }, await seqOf(bob));
  expect(opened.state).toMatchObject({
    subject: ENG_BOARD, board: { ...bobBoard, issueId: null }, handovers: [toBob],
  });
});

it("the audit of one subject holds its events and actions, and nothing of another subject", async () => {
  const alice = await newOperator("auditreader", ["operations"]);
  const bob = await newOperator("auditpeer", ["operations"]);
  const eng = await connectBoard(alice, ENG_BOARD);
  const web = await connectBoard(alice, WEB_BOARD);
  const engBoard = { workspaceId: alice.workspaceId, boardRef: ENG_BOARD };
  const webBoard = { workspaceId: alice.workspaceId, boardRef: WEB_BOARD };

  let page = await alice.session.dispatch({ type: "setChatOpen", open: false }, 0);
  page = await alice.session.dispatch({ type: "openBoard", board: engBoard }, page.seq);
  await eng.readBoard();
  const handover = await alice.session.handOver(bob.username, "ENG needs eyes");
  page = await alice.session.dispatch({ type: "openBoard", board: webBoard }, page.seq + 1);
  await web.readBoard();
  // Switching subject leaves nothing of the previous one on the page.
  expect(page.state).toMatchObject({ subject: WEB_BOARD, board: { ...webBoard, issueId: null } });
  expect(JSON.stringify(page.state)).not.toContain(ENG_BOARD);
  page = await alice.session.dispatch({ type: "closeBoard" }, page.seq);

  const engAudit = await alice.session.listSubjectAudit(engBoard);
  expect(engAudit.next).toBeUndefined();
  expect(engAudit.events.map(record => record.event.type)).toEqual(["handoverSent", "openBoard"]);
  expect(engAudit.events[0]!.event).toEqual({ type: "handoverSent", handover });
  expect(engAudit.actions).toEqual([expect.objectContaining({ type: "observation", resourceUrl: ENG_BOARD })]);

  const webAudit = await alice.session.listSubjectAudit(webBoard);
  // The event that switched to WEB, and the one that closed it.
  expect(webAudit.events.map(record => record.event.type)).toEqual(["closeBoard", "openBoard"]);
  expect(webAudit.actions).toEqual([expect.objectContaining({ type: "observation", resourceUrl: WEB_BOARD })]);
  expect(JSON.stringify(webAudit)).not.toContain(ENG_BOARD);

  // Bob's audit of ENG, read through his own connection, holds his own record of the handover and
  // none of Alice's reads; without a connection he can't read it at all.
  const bobEng = { workspaceId: bob.workspaceId, boardRef: ENG_BOARD };
  await expect(bob.session.listSubjectAudit(bobEng))
    .rejects.toSatisfy(refusedWith(OPERATE_SESSION_ERROR_CODES.boardUnavailable));
  await connectBoard(bob, ENG_BOARD);
  const bobAudit = await bob.session.listSubjectAudit(bobEng);
  expect(bobAudit.events).toEqual([expect.objectContaining({ event: { type: "handoverReceived", handover } })]);
  expect(bobAudit.actions).toEqual([]);
});
