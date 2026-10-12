// Runs scenario `operate-console-read` v1 (src/scenarios/operate-console-read.md) against a real
// Workshop and InferOps gatekeeper on loopback, and writes a credential-free report. The fixture
// follows operate-console-tools.test.ts: a builder publishes consoles offering tools-only widgets,
// and a use collaborator's page opens console A.
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { HttpAgent } from "@ag-ui/client";
import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AiChatMessage, AiToolCall, AuthenticatedApi, Overseer, PublicApi, WorkpieceId } from "@gadgets/workshop-shared/api";
import type { ConsoleWidgetEntry, OperateConsole } from "@gadgets/workshop-shared/operate-console";
import { diffFiles, type CodeContent } from "@gadgets/workshop-shared/code-change";
import { startHarness, type Harness } from "../src/harness.js";
import { INFERLAB_ORIGIN, INFEROPS_ORIGIN, InferOpsFake } from "../src/inferops-fake.js";
import { scriptedModelRouter, type ChatCompletionStep, type RoutedScriptedModel } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, nextUsernames, signUp, stubFor, waitFor, WorkpieceRecorder } from "../src/rpc-client.js";
import {
  assertLoopbackTarget, BOUNDARIES, CASE_NAMES, COUNTS_WIDGET, EXPECTED_READ, EXPECTED_STALE, FRAME, OTHER_WIDGET,
  PROMPT, readSteps, SCENARIO, SCENARIO_BOARD, scenarioVerdict, staleSteps, type ScenarioCase, type ScenarioReport,
} from "../src/scenarios/operate-console-read.js";
import { isolationOf, scenarioRevision, writeScenarioReport } from "../src/scenarios/scenario-report.js";

const REPORT_PATH = process.env.OPERATE_SCENARIO_REPORT
  ?? resolve(import.meta.dirname, `../.wrangler/tmp/scenario-reports/${SCENARIO.id}-v${SCENARIO.version}.json`);

const fake = new InferOpsFake();
const router = scriptedModelRouter();
// Model requests for a held Workers AI account wait here until the case releases them.
const held = new Map<string, Promise<void>>();
const network = new NetworkInterceptor({handlers: [async url => {
  const account = /\/accounts\/([^/]+)\/ai\//.exec(url.pathname)?.[1];
  const gate = account === undefined ? undefined : held.get(account);
  if (gate) await gate;
  return null;
}, fake.handler, router.handler]});
const cases: ScenarioCase[] = [];
// Every bearer token the fixtures mint; none may appear in the written report.
const tokens: string[] = [];
let harness: Harness;
let target: URL;
let publicApi: RpcStub<PublicApi>;
let builder: RpcStub<AuthenticatedApi>;
let space: RpcStub<Overseer>;
let spaceId: string;
let screenId: string;
let widgetSources: {counts: WorkpieceId; other: WorkpieceId; countsBlueprint: string};
let consoleA: string;
let countsFrozen: WorkpieceId;
let otherFrozen: WorkpieceId;

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    enableGadgetExecution: true,
    gatekeepers: [{binding: "INFEROPS", dir: resolve(import.meta.dirname, "../../../custom-gatekeepers/gatekeeper-inferops"),
      patch(config) {
        if (process.env.WORKSHOP_INTEGRATION_PREBUILT === "1") delete config.build;
        config.vars = {...config.vars, INFERLAB_AUTH_ORIGIN: INFERLAB_ORIGIN, INFEROPS_BASE_URL: INFEROPS_ORIGIN,
          BASE_URL: "http://workshop.test/gatekeeper/inferops"};
      }}],
    // The existing console flags, in this disposable harness only.
    patchWorkshop(config) {
      config.vars = {...config.vars, COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true", CONSOLE_TOOLS: "true"};
    },
  });
  target = assertLoopbackTarget(harness.url);
  publicApi = connect(target);
  const [builderName] = nextUsernames("consolebuilder");
  builder = await signUp(publicApi, builderName!);
  const countsBlueprint = await widgetBlueprint(COUNTS_WIDGET.label, COUNTS_WIDGET.files);
  const otherBlueprint = await widgetBlueprint(OTHER_WIDGET.label, OTHER_WIDGET.files);
  space = await builder.newGadget("app");
  spaceId = (await space.getMetadata()).id;
  widgetSources = {
    counts: await space.installBlueprint(countsBlueprint, {}, {version: 1, kind: "widget"}),
    other: await space.installBlueprint(otherBlueprint, {}, {version: 1, kind: "widget"}),
    countsBlueprint,
  };
  const screen = await space.createCanvas({title: "Shift", sections: [{id: "main", title: "Now", columns: 1,
    widgets: [{id: "board", kind: "inferops.project-board", version: 1, targetRef: SCENARIO_BOARD,
      size: "wide", params: {workflow: "software", showCompleted: false}}]}]});
  screenId = screen.id;
  const a = await publish("Floor", widgetSources.counts, countsBlueprint, COUNTS_WIDGET.label);
  const b = await publish("Elsewhere", widgetSources.other, otherBlueprint, OTHER_WIDGET.label);
  consoleA = a.id;
  countsFrozen = a.published!.content.widgets![0]!.gadgetId;
  otherFrozen = b.published!.content.widgets![0]!.gadgetId;
}, 120_000);

