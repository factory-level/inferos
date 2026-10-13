// No workflow policy through the operate chat (MVP-18, slice 07 contract §6.7): the operate agent is
// never offered an InferOps workflow-policy binding as a connectable resource, cannot request one,
// and cannot reach one through generic `executeCode` or `describeBinding` even when the person
// connected one in their session workspace and pasted it into the chat. The kind is excluded by its
// `SupportedResource.excludeFromOperateChat`, which the kernel enforces. The same connection still
// opens for the person outside the chat, and a Build chat still reads it. The real Workshop and
// InferOps gatekeeper on its demo data (workflow policies switched on for this harness only), with a
// scripted model. Modelled on `operate-chat-no-wiki.test.ts`.

import { afterAll, beforeAll, expect, it } from "vitest";
import { resolve } from "node:path";
import type { CapsuleSpecifier } from "@gadgets/workshop-shared/api";
import type { InferOpsWorkflowPolicySession } from "../../../custom-gatekeepers/gatekeeper-inferops/src/types.js";
import { openAgentSession, type WorkshopAgentSession } from "../src/agent-session.js";
import { startHarness, type Harness } from "../src/harness.js";
import {
  scriptedChatCompletions, SCRIPTED_MODEL_CONFIG, SCRIPTED_MODEL_ID, SCRIPTED_MODEL_PROFILE,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";

const INFEROPS_GATEKEEPER_DIR =
  resolve(import.meta.dirname, "../../../custom-gatekeepers/gatekeeper-inferops");
const VENDOR = "inferops";
const DEMO_WORKFLOW = "inferops://demo.local/project/workflow/DEMO";
/** The demo policy's lane and rule names: none may reach an operate chat's model. */
const POLICY_TEXT = ["owners-all", "no-agent-publish", "draft-to-published", "Drafting"];

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
      arguments: {
        vendorId: VENDOR, resourceUrl: DEMO_WORKFLOW, reason: "Read the policy", bindingName: "INFEROPS_WORKFLOW_POLICY",
      },
    },
  },
  { text: "The workflow policy isn't available here." },
  // Operate: a pasted binding, through every generic route.
  { toolCall: { id: "describe", name: "describeBinding", arguments: { name: "INFEROPS_WORKFLOW_POLICY" } } },
  run("read", `console.log(JSON.stringify(await env.INFEROPS_WORKFLOW_POLICY.readWorkflowPolicy()));`),
  run("env", `console.log(JSON.stringify(Object.keys(env).sort()));`),
  { text: "I can't use the workflow policy in this chat." },
  // Build: the same kind of paste works.
  run("build-read", `console.log((await env.INFEROPS_WORKFLOW_POLICY.readWorkflowPolicy()).revision);`),
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
        // The kind is off by default; this harness turns it on so the exclusion, not the switch, is tested.
        config.vars = { ...config.vars, INFEROPS_WORKFLOW_POLICY_ENABLED: "true" };
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
async function chat(operateSession: boolean): Promise<{ session: WorkshopAgentSession; policy: CapsuleSpecifier }> {
  const session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID,
    userModel: { profile: SCRIPTED_MODEL_PROFILE, config: SCRIPTED_MODEL_CONFIG },
    operateSession,
    ambientVendorIds: [VENDOR],
    usernamePrefix: operateSession ? "nowfp" : "buildwfp",
  });
  const account = session.connectedAccount(VENDOR);
  using workspace = session.workspace();
  using connection = await workspace.newGatekeeper(account.id, DEMO_WORKFLOW);
  if (!connection) throw new Error("Could not connect the demo workflow policy");
  const policy = { position: 0, length: 3, gatekeeperId: await connection.getId(),
                   description: await connection.describe(), vendorId: VENDOR };
  // Outside the chat, the person's own connection still opens.
  using direct = await connection.openSession() as unknown as InferOpsWorkflowPolicySession & Disposable;
  expect((await direct.readWorkflowPolicy()).revision).toBe("3");
  return { session, policy };
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

it("neither offers nor requests a workflow policy in an operate chat, and never reaches a pasted one", async () => {
  const { session, policy } = await chat(true);
  await using _ = session;

  expect((await session.runTurn("What can I connect?")).outcome).toEqual({ status: "completed" });
  expect(toolResult("list")).toContain("project/board");
  expect(toolResult("list")).not.toMatch(/project\/workflow|workflow policy/i);
  expect(toolResult("request")).toMatch(/Cannot request a connection.*not available in an operate chat/);

  const first = model.requests.length;
  expect((await session.runTurn("[0] read the policy", { capsules: [policy] })).outcome)
    .toEqual({ status: "completed" });
  expect(toolResult("describe")).toMatch(/not available in an operate chat/);
  expect(toolResult("describe")).not.toContain("InferOpsWorkflowPolicySession");
  // The pasted binding is not in the env at all.
  expect(toolResult("read")).toMatch(/reading 'readWorkflowPolicy'/);
  expect(JSON.parse(toolResult("env").split("\n").find(line => line.startsWith("["))!)).toEqual(["GIT"]);
  expect((await session.listActions({ filter: "action" })).entries).toEqual([]);
  // Nothing from the policy reached the model.
  for (const request of model.requests.slice(first)) {
    for (const text of POLICY_TEXT) expect(JSON.stringify(request)).not.toContain(text);
  }
});

it("still lets a Build chat read a pasted workflow policy", async () => {
  const { session, policy } = await chat(false);
  await using _ = session;
  expect((await session.runTurn("[0] read the policy revision", { capsules: [policy] })).outcome)
    .toEqual({ status: "completed" });
  expect(toolResult("build-read").trim()).toBe("3");
});
