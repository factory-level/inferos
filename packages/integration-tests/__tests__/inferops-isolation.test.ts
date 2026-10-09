// Tenant, workspace and project isolation of the InferOps gatekeeper, end to end: the real Workshop
// and the real gatekeeper Worker, driven over the Workshop's RPC API, against a fake InferLab and
// InferOps (src/inferops-fake.ts) behind the network interceptor.
//
// Every account here is a person's own: the gatekeeper runs with `INFERLAB_AUTH_ORIGIN` set, so
// accounts are not auto-provisioned and each one comes from the real connect flow -- the Workshop's
// `connectAccount`, the gatekeeper's `/<attempt>/<nonce>` leg redirecting to InferLab's
// `/authorize`, the `/oauth` callback exchanging the code (PKCE checked by the fake) and listing the
// person's workspaces, and the handoff ticket redeemed with `completeConnectHandoff`. The
// deployment-wide stopgap token (`INFEROPS_API_TOKEN`) is never configured, so no case rests on it.
//
// People (fake InferLab users), each fresh per test so tests do not share sessions:
//   A-type: member of `acme.operations` only (projects ENG and WEB).
//   B-type: member of `acme.knowledge` only (project OPS).
//   C-type: member of both.
//
// Tests run in order and share one harness. The last one inspects everything the Workers logged
// during the file, so it has to stay last.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi, Overseer } from "@gadgets/workshop-shared/api";
import type {
  InferOpsDispatchSession, InferOpsProjectSession, InferOpsTableSession, InferOpsWikiSession,
} from "../../../custom-gatekeepers/gatekeeper-inferops/src/types.js";
import { startHarness, type Harness } from "../src/harness.js";
import {
  DOCUMENTS, HANDBOOK_EMBED, INFERLAB_ORIGIN, INFEROPS_ORIGIN, InferOpsFake, PROJECTS, REPOS,
  SEEDED_ISSUES, TABLES, WORKSPACES, boardUrl, secretCustodian, secretDescription, secretSectionBody,
  tableUrl, wikiUrl,
  type FakePerson, type WorkspaceSlug,
} from "../src/inferops-fake.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, logIn, MAX_OBSERVER_PROMPTS, nextUsernames,
  ObserverConfigRecorder, overFreshConnection, settled, signUp, stubFor, waitFor,
  type ConnectedAccount,
} from "../src/rpc-client.js";

const INFEROPS_GATEKEEPER_DIR =
  resolve(import.meta.dirname, "../../../custom-gatekeepers/gatekeeper-inferops");
const GATEKEEPER_WORKER = "gatekeeper-inferops";
const VENDOR = "inferops";
const BASE_URL = "http://workshop.test/gatekeeper/inferops";

const OPERATIONS = WORKSPACES.operations.id;
const KNOWLEDGE = WORKSPACES.knowledge.id;
const ENG_BOARD = boardUrl("operations", "ENG");
const OPS_BOARD = boardUrl("knowledge", "OPS");
const IN_PROGRESS = PROJECTS.ENG.states[1]!;
const DONE = PROJECTS.ENG.states[2]!;

/** The message every refused binding gets, whatever was missing. */
const unavailable = (key: string, host: string) =>
  `No InferOps project ${key} is available on ${host}.`;

const fake = new InferOpsFake();
const network = new NetworkInterceptor({ handlers: [fake.handler] });
let harness: Harness;

// Runtime logs of earlier server sessions: a harness configuration update starts a new one.
const earlierLogs: unknown[] = [];
// Every failure message a test observed through the RPC API, for the same test.
const failures: string[] = [];

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [{
      binding: "INFEROPS",
      dir: INFEROPS_GATEKEEPER_DIR,
      patch: config => {
        // Prebuilt by `build:inferops-gatekeeper`, as in local-lifecycle-verify.test.ts.
        if (process.env.WORKSHOP_INTEGRATION_PREBUILT === "1") delete config.build;
        config.vars = {
          ...config.vars,
          INFERLAB_AUTH_ORIGIN: INFERLAB_ORIGIN,
          INFEROPS_BASE_URL: INFEROPS_ORIGIN,
          BASE_URL,
          // Coding dispatch on, with web-app the only allowlisted repository.
          CODING_WORKBENCH_ENABLED: "true",
          CODING_WORKBENCH_REPOS: REPOS.webApp.id,
          // Custom tables on (off by default).
          INFEROPS_TABLES_ENABLED: "true",
        };
      },
    }],
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

// ---------------------------------------------------------------------------
// Helpers

/** The message an awaited call failed with (recorded for the leakage test), or "" on success. */
async function failure(call: PromiseLike<unknown>): Promise<string> {
  try {
    await call;
    return "";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(message);
    return message;
  }
}

/**
 * Drive one InferLab sign-in from the flow URL the Workshop returned to the handoff page's ticket:
 * the gatekeeper's redirect to `/authorize`, the person signing in there, and the callback.
 */
async function signInTicket(flowUrl: string, person: FakePerson): Promise<string> {
  const start = await harness.fetchWorker(GATEKEEPER_WORKER, flowUrl, { redirect: "manual" });
  expect(start.status).toBe(302);
  const callback = fake.authorize(start.headers.get("location")!, person);
  const done = await harness.fetchWorker(GATEKEEPER_WORKER, callback);
  const html = await done.text();
  expect(done.status, html).toBe(200);
  const literal = /var ticket = (".*?");\n/.exec(html);
  if (!literal) throw new Error("The handoff page carried no ticket");
  return JSON.parse(literal[1]!);
}

type User = {
  username: string;
  api: RpcStub<AuthenticatedApi>;
  person: FakePerson;
  account: ConnectedAccount;
};

const inferOpsAccounts = async (api: RpcStub<AuthenticatedApi>) =>
  (await listConnectedAccounts(api)).filter(a => a.vendorId === VENDOR);

/** A Workshop user who connected InferOps as a fresh InferLab person with these memberships. */
async function newUser(prefix: string, workspaces: WorkspaceSlug[]): Promise<User> {
  const [username] = nextUsernames(prefix);
  const api = await signUp(connect(harness.url), username!);
  const person = fake.addPerson(username!, workspaces);
  const { url, nonce } = await api.connectAccount(VENDOR);
  await api.completeConnectHandoff(await signInTicket(url, person), nonce);
  const account = await waitFor("the connected InferOps account", async () =>
    (await inferOpsAccounts(api)).find(a => a.description.uniqueName === person.email) ?? null);
  return { username: username!, api, person, account };
}

