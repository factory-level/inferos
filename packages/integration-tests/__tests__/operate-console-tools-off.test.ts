// The operate agent's console tools with CONSOLE_TOOLS off (callable-widget contract §8.1, the
// deployment gate): an operate chat is offered neither tool, its prompt does not mention them, and a
// call the scripted model makes anyway is refused as an unknown tool, leaving the chat unmarked
// (webFetch still reaches the network). SCRIPTED MODEL; synthetic fixtures only.

import { afterAll, beforeAll, expect, it } from "vitest";
import { openAgentSession } from "../src/agent-session.js";
import { startHarness, type Harness } from "../src/harness.js";
import {
  scriptedChatCompletions, SCRIPTED_MODEL_CONFIG, SCRIPTED_MODEL_ID, SCRIPTED_MODEL_PROFILE,
} from "../src/mock-model.js";
import { NetworkInterceptor, type Handler } from "../src/network-interceptor.js";

const model = scriptedChatCompletions([
  { toolCalls: [
    { id: "list", name: "listConsoleTools", arguments: {} },
    { id: "call", name: "callConsoleTool", arguments: { widgetId: 1, tool: "count" } },
  ] },
  { toolCall: { id: "fetch", name: "webFetch", arguments: { url: "https://pages.example/off", raw: true } } },
  { text: "Nothing to call." },
]);
const fetched: string[] = [];
const page: Handler = url => {
  if (url.hostname !== "pages.example") return null;
  fetched.push(url.toString());
  return new Response("synthetic page", { headers: { "content-type": "text/plain" } });
};
const network = new NetworkInterceptor({ handlers: [model.handler, page] });
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

const toolResult = (id: string) => {
  for (const request of model.requests) {
    const { messages } = request as { messages: { role: string; tool_call_id?: string; content: string }[] };
    const found = messages.find(message => message.role === "tool" && message.tool_call_id === id);
    if (found) return found.content;
  }
  throw new Error(`No result recorded for tool call ${id}`);
};

it("offers an operate chat no console tools while CONSOLE_TOOLS is off, and leaves the chat unmarked", async () => {
  await using session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID,
    userModel: { profile: SCRIPTED_MODEL_PROFILE, config: SCRIPTED_MODEL_CONFIG },
    operateSession: true,
    usernamePrefix: "toolsoff",
  });
  expect((await session.runTurn("Use the console's tools.")).outcome).toEqual({ status: "completed" });

  const first = model.requests[0] as { messages: { content: unknown }[]; tools?: { function: { name: string } }[] };
  const offered = (first.tools ?? []).map(tool => tool.function.name);
  expect(offered).toContain("operatePage");
  expect(offered).not.toContain("listConsoleTools");
  expect(offered).not.toContain("callConsoleTool");
  expect(JSON.stringify(first.messages[0])).not.toMatch(/Console tools/);
  expect(toolResult("list")).toMatch(/listConsoleTools not found/);
  expect(toolResult("call")).toMatch(/callConsoleTool not found/);
  // Nothing marked the chat, so webFetch still works.
  expect(toolResult("fetch")).toContain("synthetic page");
  expect(fetched).toEqual(["https://pages.example/off"]);
});
