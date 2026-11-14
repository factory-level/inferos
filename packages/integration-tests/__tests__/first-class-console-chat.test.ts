// The chat that helps author a console that belongs to no workspace (ADR 0021). It runs in the
// person's hidden console assistant workspace, bound to one console, and its tools change that
// console's pages and draft as the person whose message started the turn, checked by the console at
// every call. It reaches no workspace, builds no software and publishes nothing. Driven by a
// scripted model, never a live one.
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AuthenticatedApi } from "@gadgets/workshop-shared/api";
import type { RpcStub } from "capnweb";
import { openAgentSession } from "../src/agent-session.js";
import { startHarness, type Harness } from "../src/harness.js";
import {
  scriptedChatCompletions, SCRIPTED_MODEL_CONFIG, SCRIPTED_MODEL_ID, SCRIPTED_MODEL_PROFILE,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, logIn, nextUsernames, signUp } from "../src/rpc-client.js";

const call = (id: string, name: string) => ({ toolCall: { id, name, arguments: {} as Record<string, unknown> } });

const addPage = call("helper-add-page", "editCanvas");
const readConsole = call("helper-read-console", "editConsole");
const addView = call("helper-add-view", "editConsole");
const whileAuthor = call("helper-while-author", "editCanvas");
const afterRemoval = call("helper-after-removal", "editCanvas");

// One script, consumed in test order.
const model = scriptedChatCompletions([
  addPage, readConsole, addView, { text: "Added a Dispatch page and put it in the navigation." },
  whileAuthor, { text: "Added a Handover page." },
  afterRemoval, { text: "I can no longer change this console." },
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

/** What the agent was told its tool call `id` returned, read from the request that followed it. */
const toolResult = (id: string) => {
  for (const request of model.requests) {
    const { messages } = request as { messages: { role: string; tool_call_id?: string; content: string }[] };
    const found = messages.find(message => message.role === "tool" && message.tool_call_id === id);
    if (found) return found.content;
  }
  throw new Error(`No result recorded for tool call ${id}`);
};

/** The tools the model was offered in its first request. */
const offeredTools = () => ((model.requests[0] as { tools?: { function: { name: string } }[] }).tools ?? [])
  .map(tool => tool.function.name).toSorted();

it("adds a page and a view to its console, as the person's own controls would, and is offered nothing else", async () => {
  let consoleId = "";
  await using session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID, userModel: { profile: SCRIPTED_MODEL_PROFILE, config: SCRIPTED_MODEL_CONFIG },
    consoleAssistant: async (api: RpcStub<AuthenticatedApi>) => consoleId = (await api.newConsole("Field operations")).id,
  });
  using publicApi = connect(harness.url);
  using person = await logIn(publicApi, session.username);
  using authoring = await person.openConsoleAuthoring(consoleId);
  const [overview] = await authoring.listCanvases();

  Object.assign(addPage.toolCall.arguments, { title: "Dispatch", operations: [] });
  Object.assign(readConsole.toolCall.arguments, {});
  // The scripted model can't read a tool result, so the test fills the next call in once the page exists.
  const filled = (async () => {
    for (;;) {
      const dispatch = (await authoring.listCanvases()).find(page => page.title === "Dispatch");
      if (dispatch) {
        Object.assign(addView.toolCall.arguments, { expectedRevision: "0", views: [
          { id: "overview", title: "Overview", type: "screen", screen: overview.id },
          { id: "dispatch", title: "Dispatch", type: "screen", screen: dispatch.id },
        ] });
        return dispatch;
      }
      await new Promise(done => setTimeout(done, 20));
    }
  })();
  const result = await session.runTurn("Add a Dispatch page and put it in the navigation.");
  expect(result.outcome).toEqual({ status: "completed" });
  const dispatch = await filled;

  // The page is the console's own, and the draft now shows it; nothing was published.
  expect(JSON.parse(toolResult("helper-add-page"))).toMatchObject({ success: true, canvas: { title: "Dispatch" } });
  expect(JSON.parse(toolResult("helper-read-console"))).toMatchObject({ console: { revision: "0", published: null } });
  const draft = await authoring.getConsole("draft");
  expect(draft).toMatchObject({ revision: "1", published: null,
    views: [{ id: "overview" }, { id: "dispatch", screen: dispatch.id }] });
  expect(await authoring.getConsole("published")).toBeNull();

  // It was offered the console's tools and nothing that builds software or reaches a workspace.
  expect(offeredTools()).toEqual(["editCanvas", "editConsole", "listCanvases"]);
  // The hidden host holds no page of its own, and is not among the person's workspaces.
  expect(await session.workspace().listCanvases()).toEqual([]);
  expect(await person.listGadgets()).toEqual([]);
  // A chat bound to no console can't be started there, so nothing in the host has a workspace's tools.
  await expect(session.workspace().newChat("Build me an app", SCRIPTED_MODEL_ID)).rejects.toThrow(/creator/);
});

it("starts only for a console the caller may author, only in their own assistant, and stops when they lose it", async () => {
  using publicApi = connect(harness.url);
  using owner = await signUp(publicApi, nextUsernames("fcchatowner")[0]!);
  const { id } = await owner.newConsole("Dispatch");
  using authoring = await owner.openConsoleAuthoring(id);

  // The session's person is added as an author of the owner's console, and their helper is bound to it.
  await using session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID, userModel: { profile: SCRIPTED_MODEL_PROFILE, config: SCRIPTED_MODEL_CONFIG },
    usernamePrefix: "fcchatauthor",
    consoleAssistant: async (api: RpcStub<AuthenticatedApi>) => {
      expect(await authoring.addCollaborator((await api.whoami()).id, "build")).toMatchObject({ role: "build" });
      return id;
    },
  });
  using author = await logIn(publicApi, session.username);

  // A helper starts only in the person's own console assistant, never in another workspace.
  using workspace = await author.newGadget();
  await expect(workspace.newConsoleAssistantChat(id, "Change it", SCRIPTED_MODEL_ID)).rejects.toThrow(/console assistant/);

  // While they are an author, their helper writes to the owner's console as them.
  Object.assign(whileAuthor.toolCall.arguments, { title: "Handover", operations: [] });
  expect((await session.runTurn("Add a Handover page.")).outcome).toEqual({ status: "completed" });
  expect((await authoring.listCanvases()).map(page => page.title).toSorted()).toEqual(["Handover", "Overview"]);

  // Removed from the console, the same chat's next write is refused by the console itself, which
  // reads the role of the person whose message started the turn. Nothing is written, and no new
  // helper can be started for it.
  await authoring.removeCollaborator(session.username);
  Object.assign(afterRemoval.toolCall.arguments, { title: "Should not exist", operations: [] });
  expect((await session.runTurn("Add another page.")).outcome).toEqual({ status: "completed" });
  expect(toolResult("helper-after-removal")).toMatch(/access/);
  using assistant = await author.openConsoleAssistant();
  await expect(assistant.newConsoleAssistantChat(id, "Change it", SCRIPTED_MODEL_ID)).rejects.toThrow(/access/);
  expect((await authoring.listCanvases()).map(page => page.title).toSorted()).toEqual(["Handover", "Overview"]);
});
