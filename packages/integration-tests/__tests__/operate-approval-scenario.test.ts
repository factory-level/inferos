// Runs scenario `operate-explicit-approval` v1 (src/scenarios/operate-explicit-approval.md) against a
// real Workshop and InferOps gatekeeper on loopback, and writes a credential-free report.
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { HttpAgent, type AgentSubscriber } from "@ag-ui/client";
import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { ApprovalAnswer, OperateApprovalSnapshot } from "@gadgets/workshop-shared/operate-approval";
import type { InferOpsProjectSession } from "../../../custom-gatekeepers/gatekeeper-inferops/src/types";
import { startHarness, type Harness } from "../src/harness.js";
import { InferOpsFake, INFERLAB_ORIGIN, INFEROPS_ORIGIN, PROJECTS } from "../src/inferops-fake.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, listConnectedAccounts, nextUsernames, signUp, waitFor } from "../src/rpc-client.js";
import {
  assertLoopbackTarget, BOUNDARIES, CASE_NAMES, EXPECTED_APPROVE, EXPECTED_DENY, EXPECTED_INTERRUPT,
  EXPECTED_REFUSALS, INITIAL_STATE, SCENARIO, SCENARIO_BOARD, SCENARIO_ISSUE, SCENARIO_WORKSPACE, scenarioVerdict,
  type ScenarioCase, type ScenarioReport,
} from "../src/scenarios/operate-explicit-approval.js";
import { isolationOf, scenarioRevision, writeScenarioReport } from "../src/scenarios/scenario-report.js";

type Event = Parameters<NonNullable<AgentSubscriber["onEvent"]>>[0]["event"];
type Interrupt = HttpAgent["pendingInterrupts"][number];

const REPORT_PATH = process.env.OPERATE_SCENARIO_REPORT
  ?? resolve(import.meta.dirname, `../.wrangler/tmp/scenario-reports/${SCENARIO.id}-v${SCENARIO.version}.json`);

const fake = new InferOpsFake();
const network = new NetworkInterceptor({handlers: [fake.handler]});
const cases: ScenarioCase[] = [];
// Every bearer token the fixtures mint; none may appear in the written report.
const tokens: string[] = [];
let harness: Harness;
let target: URL;

beforeAll(async () => {
  network.install();
  harness = await startHarness({gatekeepers: [{binding: "INFEROPS",
    dir: resolve(import.meta.dirname, "../../../custom-gatekeepers/gatekeeper-inferops"),
    patch(config) {
      if (process.env.WORKSHOP_INTEGRATION_PREBUILT === "1") delete config.build;
      config.vars = {...config.vars, INFERLAB_AUTH_ORIGIN: INFERLAB_ORIGIN,
        INFEROPS_BASE_URL: INFEROPS_ORIGIN, BASE_URL: "http://workshop.test/gatekeeper/inferops"};
    }}]});
  target = assertLoopbackTarget(harness.url);
});

afterAll(async () => {
  let unmocked: string[] | undefined;
  try {
    await harness?.server.close();
    unmocked = network.getUnmockedCalls();
    expect(unmocked).toEqual([]);
  } finally {
    network.uninstall();
    writeReport(unmocked);
  }
});

/** `unmocked` is undefined when the harness did not shut down cleanly enough to check isolation. */
function writeReport(unmocked: string[] | undefined) {
  const isolation = isolationOf(unmocked);
  const report: ScenarioReport = {
    scenario: SCENARIO, revision: scenarioRevision(import.meta.dirname), source: "mock", liveProviderProof: false,
    target: "wrangler createTestHarness on loopback", boundaries: BOUNDARIES,
    fixtures: {board: SCENARIO_BOARD, inferopsWorkspace: SCENARIO_WORKSPACE, issue: SCENARIO_ISSUE,
      initialState: INITIAL_STATE},
    isolation, cases, verdict: scenarioVerdict(cases, isolation),
  };
  writeScenarioReport(REPORT_PATH, report, [...tokens, ...fake.issuedTokens(), ...fake.descriptions()]);
}

/** Record a case's outcome for the report, failing the test as usual on any wrong result. */
async function record(name: string, run: () => Promise<Record<string, unknown>>) {
  try {
    cases.push({name, outcome: "PASS", observed: await run()});
  } catch (error) {
    cases.push({name, outcome: "FAIL", observed: {}, failure: error instanceof Error ? error.message : String(error)});
    throw error;
  }
}

const signIn = async (publicApi: ReturnType<typeof connect>, username: string) => {
  const token = await publicApi.login(username,
    new Uint8Array(createHash("sha256").update(`integration-test:${username}`).digest()));
  if (!token) throw new Error("Fixture sign-in failed");
  tokens.push(token);
  return token;
};

/**
 * A fresh person with InferOps connected and one pending transition of the scenario issue, proposed
 * through their real board session, checked against the scenario's initial state.
 */
