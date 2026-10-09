// Execution-bound loopbacks in an operate chat: `env.GIT`, kept past its executeCode run through
// `self` and delivered back into a later run of the same chat, is refused there, while a Build
// chat running the same script still opens it. The real Workshop, with a scripted model.

import { afterAll, beforeAll, expect, it } from "vitest";
import { openAgentSession } from "../src/agent-session.js";
import { startHarness, type Harness } from "../src/harness.js";
import {
  scriptedChatCompletions, SCRIPTED_MODEL_CONFIG, SCRIPTED_MODEL_ID, SCRIPTED_MODEL_PROFILE,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { waitFor, waitForIdleChat } from "../src/rpc-client.js";

const run = (id: string, code: string) => ({
  toolCall: { id, name: "executeCode", arguments: { code: `export default async function(self, env) { ${code} }` } },
});

// Opening the session is what the binding guards; a read of an unknown commit then fails in the
// session itself, so its message tells the two outcomes apart.
const READ = `await git.readCommit("0".repeat(40)).then(() => "read", e => e.message)`;

const turns = (prefix: string) => [
  run(`${prefix}-keep`, `const git = env.GIT; console.log(${READ}); await self.keep(git); console.log("kept");`),
  { text: "Kept." },
  // The callback turn the kept stub is delivered in.
  run(`${prefix}-use`, `const [git] = env.keep_ARGS; console.log(${READ});`),
  { text: "Used." },
];

// One script, consumed in test order.
const model = scriptedChatCompletions([...turns("operate"), ...turns("build")]);
const network = new NetworkInterceptor({ handlers: [model.handler] });
let harness: Harness;

beforeAll(async () => {
  network.install();
  harness = await startHarness({ enableGadgetExecution: true, gatekeepers: [] });
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

/** What the agent was told its tool call `id` returned, read from the request that followed it. */
const toolResult = (id: string) => {
  for (const request of model.requests) {
    const { messages } = request as { messages: { role: string; tool_call_id?: string; content: string }[] };
    const found = messages.find(message => message.role === "tool" && message.tool_call_id === id);
    if (found) return found.content;
  }
  throw new Error(`No result recorded for tool call ${id}`);
};

/** Run the keep turn, then wait out the callback turn it causes. */
async function keepAndUse(operateSession: boolean): Promise<void> {
  const session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID,
    userModel: { profile: SCRIPTED_MODEL_PROFILE, config: SCRIPTED_MODEL_CONFIG },
    operateSession,
    usernamePrefix: operateSession ? "boundop" : "boundbuild",
  });
  await using _ = session;
  const remaining = model.remainingSteps();
  expect((await session.runTurn("Keep GIT for later.")).outcome).toEqual({ status: "completed" });
  await waitFor("the callback turn", async () => model.remainingSteps() === remaining - 4 || null);
  using ws = session.workspace();
  for (const chat of await ws.listChats()) await waitForIdleChat(ws, chat.id);
}

it("refuses env.GIT kept past its execution in an operate chat", async () => {
  await keepAndUse(true);
  expect(toolResult("operate-keep")).toMatch(/not known/);
  expect(toolResult("operate-keep")).toContain("kept");
  expect(toolResult("operate-use")).toMatch(/no longer live/);
  expect(toolResult("operate-use")).not.toMatch(/not known/);
});

it("still opens it in a Build chat", async () => {
  await keepAndUse(false);
  expect(toolResult("build-keep")).toMatch(/not known/);
  expect(toolResult("build-use")).toMatch(/not known/);
});
