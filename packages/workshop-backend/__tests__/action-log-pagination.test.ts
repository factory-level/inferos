import { describe, expect, it, vi } from "vitest";
import type { RpcStub } from "capnweb";
import type { ActionLogEntry, ActionsSubscriber } from "@gadgets/workshop-shared/api";
import { ACTION_HISTORY_PAGE_DEFAULT_LIMIT, ACTION_REPLAY_PAGE_SIZE } from "../src/overseer.js";
import { makeMockStorage } from "./mock-storage.js";
import {
  FIXTURE_EPOCH, makeActionStorage, makePreIndexActionStorage, openFakeOverseer, putAction,
} from "./fixtures.js";

vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));

// Hand-rolled ActionsSubscriber stub. `events` interleaves entry ids with "ready", so tests can
// assert both content and ordering of the delivered stream.
function makeSubscriber(entry?: (record: ActionLogEntry) => Promise<void>) {
  let events: Array<number | "ready"> = [];
  let subscriber = {
    entry: entry ?? (async (record: ActionLogEntry) => { events.push(record.id); }),
    ready: async () => { events.push("ready"); },
    dup: () => subscriber,
    onRpcBroken: () => {},
    [Symbol.dispose]: () => {},
  };
  return { subscriber: subscriber as unknown as RpcStub<ActionsSubscriber>, events };
}

describe("subscribeToActions", () => {
  it("delivers adds and resolutions live, in stream order", async () => {
    let storage = makeActionStorage();
    let client = await openFakeOverseer(storage);
    let { subscriber, events } = makeSubscriber();

    using _sub = await client.subscribeToActions(subscriber);
    putAction(storage, 0);
    let record = storage.actions.get(0)!;
    record.state = "approved";
    storage.actions.put(record);

    expect(events).toEqual(["ready", 0, 0]);  // the add, then the resolving update
  });

  it("replays only the changed records, in change-time order, however large the log", async () => {
    let storage = makeActionStorage();
    for (let id = 0; id < 550; id++) putAction(storage, id, { state: "approved" });
    // Two records resolved after the cutoff, in the opposite of id order.
    putAction(storage, 7, { state: "approved", appliedAt: new Date(FIXTURE_EPOCH + 2000) });
    putAction(storage, 3, { state: "approved", appliedAt: new Date(FIXTURE_EPOCH + 3000) });
    let client = await openFakeOverseer(storage);
    let { subscriber, events } = makeSubscriber();

    using _sub = await client.subscribeToActions(subscriber, new Date(FIXTURE_EPOCH + 1000));
    expect(events).toEqual([7, 3, "ready"]);
  });

  it("replays a whole batch tied at the cutoff instant, each record once", async () => {
    // The frozen clock stamps whole batches with one instant; an exclusive bound would lose the
    // siblings of the last-seen record.
    let instant = new Date(FIXTURE_EPOCH + 100);
    let storage = makeActionStorage();
    putAction(storage, 0, { state: "approved" });  // predates the instant
    putAction(storage, 1, { createdAt: instant });
    putAction(storage, 2, { createdAt: instant });
    // Changed twice within the instant: one index key, so one delivery of the final state.
    putAction(storage, 3, { createdAt: instant, appliedAt: instant });
    putAction(storage, 3, { createdAt: instant, appliedAt: instant, state: "approved" });
    let client = await openFakeOverseer(storage);
    let entries: ActionLogEntry[] = [];
    let { subscriber } = makeSubscriber(async record => { entries.push(record); });

    using _sub = await client.subscribeToActions(subscriber, instant);
    expect(entries.map(e => e.id)).toEqual([1, 2, 3]);
    expect(entries[2].state).toBe("approved");
  });

  it("hands records changing mid-replay to the live stream and still terminates", async () => {
    let storage = makeActionStorage();
    // Two pages, so the sweep is parked mid-replay while the gate holds the first page open.
    for (let id = 0; id <= ACTION_REPLAY_PAGE_SIZE; id++) putAction(storage, id);
    let client = await openFakeOverseer(storage);
    let release!: () => void;
    let gate = new Promise<void>(resolve => { release = resolve; });
    let { subscriber, events } = makeSubscriber(async record => {
      events.push(record.id);
      await gate;
    });

    let pending = client.subscribeToActions(subscriber, new Date(0));
    let newId = ACTION_REPLAY_PAGE_SIZE + 100;
    putAction(storage, newId);  // changes past the sweep's fixed end key
    release();
    using _sub = await pending;

    // Delivered once, by the live subscription; the replay ends at its end key.
    expect(events.filter(id => id === newId)).toEqual([newId]);
    expect(events.at(-1)).toBe("ready");
    expect(events.length).toBe(ACTION_REPLAY_PAGE_SIZE + 3);  // replayed pages + live add + ready
  });

  it("replays a hook toggled after the cutoff, carrying the toggled state", async () => {
    let storage = makeActionStorage();
    putAction(storage, 0, { type: "bindHook", state: "pending" });
    // The mock kv structuredClones every write, which a live controller stub wouldn't survive,
    // so serve disableHook()'s boundHooks reads from a hand-rolled view instead.
    let hook = {
      id: 7, actionId: 0, gatekeeperId: 1, enabled: true,
      controller: { disable: async () => {} },
    };
    let client = await openFakeOverseer({
      ...storage,
      boundHooks: {
        get: (id: number) => (id === hook.id ? hook : undefined),
        put: (record: typeof hook) => Object.assign(hook, record),
      },
    });
    await client.disableHook(hook.id);  // stamps appliedAt = now on the bindHook action record

    let entries: ActionLogEntry[] = [];
    let { subscriber } = makeSubscriber(async record => { entries.push(record); });
    // Cutoff after creation (fixture epoch) but before the toggle (wall clock).
    using _sub = await client.subscribeToActions(subscriber, new Date(FIXTURE_EPOCH + 100));
    expect(entries.map(e => e.id)).toEqual([0]);
    expect(entries[0]).toMatchObject({ type: "bindHook", enabled: false });
  });

  it("rejects the resume replay when the subscriber fails mid-sweep", async () => {
    let storage = makeActionStorage();
    // More than one page, so the failure must also stop the sweep from advancing.
    for (let id = 0; id <= ACTION_REPLAY_PAGE_SIZE; id++) putAction(storage, id);
    let client = await openFakeOverseer(storage);
    let entries = 0;
    let { subscriber, events } = makeSubscriber(async () => {
      ++entries;
      throw new Error("entry failed");
    });

    // Each page's delivery is awaited, so the rejection surfaces directly, before ready().
    await expect(client.subscribeToActions(subscriber, new Date(0)))
        .rejects.toThrow("entry failed");
    expect(events).not.toContain("ready");
    expect(entries).toBeLessThanOrEqual(ACTION_REPLAY_PAGE_SIZE);
  });

  it("stops delivering after the subscription is disposed", async () => {
    let storage = makeActionStorage();
    putAction(storage, 0);
    let client = await openFakeOverseer(storage);
    let { subscriber, events } = makeSubscriber();

    let sub = await client.subscribeToActions(subscriber);
    sub[Symbol.dispose]();
    await scheduler.wait(0);  // let the stub's disposer run
    putAction(storage, 1);

    expect(events).toEqual(["ready"]);
  });
});