afterAll(async () => {
  let unmocked: string[] | undefined;
  try {
    space?.[Symbol.dispose]();
    builder?.[Symbol.dispose]();
    publicApi?.[Symbol.dispose]();
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
    fixtures: {widgets: [COUNTS_WIDGET.label, OTHER_WIDGET.label], board: SCENARIO_BOARD, prompt: PROMPT.content,
      operatorRole: "use"},
    isolation, cases, verdict: scenarioVerdict(cases, isolation),
  };
  writeScenarioReport(REPORT_PATH, report, [...tokens, ...fake.issuedTokens()]);
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

/** Publish a console with one widget on the shared screen. */
async function publish(title: string, gadgetId: WorkpieceId, blueprintId: string, label: string) {
  const widgets: ConsoleWidgetEntry[] = [{gadgetId, blueprintId, version: 1, label, state: "resettable"}];
  const created = await space.createConsole({title, views: [{id: "now", title: "Now", type: "screen", screen: screenId}],
    fullChat: "off", widgets});
  return await space.publishConsole(created.id, created.revision);
}

/** Publishes a tools-only widget blueprint with `files`, from its own authoring workspace. */
async function widgetBlueprint(title: string, files: Record<string, string>): Promise<string> {
  using authoring = await builder.newGadget("widget");
  const workpieces = new WorkpieceRecorder();
  await authoring.subscribeToWorkpieces(stubFor(workpieces));
  await workpieces.loaded;
  using source = authoring.createGadget(title, undefined, title.toUpperCase());
  const id = await source.getId();
  const head = await waitFor(`${title}'s head`, async () => {
    const summary = workpieces.summaries.get(id);
    return summary?.type === "gadget" && summary.commitId !== undefined ? summary.commitId : null;
  });
  const content = (next: Record<string, string>): CodeContent => new Map([[id, new Map(Object.entries(next))]]);
  const chatId = await authoring.newChat("Edit", null);
  await authoring.submitCodeChange(chatId, {generation: 0, revision: 0, clientId: "edit", seq: 1,
    pins: [{gadgetId: id, baseCommit: head}], change: diffFiles(content({}), content(files))});
  expect(await authoring.mergeChanges(chatId)).toEqual({outcome: "merged"});
  const blueprint = await source.createBlueprint(title, `${title} for the agent`);
  await waitFor(`the ${title} blueprint`, () => builder.getBlueprintInfo(blueprint.id));
  return blueprint.id;
}

/**
 * A fresh use collaborator of the console workspace whose model runs `script` and whose page has
 * `consoleId` open at its current published revision, with prepared selectors for one console read.
 */
async function operator(script: readonly ChatCompletionStep[], consoleId: string) {
  const stack = new DisposableStack();
  const model = router.script(script);
  const people = stack.use(connect(target));
  const [username] = nextUsernames("consolereader");
  const api = stack.use(await signUp(people, username!));
  const token = await people.login(username!,
    new Uint8Array(createHash("sha256").update(`integration-test:${username}`).digest()));
  if (!token) throw new Error("Fixture sign-in failed");
  tokens.push(token);
  await api.addModel(model.userModel.profile, model.userModel.config);
  await api.setPreferredModel(model.userModel.profile.id);
  await api.setQuickModel(null);
  await api.completeOnboarding();
  expect(await space.addCollaborator(username!, "use")).toBeTruthy();
  using _opened = await api.openGadget(spaceId);
  const session = stack.use(await api.getOperateSession());
  const workspace = stack.use(await session.getWorkspace());
  const shown = await space.getConsole(consoleId, "published") as OperateConsole;
  await session.dispatch({type: "openConsole", workspaceId: spaceId, consoleId, title: shown.title,
    source: "published", revision: shown.revision, fullChat: shown.fullChat, viewId: shown.views[0]!.id}, 0);
  // The selectors come from the authenticated HTTP preparation endpoint, as a stock client's app would get them.
  const prepared = await fetch(new URL("/api/operate/agui/prepare", target), {method: "POST",
    headers: {Authorization: `Bearer ${token}`}});
  expect(prepared.status).toBe(200);
  expect(prepared.headers.get("Cache-Control")).toBe("no-store");
  const ids = await prepared.json() as {threadId: string; runId: string};
  expect(ids.threadId).toMatch(EXPECTED_READ.preparedThread);
  expect(ids.runId).toMatch(EXPECTED_READ.preparedRun);
  const events: {type: string; [key: string]: unknown}[] = [];
  const url = new URL("/api/operate/agui/console", target).toString();
  const agent = new HttpAgent({url, threadId: ids.threadId, headers: {Authorization: `Bearer ${token}`},
    initialMessages: [PROMPT]});
  const config = model.userModel.config;
  const account = "accountId" in config ? config.accountId : undefined;
  if (!account) throw new Error("Routed model has no account id");
  return {model, workspace, ids, events, agent, token, account, url,
    run: () => agent.runAgent({runId: ids.runId}, {onEvent({event}) {events.push(event);}}),
    [Symbol.dispose]() {stack.dispose();}};
}

/** What the agent was told its tool call `id` returned, read from the request that followed it. */
function toolResult(model: RoutedScriptedModel, id: string): string {
  for (const request of model.requests) {
    const {messages} = request as {messages: {role: string; tool_call_id?: string; content: string}[]};
    const found = messages.find(message => message.role === "tool" && message.tool_call_id === id);
    if (found) return found.content;
  }
  throw new Error(`No result recorded for tool call ${id}`);
}

const recorded = (history: AiChatMessage[], id: string): AiToolCall | undefined =>
  history.flatMap(message => message.type === "message" ? message.toolCalls ?? [] : [])
    .find(toolCall => toolCall.toolCallId === id);

/**
 * One console read from a fresh operator, reduced to what must not vary between operators. The
 * caller disposes the operator it returns.
 */
async function consoleRead() {
  const op = await operator(readSteps(countsFrozen, otherFrozen), consoleA);
  await op.run();
  expect(op.events[0]?.type).toBe(EXPECTED_READ.firstEvent);
  expect(op.events.at(-1)?.type).toBe(EXPECTED_READ.lastEvent);
  expect(op.events.filter(event => event.type === "RUN_FINISHED" || event.type === "RUN_ERROR")).toHaveLength(1);

  // Only console A's widget is described, through the C6 gateway, with its authored text framed.
  const snapshot = op.agent.state.consoleRead.snapshot;
  expect(snapshot).toMatchObject({version: 1, workspaceId: spaceId, consoleId: consoleA,
    widgets: [{widgetId: countsFrozen, gateway: "callConsoleTool", untrusted: expect.stringContaining(FRAME)}]});
  expect(snapshot.widgets).toHaveLength(1);
  expect(snapshot.widgets[0].tools.map((entry: {name: string}) => entry.name)).toEqual(EXPECTED_READ.offeredTools);
  expect(JSON.stringify(snapshot)).not.toContain(OTHER_WIDGET.label);
  const activity = op.agent.messages.find(message => message.role === "activity");
  expect(activity).toMatchObject({activityType: EXPECTED_READ.activityType, content: {version: 1, boards: snapshot.boards}});
  expect(JSON.stringify(snapshot.boards)).toContain(SCENARIO_BOARD);

  // The read tool answers framed, its events correlate, and the wire matches committed history.
  for (const id of ["scenario-list", "scenario-count", "scenario-other"]) {
    expect(op.events.filter(event => event.toolCallId === id).map(event => event.type), id).toEqual(EXPECTED_READ.toolEvents);
  }
  const counted = `${FRAME}\n${JSON.stringify({widgetId: countsFrozen, tool: "count", output: EXPECTED_READ.countOutput})}`;
  expect(toolResult(op.model, "scenario-count")).toBe(counted);
  // Console B's widget is refused as not offered, before it runs, and nothing it holds is framed.
  const other = toolResult(op.model, "scenario-other");
  expect(other).toMatch(EXPECTED_READ.otherRefusal);
  expect(other).not.toContain("Untrusted widget output");
  expect(other).not.toContain('"n":9');
  const chats = await op.workspace.listChats();
  expect(chats).toHaveLength(1);
  const history = await op.workspace.getChatHistory(chats[0]!.id);
  const record = recorded(history.messages, "scenario-count")!;
  expect(record).toMatchObject({toolName: "callConsoleTool", output: counted});
  expect(op.agent.messages.find(message => message.role === "tool" && message.toolCallId === "scenario-count"))
    .toMatchObject({content: counted});
  expect(history.messages.some(m => m.type === "message" && m.message === EXPECTED_READ.reply)).toBe(true);
  const policy = (op.model.requests.at(-1) as {tools: {function: {name: string}}[]}).tools.map(entry => entry.function.name);
  expect(policy.toSorted()).toEqual(EXPECTED_READ.policyTools);
  expect(op.model.remainingSteps()).toBe(0);
  expect((await op.workspace.listActions({filter: "all"})).entries).toEqual([]);
  return {op, observed: {
    firstEvent: op.events[0]?.type, lastEvent: op.events.at(-1)?.type,
    describedWidgets: snapshot.widgets.length, offeredTools: EXPECTED_READ.offeredTools,
    activityType: EXPECTED_READ.activityType, boardsPlaced: snapshot.boards.length,
    toolEvents: EXPECTED_READ.toolEvents, countOutput: EXPECTED_READ.countOutput, framed: true,
    otherWidget: "refused, not offered", historyMatchesWire: true, policyTools: policy.toSorted(), actions: 0,
  }};
}

it("passes the report only with every case passing and a clean, checked isolation", () => {
  const passed = CASE_NAMES.map(name => ({name, outcome: "PASS" as const, observed: {}}));
  const clean = {checked: true, unmockedRequests: 0, origins: []};
  expect(scenarioVerdict(passed, clean)).toBe("PASS");
  expect(scenarioVerdict(passed, {checked: true, unmockedRequests: 1, origins: ["https://unmocked.invalid"]})).toBe("FAIL");
  expect(scenarioVerdict(passed, {checked: false, unmockedRequests: null, origins: []})).toBe("FAIL");
  expect(scenarioVerdict(passed.slice(1), clean)).toBe("FAIL");
  expect(scenarioVerdict([...passed.slice(0, 1), {...passed[1]!, outcome: "FAIL"}, ...passed.slice(2)], clean)).toBe("FAIL");
});

it("refuses a non-loopback target for the local scenario", () => record("loopback-only", async () => {
  for (const url of ["https://workshop.example", "http://10.0.0.8:8787", "http://workshop.test", "https://127.0.0.1"]) {
    expect(() => assertLoopbackTarget(new URL(url)), url).toThrow("loopback");
  }
  return {refused: 4, target: `${target.protocol}//${target.hostname}`};
}));

let first: Record<string, unknown> | undefined;
let replayResult: {status: number; modelRequestsAdded: number; historyUnchanged: boolean} | undefined;

it("discovers console A's widget only and runs its read tool, framed and correlated with history", () => record("console-read", async () => {
  const {op, observed} = await consoleRead();
  op[Symbol.dispose]();
  first = observed;
  return observed;
}));

it("repeats the read from a fresh operator with identical observable results", () => record("console-read-repeat", async () => {
  expect(first, "the first read must have passed").toBeDefined();
  const {op, observed} = await consoleRead();
  expect(observed).toEqual(first);
  // An identical resubmission of the same selectors is refused, runs no model step, and leaves history as it was.
  const before = op.model.requests.length;
  const chats = await op.workspace.listChats();
  const history = await op.workspace.getChatHistory(chats[0]!.id);
  const replay = await fetch(op.url, {method: "POST", headers: {Authorization: `Bearer ${op.token}`, "Content-Type": "application/json"},
    body: JSON.stringify({...op.ids, protocolVersion: "1.0", messages: [PROMPT], tools: [], context: [], state: {}, forwardedProps: {}})});
  replayResult = {status: replay.status, modelRequestsAdded: op.model.requests.length - before,
    historyUnchanged: JSON.stringify(await op.workspace.getChatHistory(chats[0]!.id)) === JSON.stringify(history)};
  op[Symbol.dispose]();
  return observed;
}));

it("refuses an identical retry with no new tool invocation and unchanged history", () => record("replay", async () => {
  expect(replayResult, "the repeat read must have run").toBeDefined();
  expect(replayResult).toEqual({status: EXPECTED_READ.replayStatus, modelRequestsAdded: 0, historyUnchanged: true});
  return replayResult!;
}));

it("clears the projection and activity on a republish while the model is held, then refuses the stale call", () => record("stale-republish", async () => {
  const c = await publish("Republished", widgetSources.counts, widgetSources.countsBlueprint, COUNTS_WIDGET.label);
  const widget = c.published!.content.widgets![0]!.gadgetId;
  using op = await operator(staleSteps(widget), c.id);
  const gate = Promise.withResolvers<void>();
  held.set(op.account, gate.promise);
  const run = op.run();
  try {
    await waitFor("authorized initial console projection", async () =>
      op.agent.state.consoleRead?.snapshot?.consoleId === c.id ? true : null);
    const draft = (await space.getConsole(c.id, "draft"))!;
    await space.publishConsole(draft.id, draft.revision);
    await waitFor("invalidated live catalog", async () => op.agent.state.consoleRead?.snapshot === null ? true : null);
    // The client applies the state and activity events separately; observe both boundedly.
    await waitFor("invalidated board activity", async () => {
      const current = op.agent.messages.find(message => message.role === "activity");
      return current?.content.console === null ? current : null;
    });
  } finally {
    gate.resolve();
    held.delete(op.account);
  }
  await run;
  expect(op.events.at(-1)?.type).toBe("RUN_FINISHED");
  expect(op.agent.state.consoleRead.snapshot).toBe(EXPECTED_STALE.snapshot);
  expect(op.agent.messages.find(message => message.role === "activity")).toMatchObject({content: EXPECTED_STALE.activity});
  const stale = toolResult(op.model, "scenario-stale");
  expect(stale).not.toContain('"n":3');
  expect(stale).toMatch(EXPECTED_STALE.refusal);
  const chats = await op.workspace.listChats();
  expect(recorded((await op.workspace.getChatHistory(chats[0]!.id)).messages, "scenario-stale")?.error).toBeTruthy();
  expect(op.model.remainingSteps()).toBe(0);
  return {snapshot: null, activity: EXPECTED_STALE.activity, staleCall: "refused, no output", historyError: true,
    lastEvent: op.events.at(-1)?.type};
}));