/** Reconnect the user's account as the same person, redeeming over a popup session. */
async function reconnect(user: User): Promise<void> {
  const { url, nonce } = await user.api.reconnectAccount(user.account.id);
  const ticket = await signInTicket(url, user.person);
  using popup = await logIn(connect(harness.url), user.username);
  await popup.completeConnectHandoff(ticket, nonce);
}

/** A fresh workspace of the user's with `url` bound, and a session on that binding. */
async function bind(user: User, url: string, ws?: RpcStub<Overseer>) {
  ws ??= await user.api.newGadget();
  const connection = await ws.newGatekeeper(user.account.id, url);
  if (!connection) throw new Error(`No connection for ${url}`);
  const session = await connection.openSession() as RpcStub<InferOpsProjectSession>;
  return { ws, connection, session };
}

/** Why binding `url` with the user's account was refused, or "" when it was not. */
async function bindRefusal(user: User, url: string): Promise<string> {
  const ws = await user.api.newGadget();
  return failure(ws.newGatekeeper(user.account.id, url).then(c => {
    if (!c) throw new Error("newGatekeeper returned null");
  }));
}

/**
 * The InferOps project-API requests made with any of the person's tokens. Their connect's own
 * `GET /workspaces` (no workspace header, InferLab's principal lane) is left out.
 */
const requestsBy = (person: FakePerson) =>
  fake.requests.filter(r => r.path !== "/workspaces" && r.token !== null &&
    fake.accessTokensOf(person).includes(r.token));

const pending = async (ws: RpcStub<Overseer>) =>
  (await ws.listActions({ filter: "pending" })).entries;

/** The stored log entry of one action, whatever its state. */
const entryOf = async (ws: RpcStub<Overseer>, id: number) =>
  (await ws.listActions({ filter: "all" })).entries.find(a => a.id === id);

/** The one action the next proposal queues. */
async function proposed(ws: RpcStub<Overseer>, propose: () => Promise<unknown>) {
  const before = new Set((await pending(ws)).map(a => a.id));
  await propose();
  const added = (await pending(ws)).filter(a => !before.has(a.id));
  expect(added).toHaveLength(1);
  return added[0]!;
}

// ---------------------------------------------------------------------------

describe("reads are scoped to the binding and recorded", () => {
  it("binds acme.operations/ENG and records the board read as an observation", async () => {
    const alice = await newUser("readera", ["operations"]);
    const { ws, session } = await bind(alice, ENG_BOARD);

    const board = await session.readBoard();
    expect(board.project.identifier).toBe("ENG");
    const issues = board.columns.flatMap(c => c.issues);
    expect(issues.map(i => i.identifier).toSorted()).toEqual(["ENG-1", "ENG-2"]);
    expect(issues.every(i => /^\d+$/.test(i.revision))).toBe(true);
    // Only card fields cross: no description, comments or the workspace's other projects.
    expect(JSON.stringify(board)).not.toContain("CONFIDENTIAL");
    expect(JSON.stringify(board)).not.toContain("WEB");

    const observations = (await ws.listActions({ filter: "observation" })).entries;
    expect(observations).toEqual([expect.objectContaining({
      type: "observation", state: "approved", resourceUrl: ENG_BOARD,
      description: expect.objectContaining({ title: "Read InferOps board ENG" }),
    })]);

    // Every request was the person's own token in the workspace the URL's slug resolved to.
    const mine = requestsBy(alice.person);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every(r => r.workspaceId === OPERATIONS && r.person === alice.username)).toBe(true);
  });

  it("attack: binding a workspace the person does not hold is refused like a missing project, before any request", async () => {
    const alice = await newUser("outsidera", ["operations"]);

    const unheld = await bindRefusal(alice, OPS_BOARD);
    const noWorkspace = await bindRefusal(alice, boardUrl("nowhere", "OPS"));
    const noProject = await bindRefusal(alice, boardUrl("operations", "NOPE"));
    expect(unheld).toContain(unavailable("OPS", "acme.knowledge"));
    expect(noWorkspace).toContain(unavailable("OPS", "acme.nowhere"));
    expect(noProject).toContain(unavailable("NOPE", "acme.operations"));
    // One message shape for all three: the refusal cannot tell them apart.
    const shape = (message: string, key: string, host: string) =>
      message.replace(unavailable(key, host), "<refused>");
    expect(new Set([
      shape(unheld, "OPS", "acme.knowledge"), shape(noWorkspace, "OPS", "acme.nowhere"),
      shape(noProject, "NOPE", "acme.operations"),
    ]).size).toBe(1);

    // Nothing reached InferOps for `knowledge` with this person's token; only the missing
    // project's lookup was made, in their own workspace.
    expect(requestsBy(alice.person).filter(r => r.workspaceId === KNOWLEDGE)).toEqual([]);
    expect(fake.requests.filter(r => r.workspaceId === KNOWLEDGE && r.person === alice.username))
      .toEqual([]);
  });
});

describe("URI tampering", () => {
  it("attack: another workspace's project key in the person's own workspace is refused", async () => {
    const alice = await newUser("keyswapa", ["operations"]);
    expect(await bindRefusal(alice, boardUrl("operations", "OPS")))
      .toContain(unavailable("OPS", "acme.operations"));
  });

  it("attack: a changed tenant label grants nothing beyond the person's own workspaces", async () => {
    // ADR 0005: the tenant label is syntax only (InferLab's identity has no tenant slug to compare
    // with), so `globex.operations` still means *this person's* `operations`, never someone else's.
    const alice = await newUser("tenanta", ["operations"]);
    const { session } = await bind(alice, boardUrl("operations", "ENG", "globex"));
    const before = requestsBy(alice.person).length;
    await session.readBoard();
    const reads = requestsBy(alice.person).slice(before);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(r => r.workspaceId === OPERATIONS)).toBe(true);

    expect(await bindRefusal(alice, boardUrl("knowledge", "OPS", "globex")))
      .toContain(unavailable("OPS", "globex.knowledge"));
  });

  it.each([
    ["three labels", "inferops://acme.operations.knowledge/project/board/ENG"],
    ["one label", "inferops://operations/project/board/ENG"],
    ["uppercase tenant", "inferops://ACME.operations/project/board/ENG"],
    ["a port", "inferops://acme.operations:8080/project/board/ENG"],
    ["user info", "inferops://alice@acme.operations/project/board/ENG"],
    ["a lowercase key", "inferops://acme.operations/project/board/eng"],
  ])("attack: a malformed authority (%s) is refused without a request", async (_what, url) => {
    const alice = await newUser("malformeda", ["operations"]);
    expect(await bindRefusal(alice, url)).toContain("Not an InferOps project board URL");
    expect(requestsBy(alice.person)).toEqual([]);
  });

  it("attack: the InferOps API host in the authority is not an address, only two unheld labels", async () => {
    // `inferops.test` parses as tenant `inferops`, workspace `test`: no such membership, so it is
    // refused like any unheld workspace, and no request goes anywhere.
    const alice = await newUser("hosta", ["operations"]);
    expect(await bindRefusal(alice, "inferops://inferops.test/project/board/ENG"))
      .toContain(unavailable("ENG", "inferops.test"));
    expect(requestsBy(alice.person)).toEqual([]);
  });

  it("attack: a session bound to ENG cannot open an issue of another project, in or out of its workspace", async () => {
    const carol = await newUser("scopec", ["operations", "knowledge"]);
    const { session } = await bind(carol, ENG_BOARD);
    // WEB-1 is in the same workspace, so InferOps itself would return it; OPS-1 is in a workspace
    // the person also holds, but not the binding's. Both read exactly like an unknown issue.
    for (const issue of ["WEB-1", "OPS-1"]) {
      expect(await failure(session.openIssue(fake.issue(issue).id)))
        .toContain("NOT_FOUND: No such issue in this project.");
    }
    expect(await failure(session.openIssue("00000000-0000-4000-8000-000000000000")))
      .toContain("NOT_FOUND: No such issue in this project.");
    expect(await failure(session.openIssue("../../project/projects")))
      .toContain("NOT_FOUND: No such issue in this project.");
    // The binding's workspace is fixed in its props: nothing was asked of `knowledge`.
    expect(requestsBy(carol.person).filter(r => r.workspaceId === KNOWLEDGE)).toEqual([]);
  });
});