describe("listActions", () => {
  it("returns sparse matches in one full page, however much history buries them", async () => {
    let storage = makeActionStorage();
    // A few observations buried under far more history than the old design's per-call scan cap:
    // the index-backed read must surface them in ONE call, with no cursor dance.
    putAction(storage, 0, { type: "observation", state: "approved" });
    putAction(storage, 1, { type: "observation", state: "rejected" });
    for (let id = 2; id < 550; id++) putAction(storage, id, { state: "approved" });
    let client = await openFakeOverseer(storage);

    let page = await client.listActions({ filter: "observation" });
    expect(page.entries.map(e => e.id)).toEqual([1, 0]);
    expect(page.nextBeforeId).toBeUndefined();
  });

  it("pages without overlap or gaps", async () => {
    let storage = makeActionStorage();
    let expected: number[] = [];
    for (let id = 0; id < 130; id++) {
      // Mixed states, so the "all" pages span records with differing byHistoryFilter keys.
      putAction(storage, id, { state: id % 4 === 0 ? "pending" : "approved" });
      expected.unshift(id);
    }
    let client = await openFakeOverseer(storage);

    let ids: number[] = [];
    let beforeId: number | undefined;
    do {
      let page = await client.listActions({ beforeId });
      ids.push(...page.entries.map(e => e.id));
      beforeId = page.nextBeforeId;
    } while (beforeId !== undefined);

    expect(ids).toEqual(expected);
  });

  it("applies the default limit and reports more history", async () => {
    let storage = makeActionStorage();
    let total = ACTION_HISTORY_PAGE_DEFAULT_LIMIT + 10;
    for (let id = 0; id < total; id++) putAction(storage, id, { state: "approved" });
    let client = await openFakeOverseer(storage);

    let first = await client.listActions();
    expect(first.entries.length).toBe(ACTION_HISTORY_PAGE_DEFAULT_LIMIT);
    expect(first.nextBeforeId).toBe(total - ACTION_HISTORY_PAGE_DEFAULT_LIMIT);

    let second = await client.listActions({ beforeId: first.nextBeforeId });
    expect(second.entries.length).toBe(10);
    expect(second.nextBeforeId).toBeUndefined();
  });

  it("rejects an invalid beforeId", async () => {
    let client = await openFakeOverseer(makeActionStorage());

    await expect(client.listActions({ beforeId: -1 })).rejects.toThrow("Invalid beforeId");
  });
});

