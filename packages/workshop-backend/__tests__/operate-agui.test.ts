import { MAX_READ_GENERATION, newReadRunSelectors, parseReadRunSelectors } from "@gadgets/workshop-shared/operate-read-run";
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

// The actual User DO/storage is exercised; only inspection/fault injection uses this test seam.
const storeOf = (instance: UserDurableObject) => (instance as unknown as {storage: any}).storage;
const refusal = async (operation: PromiseLike<unknown>) => {
  try { await operation; return "accepted"; } catch (error) { return (error as Error).message; }
};
const ids = (generation = 1n) => newReadRunSelectors(generation);
const reserve = async (user: DurableObjectStub<UserDurableObject>, pair: ReturnType<typeof ids>) =>
  user.reserveOperateReadRun(pair.threadId, pair.runId);

it("keeps thread/run uniqueness across restart and person isolation", async () => {
  const name = crypto.randomUUID();
  let user = env.TEST_USER.getByName(name);
  const pair = await user.prepareOperateReadRun();
  const outcomes = await Promise.allSettled([reserve(user, pair), reserve(user, pair)]);
  expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.find(result => result.status === "rejected")).toMatchObject({reason: {message: "RUN_ALREADY_RESERVED"}});
  await user.bindOperateReadRun(pair.threadId, 17);
  expect(await refusal(reserve(user, {...ids(), runId: pair.runId}))).toBe("RUN_ALREADY_RESERVED");
  expect(await refusal(reserve(user, {...ids(), threadId: pair.threadId}))).toBe("RUN_ALREADY_RESERVED");
  await reserve(env.TEST_USER.getByName(`${name}-other`), pair);
  await abortAllDurableObjects();
  user = env.TEST_USER.getByName(name);
  expect(await refusal(reserve(user, pair))).toBe("RUN_ALREADY_RESERVED");
  await runInDurableObject(user, instance => expect(storeOf(instance).operateReadGenerationRuns.get(pair.threadId).chatId).toBe(17));
});

