import { afterAll, beforeAll, expect, it } from "vitest";
import type { OperateRef } from "@gadgets/workshop-shared/operate-session";
import { diffFiles } from "@gadgets/workshop-shared/code-change";
import { openAgentSession } from "../src/agent-session.js";
import { startHarness, type Harness } from "../src/harness.js";
import {
  scriptedChatCompletions, SCRIPTED_MODEL_CONFIG, SCRIPTED_MODEL_ID, SCRIPTED_MODEL_PROFILE,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, logIn, nextUsernames, signUp } from "../src/rpc-client.js";

// Operate chat (issue #61): the operate session's workspace is operate-only however it is opened,
// and its chats' agents get no authoring tools but can change the session's page as themselves.

const AUTHORING_TOOLS = [
  "writeFile", "editFile", "createGadget", "createWorktree", "setGadgetBinding", "editCanvas",
];
const BOARD: OperateRef = { type: "workspace", workspaceId: "board-workspace" };

// One script, consumed in test order.
const model = scriptedChatCompletions([
  // The operate chat asks for a tool it was not offered.
  {
    toolCall: {
      id: "operate-write", name: "writeFile",
      arguments: { workpiece: "BUILT", filename: "server.js", content: "export default {};" },
    },
  },
  { text: "I can't change software here." },
  // The operate chat opens something on the page.
  {
    toolCall: {
      id: "operate-open", name: "operatePage",
      arguments: { action: "open", workspaceId: BOARD.workspaceId },
    },
  },
  { text: "Opened." },
  // A Build chat.
  { text: "Ready to build." },
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

const open = (operateSession: boolean) => openAgentSession(harness.url, {
  modelId: SCRIPTED_MODEL_ID,
  userModel: { profile: SCRIPTED_MODEL_PROFILE, config: SCRIPTED_MODEL_CONFIG },
  operateSession,
});

/** The tool names offered in the model request at `index`. */
const offeredTools = (index: number) => {
  const { tools } = model.requests[index] as { tools?: { function: { name: string } }[] };
  return (tools ?? []).map(tool => tool.function.name);
};

/** What the agent was told its tool call `id` returned, read from the request that followed it. */
const toolResult = (id: string) => {
  for (const request of model.requests) {
    const { messages } = request as { messages: { role: string; tool_call_id?: string; content: string }[] };
    const found = messages.find(message => message.role === "tool" && message.tool_call_id === id);
    if (found) return found.content;
  }
  throw new Error(`No result recorded for tool call ${id}`);
};

it("denies authoring on the session workspace, however it is opened, and to anyone else", async () => {
  using publicApi = connect(harness.url);
  const [ownerName, otherName] = nextUsernames("operateowner", "operateother");
  using person = await signUp(publicApi, ownerName!);
  using session = await person.getOperateSession();
  using workspace = await session.getWorkspace();
  const { id } = await workspace.getMetadata();

  // What the operate chat needs still works.
  expect(await workspace.listChats()).toEqual([]);
  expect(await workspace.listActions()).toMatchObject({ entries: [] });
  expect(await workspace.listCanvases()).toEqual([]);

  const denied = /Unauthorized: an operate session/;
  await expect(workspace.createGadget("Gadget")).rejects.toThrow(denied);
  await expect(workspace.createCanvas({ title: "Board", sections: [] })).rejects.toThrow(denied);
  await expect(workspace.editCanvas("canvas", "1", [])).rejects.toThrow(denied);
  await expect(workspace.submitCodeChange(1, {
    generation: 0, revision: 0, clientId: "operate", seq: 1, pins: [],
    change: diffFiles(new Map(), new Map()),
  })).rejects.toThrow(denied);
  await expect(workspace.setTitle("Renamed")).rejects.toThrow(denied);
  await expect(workspace.createShareLink("build")).rejects.toThrow(denied);

  // Opening it by id is the same operate capability, not the owner's full one.
  using reopened = await person.openGadget(id);
  await expect(reopened.createGadget("Gadget")).rejects.toThrow(denied);

  // And it is never anyone else's.
  using other = await signUp(publicApi, otherName!);
  await expect(other.openGadget(id)).rejects.toThrow();
});

it("offers an operate chat no authoring tools, and refuses one it asks for", async () => {
  await using session = await open(true);
  const first = model.requests.length;
  const result = await session.runTurn("Rewrite the app's server.");
  expect(result.outcome).toEqual({ status: "completed" });

  const offered = offeredTools(first);
  for (const name of AUTHORING_TOOLS) expect(offered).not.toContain(name);
  expect(offered).toEqual(expect.arrayContaining(["executeCode", "readFile", "operatePage"]));
  expect(toolResult("operate-write")).toMatch(/writeFile/);
  expect(result.workpieces.filter(workpiece => workpiece.type === "gadget")).toEqual([]);
});

it("records the operate agent's page change as the agent's", async () => {
  await using session = await open(true);
  const result = await session.runTurn("Open the board.");
  expect(result.outcome).toEqual({ status: "completed" });
  expect(JSON.parse(toolResult("operate-open"))).toMatchObject({ workingSet: [BOARD], focus: BOARD });

  using publicApi = connect(harness.url);
  using person = await logIn(publicApi, session.username);
  using operate = await person.getOperateSession();
  expect(await operate.listEvents(0, 10)).toEqual([
    expect.objectContaining({ seq: 1, actor: "agent", event: { type: "open", ref: BOARD } }),
  ]);
});

it("still offers a Build chat its authoring tools", async () => {
  await using session = await open(false);
  const first = model.requests.length;
  expect((await session.runTurn("Get ready.")).outcome).toEqual({ status: "completed" });
  const offered = offeredTools(first);
  expect(offered).toEqual(expect.arrayContaining(AUTHORING_TOOLS));
  expect(offered).not.toContain("operatePage");
});
