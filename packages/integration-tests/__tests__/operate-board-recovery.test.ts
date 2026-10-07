// Board and issue recovery in the operate session (#63), end to end: a connection that drops while
// a board and issue are open and an edit waits for approval comes back to the same page, the same
// single pending action and no write; two tabs proposing the same new issue queue one create; an
// issue deleted in InferOps while open is refused explicitly, never applied or swapped for another.
//
// The real Workshop and InferOps gatekeeper Worker against the fake InferLab and InferOps
// (src/inferops-fake.ts), with per-person accounts from the real connect flow.

import { afterAll, beforeAll, expect, it } from "vitest";
import { resolve } from "node:path";
import type { RpcStub } from "capnweb";
import type {
  ActionLogEntry, AuthenticatedApi, OperateSession, OperateSessionUpdate, Overseer, PublicApi,
} from "@gadgets/workshop-shared/api";
import type { InferOpsProjectSession } from "../../../custom-gatekeepers/gatekeeper-inferops/src/types.js";
import { startHarness, type Harness } from "../src/harness.js";
import {
  INFERLAB_ORIGIN, INFEROPS_ORIGIN, InferOpsFake, boardUrl, type FakePerson,
} from "../src/inferops-fake.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, logIn, nextUsernames, signUp, waitFor, type ConnectedAccount,
} from "../src/rpc-client.js";

const INFEROPS_GATEKEEPER_DIR =
  resolve(import.meta.dirname, "../../../custom-gatekeepers/gatekeeper-inferops");
const GATEKEEPER_WORKER = "gatekeeper-inferops";
const VENDOR = "inferops";
const ENG_BOARD = boardUrl("operations", "ENG");

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

type User = { username: string; person: FakePerson; account: ConnectedAccount };

/** A person with their own InferOps account, on a connection of its own that the test may drop. */
async function newUser(prefix: string): Promise<User> {
  const [username] = nextUsernames(prefix);
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, username!);
  const person = fake.addPerson(username!, ["operations"]);
  const { url, nonce } = await api.connectAccount(VENDOR);
  const start = await harness.fetchWorker(GATEKEEPER_WORKER, url, { redirect: "manual" });
  const done = await harness.fetchWorker(GATEKEEPER_WORKER, fake.authorize(start.headers.get("location")!, person));
  const literal = /var ticket = (".*?");\n/.exec(await done.text());
  if (!literal) throw new Error("The handoff page carried no ticket");
  await api.completeConnectHandoff(JSON.parse(literal[1]!), nonce);
  const account = await waitFor("the connected InferOps account", async () =>
    (await listConnectedAccounts(api)).find(a => a.vendorId === VENDOR && a.description.uniqueName === person.email) ?? null);
  return { username: username!, person, account };
}

/**
 * One tab: its own WebSocket, the person's operate session and session workspace, and a board
 * session over their ENG connection there (made by the first tab, found by the others).
 * Disposing it drops that connection and everything reached through it.
 */
async function openTab(user: User) {
  const publicApi: RpcStub<PublicApi> = connect(harness.url);
  const api: RpcStub<AuthenticatedApi> = await logIn(publicApi, user.username);
  const session: RpcStub<OperateSession> = await api.getOperateSession();
  const own: RpcStub<Overseer> = await session.getWorkspace();
  const { id: workspaceId } = await own.getMetadata();
  const connection = await own.getGatekeeperByResourceUrl(ENG_BOARD)
    ?? await own.newGatekeeper(user.account.id, ENG_BOARD);
  if (!connection) throw new Error("Could not connect ENG");
  const board = await connection.openSession() as RpcStub<InferOpsProjectSession>;
  return {
    session, own, workspaceId, board,
    [Symbol.dispose]() {
      for (const stub of [board, connection, own, session, api, publicApi]) stub[Symbol.dispose]();
    },
  };
}

/** The page the session shows now, as a newly subscribed tab first sees it. */
async function pageOf(session: RpcStub<OperateSession>) {
  let first!: (update: OperateSessionUpdate) => void;
  const update = new Promise<OperateSessionUpdate>(resolve => { first = resolve; });
  using _subscription = await session.subscribe(next => first(next));
  return update;
}

const pending = async (own: RpcStub<Overseer>): Promise<ActionLogEntry[]> =>
  (await own.listActions({ filter: "action" })).entries.filter(entry => entry.state === "pending");

async function failure(call: PromiseLike<unknown>): Promise<string> {
  try {
    await call;
    return "";
  } catch (error) {
    return String(error);
  }
}