describe("a second person", () => {
  it("attack: a collaborator without the project is refused at open; one with it is verified with their own account", async () => {
    const alice = await newUser("ownera", ["operations"]);
    const { ws, connection } = await bind(alice, ENG_BOARD);
    const session = await connection.openSession() as RpcStub<InferOpsProjectSession>;
    await session.readBoard();
    const { id: gadgetId } = await ws.getMetadata();

    // Bob holds only `knowledge`: his own account is asked, and refused before any request.
    const bob = await newUser("collabb", ["knowledge"]);
    expect(await ws.addCollaborator(bob.username, "build")).toBeTruthy();
    const bobAsked = new ObserverConfigRecorder().alwaysChoose(bob.account.id, MAX_OBSERVER_PROMPTS);
    using bobCallback = stubFor(bobAsked);
    expect(await failure(bob.api.openGadget(gadgetId, undefined, bobCallback)))
      .toMatch(/could not confirm/i);
    expect(bobAsked.callCount).toBeGreaterThan(0);
    expect(requestsBy(bob.person).filter(r => r.workspaceId === OPERATIONS)).toEqual([]);

    // Carol holds `operations` too: admitted, after InferOps answered with *her* token.
    const carol = await newUser("collabc", ["operations", "knowledge"]);
    expect(await ws.addCollaborator(carol.username, "build")).toBeTruthy();
    const carolAsked = new ObserverConfigRecorder()
      .alwaysChoose(carol.account.id, MAX_OBSERVER_PROMPTS);
    using carolCallback = stubFor(carolAsked);
    using carolWs = await carol.api.openGadget(gadgetId, undefined, carolCallback);
    expect(requestsBy(carol.person).some(r =>
      r.workspaceId === OPERATIONS && r.path === "/project/projects")).toBe(true);

    // What Carol can reach through the shared binding is board data, never Alice's credential.
    using shared = await carolWs.getGatekeeperById(await connection.getId());
    using carolSession = await shared.openSession() as RpcStub<InferOpsProjectSession>;
    const seen = JSON.stringify([await carolSession.readBoard(), await carolWs.listActions()]);
    for (const token of fake.issuedTokens()) expect(seen).not.toContain(token);
  });

  it("a second person's own account resolves only their own workspaces", async () => {
    const bob = await newUser("ownb", ["knowledge"]);
    const { session } = await bind(bob, OPS_BOARD);
    expect((await session.readBoard()).project.identifier).toBe("OPS");
    expect(await bindRefusal(bob, ENG_BOARD)).toContain(unavailable("ENG", "acme.operations"));
    expect(requestsBy(bob.person).every(r => r.workspaceId === KNOWLEDGE)).toBe(true);
  });
});

