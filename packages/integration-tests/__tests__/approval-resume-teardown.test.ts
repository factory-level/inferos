// IL-29-04 L2: an approval that lands while a turn's teardown still awaits a hook disable.
//
// The interval (decisions/2026-10-17-il-29-04-l2-interval-trace.md): a turn that ends on an awaited
// action persists its card, then its teardown reaps pending gadgets before clearing `activeAgent`.
// That reap awaits external I/O only for a pending gadget left reverted by an earlier reap that
// failed, with an enabled hook: `deleteHook` awaits the hook controller's `disable()`. An approval
// arriving during that await finds the card and posts its note, but returns because `activeAgent`
// is still set, and the teardown never re-checks.
//
// The seed is reached through product paths only (Step 0-prime, R1 PASS): a Build chat creates a
// gadget it never merges (provisional), binds and enables a hook on it, then reverts the creating
// change. The fixture's TestHookController refuses disable() twice and holds the third:
//   R   revertChanges' tail reap    -> call 1 refused  (the gadget and hook linger)
//   T3  the next turn's start reap  -> call 2 refused
//   T3  that turn's teardown reap   -> call 3 held, after the awaited write persisted its card
// No timer is asserted: completion is the idle chat plus the model's request count. Synthetic and
// local only (scripted model, test gatekeeper); no product code is changed for this proof.

import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AiChatMessage, Overseer } from "@gadgets/workshop-shared/api";
import {
  hookServer, startTestGatekeeperHarness, TEST_VENDOR_ID, testControl, type Harness,
} from "../src/harness.js";
import {
  SCRIPTED_MODEL_ID, scriptedModelRouter, type ChatCompletionStep, type RoutedScriptedModel,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, nextUsernames, signUp, waitFor, waitForIdleChat,
} from "../src/rpc-client.js";

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

const control = <T>(route: string, body: object) => testControl<T>(harness, route, body);
const disableCalls = (key: string) =>
  control<{ calls: number; rejected: number; completed: number }>("disable-calls", { key });

const watchCode = (key: string) => `import { restore } from "cloudflare:workers";
export default async function(self, env) {
  await env.TEST_AMBIENT.watch(${JSON.stringify(key)}, await env.HOOKED[restore]({ type: "value-hook" }));
}`;

const BUILD: ChatCompletionStep[] = [
  {
    toolCalls: [
      { id: "create", name: "createGadget", arguments: { title: "Lingering target", bindingName: "HOOKED" } },
      { id: "server", name: "writeFile", arguments: { workpiece: "HOOKED", filename: "server.js", content: hookServer("TEST_AMBIENT") } },
      { id: "bind", name: "setGadgetBinding", arguments: { gadget: "HOOKED", source: "TEST_AMBIENT", name: "TEST_AMBIENT" } },
    ],
  },
  { text: "Built." },
];
const watch = (key: string): ChatCompletionStep[] => [
  { toolCall: { id: "watch", name: "executeCode", arguments: { code: watchCode(key) } } },
  { text: "Watching." },
];
const WRITE: ChatCompletionStep = {
  toolCall: { id: "write", name: "executeCode", arguments: {
    code: "export default async function(self, env) { await env.TEST_AMBIENT.writeValue(7); }",
  } },
};
const STEP_2 = "Step 2: the value is applied.";

const APPROVAL_RESUME_NOTE = "The changes you submitted have been approved and applied";
const approvalResumeNotes = (history: AiChatMessage[]) => history.filter(message =>
  message.type === "message" && message.author.type !== "agent" &&
  message.message.startsWith(APPROVAL_RESUME_NOTE)).length;
const agentSaid = (history: AiChatMessage[], text: string) => history.filter(message =>
  message.type === "message" && message.author.type === "agent" && message.message === text).length;
const historyOf = async (ws: RpcStub<Overseer>, chat: number) => (await ws.getChatHistory(chat)).messages;
const pending = async (ws: RpcStub<Overseer>) => (await ws.listActions({ filter: "pending" })).entries;
const activeAgentOf = async (ws: RpcStub<Overseer>, chat: number) =>
  (await ws.listChats()).find(entry => entry.id === chat)?.activeAgent;

async function signedIn(prefix: string, model: RoutedScriptedModel) {
  const [username] = nextUsernames(prefix);
  const publicApi = connect(harness.url);
  const api = await signUp(publicApi, username!);
  await api.addModel(model.userModel.profile, model.userModel.config);
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  await waitFor("the ambient account", async () =>
    (await listConnectedAccounts(api)).find(a => a.vendorId === TEST_VENDOR_ID) ?? null);
  const ws = await api.newGadget();
  return { username: username!, publicApi, api, ws };
}

/**
 * The seed, then T3 up to the held teardown: returns once call 3 is held, with every A1
 * precondition asserted (a failed precondition fails the case; nothing is skipped).
 */