describe("exportWorkspaceRecords", () => {
  it("keeps actor attribution opaque and stable without exporting names or emails", async () => {
    let storage = makeActionStorage();
    let email = "private.person@example.test";
    let displayName = "Private Display Name";
    let userId = "private-user-123";
    let gadgetOwnerId = "private-gadget-owner-456";
    for (let id = 0; id < 5; id++) {
      putAction(storage, id, {state: "approved", appliedAt: new Date(FIXTURE_EPOCH + id + 1)});
      let entry = storage.actions.get(id)!;
      if (entry.type !== "action") throw new Error("fixture action missing");
      let resolvedBy = id < 2
        ? {type: "user" as const, id: userId, name: displayName}
        : id < 4
          ? {type: "gadget" as const, id: gadgetOwnerId, name: "Private Gadget"}
          : {type: "user" as const, id: email, name: displayName};
      storage.actions.put({...entry, resolvedBy});
    }
    let client = await openFakeOverseer(storage, {impl: {
      env: {COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true"},
      frozenInstalls: () => ({create: () => { throw new Error("unused"); }, remove: () => {}}),
      readSourceCommits: async () => new Map(),
      workflowDefinitionStore: () => ({list: () => [], controls: () => [], pinOf: () => null}),
    }});

    let exported = await client.exportWorkspaceRecords();
    let serialized = JSON.stringify(exported);
    expect(serialized).not.toContain(email);
    expect(serialized).not.toContain(displayName);
    expect(serialized).not.toContain(userId);
    expect(serialized).not.toContain(gadgetOwnerId);
    let byId = new Map(exported.actionLog.map(entry => [entry.id, entry]));
    expect(byId.get(0)?.decidedBy).toMatchObject({type: "user"});
    expect(byId.get(0)?.decidedBy?.id).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(byId.get(1)?.decidedBy?.id).toBe(byId.get(0)?.decidedBy?.id);
    expect(byId.get(2)?.decidedBy).toMatchObject({type: "gadget"});
    expect(byId.get(2)?.decidedBy?.id).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(byId.get(3)?.decidedBy?.id).toBe(byId.get(2)?.decidedBy?.id);
    expect(exported.actionLog[0].requestedBy).toMatchObject({type: "agent"});
    expect(exported.actionLog[1].requestedBy?.id).toBe(exported.actionLog[0].requestedBy?.id);
    expect(exported.withheld.actionLog).toContain("personal actor ids are opaque, names and emails are withheld");
    let exportedAgain = await client.exportWorkspaceRecords();
    let secondById = new Map(exportedAgain.actionLog.map(entry => [entry.id, entry]));
    expect(secondById.get(0)?.decidedBy?.id).not.toBe(byId.get(0)?.decidedBy?.id);
    expect(secondById.get(2)?.decidedBy?.id).not.toBe(byId.get(2)?.decidedBy?.id);
  });

  it("lists each gadget's facet and blueprint for the storage export, and nothing a person wrote (FAC-162)", async () => {
    let storage = makeActionStorage();
    storage.defaultGadgetId.put(1);
    storage.gadgets.put({type: "gadget", id: 1, title: "Private Gadget Title", created: new Date(FIXTURE_EPOCH),
      bindingName: "tracker", installedFrom: {blueprintId: "vote-tracker", version: 3, kind: "app"}} as never);
    storage.gadgets.put({type: "gadget", id: 4, title: "Scratch Notes By A Person", created: new Date(FIXTURE_EPOCH),
      bindingName: "notes"} as never);
    let client = await openFakeOverseer(storage, {impl: {
      env: {COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true"},
      frozenInstalls: () => ({create: () => { throw new Error("unused"); }, remove: () => {}}),
      readSourceCommits: async () => new Map(),
      workflowDefinitionStore: () => ({list: () => [], controls: () => [], pinOf: () => null}),
    }});

    let exported = await client.exportWorkspaceRecords();
    expect(exported.gadgets).toEqual([
      {id: 1, facet: "gadget", blueprintId: "vote-tracker"},
      {id: 4, facet: "gadget4", blueprintId: null},
    ]);
    let serialized = JSON.stringify(exported.gadgets);
    expect(serialized).not.toContain("Private Gadget Title");
    expect(serialized).not.toContain("Scratch Notes");
    expect(serialized).not.toContain('"tracker"');
    expect(exported.withheld.gadgets).toContain("Titles and binding names");
  });

  it("reports truncation when the final page straddles the export limit", async () => {
    let storage = makeActionStorage();
    for (let id = 0; id < 505; id++) putAction(storage, id, {state: "approved"});
    let client = await openFakeOverseer(storage, {impl: {
      env: {COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true"},
      frozenInstalls: () => ({create: () => { throw new Error("unused"); }, remove: () => {}}),
      readSourceCommits: async () => new Map(),
      workflowDefinitionStore: () => ({list: () => [], controls: () => [], pinOf: () => null}),
    }});
    let ids = Array.from({length: 505}, (_, index) => 504 - index);
    let makeEntries = (entryIds: number[]) => entryIds.map(id => ({
      id,
      gatekeeperId: 1,
      resourceTitle: `Resource ${id}`,
      createdAt: new Date(FIXTURE_EPOCH + id),
      state: "approved" as const,
      type: "observation" as const,
      description: {title: `Observation ${id}`, description: "fixture"},
    } satisfies ActionLogEntry));
    let pages = [
      ids.slice(0, 100), ids.slice(100, 200), ids.slice(200, 300), ids.slice(300, 400),
      ids.slice(400, 495), ids.slice(495),
    ];
    let calls = 0;
    let listActionsSpy = vi.spyOn(Object.getPrototypeOf(client), "listActions").mockImplementation(async () => {
      let pageIds = pages[calls++]!;
      return {
        entries: makeEntries(pageIds),
        nextBeforeId: pageIds.length === 0 || calls === pages.length ? undefined : pageIds.at(-1),
      };
    });

    let exported = await (async () => {
      try {
        return await client.exportWorkspaceRecords();
      } finally {
        listActionsSpy.mockRestore();
      }
    })();
    expect(exported.actionLog).toHaveLength(500);
    expect(exported.actionLogTruncated).toBe(true);
  });

  it("projects provider payloads away and reports when the bounded history is truncated", async () => {
    let storage = makeActionStorage();
    const secret = "fake-provider-token-should-never-export";
    for (let id = 0; id < 510; id++) putAction(storage, id, {state: "approved", appliedAt: new Date(FIXTURE_EPOCH + id + 1)});
    let entry = storage.actions.get(509)!;
    if (entry.type !== "action") throw new Error("fixture action missing");
    storage.actions.put({...entry, result: {providerPayload: secret, appliedRevision: `Bearer ${secret}`, createdIdentifier: `Issue ${secret}`, runId: secret},
      lastAttempt: {outcome: "notApplied", message: `provider error echoed ${secret}`, at: new Date(FIXTURE_EPOCH + 2)}});
    let validEntry = storage.actions.get(508)!;
    if (validEntry.type !== "action") throw new Error("fixture action missing");
    storage.actions.put({...validEntry, result: {
      appliedRevision: "12", createdIdentifier: "ENG-7", runId: "00000000-0000-4000-8000-000000000008",
    }});
    let client = await openFakeOverseer(storage, {impl: {
      env: {COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true"},
      frozenInstalls: () => ({create: () => { throw new Error("unused"); }, remove: () => {}}),
      readSourceCommits: async () => new Map(),
      workflowDefinitionStore: () => ({list: () => [], controls: () => [], pinOf: () => null}),
    }});
    using _client = client;

    let exported = await client.exportWorkspaceRecords();
    expect(exported.actionLog).toHaveLength(500);
    expect(exported.actionLogTruncated).toBe(true);
    expect(exported.actionLogLimit).toBe(500);
    expect(JSON.stringify(exported)).not.toContain(secret);
    expect(exported.actionLog[0]).toMatchObject({method: "edit", outcome: "succeeded"});
    expect(exported.actionLog[0].appliedRevision).toBeUndefined();
    expect(exported.actionLog[0].createdIdentifier).toBeUndefined();
    expect(exported.actionLog[0].runId).toBeUndefined();
    expect(exported.actionLog[1]).toMatchObject({
      appliedRevision: "12", createdIdentifier: "ENG-7", runId: "00000000-0000-4000-8000-000000000008",
    });
    expect(exported.withheld.actionLog).toContain("action references outside their strict formats are omitted");
  });
});

describe("listActions with the pending filter", () => {
  it("returns pendings of any type newest-first across gatekeepers, excluding resolved",
      async () => {
    let storage = makeActionStorage();
    putAction(storage, 0, { gatekeeperId: 2 });
    putAction(storage, 1, { state: "approved" });
    putAction(storage, 2, { type: "bindHook", state: "pending", gatekeeperId: 1 });
    putAction(storage, 3, { state: "rejected" });
    putAction(storage, 4, { gatekeeperId: 3 });
    let client = await openFakeOverseer(storage);

    // The index groups by gatekeeper; the page must still be one id-ordered (descending) stream.
    let page = await client.listActions({ filter: "pending" });
    expect(page.entries.map(e => e.id)).toEqual([4, 2, 0]);
    expect(page.nextBeforeId).toBeUndefined();
  });

  it("pages to exhaustion without overlap or gaps", async () => {
    let storage = makeActionStorage();
    let expected: number[] = [];
    for (let id = 0; id < ACTION_HISTORY_PAGE_DEFAULT_LIMIT * 2 + 30; id++) {
      let pending = id % 3 !== 0;
      putAction(storage, id, { state: pending ? "pending" : "approved", gatekeeperId: id % 4 });
      if (pending) expected.unshift(id);
    }
    let client = await openFakeOverseer(storage);

    let ids: number[] = [];
    let beforeId: number | undefined;
    do {
      let page = await client.listActions({ filter: "pending", beforeId });
      expect(page.entries.length).toBeLessThanOrEqual(ACTION_HISTORY_PAGE_DEFAULT_LIMIT);
      ids.push(...page.entries.map(e => e.id));
      beforeId = page.nextBeforeId;
    } while (beforeId !== undefined);

    expect(ids).toEqual(expected);
  });

  it("sees records written before the indexes existed once a rebuild backfills them", async () => {
    // Mirrors the version-3 migration: records predate the index declarations, so each index
    // starts empty until the migration's rebuild() runs.
    let mock = makeMockStorage();
    let legacy = makePreIndexActionStorage(mock);
    putAction(legacy, 0);
    putAction(legacy, 1, { state: "approved" });
    putAction(legacy, 2);
    putAction(legacy, 3, { type: "observation", state: "rejected" });

    let storage = makeActionStorage(mock);
    storage.actions.pendingByGatekeeper.rebuild();
    storage.actions.byHistoryFilter.rebuild();
    storage.actions.byLastChanged.rebuild();
    let client = await openFakeOverseer(storage);

    // Every filter serves the legacy records.
    expect((await client.listActions({ filter: "pending" })).entries.map(e => e.id))
        .toEqual([2, 0]);
    expect((await client.listActions()).entries.map(e => e.id)).toEqual([3, 2, 1, 0]);
    expect((await client.listActions({ filter: "action" })).entries.map(e => e.id))
        .toEqual([2, 1, 0]);
    expect((await client.listActions({ filter: "observation" })).entries.map(e => e.id))
        .toEqual([3]);

    // Resolving a backfilled record must not throw on any index's update.
    let record = storage.actions.get(2)!;
    record.state = "approved";
    record.appliedAt = new Date(FIXTURE_EPOCH + 100);
    storage.actions.put(record);
    expect((await client.listActions({ filter: "pending" })).entries.map(e => e.id)).toEqual([0]);
    expect((await client.listActions()).entries.map(e => e.id)).toEqual([3, 2, 1, 0]);

    // The resume replay serves the backfilled records too.
    let { subscriber, events } = makeSubscriber();
    using _sub = await client.subscribeToActions(subscriber, new Date(FIXTURE_EPOCH + 3));
    expect(events).toEqual([3, 2, "ready"]);
  });
});