describe("writes wait for approval and apply once", () => {
  it("queues a transition without writing, and applies exactly one write under an idempotency key", async () => {
    const alice = await newUser("movera", ["operations"]);
    const { ws, session } = await bind(alice, ENG_BOARD);
    const issue = await (await session.openIssue(fake.issue("ENG-2").id)).read();
    const writesBefore = fake.writeRequests().length;

    const action = await proposed(ws, async () =>
      (await session.openIssue(issue.id)).transition(IN_PROGRESS.id, issue.revision));
    expect(action.description.title).toBe(`Move ENG-2 to ${IN_PROGRESS.name}`);
    // The board simulates the move, but InferOps has not been written to.
    expect(fake.writeRequests().length).toBe(writesBefore);
    expect(fake.issue("ENG-2").stateId).toBe(PROJECTS.ENG.states[0]!.id);

    await ws.approveAction(action.id);
    const writes = fake.writeRequests().slice(writesBefore);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      method: "POST", path: `/project/issues/${issue.id}/transition`, person: alice.username,
      workspaceId: OPERATIONS, idempotencyKey: expect.stringMatching(/.+:\d+$/),
    });
    expect(fake.commits.filter(c => c.idempotencyKey === writes[0]!.idempotencyKey)).toHaveLength(1);
    expect(fake.issue("ENG-2")).toMatchObject({
      stateId: IN_PROGRESS.id, revision: String(Number(issue.revision) + 1),
    });

    // Approving again is refused by the Workshop and writes nothing.
    expect(await failure(ws.approveAction(action.id))).toContain("not pending");
    expect(fake.writeRequests().length).toBe(writesBefore + 1);
  });

  it("failure: a stale expected revision surfaces STALE_REVISION and writes nothing", async () => {
    const alice = await newUser("stalea", ["operations"]);
    const { ws, session } = await bind(alice, ENG_BOARD);
    const issue = await (await session.openIssue(fake.issue("ENG-1").id)).read();

    // At proposal: refused at once, nothing queued.
    const old = String(Number(issue.revision) - 1);
    expect(await failure((await session.openIssue(issue.id)).transition(DONE.id, old)))
      .toContain("STALE_REVISION");
    expect(await pending(ws)).toEqual([]);

    // At apply: someone edits the issue in InferOps after the update was proposed.
    const action = await proposed(ws, async () =>
      (await session.openIssue(issue.id)).update({ title: "Renamed while stale" }, issue.revision));
    fake.touch("ENG-1");
    const commits = fake.commits.length;
    expect(await failure(ws.approveAction(action.id)))
      .toContain("the issue changed in InferOps after this update was proposed");
    expect(fake.commits.length).toBe(commits);
    expect(fake.issue("ENG-1").title).not.toBe("Renamed while stale");
    // InferOps refused the first attempt itself, so it is known not applied, for good.
    expect(await entryOf(ws, action.id)).toMatchObject({
      state: "failed", lastAttempt: { outcome: "notApplied", code: "STALE_REVISION" },
    });
    expect(await pending(ws)).toEqual([]);
    expect(await failure(ws.approveAction(action.id))).not.toBe("");
    expect(fake.commits.length).toBe(commits);
  });

  it("failure: a create whose response is lost after commit is retried under the same key into one issue", async () => {
    const alice = await newUser("creatora", ["operations"]);
    const { ws, session } = await bind(alice, ENG_BOARD);
    const before = fake.issuesOf("ENG").length;

    const action = await proposed(ws, () => session.createIssue({ title: "Created once" }));
    expect(fake.issuesOf("ENG").length).toBe(before);

    fake.loseNextWriteResponse = true;
    expect(await failure(ws.approveAction(action.id))).toContain("may or may not have been applied: InferOps did not confirm the outcome (UNAVAILABLE)");
    // InferOps committed it, but the Workshop never heard back, so the action is still pending.
    expect(fake.issuesOf("ENG").length).toBe(before + 1);
    expect((await pending(ws)).map(a => a.id)).toEqual([action.id]);

    const replays = fake.replays.length;
    await ws.approveAction(action.id);
    expect(fake.replays.length).toBe(replays + 1);
    expect(fake.issuesOf("ENG").filter(i => i.title === "Created once")).toHaveLength(1);
    const creates = fake.writeRequests().filter(r => r.person === alice.username);
    expect(creates).toHaveLength(2);
    expect(creates[0]!.idempotencyKey).toBe(creates[1]!.idempotencyKey);
    expect(fake.commits.filter(c => c.idempotencyKey === creates[0]!.idempotencyKey))
      .toHaveLength(1);
  });

  it("applies an approved update once, and a lost update response is replayed, not reapplied", async () => {
    const alice = await newUser("updatera", ["operations"]);
    const { ws, session } = await bind(alice, ENG_BOARD);
    const issue = await (await session.openIssue(fake.issue("ENG-1").id)).read();

    const action = await proposed(ws, async () =>
      (await session.openIssue(issue.id)).update({ priority: "urgent" }, issue.revision));
    fake.loseNextWriteResponse = true;
    expect(await failure(ws.approveAction(action.id))).toContain("may or may not have been applied: InferOps did not confirm the outcome (UNAVAILABLE)");
    expect(await entryOf(ws, action.id)).toMatchObject({ state: "pending", lastAttempt: { outcome: "unknown" } });
    await ws.approveAction(action.id);

    expect(fake.issue("ENG-1")).toMatchObject({
      priority: "urgent", revision: String(Number(issue.revision) + 1),
    });
    const updates = fake.writeRequests().filter(r => r.person === alice.username);
    expect(updates.map(r => r.method)).toEqual(["PATCH", "PATCH"]);
    expect(new Set(updates.map(r => r.idempotencyKey)).size).toBe(1);
    expect(fake.commits.filter(c => c.idempotencyKey === updates[0]!.idempotencyKey))
      .toHaveLength(1);
  });
});

describe("a revoked session", () => {
  it("failure: a session revoked at InferLab fails reads and applies as UNAUTHORIZED and writes nothing; reconnecting restores it", async () => {
    const alice = await newUser("revokeda", ["operations"]);
    const { ws, session } = await bind(alice, ENG_BOARD);
    const issue = await (await session.openIssue(fake.issue("ENG-2").id)).read();
    const action = await proposed(ws, async () =>
      (await session.openIssue(issue.id)).update({ title: "After the reconnect" }, issue.revision));

    fake.revokeSessions(alice.person);
    expect(await failure(session.readBoard())).toContain("UNAUTHORIZED");
    expect(await failure(ws.approveAction(action.id)))
      .toContain("does not permit it for this connection");
    expect(fake.writeRequests().filter(r => r.person === alice.username ||
      fake.accessTokensOf(alice.person).includes(r.token ?? ""))).toEqual([]);
    await waitFor("the account to be marked expired", async () =>
      (await inferOpsAccounts(alice.api)).some(a => a.id === alice.account.id &&
        !a.credentialsValid) || null);

    await reconnect(alice);
    await waitFor("the account to be valid again", async () =>
      (await inferOpsAccounts(alice.api)).some(a => a.id === alice.account.id &&
        a.credentialsValid) || null);
    expect((await session.readBoard()).project.identifier).toBe("ENG");
    await ws.approveAction(action.id);
    expect(fake.issue("ENG-2").title).toBe("After the reconnect");
    // The old session was signed out when the new one went live.
    expect(fake.logouts.length).toBeGreaterThan(0);
  });
});

describe("InferOps unavailable", () => {
  it("failure: a provider 5xx surfaces UNAVAILABLE, leaves no partial state, and a retry succeeds", async () => {
    const alice = await newUser("outagea", ["operations"]);
    const { ws, session } = await bind(alice, ENG_BOARD);

    fake.failNextRequests = 1;
    expect(await failure(session.readBoard())).toContain("UNAVAILABLE");
    expect((await session.readBoard()).project.identifier).toBe("ENG");

    const issue = await (await session.openIssue(fake.issue("ENG-1").id)).read();
    const action = await proposed(ws, async () =>
      (await session.openIssue(issue.id)).transition(DONE.id, issue.revision));
    const commits = fake.commits.length;
    fake.failNextWrites = 1;
    // A 5xx proves nothing about the write, so it may have applied; it is replayed under its key.
    expect(await failure(ws.approveAction(action.id))).toContain("may or may not have been applied: InferOps did not confirm the outcome (UNAVAILABLE)");
    expect(fake.commits.length).toBe(commits);
    expect(fake.issue("ENG-1").revision).toBe(issue.revision);
    expect((await pending(ws)).map(a => a.id)).toEqual([action.id]);

    await ws.approveAction(action.id);
    expect(fake.commits.length).toBe(commits + 1);
    expect(fake.issue("ENG-1").stateId).toBe(DONE.id);
  });
});

