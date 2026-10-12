// Runs scenario `operate-read-navigation` v1 (src/scenarios/operate-read-navigation.md) against a
// real Workshop and InferOps gatekeeper on loopback, and writes a credential-free report.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { HttpAgent } from "@ag-ui/client";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startHarness, type Harness } from "../src/harness.js";
import { InferOpsFake, INFERLAB_ORIGIN, INFEROPS_ORIGIN } from "../src/inferops-fake.js";
import { scriptedModelRouter, type ChatCompletionStep, type RoutedScriptedModel } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, listConnectedAccounts, nextUsernames, waitFor } from "../src/rpc-client.js";
import {
  assertLoopbackTarget, BOUNDARIES, EXPECTED_INTERRUPTION, EXPECTED_READ, EXPECTED_REFUSAL, INITIAL_STATE,
  INTERRUPTED_STEPS, PROMPT, READ_STEPS, SCENARIO, SCENARIO_BOARD, SCENARIO_WORKSPACE, scenarioVerdict, CASE_NAMES,
  type ScenarioCase, type ScenarioReport,
} from "../src/scenarios/operate-read-navigation.js";

const REPORT_PATH = process.env.OPERATE_SCENARIO_REPORT
  ?? resolve(import.meta.dirname, `../.wrangler/tmp/scenario-reports/${SCENARIO.id}-v${SCENARIO.version}.json`);

const fake = new InferOpsFake();
const router = scriptedModelRouter();
// Model requests for a held Workers AI account wait here until the case releases them. Agent steps
// (those offering tools) are counted on arrival, before the scripted model records them.
const held = new Map<string, {gate: Promise<void>; agentRequests: number}>();
const network = new NetworkInterceptor({handlers: [async (url, _method, _headers, request) => {
  const account = /\/accounts\/([^/]+)\/ai\//.exec(url.pathname)?.[1];
  const hold = account === undefined ? undefined : held.get(account);
  if (!hold) return null;
  const body = await request.clone().json() as {tools?: unknown[]};
  if (body.tools?.length) ++hold.agentRequests;
  await hold.gate;
  return null;
}, fake.handler, router.handler]});
const cases: ScenarioCase[] = [];
// Every bearer token the fixtures mint; none may appear in the written report.
const tokens: string[] = [];
let harness: Harness;
let target: URL;

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [{binding: "INFEROPS", dir: resolve(import.meta.dirname, "../../../custom-gatekeepers/gatekeeper-inferops"),
      patch(config) {
        if (process.env.WORKSHOP_INTEGRATION_PREBUILT === "1") delete config.build;
        config.vars = {...config.vars, INFERLAB_AUTH_ORIGIN: INFERLAB_ORIGIN, INFEROPS_BASE_URL: INFEROPS_ORIGIN,
          BASE_URL: "http://workshop.test/gatekeeper/inferops"};
      }}],
  });
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