it("restores the board, the open issue and the one pending edit after the connection drops, with no write", async () => {
  const user = await newUser("reconnect");
  const eng1 = fake.issue("ENG-1");
  let seq: number;
  {
    using tab = await openTab(user);
    let page = await tab.session.dispatch({ type: "openBoard", board: { workspaceId: tab.workspaceId, boardRef: ENG_BOARD } }, 0);
    page = await tab.session.dispatch({ type: "openIssue", issueId: eng1.id }, page.seq);
    seq = page.seq;
    using issue = await tab.board.openIssue(eng1.id);
    await issue.update({ title: "Proposed before the drop" }, eng1.revision);
    expect((await pending(tab.own)).map(a => a.description.title)).toEqual(["Update ENG-1: title"]);
    // The tab's WebSocket goes away here, mid-approval.
  }

  using tab = await openTab(user);
  // The same page: the board and the issue open over it, at the same point in the log.
  expect(await pageOf(tab.session)).toMatchObject({
    seq, state: { board: { workspaceId: tab.workspaceId, boardRef: ENG_BOARD, issueId: eng1.id } },
  });
  // The one pending edit, still shown as pending and not as done; nothing reached InferOps.
  const [action, ...more] = await pending(tab.own);
  expect(more).toEqual([]);
  expect(action!.description.title).toBe("Update ENG-1: title");
  const card = (await tab.board.readBoard()).columns.flatMap(column => column.issues).find(i => i.id === eng1.id);
  expect(card).toMatchObject({ title: "Proposed before the drop", pending: "update" });
  expect(fake.writeRequests().filter(r => r.person === user.username)).toEqual([]);
  expect((await tab.own.listActions({ filter: "action" })).entries.filter(entry => entry.state !== "pending")).toEqual([]);

  // Proposing it again from the reconnected tab changes nothing (the pending edit already shows
  // it), and another edit of the issue is refused while that one waits: nothing is queued twice.
  using issue = await tab.board.openIssue(eng1.id);
  await issue.update({ title: "Proposed before the drop" }, eng1.revision);
  expect(await failure(issue.update({ title: "Another edit" }, eng1.revision))).toContain("CONFLICT");
  expect(await pending(tab.own)).toHaveLength(1);

  // Approved once: one write. Approving it again writes nothing.
  await tab.own.approveAction(action!.id);
  expect(await failure(tab.own.approveAction(action!.id))).toContain("not pending");
  expect(fake.commits.filter(c => c.person === user.username)).toHaveLength(1);
  expect(fake.issue("ENG-1").title).toBe("Proposed before the drop");
});

it("queues one create when two tabs propose the same new issue, and writes it once", async () => {
  const user = await newUser("twotabs");
  using first = await openTab(user);
  using second = await openTab(user);
  await Promise.all([
    first.board.createIssue({ title: "Proposed in two tabs" }),
    second.board.createIssue({ title: "Proposed in two tabs" }),
  ]);
  const queued = await pending(first.own);
  expect(queued.map(a => a.description.title)).toEqual(["Create issue: Proposed in two tabs"]);
  expect((await second.board.readBoard()).columns.flatMap(column => column.issues)
    .filter(i => i.pending === "create").map(i => i.title)).toEqual(["Proposed in two tabs"]);

  await second.own.approveAction(queued[0]!.id);
  expect(fake.issuesOf("ENG").filter(i => i.title === "Proposed in two tabs")).toHaveLength(1);
  expect(fake.commits.filter(c => c.person === user.username).map(c => c.operation)).toEqual(["create"]);
});

it("refuses an issue deleted in InferOps while it is open, and its pending edit, writing nothing", async () => {
  const user = await newUser("deleted");
  using tab = await openTab(user);
  const eng2 = fake.issue("ENG-2");
  let page = await tab.session.dispatch({ type: "openBoard", board: { workspaceId: tab.workspaceId, boardRef: ENG_BOARD } }, 0);
  page = await tab.session.dispatch({ type: "openIssue", issueId: eng2.id }, page.seq);
  using issue = await tab.board.openIssue(eng2.id);
  await issue.update({ priority: "urgent" }, eng2.revision);
  const [action] = await pending(tab.own);

  fake.deleteIssue("ENG-2");

  // The board no longer has it; the issue's own reads and writes say it is gone.
  expect((await tab.board.readBoard()).columns.flatMap(column => column.issues).map(i => i.identifier))
    .not.toContain("ENG-2");
  expect(await failure(issue.read())).toContain("NOT_FOUND");
  expect(await failure(issue.update({ title: "Too late" }, eng2.revision))).toContain("NOT_FOUND");
  expect(await failure(tab.board.openIssue(eng2.id))).toContain("NOT_FOUND");
  // The pending edit cannot apply: nothing is written, and it ends failed (refused before sending).
  const commits = fake.commits.length;
  expect(await failure(tab.own.approveAction(action!.id))).toContain("no longer in this project");
  expect(fake.commits.length).toBe(commits);
  expect((await tab.own.listActions({ filter: "all" })).entries.find(a => a.id === action!.id))
    .toMatchObject({ state: "failed", lastAttempt: { outcome: "notApplied", code: "NOT_FOUND" } });
  expect(await pending(tab.own)).toEqual([]);

  // The page still names the issue (the UI shows it is gone), and closing it returns to the board.
  expect((await pageOf(tab.session)).state.board?.issueId).toBe(eng2.id);
  page = await tab.session.dispatch({ type: "closeIssue" }, page.seq);
  expect(page.state.board).toEqual({ workspaceId: tab.workspaceId, boardRef: ENG_BOARD, issueId: null });
});
