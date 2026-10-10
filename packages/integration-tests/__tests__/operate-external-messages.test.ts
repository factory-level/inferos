// The external-message path cannot reach an operate chat (callable-widget contract, revision 11):
// the gateway finds its workspace by name, and an operate workspace's id is a unique id. So an
// external message naming the operate workspace's id lands in a new workspace of its own, and the
// operate workspace's chats and external chats are untouched. A tainted operate chat therefore has
// no external response target its reply could leave through.

import { afterAll, beforeAll, expect, it } from "vitest";
import type { SubmitExternalMessageResult } from "@gadgets/workshop-shared/external-message-gateway";
import { openAgentSession } from "../src/agent-session.js";
import { startTestGatekeeperHarness, testControl, type Harness } from "../src/harness.js";
import { SCRIPTED_MODEL_ID, scriptedModelRouter } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { waitFor } from "../src/rpc-client.js";

let harness: Harness;
const models = scriptedModelRouter();
const network = new NetworkInterceptor({ handlers: [models.handler] });

beforeAll(async () => {
  network.install();
  harness = await startTestGatekeeperHarness();
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

it("an external message naming the operate workspace lands in a workspace of its own", async () => {
  const model = models.script([{ text: "External reply." }]);
  await using session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID,
    userModel: model.userModel,
    operateSession: true,
    usernamePrefix: "operateext",
  });
  using operate = session.workspace();
  const { id: operateId } = await operate.getMetadata();
  const chatsBefore = await operate.listChats();

  const messageKey = `${session.username}-m1`;
  const result = await testControl<SubmitExternalMessageResult>(harness, "submit-external-message", {
    callerEmail: session.username,
    gadgetKey: operateId,
    chatKey: `${session.username}-chat`,
    messageKey,
    gadgetTitle: "External",
    prompt: "Hello",
  });
  if (!result.accepted) throw new Error(`External message was rejected: ${result.message}`);

  const { gadgetId } = await testControl<{ gadgetId: string }>(
      harness, "external-gadget-id", { gadgetKey: operateId });
  expect(gadgetId).not.toBe(operateId);
  expect(result.chatPath).toMatch(new RegExp(`^/workspace/${gadgetId}\\?chat=`));
  expect(result.chatPath).not.toContain(operateId);

  // The reply went out from the new workspace's chat.
  await waitFor("the external reply", async () => {
    const { responses } = await testControl<{ responses: { text: string }[] }>(
        harness, "gadget-responses", { messageKey });
    return responses.length > 0 ? responses : null;
  });
  expect(await operate.listChats()).toEqual(chatsBefore);
  expect(model.remainingSteps()).toBe(0);
});