async function fixture() {
  const stack = new DisposableStack();
  const publicApi = stack.use(connect(target));
  const [username] = nextUsernames("approvalscenario");
  const api = stack.use(await signUp(publicApi, username!));
  const token = await signIn(publicApi, username!);
  const person = fake.addPerson(username!, [SCENARIO_WORKSPACE]);
  const flow = await api.connectAccount("inferops");
  const start = await harness.fetchWorker("gatekeeper-inferops", flow.url, {redirect: "manual"});
  const done = await harness.fetchWorker("gatekeeper-inferops", fake.authorize(start.headers.get("location")!, person));
  const ticket = /var ticket = (".*?");\n/.exec(await done.text());
  if (!ticket) throw new Error("No handoff ticket");
  await api.completeConnectHandoff(JSON.parse(ticket[1]!), flow.nonce);
  const account = await waitFor("connected account", async () =>
    (await listConnectedAccounts(api)).find(value => value.vendorId === "inferops") ?? null);
  const workspace = stack.use(await api.newGadget());
  const workspaceId = (await workspace.getMetadata()).id;
  const connection = stack.use(await workspace.newGatekeeper(account.id, SCENARIO_BOARD));
  if (!connection) throw new Error("No board connection");
  const session = stack.use(await connection.openSession() as RpcStub<InferOpsProjectSession>);
  const before = {...fake.issue(SCENARIO_ISSUE)};
  const destination = PROJECTS.ENG.states.find(value => value.id !== before.stateId)!;
  const writesBefore = fake.commits.length;
  {
    using issueSession = await session.openIssue(before.id);
    await issueSession.transition(destination.id, before.revision);
  }
  const pending = (await workspace.listActions({filter: "pending"})).entries;
  expect({pendingActions: pending.length, providerWrites: fake.commits.length - writesBefore,
    issueMoved: fake.issue(SCENARIO_ISSUE).stateId !== before.stateId}).toEqual(INITIAL_STATE);
  const action = pending[0]!;
  const threadId = randomUUID();
  const forwardedProps = {approval: {workspaceId, actionId: action.id}};
  const url = new URL("/api/operate/agui/approval", target).href;
  let agent = new HttpAgent({url, headers: {Authorization: `Bearer ${token}`}, threadId});
  /** One run of the stock client: unanswered, with one answer, or reloaded into a fresh agent. */
  const run = async (answer?: {interrupt: Interrupt; payload: ApprovalAnswer}, reload = false) => {
    if (reload) agent = new HttpAgent({url, headers: {Authorization: `Bearer ${token}`}, threadId});
    const events: Event[] = [];
    await agent.runAgent({runId: randomUUID(), forwardedProps,
      ...(answer ? {resume: [{interruptId: answer.interrupt.id, status: "resolved", payload: answer.payload}]} : {})},
      {onEvent({event}) {events.push(event);}});
    expect(events.at(-1)?.type).toBe("RUN_FINISHED");
    return {events, interrupt: agent.pendingInterrupts[0], snapshot: agent.state.approval as OperateApprovalSnapshot};
  };
  /** One raw request to the bridge, for answers the stock client is not meant to send. */
  const raw = (body: object, auth = token) => fetch(url, {method: "POST",
    headers: {Authorization: `Bearer ${auth}`, "Content-Type": "application/json"},
    body: JSON.stringify({threadId, runId: randomUUID(), messages: [], forwardedProps, ...body})});
  const writes = () => fake.commits.length - writesBefore;
  return {username, workspace, action, before, destination, run, raw, writes, [Symbol.dispose]() {stack.dispose();}};
}

/** The first, unanswered run: the interrupt names the pending action and nothing is written. */
async function interrupted(f: Awaited<ReturnType<typeof fixture>>) {
  const first = await f.run();
  expect(first.events.map(event => event.type)).toEqual(EXPECTED_INTERRUPT.eventTypes);
  expect(first.interrupt).toMatchObject({reason: EXPECTED_INTERRUPT.reason,
    responseSchema: {required: EXPECTED_INTERRUPT.required}, metadata: {actionId: f.action.id}});
  expect(first.snapshot).toMatchObject({status: EXPECTED_INTERRUPT.status, actionId: f.action.id});
  expect(Date.parse(first.interrupt!.expiresAt!) - Date.now()).toBeGreaterThan(EXPECTED_INTERRUPT.minimumRemainingMs);
  expect(fake.issue(SCENARIO_ISSUE)).toEqual(f.before);
  expect(f.writes()).toBe(0);
  return first;
}

