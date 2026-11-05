// FAC-88, end to end: a person's operate page (the board and issue they selected) belongs to the
// company their own InferOps sign-in is in. They select an issue as an acme person, then sign in
// to InferOps as a person of another company instead: the page and its history are gone before
// anything reads them, a write against the old page is refused, and signing back in to acme starts
// afresh rather than restoring acme's page. Another acme operator's page is never touched.
//
// The real Workshop and InferOps gatekeeper Worker (its presentationCompany) against the fake
// InferLab and InferOps (src/inferops-fake.ts), with accounts from the real connect flow and
// SHARED_CONFIGURATION_GATEKEEPER naming InferOps, as both stages set it. All data is synthetic.

import { afterAll, beforeAll, expect, it } from "vitest";
import { resolve } from "node:path";
import type { RpcStub } from "capnweb";
import {
  getOperateSessionErrorCode, OPERATE_SESSION_ERROR_CODES, type AuthenticatedApi, type OperateSession, type Overseer,
} from "@gadgets/workshop-shared/api";
import type { InferOpsProjectSession } from "../../../custom-gatekeepers/gatekeeper-inferops/src/types.js";
import { startHarness, type Harness } from "../src/harness.js";
import { INFERLAB_ORIGIN, INFEROPS_ORIGIN, InferOpsFake, boardUrl, type FakePerson } from "../src/inferops-fake.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, listConnectedAccounts, nextUsernames, signUp, waitFor } from "../src/rpc-client.js";

const INFEROPS_GATEKEEPER_DIR = resolve(import.meta.dirname, "../../../custom-gatekeepers/gatekeeper-inferops");
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
        config.vars = { ...config.vars, INFERLAB_AUTH_ORIGIN: INFERLAB_ORIGIN, INFEROPS_BASE_URL: INFEROPS_ORIGIN,
          BASE_URL: "http://workshop.test/gatekeeper/inferops" };
      },
    }],
    patchWorkshop(config) {
      config.vars = { ...config.vars, COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true", SHARED_CONFIGURATION_GATEKEEPER: VENDOR };
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

type Operator = { api: RpcStub<AuthenticatedApi>; session: RpcStub<OperateSession>; own: RpcStub<Overseer>; workspaceId: string };

/** Connects an InferOps account signed in as `person`, and returns its account id. */
async function signInAs(api: RpcStub<AuthenticatedApi>, person: FakePerson): Promise<number> {
  const { url, nonce } = await api.connectAccount(VENDOR);
  const start = await harness.fetchWorker(GATEKEEPER_WORKER, url, { redirect: "manual" });
  const done = await harness.fetchWorker(GATEKEEPER_WORKER, fake.authorize(start.headers.get("location")!, person));
  const literal = /var ticket = (".*?");\n/.exec(await done.text());
  if (!literal) throw new Error("The handoff page carried no ticket");
  await api.completeConnectHandoff(JSON.parse(literal[1]!), nonce);
  const account = await waitFor("the connected InferOps account", async () =>
    (await listConnectedAccounts(api)).find(a => a.vendorId === VENDOR && a.description.uniqueName === person.email) ?? null);
  return account.id;
}

/** A Workshop user signed in to InferOps as `person`, with their operate session. */
async function newOperator(username: string, person: FakePerson): Promise<Operator & { accountId: number }> {
  const api = await signUp(connect(harness.url), username);
  const accountId = await signInAs(api, person);
  const session = await api.getOperateSession();
  const own: RpcStub<Overseer> = await session.getWorkspace();
  const { id: workspaceId } = await own.getMetadata();
  return { api, session, own, workspaceId, accountId };
}

/** Shows the ENG board's issue ENG-2 on the operator's page, through their own board connection. */
async function selectIssue(operator: Operator, accountId: number) {
  const connection = await operator.own.newGatekeeper(accountId, ENG_BOARD);
  if (!connection) throw new Error("Could not connect the board");
  (await connection.openSession() as RpcStub<InferOpsProjectSession>)[Symbol.dispose]();
  let page = await operator.session.dispatch({ type: "openBoard", board: { workspaceId: operator.workspaceId, boardRef: ENG_BOARD } }, 0);
  page = await operator.session.dispatch({ type: "openIssue", issueId: fake.issue("ENG-2").id }, page.seq);
  return page;
}

const types = async (session: RpcStub<OperateSession>) =>
  (await session.listEvents(0, 50)).map(record => record.event.type);

it("drops a person's page when they sign in to another company, and never restores it", async () => {
  const [aliceName, bobName] = nextUsernames("switchalice", "switchbob");
  const aliceAcme = fake.addPerson(`${aliceName}-acme`, ["operations"]);
  const aliceGlobex = fake.addPerson(`${aliceName}-globex`, ["operations"]);
  aliceGlobex.tenantId = "tenant-globex";
  const alice = await newOperator(aliceName!, aliceAcme);
  const bob = await newOperator(bobName!, fake.addPerson(bobName!, ["operations"]));

  // Both select the same issue in acme, each on their own page.
  const selected = await selectIssue(alice, alice.accountId);
  expect(selected.state.board).toMatchObject({ boardRef: ENG_BOARD, issueId: fake.issue("ENG-2").id });
  await selectIssue(bob, bob.accountId);
  const bobLog = await types(bob.session);

  // Alice signs in to InferOps as her globex person instead.
  await alice.api.disconnectAccount(alice.accountId);
  const globexAccount = await signInAs(alice.api, aliceGlobex);

  // Nothing of acme's page is listed or applied: a write at acme's seq is a conflict, and the
  // page the next write lands on is the fresh one.
  expect(await types(alice.session)).toEqual(["companyChanged"]);
  await expect(alice.session.dispatch({ type: "closeIssue" }, selected.seq)).rejects.toSatisfy(
    (caught: unknown) => getOperateSessionErrorCode(caught) === OPERATE_SESSION_ERROR_CODES.conflict);
  const inGlobex = await alice.session.dispatch({ type: "setChatOpen", open: false }, selected.seq + 1);
  expect(inGlobex.state.board).toBeNull();
  expect(inGlobex.state.focus).toBeNull();

  // Back to acme: a fresh start, not acme's page restored.
  await alice.api.disconnectAccount(globexAccount);
  await signInAs(alice.api, aliceAcme);
  expect(await types(alice.session)).toEqual(["companyChanged"]);
  const back = await alice.session.dispatch({ type: "setChatOpen", open: true }, inGlobex.seq + 1);
  expect(back.state.board).toBeNull();

  // Bob, in acme throughout, was never touched.
  expect(await types(bob.session)).toEqual(bobLog);
});
