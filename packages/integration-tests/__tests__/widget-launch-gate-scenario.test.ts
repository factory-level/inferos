// FAC-15's programmed scenario `widget-launch-gate` (contract: src/scenarios/widget-launch-gate.md):
// one authored React/Refine widget generated, securely published, found by meaning, embedded in the
// Wiki and in Operate, then read, filtered and acted on by the operate agent, against the real
// Workshop under wrangler's test harness. Only InferOps/InferLab (InferOpsFake) and the model are
// programmed. Writes a bounded, credential-free report.

import { afterAll, beforeAll, expect, it } from "vitest";
import { resolve } from "node:path";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi, OperateSession, Overseer, WorkpieceId } from "@gadgets/workshop-shared/api";
import type { ConsoleWidgetEntry, OperateConsoleContent } from "@gadgets/workshop-shared/operate-console";
import type { WidgetSearchAnswer } from "@gadgets/workshop-shared/gatekeeper";
import { diffFiles, type CodeContent } from "@gadgets/workshop-shared/code-change";
import { startHarness, type Harness } from "../src/harness.js";
import { boardUrl, INFERLAB_ORIGIN, INFEROPS_ORIGIN, InferOpsFake, PROJECTS, WORKSPACES, type FakePerson, type WorkspaceSlug } from "../src/inferops-fake.js";
import { SCRIPTED_MODEL_ID, scriptedModelRouter, type RoutedScriptedModel } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, listConnectedAccounts, nextUsernames, signUp, stubFor, waitFor, waitForIdleChat, WorkpieceRecorder } from "../src/rpc-client.js";
import { isolationOf, scenarioRevision, writeScenarioReport } from "../src/scenarios/scenario-report.js";
import {
  assertLoopbackTarget, BOUNDARIES, COMMAND, SCENARIO, SCENARIO_ISSUE, SCENARIO_WORKSPACE, SEARCH_INTENT, scenarioVerdict, WIDGET_PURPOSE,
  WIDGET_SOURCES, WIDGET_TITLE, type ScenarioCase, type ScenarioReport,
} from "../src/scenarios/widget-launch-gate.js";

const REPORT_PATH = process.env.WIDGET_LAUNCH_GATE_REPORT
  ?? resolve(import.meta.dirname, `../.wrangler/tmp/scenario-reports/${SCENARIO.id}-v${SCENARIO.version}.json`);
const GATEKEEPER_WORKER = "gatekeeper-inferops";
const VENDOR = "inferops";

const fake = new InferOpsFake();
const router = scriptedModelRouter();
// Only the harness's own origin uses the real network (r1 LOW 4): any other loopback call, such as
// a step mis-wired to a dev API on the host, goes to the handlers and fails isolation if unanswered.
let harnessOrigin: string | undefined;
const network = new NetworkInterceptor({ handlers: [fake.handler, router.handler], allowLoopback: false,
  allow: url => harnessOrigin !== undefined && url.origin === harnessOrigin });
const cases: ScenarioCase[] = [];
let harness: Harness;
let target: URL;

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    enableGadgetExecution: true,
    gatekeepers: [{
      binding: "INFEROPS",
      dir: resolve(import.meta.dirname, "../../../custom-gatekeepers/gatekeeper-inferops"),
      patch: config => {
        if (process.env.WORKSHOP_INTEGRATION_PREBUILT === "1") delete config.build;
        config.vars = { ...config.vars, INFERLAB_AUTH_ORIGIN: INFERLAB_ORIGIN, INFEROPS_BASE_URL: INFEROPS_ORIGIN,
          BASE_URL: "http://workshop.test/gatekeeper/inferops" };
      },
    }],
    patchWorkshop(config) {
      config.vars = { ...config.vars, COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true",
        SHARED_CONFIGURATION_GATEKEEPER: VENDOR, AUTHORED_WIDGET_BUILD_ENABLED: "true", CONSOLE_TOOLS: "true" };
    },
  });
  target = assertLoopbackTarget(harness.url);
  harnessOrigin = harness.url.origin;
});

