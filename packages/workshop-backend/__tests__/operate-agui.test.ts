import { expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { runAgent } from "../src/agent";
import type { OverseerDurableObject } from "../src/overseer";
import type { UserDurableObject } from "../src/user";
import { INITIAL_OPERATE_PAGE } from "@gadgets/workshop-shared/operate-session";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

it("reserves both selectors per person, rejects concurrent/restarted retries and retains binding", async () => {
  const name = crypto.randomUUID();
  const a = env.TEST_USER.getByName(name);
  const reserve = async (thread: string, run: string) => {
    try { await a.reserveOperateReadRun(thread, run); return "reserved"; }
    catch { return "duplicate"; }
  };
  expect(await Promise.all([reserve("thread", "run"), reserve("thread", "run")]))
    .toEqual(["reserved", "duplicate"]);
  await a.bindOperateReadRun("thread", 17);
  expect(await reserve("other", "run")).toBe("duplicate");
  expect(await reserve("thread", "other")).toBe("duplicate");
  await env.TEST_USER.getByName(`${name}-other`).reserveOperateReadRun("thread", "run");
  await abortAllDurableObjects();
  expect(await reserve("thread", "run")).toBe("duplicate");
});

it("offers only page read and refuses hostile tools and navigation at execution in the real agent loop", async () => {
  const stub = env.TEST_OVERSEER.getByName(`agui-policy-${crypto.randomUUID()}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    // Same inspection seam as console-agent-tools.test.ts; actual stored context drives runAgent.
    const impl = (instance as unknown as {impl: any}).impl;
    impl.ownerId = "owner";
    impl.users = {idFromString: (id: string) => id, get: () => ({listGatekeeperVendors: async () => []})};
    impl.storage.operateSession.put(true);
    impl.storage.chatMeta.put({id: 1, title: "Read", started: new Date(0), lastActive: new Date(0)});
    impl.storage.chatContext.put({chatId: 1, operateReadOnly: true, bindings: {}, alwaysAvailableCapsuleIds: []});
    let reads = 0;
    impl.operatePage = async (event: unknown) => {
      expect(event).toBeUndefined(); ++reads;
      return {seq: 0, state: INITIAL_OPERATE_PAGE};
    };
    const faux = createFauxCore({models: [{id: "faux-model"}]});
    const offered: string[][] = [];
    const steps = [
      ...["executeCode", "requestConnection", "callConsoleTool", "writeFile"].map(name =>
        fauxAssistantMessage([fauxToolCall(name, {code: "write()"})], {stopReason: "toolUse"})),
      fauxAssistantMessage([fauxToolCall("operatePage", {action: "showHome"})], {stopReason: "toolUse"}),
      fauxAssistantMessage([fauxToolCall("operatePage", {})], {stopReason: "toolUse"}),
      fauxAssistantMessage(fauxText("Read only.")),
    ];
    faux.setResponses(steps.map(step => (context: TranscriptContext) => {
      offered.push(getCurrentTools(context.messages).map(tool => tool.name)); return step;
    }));
    const person = {type: "user" as const, id: "alice", name: "Alice"};
    impl.storage.chats.put({chatId: 1, sequence: impl.nextChatSequence(1), timestamp: new Date(),
      author: person, type: "message", message: "Go"});
    await runAgent(impl, {model: faux.getModel(), stream: faux.stream}, 1,
      {type: "agent", id: "faux-model", name: "Faux"}, new AbortController().signal, person,
      {provider: "cloudflare", model: "faux-model", apiToken: ""} as any);
    expect(offered).toHaveLength(7);
    for (const tools of offered) expect(tools).toEqual(["operatePage"]);
    expect(reads).toBe(1);
    expect([...impl.storage.actions.list()]).toEqual([]);
    expect(impl.storage.chatContext.get(1).operateReadOnly).toBe(true);
  });
});
