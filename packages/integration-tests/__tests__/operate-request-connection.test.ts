// An Operate chat asking for a new connection (MVP-09, no authoring): the operate agent's
// requestConnection creates a pending request and ends its turn, with nothing bound. Denying it
// binds nothing and the agent stays stopped; accepting it binds exactly the one requested name and
// resumes the agent once. The Build-chat version of this flow is workshop-connections.test.ts; this
// runs it from an operate session.
//
// The real Workshop with the test gatekeeper, a scripted model and synthetic identities. The
// agent's env is read from inside its own executeCode, before and after the decision.

import { afterAll, beforeAll, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type { AiChatMessage, Overseer } from "@gadgets/workshop-shared/api";
import { loadAllChatHistory, openAgentSession } from "../src/agent-session.js";
import { startTestGatekeeperHarness, TEST_VENDOR_ID, type Harness } from "../src/harness.js";
import {
  SCRIPTED_MODEL_ID, scriptedModelRouter, type ChatCompletionStep, type RoutedScriptedModel,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, logIn, waitForIdleChat } from "../src/rpc-client.js";

let harness: Harness;
const models = scriptedModelRouter();
const network = new NetworkInterceptor({ handlers: [models.handler] });

beforeAll(async () => {
  network.install();
  harness = await startTestGatekeeperHarness({ enableGadgetExecution: true });
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

const REQUEST = {
  vendorId: TEST_VENDOR_ID,
  resourceUrl: "https://gadgets-test.example/things/requested",
  reason: "Read the requested test value.",
  bindingName: "REQUESTED_THING",
};
const requestConnection: ChatCompletionStep = {
  toolCall: { id: "request", name: "requestConnection", arguments: REQUEST },
};
/** The agent reports the names in its own env, as a marked string the test reads back. */
const listEnv = (id: string): ChatCompletionStep => ({
  toolCall: {
    id,
    name: "executeCode",
    arguments: {
      code: "export default async function(self, env) { " +
        // The marker is assembled at run time, so only the RESULT carries it, never the code text.
        `return 'ENV' + 'KEYS[${id}]:' + Object.keys(env).sort().join(',') + ':' + 'END'; }`,
    },
  },
});

/** The env listing the step `id` returned, as sent back to the model (later requests repeat it). */
function envListing(model: RoutedScriptedModel, id: string): string[] {
  const match = new RegExp(`ENVKEYS\\[${id}\\]:([^:]*?):END`).exec(JSON.stringify(model.requests));
  if (!match) throw new Error(`No env listing from ${id}`);
  return match[1]!.split(",").filter(Boolean);
}

/** The operate session's own workspace, opened as its owner (the operate interface). */
async function withOperateWorkspace<T>(username: string, fn: (ws: RpcStub<Overseer>) => Promise<T>): Promise<T> {
  using publicApi = connect(harness.url);
  using api = await logIn(publicApi, username);
  using session = await api.getOperateSession();
  using ws = await session.getWorkspace();
  return await fn(ws);
}

const openOperate = (model: RoutedScriptedModel, usernamePrefix: string) =>
  openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID,
    userModel: model.userModel,
    ambientVendorIds: [TEST_VENDOR_ID],
    usernamePrefix,
    operateSession: true,
  });

function connectionCard(history: AiChatMessage[]) {
  const card = history.find(message => message.type === "connectionRequest");
  if (!card || card.type !== "connectionRequest") throw new Error("The agent did not create a connection request");
  return card;
}

/** The request is pending, nothing is bound yet, and the operate turn ended at the request. */
async function requestAndPause(model: RoutedScriptedModel, username: string, runTurn: () => Promise<{
  outcome: unknown; history: AiChatMessage[];
}>) {
  const first = await runTurn();
  expect(first.outcome).toEqual({ status: "completed" });
  // One request listed the env, the next asked for the connection; no third request followed.
  expect(model.requests).toHaveLength(2);
  const pending = connectionCard(first.history);
  expect(pending).toMatchObject({
    state: "pending", vendorId: REQUEST.vendorId, resourceUrl: REQUEST.resourceUrl, bindingName: REQUEST.bindingName,
  });
  const before = envListing(model, "env-before");
  expect(before).not.toContain(REQUEST.bindingName);
  // Still paused a moment later: the turn does not continue before a decision.
  await new Promise(resolve => setTimeout(resolve, 1_000));
  expect(model.requests).toHaveLength(2);
  await withOperateWorkspace(username, async ws => {
    expect((await ws.listChats()).find(chat => chat.id === pending.chatId)?.activeAgent).toBeUndefined();
  });
  return { pending, before };
}

it.concurrent("an operate agent's denied connection request binds nothing and the agent stays stopped", async () => {
  const model = models.script([listEnv("env-before"), requestConnection, listEnv("env-after"), { text: "Done." }]);
  await using session = await openOperate(model, "operaterequestdeny");
  const { pending, before } = await requestAndPause(model, session.username,
    () => session.runTurn("Connect the requested thing."));

  await withOperateWorkspace(session.username, async ws => {
    await ws.denyConnectionRequest(pending.requestId);
    const history = await loadAllChatHistory(b => ws.getChatHistory(pending.chatId, b));
    expect(connectionCard(history)).toMatchObject({ state: "denied" });
    expect((await ws.listChats()).find(chat => chat.id === pending.chatId)?.activeAgent).toBeUndefined();
  });
  // Denial woke no agent turn.
  expect(model.requests).toHaveLength(2);

  // A later turn's env still has nothing new.
  const next = await session.runTurn("List your env.");
  expect(next.outcome).toEqual({ status: "completed" });
  const after = envListing(model, "env-after");
  expect(after).not.toContain(REQUEST.bindingName);
  expect(after).toEqual(before);
  expect(model.remainingSteps()).toBe(0);
});

it.concurrent("an operate agent's accepted connection request binds exactly the requested name and resumes once", async () => {
  const model = models.script([listEnv("env-before"), requestConnection, listEnv("env-after"), { text: "Connected." }]);
  await using session = await openOperate(model, "operaterequestaccept");
  const { pending, before } = await requestAndPause(model, session.username,
    () => session.runTurn("Connect the requested thing."));

  await withOperateWorkspace(session.username, async ws => {
    const account = session.connectedAccount(TEST_VENDOR_ID);
    using chosen = await ws.newGatekeeper(account.id, "https://gadgets-test.example/things/chosen");
    if (!chosen) throw new Error("Failed to create the test connection");
    const chosenId = await chosen.getId();
    await ws.acceptConnectionRequest(pending.requestId, { gatekeeperId: chosenId });
    await waitForIdleChat(ws, pending.chatId);
    const history = await loadAllChatHistory(b => ws.getChatHistory(pending.chatId, b));
    expect(connectionCard(history)).toMatchObject({
      state: "accepted", gatekeeperId: chosenId, bindingName: REQUEST.bindingName,
    });
  });

  // The acceptance resumed the agent exactly once: it listed its env, then finished.
  expect(model.requests).toHaveLength(4);
  expect(JSON.stringify(model.requests[2])).toContain("accepted your connection request");
  const after = envListing(model, "env-after");
  expect(after.filter(name => !before.includes(name)), JSON.stringify({ before, after })).toEqual([REQUEST.bindingName]);
  expect(before.filter(name => !after.includes(name))).toEqual([]);
  expect(model.remainingSteps()).toBe(0);
});