afterAll(async () => {
  let unmocked: string[] | undefined;
  try {
    await harness?.server.close();
    unmocked = network.getUnmockedCalls();
    expect(unmocked).toEqual([]);
  } finally {
    network.uninstall();
    const isolation = isolationOf(unmocked);
    const report: ScenarioReport = {
      scenario: SCENARIO, revision: scenarioRevision(import.meta.dirname), source: "mock", liveProviderProof: false,
      target: "wrangler createTestHarness on loopback", boundaries: BOUNDARIES,
      fixtures: { inferopsWorkspace: SCENARIO_WORKSPACE, widget: WIDGET_TITLE, intent: SEARCH_INTENT,
        sources: Object.keys(WIDGET_SOURCES) },
      isolation, cases, verdict: scenarioVerdict(cases, isolation),
    };
    writeScenarioReport(REPORT_PATH, report, [...fake.issuedTokens(), ...fake.descriptions()]);
  }
});

/** Record a case's outcome for the report, failing the test as usual on any wrong result. */
async function record(name: string, run: () => Promise<Record<string, unknown>>) {
  try {
    cases.push({ name, outcome: "PASS", observed: await run() });
  } catch (error) {
    cases.push({ name, outcome: "FAIL", observed: {}, failure: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

type User = { username: string; api: RpcStub<AuthenticatedApi>; person: FakePerson };

async function signInTicket(flowUrl: string, person: FakePerson): Promise<string> {
  const start = await harness.fetchWorker(GATEKEEPER_WORKER, flowUrl, { redirect: "manual" });
  const done = await harness.fetchWorker(GATEKEEPER_WORKER, fake.authorize(start.headers.get("location")!, person));
  const literal = /var ticket = (".*?");\n/.exec(await done.text());
  if (!literal) throw new Error("The handoff page carried no ticket");
  return JSON.parse(literal[1]!);
}

/** A Workshop user with an InferOps account connected as a fresh synthetic person of `workspaces`. */
async function newUser(prefix: string, workspaces: WorkspaceSlug[]): Promise<User> {
  const [username] = nextUsernames(prefix);
  const api = await signUp(connect(harness.url), username!);
  const person = fake.addPerson(username!, workspaces);
  const { url, nonce } = await api.connectAccount(VENDOR);
  await api.completeConnectHandoff(await signInTicket(url, person), nonce);
  await waitFor("the connected InferOps account", async () =>
    (await listConnectedAccounts(api)).find(a => a.vendorId === VENDOR && a.description.uniqueName === person.email) ?? null);
  return { username: username!, api, person };
}

const consoleOf = (screenId: string, widgets: ConsoleWidgetEntry[]): OperateConsoleContent => ({
  title: "Dispatch", views: [{ id: "now", title: "Now", type: "screen", screen: screenId }], fullChat: "off", widgets,
});

// What the cases share, built up in order.
const state: {
  publisher?: User; operator?: User; blueprintId?: string; space?: RpcStub<Overseer>; spaceId?: string;
  installed?: WorkpieceId; consoleId?: string; revision?: string; frozen?: WorkpieceId;
  gatekeeperId?: WorkpieceId; placementId?: string; model?: RoutedScriptedModel;
  session?: RpcStub<OperateSession>; workspace?: RpcStub<Overseer>; chatId?: number; toStateId?: string;
} = {};

/** What the agent was told its tool call `id` returned, read from the request that followed it. */
function toolResult(model: RoutedScriptedModel, id: string): string {
  for (const request of model.requests) {
    const { messages } = request as { messages: { role: string; tool_call_id?: string; content: string }[] };
    const found = messages.find(message => message.role === "tool" && message.tool_call_id === id);
    if (found) return found.content;
  }
  throw new Error(`No result recorded for tool call ${id}`);
}

it("refuses a non-loopback target for the local scenario", () => record("loopback-only", async () => {
  for (const url of ["https://workshop.example", "http://10.0.0.8:8787", "http://workshop.test", "https://127.0.0.1"]) {
    expect(() => assertLoopbackTarget(new URL(url)), url).toThrow("loopback");
  }
  return { refused: 4, target: `${target.protocol}//${target.hostname}` };
}));

it("generates the Refine widget: its TSX compiled by the build Durable Object as its blueprint is published", () =>
  record("generate", async () => {
    const publisher = state.publisher = await newUser("gatepublisher", [SCENARIO_WORKSPACE]);
    const workspace = await publisher.api.newGadget("widget");
    const workpieces = new WorkpieceRecorder();
    await workspace.subscribeToWorkpieces(stubFor(workpieces));
    await workpieces.loaded;
    const gadget = workspace.createGadget(WIDGET_TITLE, undefined, "STATUS");
    const gadgetId = await gadget.getId();
    const content = (files: Record<string, string>): CodeContent => new Map([[gadgetId, new Map(Object.entries(files))]]);
    const baseCommit = await waitFor(`gadget ${gadgetId}'s head`, async () => {
      const summary = workpieces.summaries.get(gadgetId);
      return summary?.type === "gadget" && summary.commitId !== undefined ? summary.commitId : null;
    });
    const chatId = await workspace.newChat("Author", null);
    await workspace.submitCodeChange(chatId, { generation: 0, revision: 0, clientId: "author", seq: 1,
      pins: [{ gadgetId, baseCommit }], change: diffFiles(content({}), content({ ...WIDGET_SOURCES })) });
    expect(await workspace.mergeChanges(chatId)).toEqual({ outcome: "merged" });
    const blueprint = await gadget.createBlueprint(WIDGET_TITLE, WIDGET_PURPOSE);
    state.blueprintId = blueprint.id;
    await waitFor("the published blueprint", () => publisher.api.getBlueprintInfo(blueprint.id));
    // Authored as TSX only: no client.js was written, so the one the published widget serves (see
    // embed-resolve) was compiled on the server. In the Worker that is the build Durable Object's
    // compiler; the Node-only Blueprint compiler isn't loaded there (agent-authoring.md).
    expect(Object.keys(WIDGET_SOURCES)).not.toContain("client.js");
    return { blueprintId: blueprint.id, sources: Object.keys(WIDGET_SOURCES), authoredClientJs: false };
  }));

it("publishes it securely: a console publication lists it in InferOps' index, as the publisher", () =>
  record("publish", async () => {
    const publisher = state.publisher!;
    fake.grantPublishConfiguration(publisher.person, SCENARIO_WORKSPACE);
    const space = state.space = await publisher.api.newGadget("app");
    state.spaceId = (await space.getMetadata()).id;
    const account = (await listConnectedAccounts(publisher.api)).find(a => a.vendorId === VENDOR)!;
    const board = await space.newGatekeeper(account.id, boardUrl(SCENARIO_WORKSPACE, "ENG"));
    if (!board) throw new Error("No board connection");
    const gatekeeperId = state.gatekeeperId = await board.getId();
    const installed = state.installed = await space.installBlueprint(state.blueprintId!, {}, { version: 1, kind: "widget" });
    const screen = await space.createCanvas({ title: "Dispatch", sections: [{ id: "main", title: "Now", columns: 1, widgets: [{
      id: `w${installed}`, version: 1, kind: "inferos.gadget", targetRef: `gadget:${installed}`, params: {}, size: "normal",
    }] }] });
    const entry: ConsoleWidgetEntry = { gadgetId: installed, blueprintId: state.blueprintId!, version: 1,
      label: WIDGET_TITLE, state: "resettable", commands: [{ name: COMMAND, gatekeeperId }] };
    const draft = await space.createConsole(consoleOf(screen.id, [entry]));
    const published = await space.publishConsole(draft.id, draft.revision);
    state.consoleId = draft.id;
    state.revision = published.revision;
    state.frozen = published.published!.content.widgets![0]!.gadgetId;
    const index = await space.getConsoleWidgetIndex(draft.id);
    expect(index).toMatchObject({ target: { workspaceId: WORKSPACES[SCENARIO_WORKSPACE].id }, blocked: null,
      widgets: [{ versionId: `${state.blueprintId}@1`, outcome: { status: "applied" } }] });
    const definitions = [...fake.widgetDefinitions.values()].filter(d => d.sourceId === state.blueprintId);
    expect(definitions).toEqual([expect.objectContaining({ workspace: SCENARIO_WORKSPACE, sourceVersion: 1,
      visibility: "company", publishedBy: publisher.username })]);
    return { consoleId: draft.id, revision: published.revision, indexed: definitions.length, publishedBy: "publisher",
      commandBound: COMMAND };
  }));

it("is found by meaning through the operator's own widget search", () => record("find", async () => {
  const operator = state.operator = await newUser("gateoperator", [SCENARIO_WORKSPACE]);
  const answer: WidgetSearchAnswer = await operator.api.searchWidgets(SEARCH_INTENT);
  if (answer.status !== "searched") throw new Error(`Expected a search, got ${answer.status}`);
  const found = answer.definitions.find(d => d.sourceId === state.blueprintId);
  expect(found).toMatchObject({ sourceVersion: 1 });
  return { intent: SEARCH_INTENT, found: true, ranking: answer.ranking };
}));

it("resolves through the kernel's embed path a Wiki embed uses, and serves its compiled bundle", () =>
  record("embed-resolve", async () => {
    const operator = state.operator!;
    expect(await state.space!.addCollaborator(operator.username, "use")).toBeTruthy();
    using used = await operator.api.openGadget(state.spaceId!);
    const resolved = await used.resolveEmbeddedWidget(state.consoleId!, state.installed!);
    expect(resolved).toMatchObject({ status: "available", consoleId: state.consoleId, gadgetId: state.frozen,
      blueprintId: state.blueprintId, version: 1 });
    using embedded = await used.getEmbeddedWidget(state.consoleId!, state.revision!, state.frozen!);
    const bundle = await embedded.getUiBundle();
    if (!bundle) throw new Error("The embedded widget has no UI bundle");
    const { jsCode } = bundle;
    // Compiled on the server from TSX alone (see generate): a bundle, not the authored source, with
    // no TSX type syntax and no Refine telemetry.
    expect(jsCode.length).toBeGreaterThan(0);
    expect(jsCode).not.toContain("type DataProvider");
    expect(jsCode).not.toContain("telemetry.refine.dev");
    return { status: "available", compiledBytes: jsCode.length };
  }));

it("is embedded in Operate: the operator places it on their own canvas", () => record("embed-operate", async () => {
  const session = state.session = await state.operator!.api.getOperateSession();
  const before = await session.listWidgetPlacements();
  const after = await session.saveWidgetPlacement({
    ref: { type: "console-widget", workspaceId: state.spaceId!, consoleId: state.consoleId!,
      sourceGadgetId: state.installed! as number, blueprintId: state.blueprintId!, version: 1 },
    layout: { x: 0, y: 0, w: 6, h: 4 },
  }, before.revision);
  expect(after.placements).toHaveLength(before.placements.length + 1);
  state.placementId = after.placements.find(p => p.ref.type === "console-widget" && p.ref.consoleId === state.consoleId)!.placementId;
  expect((await session.listWidgetPlacements()).placements.map(p => p.ref)).toContainEqual(
    expect.objectContaining({ consoleId: state.consoleId, blueprintId: state.blueprintId }));
  return { placements: after.placements.length };
}));

it("is read and filtered by the operate agent, which changes only the operator's overlay", () =>
  record("agent-read-filter", async () => {
    const operator = state.operator!;
    const issue = fake.issue(SCENARIO_ISSUE);
    const toState = PROJECTS.ENG.states.find(candidate => candidate.id !== issue.stateId)!;
    state.toStateId = toState.id;
    const ref = { workspaceId: state.spaceId!, consoleId: state.consoleId!, revision: state.revision!, widgetId: state.frozen! };
    const model = state.model = router.script([
      { toolCall: { id: "find", name: "findWidgets", arguments: { query: SEARCH_INTENT } } },
      { toolCall: { id: "describe", name: "describeWidget", arguments: ref } },
      { toolCall: { id: "filter", name: "setWidgetView", arguments: { placementId: state.placementId!, filters: { status: "open" } } } },
      { text: "Shown with the open orders." },
      { toolCall: { id: "act", name: "callConsoleTool", arguments: { widgetId: state.frozen!, tool: COMMAND,
        input: { issueId: issue.id, toStateId: toState.id, expectedRevision: issue.revision } } } },
      { text: "Asked to move it; it waits for approval." },
    ]);
    await operator.api.addModel(model.userModel.profile, model.userModel.config);
    await operator.api.setPreferredModel(model.userModel.profile.id);
    await operator.api.setQuickModel(null);
    await operator.api.completeOnboarding();
    const session = state.session!;
    const shown = await state.space!.getConsole(state.consoleId!, "published");
    await session.dispatch({ type: "openConsole", workspaceId: state.spaceId!, consoleId: state.consoleId!, title: shown!.title,
      source: "published", revision: shown!.revision, fullChat: shown!.fullChat, viewId: shown!.views[0]!.id }, 0);
    const workspace = state.workspace = await session.getWorkspace();
    const placementsBefore = await session.listWidgetPlacements();
    const chatId = state.chatId = await workspace.newChat("Show me the open orders", SCRIPTED_MODEL_ID);
    await waitForIdleChat(workspace, chatId);

    // It found and described the widget, as the operator.
    expect(toolResult(model, "find")).toContain(state.blueprintId!);
    expect(toolResult(model, "describe")).toContain(WIDGET_TITLE);
    // The filter is in the overlay only: the saved placement is unchanged until the operator keeps it.
    const overlay = await session.getAgentView();
    expect(overlay.views).toContainEqual(expect.objectContaining({ placementId: state.placementId, filters: { status: "open" } }));
    expect(await session.listWidgetPlacements()).toEqual(placementsBefore);
    return { found: true, described: true, overlayViews: overlay.views.length, placementsUnchanged: true };
  }));

it("is acted on by the agent: the declared command waits for a decider of the console's workspace, then applies once", () =>
  record("agent-act", async () => {
    // A copy: `fake.issue` returns the live issue, which the write changes.
    const before = { ...fake.issue(SCENARIO_ISSUE) };
    const writesBefore = fake.commits.length;
    await state.workspace!.sendChatMessage(state.chatId!, "Move that order's issue on", SCRIPTED_MODEL_ID);
    await waitForIdleChat(state.workspace!, state.chatId!);
    const pending = await waitFor("the requested command", async () => {
      const entries = (await state.space!.listActions({ filter: "pending" })).entries;
      return entries.length > 0 ? entries : null;
    });
    expect(pending).toHaveLength(1);
    // Requested, not applied: nothing written yet, the issue where it was.
    expect(fake.commits.length).toBe(writesBefore);
    expect(fake.issue(SCENARIO_ISSUE).stateId).toBe(before.stateId);
    // A decider of the console's workspace (the publisher) approves; it is applied once.
    await state.space!.approveAction(pending[0]!.id);
    await waitFor("the board write", async () => fake.commits.length > writesBefore ? true : null);
    expect(fake.issue(SCENARIO_ISSUE).stateId).toBe(state.toStateId);
    // Once (r1 LOW 3): approving the same action again is refused, and after a pause the write count
    // is still one more than before.
    await expect(state.space!.approveAction(pending[0]!.id)).rejects.toThrow();
    await new Promise(settled => setTimeout(settled, 1_000));
    expect(fake.commits.length).toBe(writesBefore + 1);
    return { pendingBeforeApproval: 1, writesBeforeApproval: 0, writesAfterApproval: 1, secondApprovalRefused: true,
      decidedBy: "publisher" };
  }));