describe("account and scope changes", () => {
  it("attack: after a reconnect with fewer workspaces, a board of the dropped workspace is refused", async () => {
    const carol = await newUser("narrowc", ["operations", "knowledge"]);
    const ops = await bind(carol, OPS_BOARD);
    const eng = await bind(carol, ENG_BOARD);
    await ops.session.readBoard();
    await eng.session.readBoard();

    // InferOps removes her from `knowledge`. Until she reconnects, InferOps itself refuses it.
    fake.setWorkspaces(carol.person, ["operations"]);
    expect(await failure(ops.session.readBoard())).toContain("FORBIDDEN");

    // After the reconnect her stored memberships no longer include it: refused before a request.
    await reconnect(carol);
    const before = fake.requests.length;
    expect(await failure(ops.session.readBoard())).toContain("not a member");
    expect(await bindRefusal(carol, OPS_BOARD)).toContain(unavailable("OPS", "acme.knowledge"));
    expect(fake.requests.slice(before).filter(r => r.workspaceId === KNOWLEDGE)).toEqual([]);
    expect((await eng.session.readBoard()).project.identifier).toBe("ENG");
  });

  it("attack: after a disconnect, the account's bindings stop working and its session is signed out", async () => {
    const alice = await newUser("disconnecta", ["operations"]);
    const { session } = await bind(alice, ENG_BOARD);
    await session.readBoard();
    const live = fake.issuedTokens();

    await alice.api.disconnectAccount(alice.account.id);
    expect(fake.logouts.some(token => live.includes(token))).toBe(true);
    const before = fake.requests.length;
    expect(await failure(session.readBoard())).not.toBe("");
    expect(fake.requests.slice(before)).toEqual([]);
  });
});

/** Reload the gatekeeper with a deployment var set, keeping its storage and the fake's data. */
async function setVar(
  name: "INFEROPS_ENABLED" | "CODING_WORKBENCH_ENABLED" | "INFEROPS_TABLES_ENABLED", enabled: boolean,
): Promise<void> {
  earlierLogs.push(...harness.server.getLogs());
  await harness.server.update(options => ({
    ...options,
    workers: options.workers.map(worker => {
      if (!("config" in worker)) throw new Error("Expected inline harness config");
      if (worker.config.name !== GATEKEEPER_WORKER) return worker;
      return { ...worker, config: { ...worker.config,
        vars: { ...worker.config.vars, [name]: String(enabled) } } };
    }),
  }));
  harness.url = (await harness.server.listen()).url;
  await settled(harness.url);
}

const setEnabled = (enabled: boolean) => setVar("INFEROPS_ENABLED", enabled);

const ENG_DISPATCH = `inferops://acme.operations/project/dispatch/ENG`;

describe("coding dispatch", () => {
  /** An ENG issue earlier tests left open and never dispatched. */
  const openIssue = () => {
    const found = fake.issuesOf("ENG").find(i => i.stateId !== DONE.id && fake.runsOf(i.identifier).length === 0);
    if (!found) throw new Error("No open ENG issue left");
    return found;
  };

  /** A dispatch binding of the user's, and a session on it. */
  async function bindDispatch(user: User, url = ENG_DISPATCH) {
    const ws = await user.api.newGadget();
    const connection = await ws.newGatekeeper(user.account.id, url);
    if (!connection) throw new Error(`No connection for ${url}`);
    const session = await connection.openSession() as RpcStub<InferOpsDispatchSession>;
    return { ws, connection, session };
  }

  it("dispatches with the person's own delegate permission, once, only on approval", async () => {
    const dana = await newUser("dispatcha", ["operations"]);
    fake.grantDelegate(dana.person);
    const { ws, session } = await bindDispatch(dana);
    const repos = await session.listRepos();
    expect(repos.map(r => [r.slug, r.allowed])).toEqual([["web-app", true], ["infra", false]]);
    const issue = openIssue();

    const writesBefore = fake.writeRequests().length;
    const action = await proposed(ws, () =>
      session.dispatch(issue.identifier, { repoId: REPOS.webApp.id }, issue.revision));
    expect(fake.writeRequests().length).toBe(writesBefore);
    expect((await session.listRuns()).map(r => r.pending)).toEqual(["dispatch"]);

    await ws.approveAction(action.id);
    const [run] = fake.runsOf(issue.identifier);
    expect(run).toMatchObject({ status: "queued", repoId: REPOS.webApp.id, requestedBy: dana.person.userId });
    const posts = fake.writeRequests().slice(writesBefore);
    expect(posts.map(r => r.path)).toEqual([`/project/issues/${issue.id}/dispatch`]);
    expect(posts[0]!.idempotencyKey).toMatch(/^[0-9a-f-]{36}:\d+$/);
    expect(fake.accessTokensOf(dana.person)).toContain(posts[0]!.token);
    expect(await failure(ws.approveAction(action.id))).toContain("not pending");
    expect(fake.runsOf(issue.identifier)).toHaveLength(1);
    expect((await session.listRuns()).map(r => [r.id, r.status])).toEqual([[run!.id, "queued"]]);

    // A second dispatch of the issue is refused while the run is active, without a write.
    expect(await failure(session.dispatch(issue.identifier, { repoId: REPOS.webApp.id }, fake.issue(issue.identifier).revision)))
      .toContain("RUN_ACTIVE");
    // Cancelling it is an approved action too.
    const cancel = await proposed(ws, () => session.cancel(run!.id));
    await ws.approveAction(cancel.id);
    expect(fake.runsOf(issue.identifier)[0]!.status).toBe("cancelled");
  });

  it("attack: a person without dispatch permission is refused by InferOps at apply, and nothing runs", async () => {
    const erin = await newUser("nodelega", ["operations"]);
    const { ws, session } = await bindDispatch(erin);
    const issue = openIssue();
    const action = await proposed(ws, () =>
      session.dispatch(issue.identifier, { repoId: REPOS.webApp.id }, issue.revision));

    // InferOps' refusal of a dispatch is not yet taken as proof: unknown, and never resent.
    expect(await failure(ws.approveAction(action.id))).toContain("InferOps refused it (FORBIDDEN)");
    expect(fake.runsOf(issue.identifier)).toEqual([]);
    fake.grantDelegate(erin.person);
    const before = fake.requests.length;
    expect(await failure(ws.approveAction(action.id))).toContain("InferOps refused it (FORBIDDEN)");
    expect(fake.requests.slice(before)).toEqual([]);
    expect(fake.runsOf(issue.identifier)).toEqual([]);
    expect(await entryOf(ws, action.id)).toMatchObject({ state: "pending", lastAttempt: { outcome: "unknown" } });
  });

  it("attack: a board-only binding cannot dispatch, and a repository off the allowlist is refused before any request", async () => {
    const fay = await newUser("boardonly", ["operations"]);
    fake.grantDelegate(fay.person);
    const { session: board } = await bind(fay, ENG_BOARD);
    const asDispatch = board as unknown as RpcStub<InferOpsDispatchSession>;
    expect(await failure(asDispatch.dispatch(openIssue().identifier, { repoId: REPOS.webApp.id }, "1"))).not.toBe("");

    const { session } = await bindDispatch(fay);
    const before = fake.requests.length;
    const issue = openIssue();
    expect(await failure(session.dispatch(issue.identifier, { repoId: REPOS.infra.id }, issue.revision)))
      .toContain("FORBIDDEN: Repository");
    expect(fake.requests.slice(before)).toEqual([]);
    // Another workspace's project, and a workspace the person does not hold, are refused like a missing one.
    expect(await bindRefusal(fay, "inferops://acme.knowledge/project/dispatch/OPS"))
      .toContain(unavailable("OPS", "acme.knowledge"));
    expect(await bindRefusal(fay, "inferops://acme.operations/project/dispatch/OPS"))
      .toContain(unavailable("OPS", "acme.operations"));
  });

  it("failure: a dispatch made stale before approval surfaces the revision and queues nothing", async () => {
    const gus = await newUser("stalegus", ["operations"]);
    fake.grantDelegate(gus.person);
    const { ws, session } = await bindDispatch(gus);
    const issue = openIssue();
    const action = await proposed(ws, () =>
      session.dispatch(issue.identifier, { repoId: REPOS.webApp.id }, issue.revision));
    fake.touch(issue.identifier);

    expect(await failure(ws.approveAction(action.id))).toContain("InferOps refused it (STALE_REVISION)");
    expect(fake.runsOf(issue.identifier)).toEqual([]);
  });

  it("failure: with CODING_WORKBENCH_ENABLED off, dispatch sessions and queued dispatches are refused without a request", async () => {
    const hal = await newUser("codeoff", ["operations"]);
    fake.grantDelegate(hal.person);
    const { ws, connection, session } = await bindDispatch(hal);
    const issue = openIssue();
    const action = await proposed(ws, () =>
      session.dispatch(issue.identifier, { repoId: REPOS.webApp.id }, issue.revision));
    const { id: gadgetId } = await ws.getMetadata();
    const connectionId = await connection.getId();

    await setVar("CODING_WORKBENCH_ENABLED", false);
    try {
      await overFreshConnection(() => harness.url, async () => {
        const api = await logIn(connect(harness.url), hal.username);
        const reopened = await api.openGadget(gadgetId);
        const stale = await (await reopened.getGatekeeperById(connectionId)).openSession() as
          RpcStub<InferOpsDispatchSession>;
        const before = fake.requests.length;
        expect(await failure(stale.listRuns())).toContain("DISABLED: Coding dispatch is turned off");
        expect(await failure(reopened.approveAction(action.id))).toContain("coding dispatch is turned off");
        expect(await failure(reopened.newGatekeeper(hal.account.id, ENG_DISPATCH)))
          .toContain("Coding dispatch is turned off");
        expect(fake.requests.slice(before)).toEqual([]);
        // The board stays available: the switch covers coding dispatch only.
        expect(await (await api.newGadget()).newGatekeeper(hal.account.id, ENG_BOARD)).toBeTruthy();
      });
    } finally {
      await setVar("CODING_WORKBENCH_ENABLED", true);
    }
  });
});