async function seedAndHoldTeardown(prefix: string) {
  const [user] = nextUsernames(`${prefix}k`);
  const key = `${user}:lingering`;
  const model = models.script([...BUILD, ...watch(key), WRITE, { text: STEP_2 }]);
  const session = await signedIn(prefix, model);
  const { ws } = session;

  // T1: build the gadget; never merge it, so it stays provisional to this chat.
  const chat = await ws.newChat("Build the gadget.", SCRIPTED_MODEL_ID);
  await waitFor("the build turn", async () => model.requests.length === 2 || null);
  await waitForIdleChat(ws, chat);
  const created = (await historyOf(ws, chat)).find(message => message.type === "changes");
  if (!created) throw new Error("T1 persisted no changes message to revert from");

  // T2, K1: the chat's own provisional gadget resolves as env.HOOKED[restore], so the hook binds.
  await ws.sendChatMessage(chat, "Watch the key.", SCRIPTED_MODEL_ID);
  await waitFor("the watch turn", async () => model.requests.length === 4 || null);
  await waitForIdleChat(ws, chat);
  const hook = (await ws.listHooks()).find(h => h.description.title === `Test hook ${key}`);
  expect(hook, "K1: a hook bound to an own-chat provisional gadget").toBeDefined();
  await ws.enableHook(hook!.id);
  expect(await disableCalls(key)).toEqual({ calls: 0, rejected: 0, completed: 0 });

  // R, K2: revert the creating change. Its tail reap calls disable() once; refused, so the
  // reverted gadget and its enabled hook linger.
  await control("fail-next-disable", { key, count: 2 });
  await ws.revertChanges(chat, created.sequence);
  expect(await disableCalls(key), "K2: the revert's reap called disable() once, refused")
      .toEqual({ calls: 1, rejected: 1, completed: 0 });
  expect((await ws.listHooks()).map(h => h.id), "K2: the hook lingers").toContain(hook!.id);

  // T3: its start reap is call 2 (refused); step 1's awaited write persists the card; the turn's
  // teardown reap is call 3, held.
  await control("hold-next-disable", { key });
  await ws.sendChatMessage(chat, "Set the test value to 7.", SCRIPTED_MODEL_ID);
  const [action] = await waitFor("the awaited write's card", async () => {
    const entries = await pending(ws);
    return entries.length === 1 ? entries : null;
  });
  await waitFor("the teardown's held disable", async () => (await disableCalls(key)).calls === 3 || null);

  // A1: every precondition of the L2 interval, at the moment of approval.
  expect(action, "A1: the card").toMatchObject({ requestedBy: "agent", description: { title: "Set the test value to 7" } });
  expect(await activeAgentOf(ws, chat), "A1: the turn is still active").toBeDefined();
  expect(await disableCalls(key), "A1: calls 1 and 2 refused, call 3 pending")
      .toEqual({ calls: 3, rejected: 2, completed: 0 });
  expect((await ws.listHooks()).map(h => h.id), "A1: the gadget's hook is still present").toContain(hook!.id);
  expect(model.requests).toHaveLength(5);
  return { ...session, model, chat, key, action: action! };
}

const close = (session: { ws: RpcStub<Overseer>; api: { [Symbol.dispose](): void }; publicApi: { [Symbol.dispose](): void } }) => {
  session.ws[Symbol.dispose]();
  session.api[Symbol.dispose]();
  session.publicApi[Symbol.dispose]();
};

describe("IL-29-04 L2: approval during a held teardown hook disable", () => {
  // The determinism loop: the same interleaving, three fresh users, the same outcome each time.
  for (const round of [1, 2, 3]) {
    it(`L2 (round ${round}): the approval posts its note once, and the turn is never resumed`, async () => {
      const s = await seedAndHoldTeardown(`l2r${round}`);
      try {
        await s.ws.approveAction(s.action.id);
        await control("release-disable", { key: s.key });
        await waitForIdleChat(s.ws, s.chat);

        const history = await historyOf(s.ws, s.chat);
        expect(approvalResumeNotes(history)).toBe(1);
        // T1 (2), T2 (2) and T3's step 1: a resume would request step 2 as the 6th.
        expect(s.model.requests, "step 2 was never requested").toHaveLength(5);
        expect(agentSaid(history, STEP_2)).toBe(0);
        expect(s.model.remainingSteps()).toBe(1);
        expect(await pending(s.ws)).toEqual([]);
        expect(await activeAgentOf(s.ws, s.chat)).toBeUndefined();
        expect(await disableCalls(s.key)).toEqual({ calls: 3, rejected: 2, completed: 1 });
      } finally {
        close(s);
      }
    });
  }

  it("A2(a): approving after the teardown finished, with the gadget lingering, resumes once", async () => {
    const s = await seedAndHoldTeardown("l2late");
    try {
      await control("release-disable", { key: s.key });
      await waitForIdleChat(s.ws, s.chat);
      await s.ws.approveAction(s.action.id);
      await waitFor("the resumed turn", async () => s.model.requests.length === 6 || null);
      await waitForIdleChat(s.ws, s.chat);

      const history = await historyOf(s.ws, s.chat);
      expect(approvalResumeNotes(history)).toBe(1);
      expect(agentSaid(history, STEP_2)).toBe(1);
      expect(s.model.requests).toHaveLength(6);
      expect(s.model.remainingSteps()).toBe(0);
      expect(await pending(s.ws)).toEqual([]);
    } finally {
      close(s);
    }
  });

  it("A2(b): with no gadget, approving after the turn ends resumes once", async () => {
    const model = models.script([WRITE, { text: STEP_2 }]);
    const s = await signedIn("l2plain", model);
    try {
      const chat = await s.ws.newChat("Set the test value to 7.", SCRIPTED_MODEL_ID);
      const [action] = await waitFor("the awaited write's card", async () => {
        const entries = await pending(s.ws);
        return entries.length === 1 ? entries : null;
      });
      await waitForIdleChat(s.ws, chat);
      expect(model.requests).toHaveLength(1);
      await s.ws.approveAction(action!.id);
      await waitFor("the resumed turn", async () => model.requests.length === 2 || null);
      await waitForIdleChat(s.ws, chat);

      const history = await historyOf(s.ws, chat);
      expect(approvalResumeNotes(history)).toBe(1);
      expect(agentSaid(history, STEP_2)).toBe(1);
      expect(model.remainingSteps()).toBe(0);
      expect(await pending(s.ws)).toEqual([]);
    } finally {
      close(s);
    }
  });
});
