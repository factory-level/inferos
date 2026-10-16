// Two people on the same business subject (MVP-38), end to end: Alice and Bob each hold their own
// InferOps account and their own operate session on the ENG board, and both stage a state change
// for the same issue against the same revision. Alice's explicit approval commits once, as Alice;
// Bob's, now stale, is refused by InferOps with 409 STALE_REVISION and shows as failed/notApplied,
// with no second write and Alice's state kept. Neither can answer the other's approval, and Carol,
// who holds no ENG access, can read neither person's session, subject audit or actions.
//
// The real Workshop and InferOps gatekeeper Worker against the fake InferLab and InferOps
// (src/inferops-fake.ts), with per-person accounts from the real connect flow and the stock AG-UI
// client on the approval route. The subject flags are on in this harness only.

import { afterAll, beforeAll, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { HttpAgent, type AgentSubscriber } from "@ag-ui/client";
import type { RpcStub } from "capnweb";
import {
  getOperateSessionErrorCode, OPERATE_SESSION_ERROR_CODES, type AuthenticatedApi, type OperateSession,
  type OperateSessionErrorCode, type Overseer,
} from "@gadgets/workshop-shared/api";
import type { ApprovalAnswer, OperateApprovalSnapshot } from "@gadgets/workshop-shared/operate-approval";
import type { InferOpsProjectSession } from "../../../custom-gatekeepers/gatekeeper-inferops/src/types.js";
import { startHarness, type Harness } from "../src/harness.js";
import {
  INFERLAB_ORIGIN, INFEROPS_ORIGIN, InferOpsFake, PROJECTS, boardUrl, type WorkspaceSlug,
} from "../src/inferops-fake.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, nextUsernames, signUp, waitFor, type ConnectedAccount,
} from "../src/rpc-client.js";

type Event = Parameters<NonNullable<AgentSubscriber["onEvent"]>>[0]["event"];
type Interrupt = HttpAgent["pendingInterrupts"][number];

const INFEROPS_GATEKEEPER_DIR =
  resolve(import.meta.dirname, "../../../custom-gatekeepers/gatekeeper-inferops");
const GATEKEEPER_WORKER = "gatekeeper-inferops";
const VENDOR = "inferops";
const ENG_BOARD = boardUrl("operations", "ENG");
const OPS_BOARD = boardUrl("knowledge", "OPS");

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
  token: string;
  api: RpcStub<AuthenticatedApi>;
  account: ConnectedAccount;
  session: RpcStub<OperateSession>;
  own: RpcStub<Overseer>;
  workspaceId: string;
};

/** A Workshop user with their own InferOps account (holding `workspaces`) and operate session. */
async function newOperator(prefix: string, workspaces: WorkspaceSlug[]): Promise<Operator> {
  const [username] = nextUsernames(prefix);
  const publicApi = connect(harness.url);
  const api = await signUp(publicApi, username!);
  const token = await publicApi.login(username!,
    new Uint8Array(createHash("sha256").update(`integration-test:${username}`).digest()));
  if (!token) throw new Error(`Sign-in failed for ${username}`);
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
  return { username: username!, token, api, account, session, own, workspaceId };
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

/** One person's approval conversation for one action in their own session workspace. */
function approval(operator: Operator, actionId: number) {
  const url = new URL("/api/operate/agui/approval", harness.url).href;
  const threadId = randomUUID();
  const forwardedProps = { approval: { workspaceId: operator.workspaceId, actionId } };
  let agent = new HttpAgent({ url, headers: { Authorization: `Bearer ${operator.token}` }, threadId });
  const run = async (answer?: { interrupt: Interrupt; payload: ApprovalAnswer }, reload = false) => {
    if (reload) agent = new HttpAgent({ url, headers: { Authorization: `Bearer ${operator.token}` }, threadId });
    const events: Event[] = [];
    await agent.runAgent({
      runId: randomUUID(), forwardedProps,
      ...(answer ? { resume: [{ interruptId: answer.interrupt.id, status: "resolved", payload: answer.payload }] } : {}),
    }, { onEvent({ event }) { events.push(event); } });
    if (events.at(-1)?.type !== "RUN_FINISHED") throw new Error("No terminal run");
    return { interrupt: agent.pendingInterrupts[0], snapshot: agent.state.approval as OperateApprovalSnapshot };
  };
  /** A raw resume of this conversation, sent with someone else's sign-in. */
  const answerAs = (token: string, interruptId: string) => fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      threadId, runId: randomUUID(), messages: [], forwardedProps,
      resume: [{ interruptId, status: "resolved", payload: { approved: true } }],
    }),
  });
  return { run, answerAs };
}