describe("the deployment switch", () => {
  it("failure: with INFEROPS_ENABLED off, bindings, reads and queued applies are refused without a request; on again restores them", async () => {
    await settled(harness.url);
    const alice = await newUser("switcha", ["operations"]);
    const { ws, connection, session } = await bind(alice, ENG_BOARD);
    const issue = await (await session.openIssue(fake.issue("ENG-2").id)).read();
    const action = await proposed(ws, async () =>
      (await session.openIssue(issue.id)).transition(DONE.id, issue.revision));
    const { id: gadgetId } = await ws.getMetadata();
    const connectionId = await connection.getId();

    /** Alice's workspace and a session on the binding, over a connection to the reloaded server. */
    const reopen = async () => {
      const api = await logIn(connect(harness.url), alice.username);
      const reopened = await api.openGadget(gadgetId);
      const binding = await reopened.getGatekeeperById(connectionId);
      return {
        api, ws: reopened,
        session: await binding.openSession() as RpcStub<InferOpsProjectSession>,
      };
    };

    await setEnabled(false);
    try {
      await overFreshConnection(() => harness.url, async () => {
        const off = await reopen();
        const before = fake.requests.length;
        expect(await failure(off.session.readBoard()))
          .toContain("DISABLED: InferOps is turned off for this deployment.");
        expect(await failure(off.ws.approveAction(action.id)))
          .toContain("was not applied: InferOps is turned off for this deployment");
        expect(await failure(off.ws.newGatekeeper(alice.account.id, ENG_BOARD)))
          .toContain("InferOps is turned off for this deployment.");
        expect(fake.requests.slice(before)).toEqual([]);
        expect((await pending(off.ws)).map(a => a.id)).toEqual([action.id]);
      });
    } finally {
      await setEnabled(true);
    }

    const on = await overFreshConnection(() => harness.url, async () => {
      const reopened = await reopen();
      expect((await reopened.session.readBoard()).project.identifier).toBe("ENG");
      return reopened;
    });
    // A dropped socket after the request went out leaves the approval applied; the issue state decides.
    await on.ws.approveAction(action.id).catch(async (error: unknown) => {
      if (!String(error).includes("WebSocket connection failed")) throw error;
      await settled(harness.url);
      if (fake.issue("ENG-2").stateId !== DONE.id) {
        await overFreshConnection(() => harness.url, async () => (await reopen()).ws.approveAction(action.id));
      }
    });
    expect(fake.issue("ENG-2").stateId).toBe(DONE.id);
  });
});