// Four full 256-reservation generations and four DO restarts took 5.4s under measured contention.
// Give this invariant test a bounded 30s budget; it does not assert a 5s product latency SLO.
it("rotates bounded generations after failed setup, fences late binds and never re-admits retired identities", async () => {
  const name = crypto.randomUUID();
  let user = env.TEST_USER.getByName(name);
  const retired: ReturnType<typeof ids>[] = [];
  for (let generation = 1n; generation <= 4n; ++generation) {
    const first = await user.prepareOperateReadRun();
    expect(parseReadRunSelectors(first.threadId, first.runId)).toBe(generation);
    retired.push(first);
    await reserve(user, first);
    await runInDurableObject(user, async instance => {
      for (let i = 1; i < 255; ++i) {
        const pair = ids(generation); await instance.reserveOperateReadRun(pair.threadId, pair.runId);
      }
    });
    const final = await Promise.allSettled([reserve(user, ids(generation)), reserve(user, ids(generation))]);
    expect(final.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(final.find(result => result.status === "rejected")).toMatchObject({reason: {message: "RUN_CAPACITY_EXHAUSTED"}});
    const prepared = await Promise.all([user.prepareOperateReadRun(), user.prepareOperateReadRun()]);
    for (const pair of prepared) expect(parseReadRunSelectors(pair.threadId, pair.runId)).toBe(generation + 1n);
    // An already admitted call can finish after retirement, without resurrecting the reservation.
    await user.bindOperateReadRun(first.threadId, 17);
    await abortAllDurableObjects(); user = env.TEST_USER.getByName(name);
    for (const pair of retired) expect(await refusal(reserve(user, pair))).toBe("RUN_GENERATION_RETIRED");
    await runInDurableObject(user, (instance, state) => {
      const storage = storeOf(instance);
      // Underlying KV includes primary rows and unique indexes: no retired tombstones accumulate.
      expect([...state.storage.kv.list({prefix: "operateRead"})].map(([key]) => key)).toEqual(["operateReadGeneration"]);
      expect([...storage.operateReadGenerationRuns.list()]).toEqual([]);
      for (const pair of retired) {
        expect(storage.operateReadGenerationRuns.get(pair.threadId)).toBeUndefined();
        expect(storage.operateReadGenerationRuns.byRun.get(pair.runId)).toBeUndefined();
      }
      expect(storage.operateReadGeneration.get()).toBe(String(generation + 1n));
    });
  }
  await reserve(user, await user.prepareOperateReadRun());
}, 30_000);

it("rolls back boundary and every deleted row/index on a real storage transaction failure", async () => {
  const name = crypto.randomUUID();
  let user = env.TEST_USER.getByName(name);
  const first = ids();
  await reserve(user, first);
  await runInDurableObject(user, async instance => {
    for (let i = 1; i < 256; ++i) {const pair = ids(); await instance.reserveOperateReadRun(pair.threadId, pair.runId);}
    const storage = storeOf(instance);
    const put = storage.operateReadGeneration.put;
    storage.operateReadGeneration.put = (value: string) => {put(value); throw new Error("injected before commit");};
    try { expect(await refusal(instance.prepareOperateReadRun())).toBe("injected before commit"); }
    finally {storage.operateReadGeneration.put = put;}
  });
  await abortAllDurableObjects(); user = env.TEST_USER.getByName(name);
  await runInDurableObject(user, instance => {
    const storage = storeOf(instance);
    expect(storage.operateReadGeneration.get()).toBe("1");
    const rows = [...storage.operateReadGenerationRuns.list()];
    expect(rows).toHaveLength(256);
    for (const row of rows) expect(storage.operateReadGenerationRuns.byRun.get(row.runId)).toEqual(row);
  });
  expect(await refusal(reserve(user, first))).toBe("RUN_ALREADY_RESERVED");
  const next = await user.prepareOperateReadRun();
  await abortAllDurableObjects(); user = env.TEST_USER.getByName(name);
  await reserve(user, next);
  expect(await refusal(reserve(user, first))).toBe("RUN_GENERATION_RETIRED");
});

it("retains only existing legacy bindings and refuses legacy/mixed/future/malformed selectors", async () => {
  const user = env.TEST_USER.getByName(crypto.randomUUID());
  await runInDurableObject(user, instance => storeOf(instance).operateReadRuns.put({threadId: "legacy", runId: "legacy"}));
  await user.bindOperateReadRun("legacy", 42);
  expect(await refusal(user.bindOperateReadRun("missing", 42))).toBe("RUN_ALREADY_RESERVED");
  expect(await refusal(user.reserveOperateReadRun("legacy", "legacy"))).toBe("READ_RUN_UPGRADE_REQUIRED");
  expect(await refusal(user.reserveOperateReadRun("unused", "unused"))).toBe("READ_RUN_UPGRADE_REQUIRED");
  expect(await refusal(reserve(user, ids(2n)))).toBe("RUN_GENERATION_INVALID");
  expect(await refusal(reserve(user, {...ids(), runId: ids(2n).runId}))).toBe("RUN_GENERATION_INVALID");
  expect(await refusal(reserve(user, {...ids(), threadId: "or2:01:t:invalid"}))).toBe("UNSUPPORTED_READ_INPUT");
  expect(await refusal(user.bindOperateReadRun(ids().threadId, 42))).toBe("RUN_ALREADY_RESERVED");
  await runInDurableObject(user, instance => {
    expect([...storeOf(instance).operateReadGenerationRuns.list()]).toEqual([]);
    expect([...storeOf(instance).operateReadRuns.list()]).toEqual([{threadId: "legacy", runId: "legacy", chatId: 42}]);
  });
});

it("uses exact uint64 boundaries above Number precision and fails closed on overflow/oversized legacy state", async () => {
  for (const generation of [9_007_199_254_740_993n, MAX_READ_GENERATION]) {
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    await runInDurableObject(user, async instance => {
      storeOf(instance).operateReadGeneration.put(String(generation));
      for (let i = 0; i < 256; ++i) {const pair = ids(generation); await instance.reserveOperateReadRun(pair.threadId, pair.runId);}
    });
    if (generation === MAX_READ_GENERATION) expect(await refusal(user.prepareOperateReadRun())).toBe("READ_RUN_STORAGE_REFUSED");
    else {
      const next = await user.prepareOperateReadRun();
      expect(parseReadRunSelectors(next.threadId, next.runId)).toBe(generation + 1n);
      await reserve(user, next);
      expect(await refusal(reserve(user, ids(generation)))).toBe("RUN_GENERATION_RETIRED");
    }
  }
  const user = env.TEST_USER.getByName(crypto.randomUUID());
  await runInDurableObject(user, instance => {
    for (let i = 0; i < 257; ++i) storeOf(instance).operateReadRuns.put({threadId: `legacy-${i}`, runId: `legacy-${i}`});
  });
  expect(await refusal(user.prepareOperateReadRun())).toBe("READ_RUN_STORAGE_REFUSED");
  expect(await refusal(reserve(user, ids()))).toBe("READ_RUN_STORAGE_REFUSED");
});

it.each(["0", "01", "18446744073709551616", "corrupt", 1])("refuses invalid persisted generation %j", async value => {
  const user = env.TEST_USER.getByName(crypto.randomUUID());
  await runInDurableObject(user, instance => storeOf(instance).operateReadGeneration.put(value));
  expect(await refusal(user.prepareOperateReadRun())).toBe("READ_RUN_STORAGE_REFUSED");
  expect(await refusal(reserve(user, ids()))).toBe("READ_RUN_STORAGE_REFUSED");
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
