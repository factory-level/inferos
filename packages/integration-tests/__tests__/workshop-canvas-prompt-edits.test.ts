// Prompt edits and control edits are one edit path (FAC-84): the agent's editCanvas tool applies the
// builder controls' own typed page operations (FAC-83) at the page revision, naming the selected
// target, through the same write the controls make. So an equivalent prompt edit and control edit
// save the same configuration, a prompt reaches only its own workspace's pages and a target on the
// canvas it changes, and nothing it does publishes. Driven by a scripted model, never a live one.
import { afterAll, beforeAll, expect, it } from "vitest";
import type { CanvasContent } from "@gadgets/workshop-shared/canvas";
import type { CanvasPage, CanvasPageOperation } from "@gadgets/workshop-shared/canvas-model";
import { openAgentSession } from "../src/agent-session.js";
import { startHarness, type Harness } from "../src/harness.js";
import {
  scriptedChatCompletions, SCRIPTED_MODEL_CONFIG, SCRIPTED_MODEL_ID, SCRIPTED_MODEL_PROFILE,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, logIn, nextUsernames, signUp } from "../src/rpc-client.js";

/** A scripted editCanvas call whose arguments a test fills in once it knows the canvas ids. */
const editCall = (id: string) => ({ toolCall: { id, name: "editCanvas", arguments: {} as Record<string, unknown> } });

const nestEdit = editCall("prompt-nest");
const foreignEdit = editCall("prompt-foreign");
const elsewhereEdit = editCall("prompt-elsewhere");
const goneEdit = editCall("prompt-gone");
const publishedEdit = editCall("prompt-published");

// One script, consumed in test order.
const model = scriptedChatCompletions([
  nestEdit, { text: "Moved the board into Inner." },
  foreignEdit, { text: "I couldn't change that canvas." },
  elsewhereEdit, goneEdit, { text: "That part isn't on this canvas." },
  publishedEdit, { text: "Renamed the draft." },
]);
const network = new NetworkInterceptor({ handlers: [model.handler] });
let harness: Harness;

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [],
    patchWorkshop(config) {
      config.vars = { ...config.vars, COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true" };
    },
  });
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
    expect(model.remainingSteps()).toBe(0);
  } finally {
    network.uninstall();
  }
});

const open = () => openAgentSession(harness.url, {
  modelId: SCRIPTED_MODEL_ID,
  userModel: { profile: SCRIPTED_MODEL_PROFILE, config: SCRIPTED_MODEL_CONFIG },
});

/** What the agent was told its tool call `id` returned, read from the request that followed it. */
const toolResult = (id: string) => {
  for (const request of model.requests) {
    const { messages } = request as { messages: { role: string; tool_call_id?: string; content: string }[] };
    const found = messages.find(message => message.role === "tool" && message.tool_call_id === id);
    if (found) return found.content;
  }
  throw new Error(`No result recorded for tool call ${id}`);
};

const TRIAGE: CanvasContent = {
  title: "Triage",
  sections: [{
    id: "work", title: "Work", columns: 2,
    widgets: [{
      id: "eng", kind: "inferops.project-board", version: 1, targetRef: "inferops://demo.local/project/board/DEMO",
      size: "wide", params: { workflow: "software", showCompleted: false },
    }],
  }],
};

/** Nest the board one object deeper, attach behavior to it and retitle: something version 1 can't hold. */
const NEST: CanvasPageOperation[] = [
  { type: "addObject", parent: "work", index: 0, object: { id: "inner", title: "Inner", columns: 1 } },
  { type: "moveNode", nodeId: "eng", parent: "inner", index: 0 },
  { type: "setAttachments", target: "eng", attachments: [
    { id: "eng-done", version: 1, on: "action-completed", effect: { kind: "raise-event", target: "inner", event: "refresh" } },
  ] },
  { type: "configureObject", nodeId: "work", title: "Work, nested", columns: 1 },
];

/** A page without its ID, which is random per canvas: everything the edit decided. */
const configuration = ({ id: _id, ...page }: CanvasPage) => page;