describe("the InferMind Wiki", () => {
  const MIND = WORKSPACES.mind.id;
  const MIND_WIKI = wikiUrl("mind");

  /** A Wiki binding of the user's, and a session on it. */
  async function bindWiki(user: User, url = MIND_WIKI) {
    const ws = await user.api.newGadget();
    const connection = await ws.newGatekeeper(user.account.id, url);
    if (!connection) throw new Error(`No connection for ${url}`);
    const session = await connection.openSession() as RpcStub<InferOpsWikiSession>;
    return { ws, connection, session };
  }

  it("reads pages with the person's own token in their InferMind workspace, as observations, and the text resolves nothing", async () => {
    const wren = await newUser("wikireader", ["operations", "mind"]);
    const { ws, session } = await bindWiki(wren);

    expect((await session.listDocuments()).map(d => d.slug).toSorted()).toEqual(["handbook", "runbook"]);
    const page = await session.readDocument("handbook");
    expect(page.sections.map(s => [s.tag, s.version])).toEqual([["purpose", 7], ["current-work", 7]]);
    expect(page.references).toEqual([HANDBOOK_EMBED]);
    const text = await session.readDocumentText("handbook");
    expect(text).toBe(`# Handbook\n\n${page.sections[0]!.body}\n\n${page.sections[1]!.body}`);
    // The ENG board stays a link: no board data, and nothing of another workspace's Wiki.
    expect(text).toContain(`[ENG board](${HANDBOOK_EMBED})`);
    for (const issue of fake.issuesOf("ENG")) expect(text).not.toContain(issue.title);
    expect(text).not.toContain(secretSectionBody("private-notes", "secret"));

    const titles = (await ws.listActions({ filter: "observation" })).entries.map(e => e.description.title);
    expect(titles).toEqual(expect.arrayContaining([
      "List InferMind Wiki pages", "Read Wiki page handbook", "Read Wiki page handbook as text",
    ]));
    const requests = requestsBy(wren.person).filter(r => r.path.startsWith("/knowledge/"));
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every(r => r.workspaceId === MIND)).toBe(true);
    // The text is InferOps' own `document.text`, asked with her token, not composed in InferOS.
    expect(requests.map(r => r.path)).toContain(`/knowledge/documents/${DOCUMENTS.handbook.id}/text`);
    expect(requestsBy(wren.person).some(r => r.path.startsWith("/project/"))).toBe(false);
  });

  it("attack: another workspace's page is never readable or editable, and other workspaces cannot be bound", async () => {
    const mallory = await newUser("wikiattack", ["operations", "mind"]);
    const { ws, session } = await bindWiki(mallory);
    const notes = DOCUMENTS["private-notes"];
    const secret = fake.section("private-notes", "secret");

    expect(await failure(session.readDocument(notes.id))).toContain("NOT_FOUND: No such page in this Wiki.");
    expect(await failure(session.readDocument("private-notes"))).toContain("NOT_FOUND: No such page in this Wiki.");
    expect(await failure(session.readDocumentText(notes.id))).toContain("NOT_FOUND");
    expect(await failure(session.updateSection(secret.id, "overwritten", secret.version))).toContain("NOT_FOUND");
    expect(await pending(ws)).toEqual([]);

    const before = requestsBy(mallory.person).length;
    expect(await bindRefusal(mallory, wikiUrl("notes"))).toContain("No InferMind Wiki is available on acme.notes.");
    expect(await bindRefusal(mallory, wikiUrl("operations")))
      .toContain("acme.operations is an InferOps workspace without InferMind, so it has no Wiki.");
    expect(requestsBy(mallory.person).length).toBe(before);
    // A tampered tenant label still means her own `mind` workspace.
    const { session: tampered } = await bindWiki(mallory, "inferops://globex.mind/knowledge/wiki");
    expect((await tampered.listDocuments()).map(d => d.id)).not.toContain(notes.id);

    expect(fake.section("private-notes", "secret")).toMatchObject({ body: secretSectionBody("private-notes", "secret") });
    expect(requestsBy(mallory.person).filter(r => r.path.startsWith("/knowledge/"))
      .every(r => r.workspaceId === MIND)).toBe(true);
    expect(fake.sectionWrites.filter(w => w.person === mallory.username)).toEqual([]);
  });

  it("applies an approved section edit once, after rechecking its version; a lost response is not written twice", async () => {
    const ed = await newUser("wikieditor", ["mind"]);
    const { ws, session } = await bindWiki(ed);
    const page = await session.readDocument("runbook");
    const steps = page.sections[0]!;

    const action = await proposed(ws, () => session.updateSection(steps.id, "Step one, then step two.", steps.version));
    expect(action.description.title).toBe("Edit Wiki section steps of Runbook");
    expect(fake.sectionWrites).toHaveLength(0);
    expect((await session.readDocument("runbook")).sections[0]).toMatchObject({
      body: "Step one, then step two.", pending: "update", version: steps.version,
    });

    fake.loseNextWriteResponse = true;
    expect(await failure(ws.approveAction(action.id))).toContain("may or may not have been applied");
    expect(fake.section("runbook", "steps")).toMatchObject({ body: "Step one, then step two.", version: steps.version + 1 });
    // Section uncertainty is reconcile-only: approving again sends nothing.
    expect(await failure(ws.approveAction(action.id))).toContain("It is not sent again from here");
    expect(await entryOf(ws, action.id)).toMatchObject({ state: "pending", lastAttempt: { outcome: "unknown" } });
    const writes = fake.sectionWrites.filter(w => w.person === ed.username);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.idempotencyKey).toMatch(/^[0-9a-f-]{36}:\d+$/);
    expect(fake.section("runbook", "steps").version).toBe(steps.version + 1);
    // Reconciled in InferOps, it is discarded here, still marked as possibly applied.
    await ws.rejectAction(action.id);
    expect(await entryOf(ws, action.id)).toMatchObject({ state: "rejected", lastAttempt: { outcome: "unknown" } });
  });

  it("failure: an edit made stale before approval is refused and writes nothing", async () => {
    const sam = await newUser("wikistale", ["mind"]);
    const { ws, session } = await bindWiki(sam);
    const purpose = (await session.readDocument("handbook")).sections[0]!;
    const action = await proposed(ws, () => session.updateSection(purpose.id, "My rewrite.", purpose.version));
    fake.editSection("handbook", "purpose", "Rewritten in InferMind meanwhile.");

    expect(await failure(ws.approveAction(action.id)))
      .toContain("the section changed in InferOps after this edit was proposed");
    expect(fake.section("handbook", "purpose").body).toBe("Rewritten in InferMind meanwhile.");
    expect(fake.sectionWrites.filter(w => w.person === sam.username)).toEqual([]);
    // Found stale before anything was sent, so it is known not applied, for good.
    expect(await entryOf(ws, action.id)).toMatchObject({
      state: "failed", lastAttempt: { outcome: "notApplied", code: "STALE_REVISION" },
    });
  });

  it("attack: a person with read-only knowledge access is refused the edit by InferOps at apply", async () => {
    const rita = await newUser("wikireadonly", ["mind"]);
    fake.setKnowledgeAccess(rita.person, "read");
    const { ws, session } = await bindWiki(rita);
    const steps = fake.section("runbook", "steps");
    const action = await proposed(ws, () => session.updateSection(steps.id, "Not allowed.", steps.version));

    expect(await failure(ws.approveAction(action.id))).toContain("InferOps refused it (FORBIDDEN)");
    expect(fake.section("runbook", "steps").body).not.toBe("Not allowed.");
    expect(fake.sectionWrites.filter(w => w.person === rita.username)).toEqual([]);

    // Without knowledge access at all, even reads are refused.
    fake.setKnowledgeAccess(rita.person, "none");
    expect(await failure(session.listDocuments())).toContain("FORBIDDEN: InferOps refused the Wiki");
  });
});

