// No Wiki through the operate chat (#61): the operate agent is never offered the InferMind Wiki as
// a connectable resource, cannot request one, and cannot reach one through generic `executeCode`
// or `describeBinding` even when the person connected a Wiki in their session workspace and pasted
// it into the chat. The same connection still opens for the person outside the chat, and a Build
// chat still reads it. The real Workshop and InferOps gatekeeper on its demo data, with a scripted
// model.

import { afterAll, beforeAll, expect, it } from "vitest";
import { resolve } from "node:path";
import type { CapsuleSpecifier } from "@gadgets/workshop-shared/api";
import type { InferOpsWikiSession } from "../../../custom-gatekeepers/gatekeeper-inferops/src/types.js";
import { openAgentSession, type WorkshopAgentSession } from "../src/agent-session.js";
import { startHarness, type Harness } from "../src/harness.js";
import {
  scriptedChatCompletions, SCRIPTED_MODEL_CONFIG, SCRIPTED_MODEL_ID, SCRIPTED_MODEL_PROFILE,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";

const INFEROPS_GATEKEEPER_DIR =
  resolve(import.meta.dirname, "../../../custom-gatekeepers/gatekeeper-inferops");
const VENDOR = "inferops";
const DEMO_WIKI = "inferops://demo.local/knowledge/wiki";

const run = (id: string, code: string) => ({
  toolCall: { id, name: "executeCode", arguments: { code: `export default async function(self, env) { ${code} }` } },
});

// One script, consumed in test order.
const model = scriptedChatCompletions([
  // Operate: advertising and requesting.
  { toolCall: { id: "list", name: "listConnectableResources", arguments: { vendorId: VENDOR } } },
  {
    toolCall: {
      id: "request", name: "requestConnection",
      arguments: { vendorId: VENDOR, resourceUrl: DEMO_WIKI, reason: "Read the handbook", bindingName: "WIKI" },
    },
  },
  { text: "The Wiki isn't available here." },
  // Operate: a pasted Wiki, through every generic route.
  { toolCall: { id: "describe", name: "describeBinding", arguments: { name: "INFEROPS_WIKI" } } },
  run("read", `console.log(JSON.stringify(await env.INFEROPS_WIKI.readDocumentText("handbook")));`),
  run("env", `console.log(JSON.stringify(Object.keys(env).sort()));`),
  run("edit", `await env.INFEROPS_WIKI.updateSection("x", "y", 1); console.log("edited");`),
  { text: "I can't use the Wiki in this chat." },
  // Build: the same kind of paste works.
  run("build-read", `console.log((await env.INFEROPS_WIKI.listDocuments()).length);`),
  { text: "Read it." },
]);
const network = new NetworkInterceptor({ handlers: [model.handler] });
let harness: Harness;

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    enableGadgetExecution: true,
    gatekeepers: [{
      binding: "INFEROPS",
      dir: INFEROPS_GATEKEEPER_DIR,
      patch: config => {
        if (process.env.WORKSHOP_INTEGRATION_PREBUILT === "1") delete config.build;
      },
    }],
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

/** A chat with the demo InferOps account, in the operate session or in a new Build workspace. */
async function chat(operateSession: boolean): Promise<{ session: WorkshopAgentSession; wiki: CapsuleSpecifier }> {
  let wiki: CapsuleSpecifier | undefined;
  const session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID,
    userModel: { profile: SCRIPTED_MODEL_PROFILE, config: SCRIPTED_MODEL_CONFIG },
    operateSession,
    ambientVendorIds: [VENDOR],
    usernamePrefix: operateSession ? "nowiki" : "buildwiki",
  });
  const account = session.connectedAccount(VENDOR);
  using workspace = session.workspace();
  using connection = await workspace.newGatekeeper(account.id, DEMO_WIKI);
  if (!connection) throw new Error("Could not connect the demo Wiki");
  wiki = { position: 0, length: 3, gatekeeperId: await connection.getId(),
           description: await connection.describe(), vendorId: VENDOR };
  // Outside the chat, the person's own connection still opens.
  using direct = await connection.openSession() as unknown as InferOpsWikiSession & Disposable;
  expect((await direct.listDocuments()).length).toBeGreaterThan(0);
  return { session, wiki };
}

/** What the agent was told its tool call `id` returned, read from the request that followed it. */
const toolResult = (id: string) => {
  for (const request of model.requests) {
    const { messages } = request as { messages: { role: string; tool_call_id?: string; content: string }[] };
    const found = messages.find(message => message.role === "tool" && message.tool_call_id === id);
    if (found) return found.content;
  }
  throw new Error(`No result recorded for tool call ${id}`);
};

it("neither offers nor requests the Wiki in an operate chat, and never reaches a pasted one", async () => {
  const { session, wiki } = await chat(true);
  await using _ = session;

  expect((await session.runTurn("What can I connect?")).outcome).toEqual({ status: "completed" });
  expect(toolResult("list")).toContain("project/board");
  expect(toolResult("list")).not.toMatch(/knowledge\/wiki|Wiki/);
  expect(toolResult("request")).toMatch(/Cannot request a connection.*not available in an operate chat/);

  const first = model.requests.length;
  expect((await session.runTurn("[0] read the handbook", { capsules: [wiki] })).outcome)
    .toEqual({ status: "completed" });
  expect(toolResult("describe")).toMatch(/not available in an operate chat/);
  expect(toolResult("describe")).not.toContain("InferOpsWikiSession");
  // The pasted Wiki is not in the env at all.
  expect(toolResult("read")).toMatch(/reading 'readDocumentText'/);
  expect(toolResult("read")).not.toContain("Team handbook");
  expect(JSON.parse(toolResult("env").split("\n").find(line => line.startsWith("["))!)).toEqual(["GIT"]);
  expect(toolResult("edit")).not.toContain("edited");
  expect((await session.listActions({ filter: "action" })).entries).toEqual([]);
  // Nothing from the Wiki reached the model.
  for (const request of model.requests.slice(first)) expect(JSON.stringify(request)).not.toContain("Team handbook");
});

it("still lets a Build chat read a pasted Wiki", async () => {
  const { session, wiki } = await chat(false);
  await using _ = session;
  expect((await session.runTurn("[0] count the pages", { capsules: [wiki] })).outcome)
    .toEqual({ status: "completed" });
  expect(Number(toolResult("build-read").trim())).toBeGreaterThan(0);
});