/** One explicit approval from a fresh fixture, reduced to what must not vary between runs. */
async function approve() {
  using f = await fixture();
  const first = await interrupted(f);
  const answer = {interrupt: first.interrupt!, payload: {approved: true}};
  const approved = await f.run(answer);
  expect(approved.snapshot.status).toBe(EXPECTED_APPROVE.status);
  expect(f.writes()).toBe(EXPECTED_APPROVE.providerWrites);
  expect(fake.commits.at(-1)?.person).toBe(f.username);
  expect(fake.issue(SCENARIO_ISSUE).stateId).toBe(f.destination.id);
  // The client keeps its answer; sending it again, and reloading, recover the receipt and write nothing.
  const retry = await f.run(answer);
  const reload = await f.run(undefined, true);
  expect([retry.snapshot.status, reload.snapshot.status]).toEqual([EXPECTED_APPROVE.retryStatus, EXPECTED_APPROVE.reloadStatus]);
  expect(f.writes()).toBe(EXPECTED_APPROVE.providerWrites);
  return {firstEvents: first.events.map(event => event.type), interrupt: {reason: first.interrupt!.reason,
      required: EXPECTED_INTERRUPT.required, namesPendingAction: true},
    statuses: [first.snapshot.status, approved.snapshot.status, retry.snapshot.status, reload.snapshot.status],
    providerWrites: f.writes(), writtenBy: "the fixture person", issueMoved: true};
}

it("passes the report only with every case passing and a clean, checked isolation", () => {
  const passed = CASE_NAMES.map(name => ({name, outcome: "PASS" as const, observed: {}}));
  const clean = {checked: true, unmockedRequests: 0, origins: []};
  expect(scenarioVerdict(passed, clean)).toBe("PASS");
  expect(scenarioVerdict(passed, {checked: true, unmockedRequests: 1, origins: ["https://unmocked.invalid"]})).toBe("FAIL");
  expect(scenarioVerdict(passed, {checked: false, unmockedRequests: null, origins: []})).toBe("FAIL");
  expect(scenarioVerdict(passed.slice(1), clean)).toBe("FAIL");
  // A case whose outcome was wrong is recorded FAIL and can never pass the report.
  expect(scenarioVerdict([...passed.slice(0, 2), {...passed[2], outcome: "FAIL"}, ...passed.slice(3)], clean)).toBe("FAIL");
});

it("refuses a non-loopback target for the local scenario", () => record("loopback-only", async () => {
  for (const url of ["https://workshop.example", "http://10.0.0.8:8787", "http://workshop.test", "https://127.0.0.1"]) {
    expect(() => assertLoopbackTarget(new URL(url)), url).toThrow("loopback");
  }
  return {refused: 4, target: `${target.protocol}//${target.hostname}`};
}));

let first: Record<string, unknown> | undefined;

it("interrupts on the pending transition, then an explicit approval writes it exactly once", () => record("approve", async () => {
  first = await approve();
  return first;
}));

it("repeats the approval from a fresh fixture with identical observable results", () => record("approve-repeat", async () => {
  expect(first, "the first approval must have passed").toBeDefined();
  const second = await approve();
  expect(second).toEqual(first);
  return second;
}));

it("an explicit denial rejects the transition with no provider write", () => record("deny", async () => {
  using f = await fixture();
  const first = await interrupted(f);
  const answer = {interrupt: first.interrupt!, payload: {approved: false}};
  const denied = await f.run(answer);
  const retry = await f.run(answer);
  const reload = await f.run(undefined, true);
  expect([denied.snapshot.status, retry.snapshot.status]).toEqual([EXPECTED_DENY.status, EXPECTED_DENY.retryStatus]);
  expect(reload.snapshot.status).toBe(EXPECTED_DENY.status);
  expect(f.writes()).toBe(EXPECTED_DENY.providerWrites);
  expect(fake.issue(SCENARIO_ISSUE)).toEqual(f.before);
  return {statuses: [first.snapshot.status, denied.snapshot.status, retry.snapshot.status, reload.snapshot.status],
    providerWrites: f.writes(), issueMoved: false};
}));

it("refuses another person's answer and a conflicting answer without any effect", () => record("refusals", async () => {
  using f = await fixture();
  const first = await interrupted(f);
  const resume = (approved: boolean) => [{interruptId: first.interrupt!.id, status: "resolved", payload: {approved}}];

  using strangerApi = connect(target);
  const [stranger] = nextUsernames("approvalstranger");
  using _stranger = await signUp(strangerApi, stranger!);
  const wrongCaller = await f.raw({resume: resume(true)}, await signIn(strangerApi, stranger!));
  const wrongBody = await wrongCaller.json() as {error: string};
  expect({status: wrongCaller.status, error: wrongBody.error}).toEqual(EXPECTED_REFUSALS.wrongCaller);
  expect(f.writes()).toBe(0);
  expect((await f.run(undefined, true)).snapshot.status).toBe("pending");

  // The approver decides; a later different answer to the same interrupt is refused and changes nothing.
  expect((await f.run({interrupt: first.interrupt!, payload: {approved: true}})).snapshot.status).toBe("applied");
  const conflicting = await f.raw({resume: resume(false)});
  expect({status: conflicting.status}).toEqual(EXPECTED_REFUSALS.conflictingAnswer);
  expect(f.writes()).toBe(1);
  expect((await f.run(undefined, true)).snapshot.status).toBe("applied");
  return {wrongCaller: {status: wrongCaller.status, error: wrongBody.error, providerWrites: 0, actionStatus: "pending"},
    conflictingAnswer: {status: conflicting.status, providerWrites: 1, actionStatus: "applied"}};
}));