describe("custom tables", () => {
  const ASSETS = tableUrl("operations", TABLES.operations.id);

  /** A table binding of the user's, and a session on it. */
  async function bindTable(user: User, url = ASSETS) {
    const ws = await user.api.newGadget();
    const connection = await ws.newGatekeeper(user.account.id, url);
    if (!connection) throw new Error(`No connection for ${url}`);
    const session = await connection.openSession() as RpcStub<InferOpsTableSession>;
    return { ws, connection, session };
  }

  it("reads rows with the person's own token, without the personal column, as observations", async () => {
    const tess = await newUser("tablereader", ["operations"]);
    const { ws, session } = await bindTable(tess);
    const { table, records } = await session.listRecords();
    expect(table.columns.map(c => c.name)).toEqual(["serial"]);
    expect(records.map(r => r.values)).toEqual([{ serial: "Assets-1" }]);
    const row = await session.getRecord(records[0]!.id);
    const seen = JSON.stringify([table, records, row]);
    for (const trace of ["custodian", "Custodian", secretCustodian("Assets")]) expect(seen).not.toContain(trace);

    const titles = (await ws.listActions({ filter: "observation" })).entries.map(e => e.description.title);
    expect(titles).toEqual(expect.arrayContaining(["List InferOps custom table rows", "Read InferOps custom table row"]));
    const embeds = requestsBy(tess.person).filter(r => r.path.startsWith("/object/embed"));
    expect(embeds.length).toBeGreaterThan(0);
    for (const request of embeds) {
      expect(request.method).toBe("GET");
      expect(new URLSearchParams(request.path.split("?")[1]).get("ref")).toMatch(/^inferops:\/\/acme\.operations\/object\//);
    }
    expect(requestsBy(tess.person).every(r => r.method === "GET")).toBe(true);
  });

  it("attack: another workspace's table, a tenant label that is not the person's, and a row of another table are refused", async () => {
    const tom = await newUser("tableattack", ["operations"]);
    const refused = `No such InferOps custom table is available to you on`;
    // The knowledge table, named in the person's own workspace and in the workspace they lack.
    expect(await bindRefusal(tom, tableUrl("operations", TABLES.knowledge.id))).toContain(`${refused} acme.operations`);
    expect(await bindRefusal(tom, tableUrl("knowledge", TABLES.knowledge.id))).toContain(`${refused} acme.knowledge`);
    // `operations` is the person's workspace slug, but `globex` is not their tenant.
    expect(await bindRefusal(tom, tableUrl("operations", TABLES.operations.id, "globex")))
      .toContain(`${refused} globex.operations`);

    const { session } = await bindTable(tom);
    const knowledgeRow = TABLES.knowledge.id.replace(/^7a/, "7b");
    expect(await failure(session.getRecord(knowledgeRow))).toContain("NOT_FOUND");
  });

  it("attack: a gadget that read a table cannot be shared, even with a collaborator who holds the workspace", async () => {
    const tia = await newUser("tableowner", ["operations"]);
    const { ws, session } = await bindTable(tia);
    await session.listRecords();
    const { id: gadgetId } = await ws.getMetadata();

    const ted = await newUser("tablecollab", ["operations"]);
    expect(await ws.addCollaborator(ted.username, "build")).toBeTruthy();
    const asked = new ObserverConfigRecorder().alwaysChoose(ted.account.id, MAX_OBSERVER_PROMPTS);
    using callback = stubFor(asked);
    expect(await failure(ted.api.openGadget(gadgetId, undefined, callback))).toMatch(/could not confirm/i);
    expect(requestsBy(ted.person).filter(r => r.path.startsWith("/object/"))).toEqual([]);
  });

  it("failure: with INFEROPS_TABLES_ENABLED off, table sessions and bindings are refused without a request; boards stay", async () => {
    const tod = await newUser("tableoff", ["operations"]);
    const { ws, connection } = await bindTable(tod);
    const { id: gadgetId } = await ws.getMetadata();
    const connectionId = await connection.getId();

    await setVar("INFEROPS_TABLES_ENABLED", false);
    try {
      await overFreshConnection(() => harness.url, async () => {
        const api = await logIn(connect(harness.url), tod.username);
        const reopened = await api.openGadget(gadgetId);
        const stale = await (await reopened.getGatekeeperById(connectionId)).openSession() as
          RpcStub<InferOpsTableSession>;
        const before = fake.requests.length;
        expect(await failure(stale.listRecords())).toContain("DISABLED: InferOps custom tables are turned off");
        expect(await failure(reopened.newGatekeeper(tod.account.id, ASSETS))).toContain("custom tables are turned off");
        expect(fake.requests.slice(before)).toEqual([]);
        expect(await (await api.newGadget()).newGatekeeper(tod.account.id, ENG_BOARD)).toBeTruthy();
      });
    } finally {
      await setVar("INFEROPS_TABLES_ENABLED", true);
    }
  });
});

describe("leakage", () => {
  // Must stay last: it inspects what every earlier test logged and failed with.
  it("no log line or error message carries a token, a refresh token, an issue description or a section body", async () => {
    // Every Workers runtime log since the harness started, the Workshop's and the gatekeeper's.
    const printed = JSON.stringify([...earlierLogs, ...harness.server.getLogs()]);
    // The capture is live: the gatekeeper's own structured logs from the failures above are in it.
    expect(printed).toContain("gatekeeper.inferops");
    expect(printed).toContain("http.request.failed");
    expect(failures.length).toBeGreaterThan(5);

    const secrets = [
      ...fake.issuedTokens(),
      ...SEEDED_ISSUES.map(secretDescription),
      ...fake.seededSectionBodies(),
      ...Object.values(TABLES).map(t => secretCustodian(t.label)),
    ];
    for (const secret of secrets) {
      expect(printed.includes(secret), `the logs contain ${secret.slice(0, 18)}…`).toBe(false);
      for (const message of failures) expect(message).not.toContain(secret);
    }
    expect(printed).not.toMatch(/Bearer /);
  });
});
