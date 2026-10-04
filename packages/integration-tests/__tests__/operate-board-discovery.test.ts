// Semantic Kanban discovery for the operate session (#61), end to end: a person's own InferOps
// connection in their own session workspace finds boards from what they describe, only among the
// projects their own token lists, and the session shows a board only through a connection that
// holds exactly that reference. Stale, unconnected and revoked targets are refused explicitly and
// never replaced by another board.
//
// The real Workshop and InferOps gatekeeper Worker against the fake InferLab and InferOps
// (src/inferops-fake.ts), with per-person accounts from the real connect flow.

import { afterAll, beforeAll, expect, it } from "vitest";
import { resolve } from "node:path";
import type { RpcStub } from "capnweb";
import {
  getOperateSessionErrorCode, OPERATE_SESSION_ERROR_CODES, type AuthenticatedApi, type Overseer,
} from "@gadgets/workshop-shared/api";
import type { InferOpsProjectSession } from "../../../custom-gatekeepers/gatekeeper-inferops/src/types.js";
import { startHarness, type Harness } from "../src/harness.js";
import {
  INFERLAB_ORIGIN, INFEROPS_ORIGIN, InferOpsFake, boardUrl, type FakePerson, type WorkspaceSlug,
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

type User = { username: string; api: RpcStub<AuthenticatedApi>; person: FakePerson; account: ConnectedAccount };

async function newUser(prefix: string, workspaces: WorkspaceSlug[]): Promise<User> {
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
  return { username: username!, api, person, account };
}

/** The person's operate session, its workspace, and a board session over their own ENG connection there. */
async function operate(user: User) {
  const session = await user.api.getOperateSession();
  const own: RpcStub<Overseer> = await session.getWorkspace();
  const { id: workspaceId } = await own.getMetadata();
  const connection = await own.newGatekeeper(user.account.id, ENG_BOARD);
  if (!connection) throw new Error("Could not connect ENG");
  const board = await connection.openSession() as RpcStub<InferOpsProjectSession>;
  return { session, own, workspaceId, board };
}

const boardUnavailable = (caught: unknown) => {
  expect(getOperateSessionErrorCode(caught)).toBe(OPERATE_SESSION_ERROR_CODES.boardUnavailable);
  return true;
};

it("finds boards from a description among the person's own projects, and opens only a connected one", async () => {
  const user = await newUser("discoverer", ["operations"]);
  const { session, own, workspaceId, board } = await operate(user);

  // Paraphrased intent finds the board by its open work, or by its name; the other project of the
  // workspace (OPS, in a workspace this person does not hold) is never named.
  const landing = await board.findBoards("who is refreshing the landing page?");
  expect(landing.map(c => c.projectKey)).toEqual(["WEB"]);
  expect(landing[0]).toMatchObject({
    tenant: "acme", workspace: "operations", boardRef: WEB_BOARD, title: "Website",
  });
  expect((await board.findBoards("the isolation suite")).map(c => c.projectKey)).toEqual(["ENG"]);
  expect(await board.findBoards("operations desk on-call roster")).toEqual([]);
  // Each search is recorded as an observation in the person's own session workspace.
  expect((await own.listActions({ filter: "observation" })).entries
    .filter(a => a.description.title === "Searched InferOps boards on acme.operations")).toHaveLength(3);

  // ENG is connected here, so it opens; WEB was found but is not connected, so it is refused and
  // the page keeps showing ENG rather than switching to anything else.
  let page = await session.dispatch({ type: "openBoard", board: { workspaceId, boardRef: ENG_BOARD } }, 0);
  expect(page.state.board).toEqual({ workspaceId, boardRef: ENG_BOARD, issueId: null });
  await expect(session.dispatch({ type: "openBoard", board: { workspaceId, boardRef: WEB_BOARD } }, page.seq))
    .rejects.toSatisfy(boardUnavailable);

  // Once the person connects WEB with their own account, the same candidate opens.
  if (!await own.newGatekeeper(user.account.id, WEB_BOARD)) throw new Error("Could not connect WEB");
  page = await session.dispatch({ type: "openBoard", board: { workspaceId, boardRef: WEB_BOARD } }, page.seq);
  expect(page.state.board?.boardRef).toBe(WEB_BOARD);
});

it("refuses a board in a workspace the person cannot read connections of, or one they never connected", async () => {
  const owner = await newUser("boardowner", ["operations"]);
  const ownerWs = await owner.api.newGadget();
  await ownerWs.newChat("Console workspace", null);
  if (!await ownerWs.newGatekeeper(owner.account.id, ENG_BOARD)) throw new Error("Could not connect ENG");
  const { id: ownerWsId } = await ownerWs.getMetadata();

  const operator = await newUser("boardoperator", ["operations"]);
  expect(await ownerWs.addCollaborator(operator.username, "use")).toBeTruthy();
  using session = await operator.api.getOperateSession();
  // The owner's connection is never a way in for a use-role operator, and a workspace they have
  // no access to at all is refused the same way.
  await expect(session.dispatch({ type: "openBoard", board: { workspaceId: ownerWsId, boardRef: ENG_BOARD } }, 0))
    .rejects.toSatisfy(boardUnavailable);
  const stranger = await newUser("boardstranger", ["operations"]);
  using strangerSession = await stranger.api.getOperateSession();
  await expect(strangerSession.dispatch({ type: "openBoard", board: { workspaceId: ownerWsId, boardRef: ENG_BOARD } }, 0))
    .rejects.toSatisfy(boardUnavailable);

  // In their own session workspace, nothing is connected yet.
  using own = await session.getWorkspace();
  const { id: ownId } = await own.getMetadata();
  await expect(session.dispatch({ type: "openBoard", board: { workspaceId: ownId, boardRef: ENG_BOARD } }, 0))
    .rejects.toSatisfy(boardUnavailable);
});

it("fails discovery explicitly once the person's access is revoked, naming nothing", async () => {
  const user = await newUser("revokedfinder", ["operations"]);
  const { board } = await operate(user);
  expect((await board.findBoards("website")).map(c => c.projectKey)).toEqual(["WEB"]);

  // Membership removed at InferOps: the listing is refused, not answered from anything cached.
  fake.setWorkspaces(user.person, ["knowledge"]);
  await expect(board.findBoards("website")).rejects.toThrow(/FORBIDDEN|UNAUTHORIZED|NOT_FOUND/);

  // A signed-out session at InferLab is refused too.
  fake.setWorkspaces(user.person, ["operations"]);
  fake.revokeSessions(user.person);
  await expect(board.findBoards("website")).rejects.toThrow(/UNAUTHORIZED/);
});

it("keeps the board and its issue through a reconnect, and Back returns to that board, not another", async () => {
  const user = await newUser("continuity", ["operations"]);
  const { session, workspaceId, board } = await operate(user);
  const [eng1] = (await board.readBoard()).columns.flatMap(column => column.issues);
  let page = await session.dispatch({ type: "openBoard", board: { workspaceId, boardRef: ENG_BOARD } }, 0);
  page = await session.dispatch({ type: "openIssue", issueId: eng1!.id }, page.seq);

  // A new connection (a reload or another tab) sees the same board and issue.
  using api = await logIn(connect(harness.url), user.username);
  using again = await api.getOperateSession();
  const events = await again.listEvents(0, 10);
  expect(events.map(record => record.event.type)).toEqual(["openBoard", "openIssue"]);
  page = await again.dispatch({ type: "closeIssue" }, page.seq);
  expect(page.state.board).toEqual({ workspaceId, boardRef: ENG_BOARD, issueId: null });
  // A stale tab's change at an old sequence number is refused rather than applied over this one.
  await expect(session.dispatch({ type: "closeBoard" }, page.seq - 1)).rejects.toSatisfy(caught => {
    expect(getOperateSessionErrorCode(caught)).toBe(OPERATE_SESSION_ERROR_CODES.conflict);
    return true;
  });
});