function revision(): ScenarioReport["revision"] {
  const git = (...args: string[]) => execFileSync("git", args, {cwd: import.meta.dirname, encoding: "utf8"}).trim();
  try { return {commit: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain").length > 0}; }
  catch { return {commit: process.env.GITHUB_SHA ?? "unknown", dirty: null}; }
}

/** `unmocked` is undefined when the harness did not shut down cleanly enough to check isolation. */
function writeReport(unmocked: string[] | undefined) {
  // Only the count and origins: a request's full URL could carry query data.
  const isolation = unmocked === undefined ? {checked: false, unmockedRequests: null, origins: []}
    : {checked: true, unmockedRequests: unmocked.length,
      origins: [...new Set(unmocked.map(call => new URL(call.slice(call.indexOf(" ") + 1)).origin))]};
  const verdict = scenarioVerdict(cases, isolation);
  const report: ScenarioReport = {
    scenario: SCENARIO, revision: revision(), source: "mock", liveProviderProof: false,
    target: "wrangler createTestHarness on loopback", boundaries: BOUNDARIES,
    fixtures: {board: SCENARIO_BOARD, inferopsWorkspace: SCENARIO_WORKSPACE, prompt: PROMPT.content,
      readSteps: READ_STEPS.length, interruptedSteps: INTERRUPTED_STEPS.length, initialState: INITIAL_STATE},
    isolation, cases, verdict,
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (tokens.some(token => text.includes(token))) throw new Error("The scenario report would contain a session token");
  mkdirSync(dirname(REPORT_PATH), {recursive: true});
  writeFileSync(REPORT_PATH, text);
  console.info(`Scenario ${SCENARIO.id} v${SCENARIO.version} (mock, not live provider proof): ${verdict} ` +
    `[${cases.map(entry => `${entry.name}=${entry.outcome}`).join(", ")}; unmocked requests ${isolation.unmockedRequests}] -> ${REPORT_PATH}`);
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

/** A fresh account, workspace and Operate session, checked against the scenario's initial state. */
async function fixture(steps: readonly ChatCompletionStep[], connected: boolean) {
  const model = router.script(steps);
  const publicApi = connect(target);
  const [username] = nextUsernames("scenario");
  const token = await publicApi.createAccount(username, username,
    new Uint8Array(createHash("sha256").update(username).digest()));
  if (!token) throw new Error("Fixture account creation failed");
  tokens.push(token);
  const api = await publicApi.authenticate(token);
  await api.addModel(model.userModel.profile, model.userModel.config);
  await api.setPreferredModel(model.userModel.profile.id);
  await api.setQuickModel(null);
  await api.completeOnboarding();
  const session = await api.getOperateSession();
  const workspace = await session.getWorkspace();
  const workspaceId = (await workspace.getMetadata()).id;
  let snapshot: {seq: number; state: {board: unknown}} | undefined;
  {
    using _subscription = await session.subscribe(update => {snapshot = update;});
    const initial = await waitFor("initial page snapshot", () => Promise.resolve(snapshot ?? null));
    expect({sessionSeq: initial.seq, events: (await session.listEvents(0, 20)).length,
      chats: (await workspace.listChats()).length, board: initial.state.board}).toEqual(INITIAL_STATE);
  }
  if (connected) {
    const identity = fake.addPerson(username, [SCENARIO_WORKSPACE]);
    const flow = await api.connectAccount("inferops");
    const start = await harness.fetchWorker("gatekeeper-inferops", flow.url, {redirect: "manual"});
    const done = await harness.fetchWorker("gatekeeper-inferops", fake.authorize(start.headers.get("location")!, identity));
    const literal = /var ticket = (".*?");\n/.exec(await done.text());
    if (!literal) throw new Error("No connect ticket");
    await api.completeConnectHandoff(JSON.parse(literal[1]), flow.nonce);
    const account = await waitFor("account", async () =>
      (await listConnectedAccounts(api)).find(entry => entry.vendorId === "inferops") ?? null);
    using connection = await workspace.newGatekeeper(account.id, SCENARIO_BOARD);
    expect(connection).not.toBeNull();
  }
  return {token, model, api, session, workspace, workspaceId,
    [Symbol.dispose]() {workspace[Symbol.dispose](); session[Symbol.dispose](); api[Symbol.dispose](); publicApi[Symbol.dispose]();}};
}

const endpoint = (path: string) => new URL(path, target).toString();
const prepare = async (token: string) => {
  const response = await fetch(endpoint("/api/operate/agui/prepare"), {method: "POST", headers: {Authorization: `Bearer ${token}`}});
  expect(response.status).toBe(200);
  return await response.json() as {threadId: string; runId: string};
};
const submit = (token: string, ids: {threadId: string; runId: string}, forwardedProps: unknown = {}) =>
  fetch(endpoint("/api/operate/agui"), {method: "POST",
    headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
    body: JSON.stringify({...ids, protocolVersion: "1.0", messages: [PROMPT], tools: [], context: [], state: {}, forwardedProps})});
const offeredTools = (model: RoutedScriptedModel) =>
  (model.requests as {tools?: {function: {name: string}}[]}[]).map(request => (request.tools ?? []).map(tool => tool.function.name));

/** One read/navigation run from a fresh fixture, reduced to what must not vary between runs. */
async function readNavigation() {
  using f = await fixture(READ_STEPS, true);
  const prepared = await prepare(f.token);
  const types: string[] = [];
  const agent = new HttpAgent({url: endpoint("/api/operate/agui"), threadId: prepared.threadId,
    headers: {Authorization: `Bearer ${f.token}`}, initialMessages: [PROMPT]});
  const navigation = {event: {type: "openBoard", board: {workspaceId: f.workspaceId, boardRef: SCENARIO_BOARD}}, expectedSeq: 0};
  await agent.runAgent({runId: prepared.runId, forwardedProps: {operate: navigation}}, {onEvent({event}) {types.push(event.type);}});

  expect(types[0]).toBe(EXPECTED_READ.firstEvent);
  expect(types.at(-1)).toBe(EXPECTED_READ.lastEvent);
  expect(types.filter(type => type === "RUN_FINISHED" || type === "RUN_ERROR")).toHaveLength(1);
  for (const type of EXPECTED_READ.requiredEvents) expect(types, type).toContain(type);
  expect(agent.state).toMatchObject({operate: {seq: EXPECTED_READ.sessionSeq,
    board: {workspaceId: f.workspaceId, boardRef: SCENARIO_BOARD}}});
  expect(agent.messages.some(m => m.role === "tool" && m.toolCallId === EXPECTED_READ.toolCallId)).toBe(true);
  expect(agent.messages.some(m => m.role === "assistant" && m.content === EXPECTED_READ.reply)).toBe(true);

  const log = await f.session.listEvents(0, 20);
  expect(log).toHaveLength(1);
  expect(log[0]).toMatchObject({seq: EXPECTED_READ.sessionSeq, actor: "person", event: navigation.event});
  const chats = await f.workspace.listChats();
  expect(chats).toHaveLength(1);
  const history = (await f.workspace.getChatHistory(chats[0].id)).messages.flatMap(m => m.type === "message"
    ? [{author: m.author.type, text: m.message, tools: (m.toolCalls ?? []).map(call => call.toolName)}] : []);
  expect(history.filter(m => m.author === "user").map(m => m.text)).toEqual([PROMPT.content]);
  expect(history.some(m => m.text === EXPECTED_READ.reply)).toBe(true);
  expect(history.some(m => m.tools.includes("operatePage"))).toBe(true);
  expect(offeredTools(f.model).every(tools => tools.join() === EXPECTED_READ.offeredTools.join())).toBe(true);
  expect(f.model.remainingSteps()).toBe(0);

  // The client keeps its selectors; resubmitting them is refused and changes nothing.
  const replay = await submit(f.token, prepared, {operate: navigation});
  expect(replay.status).toBe(409);
  expect(await replay.json()).toEqual({error: EXPECTED_READ.replayError});
  expect(await f.session.listEvents(0, 20)).toEqual(log);
  expect(await f.workspace.listChats()).toHaveLength(1);

  return {eventTypes: types, state: {seq: agent.state.operate.seq, boardRef: agent.state.operate.board.boardRef},
    reply: EXPECTED_READ.reply, log: log.map(entry => ({seq: entry.seq, actor: entry.actor, type: entry.event.type})),
    history, offeredTools: offeredTools(f.model), modelRequests: f.model.requests.length,
    replay: {status: replay.status, error: EXPECTED_READ.replayError}};
}

it("passes the report only with every case passing and a clean, checked isolation", () => {
  const passed = CASE_NAMES.map(name => ({name, outcome: "PASS" as const, observed: {}}));
  const clean = {checked: true, unmockedRequests: 0, origins: []};
  expect(scenarioVerdict(passed, clean)).toBe("PASS");
  expect(scenarioVerdict(passed, {checked: true, unmockedRequests: 1, origins: ["https://unmocked.invalid"]})).toBe("FAIL");
  expect(scenarioVerdict(passed, {checked: false, unmockedRequests: null, origins: []})).toBe("FAIL");
  expect(scenarioVerdict(passed.slice(1), clean)).toBe("FAIL");
  expect(scenarioVerdict([...passed.slice(0, 4), {...passed[4], outcome: "FAIL"}], clean)).toBe("FAIL");
});

it("refuses a non-loopback target for the local scenario", () => record("loopback-only", async () => {
  for (const url of ["https://workshop.example", "http://10.0.0.8:8787", "http://workshop.test", "https://127.0.0.1"]) {
    expect(() => assertLoopbackTarget(new URL(url)), url).toThrow("loopback");
  }
  return {refused: 4, target: `${target.protocol}//${target.hostname}`};
}));

let first: Record<string, unknown> | undefined;

it("plays the read/navigation run through the stock client", () => record("read-navigation", async () => {
  first = await readNavigation();
  return first;
}));

it("repeats the run from a fresh fixture with identical observable results", () => record("read-navigation-repeat", async () => {
  expect(first, "the first run must have passed").toBeDefined();
  const second = await readNavigation();
  expect(second).toEqual(first);
  return second;
}));

it("refuses an unconnected board before any chat, navigation or model request", () => record("refusal", async () => {
  using f = await fixture([], false);
  const response = await submit(f.token, await prepare(f.token), {operate: {
    event: {type: "openBoard", board: {workspaceId: f.workspaceId, boardRef: SCENARIO_BOARD}}, expectedSeq: 0}});
  const body = await response.json() as {error: string};
  expect({status: response.status, error: body.error}).toEqual(EXPECTED_REFUSAL);
  expect(await f.session.listEvents(0, 20)).toEqual([]);
  expect(await f.workspace.listChats()).toEqual([]);
  expect(f.model.requests).toHaveLength(0);
  return {status: response.status, error: body.error, events: 0, chats: 0, modelRequests: 0};
}));

it("reports an interrupted stream without a terminal event or an automatic resubmit", () => record("interrupted", async () => {
  using f = await fixture(INTERRUPTED_STEPS, false);
  const config = f.model.userModel.config;
  const account = "accountId" in config ? config.accountId : undefined;
  if (!account) throw new Error("Routed model has no account id");
  const gate = Promise.withResolvers<void>();
  const hold = {gate: gate.promise, agentRequests: 0};
  held.set(account, hold);
  try {
    const prepared = await prepare(f.token);
    const clientEvents: {type: string; code?: unknown}[] = [];
    // The bytes that actually crossed the wire, kept apart from events the client makes up itself.
    let wire = "";
    let wireRead: Promise<void> | undefined;
    const agent = new HttpAgent({url: endpoint("/api/operate/agui"), threadId: prepared.threadId,
      headers: {Authorization: `Bearer ${f.token}`}, initialMessages: [PROMPT],
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        const reader = response.clone().body!.getReader();
        const decoder = new TextDecoder();
        wireRead = (async () => {
          try {
            for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) wire += decoder.decode(chunk.value, {stream: true});
          } catch { /* the abort ends the copy too */ }
        })();
        return response;
      }});
    const run = agent.runAgent({runId: prepared.runId}, {onEvent({event}) {clientEvents.push({type: event.type, code: (event as {code?: unknown}).code});}})
      .then(() => "resolved", (error: unknown) => `rejected: ${error instanceof Error ? error.name : typeof error}`);
    // The kernel turn has reached the held model call and the client has the run's start.
    await waitFor("run start and held model request", async () =>
      clientEvents.some(event => event.type === "RUN_STARTED") && hold.agentRequests === 1 ? true : null);
    agent.abortRun();
    const settled = await run;
    await wireRead;
    const wireTypes = [...wire.matchAll(/^data: (\{.*\})\n\n/gm)].map(match => (JSON.parse(match[1]) as {type: string}).type);
    expect(wireTypes[0]).toBe("RUN_STARTED");
    expect(wireTypes.filter(type => type === "RUN_FINISHED" || type === "RUN_ERROR")).toEqual(EXPECTED_INTERRUPTION.wireTerminalEvents);
    expect(clientEvents.filter(event => event.type === "RUN_FINISHED" || event.type === "RUN_ERROR"))
      .toEqual([EXPECTED_INTERRUPTION.clientError]);
    gate.resolve();
    const chats = await f.workspace.listChats();
    expect(chats).toHaveLength(1);
    // Losing the transport does not cancel the kernel turn; its outcome is recovered from history.
    const history = await waitFor("kernel turn after disconnect", async () => {
      const rows = (await f.workspace.getChatHistory(chats[0].id)).messages;
      return rows.some(m => m.type === "message" && m.message === EXPECTED_INTERRUPTION.reply) ? rows : null;
    });
    expect(history.filter(m => m.type === "message" && m.author.type === "user")).toHaveLength(1);
    const replay = await submit(f.token, prepared);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({error: EXPECTED_INTERRUPTION.replayError});
    expect(f.model.requests).toHaveLength(EXPECTED_INTERRUPTION.modelRequests);
    expect(await f.session.listEvents(0, 20)).toEqual([]);
    return {wireEvents: wireTypes, clientEvents: clientEvents.map(event => event.type), clientOutcome: settled,
      clientError: EXPECTED_INTERRUPTION.clientError, wireTerminalEvent: null,
      kernelReply: EXPECTED_INTERRUPTION.reply, modelRequests: f.model.requests.length,
      replay: {status: replay.status, error: EXPECTED_INTERRUPTION.replayError}};
  } finally {
    gate.resolve();
    held.delete(account);
  }
}));