/** The target lanes an action log names, from each action description's "To" field. */
const lanesIn = (entries: readonly unknown[]) => entries.flatMap(entry => {
  const fields = (entry as { description?: { fields?: unknown } }).description?.fields;
  if (!Array.isArray(fields)) return [];
  return (fields as Array<{ label?: unknown; value?: unknown }>)
    .filter(f => f.label === "To" && typeof f.value === "string").map(f => f.value as string);
});

it("two people stage the same revision: one approval commits once, the stale one is refused and nothing else leaks", async () => {
  const alice = await newOperator("conflictalice", ["operations"]);
  const bob = await newOperator("conflictbob", ["operations"]);
  const carol = await newOperator("conflictcarol", ["knowledge"]);
  const aliceBoard = await connectBoard(alice, ENG_BOARD);
  const bobBoard = await connectBoard(bob, ENG_BOARD);
  await connectBoard(carol, OPS_BOARD);

  // Both show the same subject, each in their own private session.
  for (const who of [alice, bob]) {
    const page = await who.session.dispatch({ type: "openBoard", board: { workspaceId: who.workspaceId, boardRef: ENG_BOARD } }, 0);
    expect(page.state.subject).toBe(ENG_BOARD);
  }
  expect(alice.workspaceId).not.toBe(bob.workspaceId);

  // Both stage a different target for the same issue, against the same revision r.
  const issue = fake.issue("ENG-2");
  const r = issue.revision;
  const before = { ...issue };
  const [aliceTarget, bobTarget] = PROJECTS.ENG.states.filter(state => state.id !== issue.stateId);
  const commits = fake.commits.length;
  {
    using aliceIssue = await aliceBoard.openIssue(issue.id);
    await aliceIssue.transition(aliceTarget!.id, r);
  }
  {
    using bobIssue = await bobBoard.openIssue(issue.id);
    await bobIssue.transition(bobTarget!.id, r);
  }
  const alicePending = (await alice.own.listActions({ filter: "pending" })).entries;
  const bobPending = (await bob.own.listActions({ filter: "pending" })).entries;
  expect(alicePending).toHaveLength(1);
  expect(bobPending).toHaveLength(1);
  // Staging wrote nothing.
  expect(fake.commits.length).toBe(commits);
  expect(fake.issue("ENG-2")).toEqual(before);

  const aliceApproval = approval(alice, alicePending[0]!.id);
  const bobApproval = approval(bob, bobPending[0]!.id);
  const aliceOpen = await aliceApproval.run();
  const bobOpen = await bobApproval.run();
  // Each proposal is the person's own edit, bound to the same source revision.
  expect(aliceOpen.snapshot).toMatchObject({ status: "pending", proposal: { expectedRevision: r, args: { toStateId: aliceTarget!.id } } });
  expect(bobOpen.snapshot).toMatchObject({ status: "pending", proposal: { expectedRevision: r, args: { toStateId: bobTarget!.id } } });

  // Neither can answer the other's approval, and Carol can answer neither.
  for (const [conversation, interrupt, intruders] of [
    [aliceApproval, aliceOpen.interrupt!, [bob, carol]],
    [bobApproval, bobOpen.interrupt!, [alice, carol]],
  ] as const) {
    for (const intruder of intruders) {
      const refused = await conversation.answerAs(intruder.token, interrupt.id);
      expect(refused.status).toBe(403);
      expect(await refused.text()).toBe(JSON.stringify({ error: "APPROVAL_REFUSED" }));
    }
  }
  expect(fake.commits.length).toBe(commits);

  // Alice approves first: one commit, attributed to Alice, at r + 1.
  const aliceDone = await aliceApproval.run({ interrupt: aliceOpen.interrupt!, payload: { approved: true } });
  expect(aliceDone.snapshot.status).toBe("applied");
  expect(fake.commits.length).toBe(commits + 1);
  expect(fake.commits.at(-1)).toMatchObject({ operation: "transition", issueId: issue.id, person: alice.username });
  const won = fake.issue("ENG-2");
  expect(won).toMatchObject({ stateId: aliceTarget!.id, revision: String(Number(r) + 1) });

  // Bob's approval, still bound to r, is refused by InferOps: failed and not applied, with no
  // second write and Alice's state kept.
  const bobDone = await bobApproval.run({ interrupt: bobOpen.interrupt!, payload: { approved: true } });
  expect(bobDone.snapshot.status).toBe("failed");
  expect(bobDone.snapshot.failure).toMatchObject({ outcome: "notApplied", code: "STALE_REVISION" });
  const staleWrites = fake.requests.filter(request =>
    request.method === "POST" && request.path === `/project/issues/${issue.id}/transition` && request.person === bob.username);
  expect(staleWrites.length).toBeGreaterThan(0);
  expect(fake.commits.length).toBe(commits + 1);
  expect(fake.commits.filter(commit => commit.issueId === issue.id).map(commit => commit.person)).toEqual([alice.username]);
  expect(fake.issue("ENG-2")).toEqual(won);
  // Reloads read the same outcomes back, and nothing is written again.
  expect((await bobApproval.run(undefined, true)).snapshot).toMatchObject({ status: "failed", failure: { outcome: "notApplied" } });
  expect((await aliceApproval.run(undefined, true)).snapshot.status).toBe("applied");
  expect(fake.commits.length).toBe(commits + 1);

  // Private sessions: each person's actions and subject audit hold only their own edit.
  const aliceActions = (await alice.own.listActions()).entries;
  const bobActions = (await bob.own.listActions()).entries;
  expect(lanesIn(aliceActions)).toEqual([aliceTarget!.name]);
  expect(lanesIn(bobActions)).toEqual([bobTarget!.name]);
  for (const leaked of [bobTarget!.id, bobTarget!.name]) expect(JSON.stringify(aliceActions)).not.toContain(leaked);
  for (const leaked of [aliceTarget!.id, aliceTarget!.name]) expect(JSON.stringify(bobActions)).not.toContain(leaked);
  const aliceAudit = await alice.session.listSubjectAudit({ workspaceId: alice.workspaceId, boardRef: ENG_BOARD });
  const bobAudit = await bob.session.listSubjectAudit({ workspaceId: bob.workspaceId, boardRef: ENG_BOARD });
  for (const leaked of [bobTarget!.id, bobTarget!.name]) expect(JSON.stringify(aliceAudit)).not.toContain(leaked);
  for (const leaked of [aliceTarget!.id, aliceTarget!.name]) expect(JSON.stringify(bobAudit)).not.toContain(leaked);
  // Bob can't read Alice's session workspace audit, nor she his.
  await expect(bob.session.listSubjectAudit({ workspaceId: alice.workspaceId, boardRef: ENG_BOARD }))
    .rejects.toSatisfy(refusedWith(OPERATE_SESSION_ERROR_CODES.boardUnavailable));
  await expect(alice.session.listSubjectAudit({ workspaceId: bob.workspaceId, boardRef: ENG_BOARD }))
    .rejects.toSatisfy(refusedWith(OPERATE_SESSION_ERROR_CODES.boardUnavailable));

  // No one can open another person's session workspace directly (R1 L1; the same refusal as
  // operate-chat.test.ts "never anyone else's").
  for (const [who, owner] of [[carol, alice], [carol, bob], [bob, alice], [alice, bob]] as const) {
    await expect(who.api.openGadget(owner.workspaceId)).rejects.toThrow();
  }

  // Carol, with no ENG access, reads neither person's session, audit or actions.
  for (const who of [alice, bob]) {
    await expect(carol.session.listSubjectAudit({ workspaceId: who.workspaceId, boardRef: ENG_BOARD }))
      .rejects.toSatisfy(refusedWith(OPERATE_SESSION_ERROR_CODES.boardUnavailable));
  }
  const carolLog = JSON.stringify(await carol.session.listEvents(0, 200));
  const carolActions = JSON.stringify((await carol.own.listActions()).entries);
  for (const leaked of [ENG_BOARD, alice.workspaceId, bob.workspaceId, aliceTarget!.id, bobTarget!.id,
    aliceTarget!.name, bobTarget!.name, issue.id, issue.identifier]) {
    expect(carolLog).not.toContain(leaked);
    expect(carolActions).not.toContain(leaked);
  }
});
