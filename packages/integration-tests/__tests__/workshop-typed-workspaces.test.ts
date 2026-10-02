import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { WorkspaceKind } from "@gadgets/workshop-shared/api";
import { checkWorkspaceKind, workspaceKindStarter } from "@gadgets/workshop-shared/workspace-kind";
import { openAgentSession, type WorkshopAgentSession } from "../src/agent-session.js";
import { startTestGatekeeperHarness, type Harness } from "../src/harness.js";
import {
  scriptedChatCompletions, SCRIPTED_MODEL_CONFIG, SCRIPTED_MODEL_ID, SCRIPTED_MODEL_PROFILE,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";

type Workflow = { run(input: unknown): Promise<{ input: unknown }>; lastRun(): Promise<unknown> };
type Widget = { summary(): Promise<{ title: string; value: string }> };

const create = (id: string) =>
  ({ toolCall: { id, name: "createGadget", arguments: { title: "Built", bindingName: "BUILT" } } });

// One script, consumed in test order.
const model = scriptedChatCompletions([
  // app
  create("create-app"), { text: "Created." },
  // widget
  create("create-widget"), { text: "Created." },
  // workflow: create, then try to give it a UI
  create("create-workflow"),
  {
    toolCall: {
      id: "write-ui", name: "writeFile",
      arguments: { workpiece: "BUILT", filename: "client.js", content: "document.body.append('x');" },
    },
  },
  { text: "A workflow has no UI." },
]);
const network = new NetworkInterceptor({ handlers: [model.handler] });
let harness: Harness;

beforeAll(async () => {
  network.install();
  harness = await startTestGatekeeperHarness({ enableGadgetExecution: true });
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

const open = (workspaceKind: WorkspaceKind) => openAgentSession(harness.url, {
  modelId: SCRIPTED_MODEL_ID,
  userModel: { profile: SCRIPTED_MODEL_PROFILE, config: SCRIPTED_MODEL_CONFIG },
  workspaceKind,
});

/** The system prompt of the model request at `index`. */
const systemPrompt = (index: number) => {
  const { messages } = model.requests[index] as { messages: { role: string; content: string }[] };
  return messages.filter(message => message.role === "system").map(m => m.content).join("\n");
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

/** Builds a gadget in a workspace of `kind` and returns it, connected, with its created files. */
async function build(session: WorkshopAgentSession) {
  const result = await session.runTurn("Build it.");
  expect(result.outcome).toEqual({ status: "completed" });
  const created = result.workpieces.find(workpiece => workpiece.type === "gadget");
  if (!created) throw new Error("The turn created no gadget");
  const gadget = await session.openGadget(created.id);
  return { gadget, connect: () => gadget.client.connectToGadget(gadget.chatId) };
}

it("an app workspace builds as before: no contract, no starter", async () => {
  await using session = await open("app");
  const first = model.requests.length;
  await build(session);
  expect(systemPrompt(first)).not.toContain("This workspace builds");
  expect(toolResult("create-app")).not.toContain("starterNotes");
});

it("a widget workspace states its contract and starts the gadget from the widget starter", async () => {
  await using session = await open("widget");
  const first = model.requests.length;
  const { connect } = await build(session);

  expect(systemPrompt(first)).toContain("# This workspace builds a Widget");
  const files = Object.keys(workspaceKindStarter("widget")!);
  expect(toolResult("create-widget")).toContain(`Started from the widget starter: ${files.join(", ")}`);
  expect(checkWorkspaceKind("widget", files)).toEqual([]);

  // The starter is running code, not just files.
  using widget = await connect() as unknown as RpcStub<Widget>;
  expect(await widget.summary()).toEqual({ title: "Widget", value: "Nothing to show yet" });
});

it("a workflow workspace starts from the workflow starter and refuses a UI file", async () => {
  await using session = await open("workflow");
  const first = model.requests.length;
  const { connect } = await build(session);

  expect(systemPrompt(first)).toContain("# This workspace builds a Workflow");
  expect(toolResult("create-workflow")).toContain("Started from the workflow starter: server.js");
  expect(toolResult("write-ui")).toContain("client.js cannot be written here");

  using workflow = await connect() as unknown as RpcStub<Workflow>;
  expect(await workflow.lastRun()).toBeNull();
  expect((await workflow.run({ shift: "night" })).input).toEqual({ shift: "night" });
  expect(await workflow.lastRun()).toMatchObject({ input: { shift: "night" } });
});