it("an equivalent control edit and prompt edit save the same configuration", async () => {
  await using session = await open();
  const workspace = session.workspace();

  // The control: the builder's editCanvasPage, in another workspace of the same person.
  using publicApi = connect(harness.url);
  using person = await logIn(publicApi, session.username);
  using controls = await person.newGadget();
  const controlled = await controls.createCanvas(TRIAGE);
  const byControl = await controls.editCanvasPage(controlled.id, controlled.revision, NEST);

  // The prompt: the agent's editCanvas with the selected target and the page revision.
  const prompted = await workspace.createCanvas(TRIAGE);
  Object.assign(nestEdit.toolCall.arguments, {
    canvasId: prompted.id, expectedRevision: prompted.revision, target: `page:${prompted.id}/node:eng`, operations: NEST,
  });
  const result = await session.runTurn(`Move the board into a new part (target page:${prompted.id}/node:eng).`);
  expect(result.outcome).toEqual({ status: "completed" });
  expect(JSON.parse(toolResult("prompt-nest"))).toMatchObject({ success: true, canvas: { revision: "1" } });

  const byPrompt = (await workspace.getCanvasPage(prompted.id))!;
  expect(JSON.stringify(configuration(byPrompt))).toBe(JSON.stringify(configuration(byControl)));
  expect(byPrompt.revision).toBe(byControl.revision);
  // The tool showed the agent the saved page itself, nested parts included.
  expect(JSON.parse(toolResult("prompt-nest")).canvas).toEqual(
    (({ schemaVersion: _version, ...page }: CanvasPage) => page)(byPrompt));
});

it("refuses a prompt edit of another company's canvas, of another canvas than its target, and of a part that's gone", async () => {
  await using session = await open();
  const workspace = session.workspace();
  using publicApi = connect(harness.url);
  const [otherName] = nextUsernames("othercompany");
  using other = await signUp(publicApi, otherName!);
  using theirs = await other.newGadget();
  const foreign = await theirs.createCanvas(TRIAGE);
  const mine = await workspace.createCanvas(TRIAGE);
  const another = await workspace.createCanvas({ ...TRIAGE, title: "Another" });

  Object.assign(foreignEdit.toolCall.arguments, {
    canvasId: foreign.id, expectedRevision: foreign.revision, operations: [{ type: "renamePage", title: "Taken" }],
  });
  expect((await session.runTurn("Rename that canvas.")).outcome).toEqual({ status: "completed" });
  expect(toolResult("prompt-foreign")).toMatch(/Canvas not found/);
  expect(await theirs.getCanvasPage(foreign.id)).toMatchObject({ title: "Triage", revision: "0" });

  Object.assign(elsewhereEdit.toolCall.arguments, {
    canvasId: mine.id, expectedRevision: mine.revision, target: `page:${another.id}/node:eng`,
    operations: [{ type: "renamePage", title: "Wrong canvas" }],
  });
  Object.assign(goneEdit.toolCall.arguments, {
    canvasId: mine.id, expectedRevision: mine.revision, target: `page:${mine.id}/node:gone`,
    operations: [{ type: "removeNode", nodeId: "eng" }],
  });
  expect((await session.runTurn("Remove the selected board.")).outcome).toEqual({ status: "completed" });
  expect(toolResult("prompt-elsewhere")).toMatch(/is on another canvas/);
  expect(toolResult("prompt-gone")).toMatch(/isn't on canvas .* any more/);
  for (const canvas of [mine, another]) {
    expect(await workspace.getCanvasPage(canvas.id)).toMatchObject({ revision: "0" });
  }
});

it("never publishes: a prompt edit changes the draft, and the published console keeps what it published", async () => {
  await using session = await open();
  const workspace = session.workspace();
  const screen = await workspace.createCanvas(TRIAGE);
  const draft = await workspace.createConsole({
    title: "Floor", fullChat: "off", views: [{ id: "v-triage", title: "Triage", type: "screen", screen: screen.id }],
  });
  const published = await workspace.publishConsole(draft.id, draft.revision);
  const frozen = await workspace.getConsolePage(draft.id, screen.id, "published");

  const first = model.requests.length;
  Object.assign(publishedEdit.toolCall.arguments, {
    canvasId: screen.id, expectedRevision: screen.revision, target: `page:${screen.id}`,
    operations: [{ type: "renamePage", title: "Triage, edited" }],
  });
  expect((await session.runTurn("Rename the triage screen and publish it.")).outcome).toEqual({ status: "completed" });
  expect(JSON.parse(toolResult("prompt-published"))).toMatchObject({ success: true });

  expect(await workspace.getConsolePage(draft.id, screen.id, "draft")).toMatchObject({ title: "Triage, edited" });
  expect(await workspace.getConsolePage(draft.id, screen.id, "published")).toEqual(frozen);
  expect((await workspace.getConsole(draft.id, "published"))?.published).toEqual(published.published);
  // The agent is offered no tool that publishes.
  const { tools } = model.requests[first] as { tools?: { function: { name: string } }[] };
  expect((tools ?? []).map(tool => tool.function.name).filter(name => /publish/i.test(name))).toEqual([]);
});
