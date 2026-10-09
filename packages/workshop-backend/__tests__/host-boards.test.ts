// The host-board desk (host-boards.ts) against synthetic in-memory ports: a fake clock, storage
// with real rollback, a fake gatekeeper facet whose calls can be held, and a fake account record.
// Everything here is synthetic; the integration suite drives the real Workshop and gatekeeper.
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import type { HostBoardFence, HostBoardRead } from "@gadgets/gatekeeper-kit/host-board";
import type { HostBoardReadAudit } from "@gadgets/workshop-shared/operate-console";
import {
  HOST_BOARD_READ_DEADLINE_MS, HostBoardDesk, HostBoardSelectionRelay, projectHostBoardSnapshot, readByDeadline, type HostBoardContext, type HostBoardMint,
  type HostBoardPorts, type HostBoardRequestRecord, type HostBoardSelectionPayload, type HostBoardSelectionRecord,
  type HostBoardSelectionState,
} from "../src/host-boards";
import type { HostBoardAccount } from "../src/user";

const TARGET = "inferops://acme.operations/project/board/ENG";
const OTHER = "inferops://acme.operations/project/board/WEB";
const OWNER = "owner-1";
const INTENT = { target: TARGET, sessionSeq: 1 };
const SNAPSHOT = {
  project: { identifier: "ENG", name: "Engineering (synthetic)" },
  columns: [{ label: "Todo", group: "unstarted", issues: [
    { identifier: "ENG-1", title: "Synthetic issue", priority: "high", targetDate: null, blocked: false },
  ] }],
};
const SCOPE = { workspaceId: "ws-1", projectId: "p-1" };

/** A promise the test resolves by hand. */
function held<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  let promise = new Promise<T>((r, j) => { resolve = r; reject = j; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function world() {
  let now = 1_000_000;
  let sleepers: { at: number; resolve: () => void }[] = [];
  let selections = new Map<string, HostBoardSelectionRecord>();
  let requests = new Map<string, HostBoardRequestRecord>();
  let gatekeepers = new Map<number, { resourceUrl: string; mint: HostBoardMint }>();
  let audit: HostBoardReadAudit[] = [];
  let deferred: (() => void)[] = [];
  let nextId = 10;
  let state = {
    enabled: true,
    account: { accountId: 7, vendorId: "inferops", incarnation: "inc-1", epoch: 1 } as HostBoardAccount | null,
    fence: { accountId: "adapter-7", identity: "id-1", generation: "g-1" } as HostBoardFence | null,
    answer: (): HostBoardRead => ({ status: "ok", scope: SCOPE, snapshot: SNAPSHOT as never, fence: { ...state.fence! } }),
    context: { target: TARGET, sessionSeq: 1 } as HostBoardContext | null,
    mints: 0,
    drops: [] as number[],
    failCommit: false,
    holdMint: null as null | ReturnType<typeof held<void>>,
    holdSnapshot: null as null | ReturnType<typeof held<void>>,
    holdIdentity: null as null | ReturnType<typeof held<void>>,
    holdGuard: null as null | ReturnType<typeof held<void>>,
  };
  let ports: HostBoardPorts = {
    ownerId: OWNER,
    enabled: () => state.enabled,
    selections: {
      get: key => structuredClone(selections.get(key)),
      put: record => { selections.set(record.target, structuredClone(record)); },
      list: () => [...selections.values()].map(record => structuredClone(record)),
    },
    requests: {
      get: key => structuredClone(requests.get(key)),
      put: record => {
        if (state.failCommit && record.state === "committed") throw new Error("synthetic storage failure");
        requests.set(record.requestKey, structuredClone(record));
      },
    },
    transaction: fn => {
      let saved = [new Map(selections), new Map(requests), new Map(gatekeepers)] as const;
      try {
        return fn();
      } catch (error) {
        selections = new Map(saved[0]); requests = new Map(saved[1]); gatekeepers = new Map(saved[2]);
        throw error;
      }
    },
    defer: fn => { deferred.push(fn); },
    recordAudit: entry => { audit.push(entry); },
    connection: id => gatekeepers.get(id),
    mintedBy: key => [...gatekeepers].find(([, g]) => g.mint.requestKey === key)?.[0],
    mint: async (accountId, target, stamp) => {
      state.mints++;
      if (state.holdMint) await state.holdMint.promise;
      gatekeepers.set(nextId++, { resourceUrl: target, mint: { ...stamp, accountId, incarnation: state.account!.incarnation } });
    },
    drop: id => {
      state.drops.push(id);
      gatekeepers.delete(id);
    },
    facet: () => ({
      async connectionIdentity() {
        if (state.holdIdentity) await state.holdIdentity.promise;
        return state.fence && { ...state.fence };
      },
      async readHostBoardSnapshot() {
        let answer = state.answer();
        if (state.holdSnapshot) await state.holdSnapshot.promise;
        return answer;
      },
    }),
    account: async () => state.account && { ...state.account },
    now: () => now,
    sleep: ms => new Promise<void>(resolve => sleepers.push({ at: now + ms, resolve })),
  };
  let desk = new HostBoardDesk(ports);
  let guard = async () => {
    if (state.holdGuard) await state.holdGuard.promise;
    return state.context && { ...state.context };
  };
  return {
    ports, desk, state, audit, gatekeepers: () => gatekeepers, selections: () => selections, requests: () => requests,
    guard,
    /** Moves the fake clock on, waking every sleeper due. */
    async advance(ms: number) {
      now += ms;
      for (let sleeper of sleepers.filter(s => s.at <= now)) sleeper.resolve();
      sleepers = sleepers.filter(s => s.at > now);
      await tick();
    },
    /** Runs what the desk deferred until after the current event. */
    flush() { let run = deferred; deferred = []; for (let fn of run) fn(); },
    /** A new desk over the same storage, as after a restart. */
    restart() { desk = new HostBoardDesk(ports); return desk; },
    get now() { return now; },
  };
}

const payload = (accountId = 7, entryId = "entry-1"): HostBoardSelectionPayload =>
  ({ workspaceId: "console-ws", consoleId: "c1", source: "published", revision: "3", entryId, accountId });

const readRequest = (w: ReturnType<typeof world>) =>
  ({ consoleId: "c1", entryId: "entry-1", requirementName: "board", source: "published" as const, revision: "3", readAt: w.now });

describe("host-board selection", () => {
  it("commits, and a same-key retry returns the outcome without another mint", async () => {
    let w = world();
    expect(await w.desk.select("k1", payload(), INTENT, w.guard)).toEqual({ status: "selected" });
    expect(await w.desk.select("k1", payload(), INTENT, w.guard)).toEqual({ status: "selected" });
    expect(w.state.mints).toBe(1);
    let slot = w.selections().get(TARGET)!;
    expect(slot.selection).toMatchObject({ gatekeeperId: 10, selectionEpoch: 1,
      mintedFor: { by: OWNER, requestKey: "k1", accountId: 7, incarnation: "inc-1", adapterAccountId: "adapter-7" } });
    expect(w.gatekeepers().get(10)!.mint).toEqual({ by: OWNER, requestKey: "k1", accountId: 7, incarnation: "inc-1" });
  });

  it("refuses a key reused with another payload before anything is created", async () => {
    let w = world();
    await w.desk.select("k1", payload(), INTENT, w.guard);
    await expect(w.desk.select("k1", payload(8), INTENT, w.guard)).rejects.toThrow(/different selection/);
    await expect(w.desk.select("k1", payload(7, "entry-2"), INTENT, w.guard)).rejects.toThrow(/different selection/);
    expect(w.state.mints).toBe(1);
  });

  it("joins a concurrent same-key retry after a lost response: one mint, one outcome", async () => {
    let w = world();
    w.state.holdMint = held();
    let first = w.desk.select("k1", payload(), INTENT, w.guard);
    await tick();
    let retry = w.desk.select("k1", payload(), INTENT, w.guard);
    w.state.holdMint.resolve();
    expect(await Promise.all([first, retry])).toEqual([{ status: "selected" }, { status: "selected" }]);
    expect(w.state.mints).toBe(1);
  });

  it("resumes after a restart, finding the stamped candidate instead of minting again", async () => {
    let w = world();
    // The connection was created, then the instance went away before committing.
    w.state.holdIdentity = held();
    void w.desk.select("k1", payload(), INTENT, w.guard);
    await tick(); await tick();
    expect(w.gatekeepers().size).toBe(1);
    expect(w.requests().get("k1")!.state).toBe("pending");
    // The old instance's call never returns; the restarted one resumes the same request.
    w.state.holdIdentity = null;
    let resumed = w.restart();
    expect(await resumed.select("k1", payload(), INTENT, w.guard)).toEqual({ status: "selected" });
    expect(w.state.mints).toBe(1);
    expect(w.selections().get(TARGET)!.intentEpoch).toBe(1);
    expect(w.selections().get(TARGET)!.selection!.selectionEpoch).toBe(1);
  });

  it("resumes after a restart that lost the mint with no new epoch, minting it once", async () => {
    let w = world();
    w.state.holdMint = held();
    void w.desk.select("k1", payload(), INTENT, w.guard);
    await tick();
    // The instance died mid-mint: nothing was created.
    let resumed = w.restart();
    w.state.holdMint = null;
    expect(await resumed.select("k1", payload(), INTENT, w.guard)).toEqual({ status: "selected" });
    expect(w.selections().get(TARGET)!.intentEpoch).toBe(1);
    expect(w.gatekeepers().size).toBe(1);
  });

  it("commits only the latest intent; the loser removes only its own candidate", async () => {
    let w = world();
    expect(await w.desk.select("a1", payload(), INTENT, w.guard)).toEqual({ status: "selected" });
    w.state.holdIdentity = held();
    let b = w.desk.select("b", payload(8), INTENT, w.guard);
    await tick(); await tick();
    let a2 = w.desk.select("a2", payload(), INTENT, w.guard);
    w.state.holdIdentity.resolve();
    w.state.holdIdentity = null;
    expect(await b).toEqual({ status: "superseded" });
    expect(await a2).toEqual({ status: "selected" });
    let slot = w.selections().get(TARGET)!;
    expect(slot.selection!.selectionEpoch).toBe(3);
    expect(slot.selection!.mintedFor.requestKey).toBe("a2");
    // b's candidate and a1's replaced connection are gone; a2's is kept.
    expect([...w.gatekeepers().keys()]).toEqual([slot.selection!.gatekeeperId]);
    expect(w.requests().get("a1")!.state).toBe("superseded");
    expect(w.requests().get("b")!.state).toBe("superseded");
    // A tombstone never becomes a new selection.
    expect(await w.desk.select("b", payload(8), INTENT, w.guard)).toEqual({ status: "superseded" });
    expect(w.state.mints).toBe(3);
  });

  it("fails a selection whose account was replaced under the same id while it was made", async () => {
    let w = world();
    w.state.holdIdentity = held();
    let pending = w.desk.select("k1", payload(), INTENT, w.guard);
    await tick(); await tick();
    w.state.account = { ...w.state.account!, incarnation: "inc-2", epoch: 2 };
    w.state.holdIdentity.resolve();
    expect(await pending).toEqual({ status: "failed" });
    expect(w.gatekeepers().size).toBe(0);
    expect(w.selections().get(TARGET)!.selection).toBeNull();
  });

  it("fails when the console context no longer holds at commit", async () => {
    let w = world();
    w.state.holdIdentity = held();
    let pending = w.desk.select("k1", payload(), INTENT, w.guard);
    await tick(); await tick();
    w.state.context = null;
    w.state.holdIdentity.resolve();
    expect(await pending).toEqual({ status: "failed" });
    // The session refuses a new request whose context does not hold; one that slips past fails here.
    expect(await w.desk.select("k2", payload(), INTENT, w.guard)).toEqual({ status: "failed" });
    expect(w.gatekeepers().size).toBe(0);
  });

  it("is refused while the switch is off", async () => {
    let w = world();
    w.state.enabled = false;
    await expect(w.desk.select("k1", payload(), INTENT, w.guard)).rejects.toThrow(/turned off/);
    expect(w.state.mints).toBe(0);
  });
});

describe("host-board reads", () => {
  async function selected() {
    let w = world();
    await w.desk.select("k1", payload(), INTENT, w.guard);
    return w;
  }

  it("returns the projected board, pins the scope and audits exactly the allowlisted fields", async () => {
    let w = await selected();
    let view = await w.desk.read(readRequest(w), w.guard);
    expect(view).toEqual({ status: "ok", board: SNAPSHOT, readAt: new Date(1_000_000).toISOString(), publicationRevision: "3" });
    expect(w.selections().get(TARGET)!.selection!.pinned).toEqual(SCOPE);
    expect(w.audit).toEqual([{ kind: "host-board-read", consoleId: "c1", entryId: "entry-1", requirementName: "board",
      status: "ok", at: new Date(1_000_000).toISOString() }]);
    expect(Object.keys(w.audit[0]!).toSorted()).toEqual(["at", "consoleId", "entryId", "kind", "requirementName", "status"]);
  });

  it("is not-connected without a selection, audited only while the context holds", async () => {
    let w = world();
    expect(await w.desk.read(readRequest(w), w.guard)).toEqual({ status: "not-connected" });
    expect(w.audit.map(a => a.status)).toEqual(["not-connected"]);
    w.state.context = null;
    expect(await w.desk.read(readRequest(w), w.guard)).toEqual({ status: "stale" });
    expect(w.audit).toHaveLength(1);
  });

  it("is not-connected when the account is gone or replaced under the same id", async () => {
    let w = await selected();
    w.state.account = { ...w.state.account!, incarnation: "inc-2" };
    expect(await w.desk.read(readRequest(w), w.guard)).toEqual({ status: "not-connected" });
    w.state.account = null;
    expect(await w.desk.read(readRequest(w), w.guard)).toEqual({ status: "not-connected" });
  });

  it("refuses a pinned selection whose target now resolves elsewhere (slug reuse)", async () => {
    let w = await selected();
    await w.desk.read(readRequest(w), w.guard);
    let answer = w.state.answer;
    w.state.answer = () => ({ ...answer(), scope: { workspaceId: "ws-1", projectId: "p-other" } } as HostBoardRead);
    expect(await w.desk.read(readRequest(w), w.guard)).toEqual({ status: "not-connected" });
    expect(w.selections().get(TARGET)!.selection!.pinned).toEqual(SCOPE);
  });

  it("accepts a token-refresh retry, fenced on the answering attempt", async () => {
    let w = await selected();
    // The attempt that answered ran under a refreshed credential, which still holds afterwards.
    w.state.answer = () => ({ status: "ok", scope: SCOPE, snapshot: SNAPSHOT as never,
      fence: { accountId: "adapter-7", identity: "id-2", generation: "g-1" } });
    let held1 = held<void>();
    w.state.holdSnapshot = held1;
    let reading = w.desk.read(readRequest(w), w.guard);
    await tick(); await tick();
    w.state.fence = { accountId: "adapter-7", identity: "id-2", generation: "g-1" };
    held1.resolve();
    expect((await reading).status).toBe("ok");
  });

  for (let [name, change] of [
    ["a reconnect", (w: ReturnType<typeof world>) => { w.state.fence = { ...w.state.fence!, generation: "g-2" }; }],
    ["a revoke", (w: ReturnType<typeof world>) => { w.state.fence = null; }],
    ["an account mutation", (w: ReturnType<typeof world>) => { w.state.account = { ...w.state.account!, epoch: 9 }; }],
    ["a console move", (w: ReturnType<typeof world>) => { w.state.context = { ...w.state.context!, sessionSeq: 2 }; }],
    ["a republish", (w: ReturnType<typeof world>) => { w.state.context = null; }],
  ] as const) {
    it(`discards a paused read released after ${name}`, async () => {
      let w = await selected();
      w.state.holdSnapshot = held();
      let reading = w.desk.read(readRequest(w), w.guard);
      await tick(); await tick();
      change(w);
      w.state.holdSnapshot.resolve();
      expect(await reading).toEqual({ status: "stale" });
      expect(w.audit).toEqual([]);
      expect(w.selections().get(TARGET)!.selection!.pinned).toBeUndefined();
    });
  }

  it("discards a read released after a selection change A to B to A", async () => {
    let w = await selected();
    w.state.holdSnapshot = held();
    let reading = w.desk.read(readRequest(w), w.guard);
    await tick(); await tick();
    let hold = w.state.holdSnapshot;
    w.state.holdSnapshot = null;
    await w.desk.select("k2", payload(8), INTENT, w.guard);
    await w.desk.select("k3", payload(7), INTENT, w.guard);
    hold.resolve();
    expect(await reading).toEqual({ status: "stale" });
    expect(w.audit).toEqual([]);
  });

  for (let step of ["guard", "identity", "snapshot"] as const) {
    it(`answers unavailable at 10 s when the ${step} stalls, and the late completion has no effect`, async () => {
      let w = await selected();
      let stall = held<void>();
      if (step === "guard") w.state.holdGuard = stall;
      if (step === "identity") w.state.holdIdentity = stall;
      if (step === "snapshot") w.state.holdSnapshot = stall;
      let settled = false;
      let reading = w.desk.read(readRequest(w), w.guard).finally(() => { settled = true; });
      await w.advance(HOST_BOARD_READ_DEADLINE_MS - 1);
      expect(settled).toBe(false);
      await w.advance(1);
      expect(await reading).toEqual({ status: "unavailable" });
      // The stalled step completes late: nothing is pinned, audited or returned.
      w.state.holdGuard = w.state.holdIdentity = w.state.holdSnapshot = null;
      stall.resolve();
      for (let i = 0; i < 10; i++) await tick();
      expect(w.audit).toEqual([]);
      expect(w.selections().get(TARGET)!.selection!.pinned).toBeUndefined();
    });
  }

  it("observes a late rejection without surfacing it", async () => {
    let w = await selected();
    let failing = held<void>();
    w.state.holdSnapshot = failing;
    let reading = w.desk.read(readRequest(w), w.guard);
    await w.advance(HOST_BOARD_READ_DEADLINE_MS);
    expect(await reading).toEqual({ status: "unavailable" });
    failing.reject(new Error("CONFIDENTIAL late failure"));
    for (let i = 0; i < 5; i++) await tick();
    expect(w.audit).toEqual([]);
  });

  it("is unavailable, unaudited, while the switch is off", async () => {
    let w = await selected();
    w.state.enabled = false;
    expect(await w.desk.read(readRequest(w), w.guard)).toEqual({ status: "unavailable" });
    expect(w.audit).toEqual([]);
  });
});

describe("host-board selection subscriptions", () => {
  function listen(w: ReturnType<typeof world>, target = TARGET) {
    let states: HostBoardSelectionState[] = [];
    let { snapshot, unsubscribe } = w.desk.subscribe(target, state => { states.push(state); });
    return { snapshot, states, unsubscribe };
  }
  const deliveries = async (w: ReturnType<typeof world>) => { w.flush(); await tick(); };

  it("takes its first state atomically, even while a mutation is in flight, then follows pending to committed", async () => {
    let w = world();
    w.state.holdIdentity = held();
    let pending = w.desk.select("k1", payload(), INTENT, w.guard);
    await tick(); await tick();
    let sub = listen(w);
    expect(sub.snapshot).toEqual({ state: "pending", changeSeq: 1, selectionEpoch: null });
    w.state.holdIdentity.resolve();
    await pending;
    await deliveries(w);
    expect(sub.states.at(-1)).toEqual({ state: "selected", changeSeq: 2, selectionEpoch: 1 });
  });

  it("never reports a commit that rolled back", async () => {
    let w = world();
    await w.desk.select("k1", payload(), INTENT, w.guard);
    let sub = listen(w);
    w.state.failCommit = true;
    // The second commit writes the new selection, then fails before it completes.
    expect(await w.desk.select("k2", payload(8), INTENT, w.guard)).toEqual({ status: "failed" });
    await deliveries(w);
    expect(sub.states.some(s => s.state === "selected" && s.selectionEpoch === 2)).toBe(false);
    expect(w.selections().get(TARGET)!.selection!.selectionEpoch).toBe(1);
    expect(sub.states.at(-1)).toMatchObject({ state: "selected", selectionEpoch: 1 });
  });

  it("reports a deletion as none, then a recreation", async () => {
    let w = world();
    await w.desk.select("k1", payload(), INTENT, w.guard);
    let sub = listen(w);
    w.desk.connectionRemoved(w.selections().get(TARGET)!.selection!.gatekeeperId);
    await deliveries(w);
    expect(sub.states.at(-1)).toMatchObject({ state: "none", selectionEpoch: null });
    await w.desk.select("k2", payload(), INTENT, w.guard);
    await deliveries(w);
    expect(sub.states.at(-1)).toMatchObject({ state: "selected", selectionEpoch: 2 });
    let seqs = sub.states.map(s => s.changeSeq);
    expect(seqs).toEqual(seqs.toSorted((a, b) => a - b));
  });

  it("shows a change missed while unsubscribed in the next subscription's first state", async () => {
    let w = world();
    let sub = listen(w);
    sub.unsubscribe();
    await w.desk.select("k1", payload(), INTENT, w.guard);
    await deliveries(w);
    expect(sub.states).toEqual([]);
    expect(listen(w).snapshot).toEqual({ state: "selected", changeSeq: 2, selectionEpoch: 1 });
  });

  it("hears nothing about another target, and is refused while the switch is off", async () => {
    let w = world();
    let other = listen(w, OTHER);
    await w.desk.select("k1", payload(), INTENT, w.guard);
    await deliveries(w);
    expect(other.states).toEqual([]);
    w.state.enabled = false;
    expect(() => w.desk.subscribe(TARGET, () => {})).toThrow(/turned off/);
  });

  it("drops a subscriber whose delivery fails", async () => {
    let w = world();
    let calls = 0;
    w.desk.subscribe(TARGET, () => { calls++; throw new Error("gone"); });
    await w.desk.select("k1", payload(), INTENT, w.guard);
    await deliveries(w);
    let after = calls;
    await w.desk.select("k2", payload(), INTENT, w.guard);
    await deliveries(w);
    expect(calls).toBe(after);
  });
});

describe("host-board projection", () => {
  it("keeps only the allowlisted fields and refuses anything over a bound", () => {
    let extra = { ...SNAPSHOT, scope: SCOPE, columns: [{ ...SNAPSHOT.columns[0], id: "x",
      issues: [{ ...SNAPSHOT.columns[0]!.issues[0], id: "uuid", assignee: "someone" }] }] };
    expect(projectHostBoardSnapshot(extra)).toEqual(SNAPSHOT);
    expect(projectHostBoardSnapshot({ ...SNAPSHOT, project: { identifier: "E".repeat(33), name: "x" } })).toBeNull();
    expect(projectHostBoardSnapshot({ ...SNAPSHOT, columns: Array.from({ length: 21 }, () => SNAPSHOT.columns[0]) })).toBeNull();
    expect(projectHostBoardSnapshot({ ...SNAPSHOT, columns: [{ ...SNAPSHOT.columns[0], group: "canceled" }] })).toBeNull();
    expect(projectHostBoardSnapshot(null)).toBeNull();
  });
});

describe("the operate workspace's host-board entry points", () => {
  it("refuse anyone but the owner of an operate session workspace, and refuse while the switch is off", async () => {
    let stub = env.TEST_OVERSEER.getByName("host-board-owner");
    await runInDurableObject(stub, async (instance: any) => {
      instance.impl.ownerId = OWNER;
      instance.impl.storage.ownerId.put(OWNER);
      let guard = async () => ({ target: TARGET, sessionSeq: 1 });
      // Not yet an operate session workspace: nothing is reachable, even for the owner.
      await expect(instance.selectHostBoard(OWNER, "k1", payload(), INTENT, guard)).rejects.toThrow(/operate session workspace/);
      instance.impl.storage.operateSession.put(true);
      for (let intruder of ["someone-else", ""]) {
        await expect(instance.selectHostBoard(intruder, "k1", payload(), INTENT, guard)).rejects.toThrow(/operate session workspace/);
        await expect(instance.subscribeHostBoardSelection(intruder, TARGET, async () => {})).rejects.toThrow(/operate session workspace/);
        expect(await instance.readHostBoard(intruder, { consoleId: "c1", entryId: "e", requirementName: "board",
          source: "published", revision: "3", readAt: Date.now() }, guard)).toEqual({ status: "not-connected" });
        expect(await instance.listHostBoardReads(intruder)).toEqual([]);
      }
      // The owner, with the switch off (this test Worker leaves INFEROPS_HOST_BOARDS unset).
      await expect(instance.subscribeHostBoardSelection(OWNER, TARGET, async () => {})).rejects.toThrow(/turned off/);
      await expect(instance.selectHostBoard(OWNER, "k1", payload(), INTENT, guard)).rejects.toThrow(/turned off/);
    });
  });
});

describe("host-board race fences (review)", () => {
  it("rejects a generation change after the initial sample even when the account epoch is unchanged", async () => {
    let w = world();
    await w.desk.select("k1", payload(), INTENT, w.guard);
    w.state.holdSnapshot = held();
    let hold = w.state.holdSnapshot;
    // The answering attempt ran under a new connection generation the initial sample did not see.
    w.state.answer = () => ({ status: "ok", scope: SCOPE, snapshot: SNAPSHOT as never,
      fence: { accountId: "adapter-7", identity: "id-1", generation: "g-2" } });
    let reading = w.desk.read(readRequest(w), w.guard);
    await tick(); await tick();
    w.state.fence = { accountId: "adapter-7", identity: "id-1", generation: "g-2" };
    hold.resolve();
    expect(await reading).toEqual({ status: "stale" });
    expect(w.audit).toEqual([]);
    expect(w.selections().get(TARGET)!.selection!.pinned).toBeUndefined();
  });

  it("never lets an older selection whose guard was held overtake a newer completed intent", async () => {
    let w = world();
    let olderGuard = held<void>();
    let older = w.desk.select("older", payload(8), INTENT, async () => { await olderGuard.promise; return { target: TARGET, sessionSeq: 1 }; });
    await tick();
    expect(await w.desk.select("newer", payload(7), INTENT, w.guard)).toEqual({ status: "selected" });
    olderGuard.resolve();
    expect((await older).status).not.toBe("selected");
    expect(w.selections().get(TARGET)!.selection!.mintedFor.requestKey).toBe("newer");
  });

  it("does not commit a selection whose session moved away and back while its identity was held", async () => {
    let w = world();
    w.state.holdIdentity = held();
    let pending = w.desk.select("k1", payload(), INTENT, w.guard);
    await tick(); await tick();
    // Console A, away, then A again: same target, a later session sequence.
    w.state.context = { target: TARGET, sessionSeq: 3 };
    w.state.holdIdentity.resolve();
    expect((await pending).status).not.toBe("selected");
    expect(w.selections().get(TARGET)!.selection).toBeNull();
  });

  it("discards a read of the old selection released while a newer intent is reserved", async () => {
    let w = world();
    await w.desk.select("a", payload(), INTENT, w.guard);
    w.state.holdSnapshot = held();
    let snapshot = w.state.holdSnapshot;
    let reading = w.desk.read(readRequest(w), w.guard);
    await tick(); await tick();
    w.state.holdSnapshot = null;
    w.state.holdMint = held();
    void w.desk.select("b", payload(8), INTENT, w.guard);
    await tick(); await tick();
    snapshot.resolve();
    expect(await reading).toEqual({ status: "stale" });
    expect(w.audit).toEqual([]);
    expect(w.selections().get(TARGET)!.selection!.pinned).toBeUndefined();
    w.state.holdMint.resolve();
  });
});

describe("the selection delivery relay", () => {
  const state = (changeSeq: number, sel: "none" | "pending" | "selected" = "selected") =>
    ({ state: sel, changeSeq, selectionEpoch: sel === "selected" ? changeSeq : null });
  function relay(options: { holds?: () => Promise<boolean> } = {}) {
    let delivered: unknown[] = [];
    let ends = 0;
    let gate: ReturnType<typeof held<void>> | null = null;
    let r = new HostBoardSelectionRelay(async update => {
      delivered.push(update);
      if (gate) await gate.promise;
    }, options.holds ?? (async () => true), () => { ends++; });
    return { r, delivered, ends: () => ends, hold() { gate = held(); return gate; }, open() { gate = null; } };
  }
  const settle = async () => { for (let i = 0; i < 10; i++) await tick(); };

  it("delivers nothing before its snapshot, then the newest state, never an older one", async () => {
    let t = relay();
    t.r.push(state(3));
    t.r.push(state(2));
    await settle();
    expect(t.delivered).toEqual([]);
    t.r.start(state(1, "none"));
    await settle();
    expect(t.delivered).toEqual([state(3)]);
    t.r.push(state(3));
    t.r.push(state(2));
    await settle();
    expect(t.delivered).toEqual([state(3)]);
  });

  it("keeps one lane through a delayed guard: deliveries stay ordered", async () => {
    let guards: ReturnType<typeof held<boolean>>[] = [];
    let t = relay({ holds: () => { let g = held<boolean>(); guards.push(g); return g.promise; } });
    t.r.start(state(1));
    t.r.push(state(2));
    t.r.push(state(3));
    await settle();
    expect(guards).toHaveLength(1);
    guards[0]!.resolve(true);
    await settle();
    guards[1]!.resolve(true);
    await settle();
    expect(t.delivered).toEqual([state(1), state(3)]);
  });

  it("holds at most one pending state behind a slow consumer", async () => {
    let t = relay();
    let gate = t.hold();
    t.r.start(state(1));
    for (let n = 2; n <= 50; n++) t.r.push(state(n));
    await settle();
    t.open();
    gate.resolve();
    await settle();
    expect(t.delivered).toEqual([state(1), state(50)]);
  });

  it("ends exactly once, with one unknown, under concurrent invalidation", async () => {
    let t = relay({ holds: async () => false });
    t.r.start(state(1));
    t.r.end();
    t.r.end();
    t.r.push(state(2));
    await settle();
    expect(t.delivered.filter(u => (u as { state: string }).state === "unknown")).toHaveLength(1);
    expect(t.ends()).toBe(1);
    expect(t.delivered.filter(u => (u as { state: string }).state !== "unknown")).toEqual([]);
  });

  it("ends with unknown when a delivery fails, and abandons a failed setup silently", async () => {
    let failing = new HostBoardSelectionRelay(async update => {
      if (update.state !== "unknown") throw new Error("gone");
    }, async () => true, () => {});
    failing.start(state(1));
    await settle();
    expect(failing.ended).toBe(true);
    let t = relay();
    t.r.abandon();
    t.r.start(state(1));
    await settle();
    expect(t.delivered).toEqual([]);
    expect(t.ends()).toBe(1);
  });

  it("is told when the selection workspace resets: it drops the subscriber, which is disposed", async () => {
    let stub = env.TEST_OVERSEER.getByName("host-board-reset");
    await runInDurableObject(stub, async (instance: any) => {
      instance.impl.ownerId = OWNER;
      instance.impl.storage.ownerId.put(OWNER);
      instance.impl.storage.operateSession.put(true);
      instance.impl.env = { ...instance.impl.env, INFEROPS_HOST_BOARDS: "true" };
    });
    let disposed = Promise.withResolvers<void>();
    let isDisposed = false;
    let subscriber = async () => {};
    (subscriber as unknown as Disposable)[Symbol.dispose] = () => { isDisposed = true; disposed.resolve(); };
    let result = await (stub as any).subscribeHostBoardSelection(OWNER, TARGET, subscriber);
    expect(result.snapshot).toEqual({ state: "none", changeSeq: 0, selectionEpoch: null });
    expect(isDisposed).toBe(false);
    await abortAllDurableObjects();
    await disposed.promise;
    expect(isDisposed).toBe(true);
  });
});

describe("the read's one deadline", () => {
  it("answers unavailable at exactly 10 s from readAt when the stall is before the desk starts", async () => {
    let w = world();
    let readAt = w.now;
    // Reaching the operate workspace never completes; the desk never starts.
    let reading = readByDeadline(readAt, () => new Promise(() => {}), { now: () => w.now, sleep: ms => w.ports.sleep(ms) });
    let settled = false;
    void reading.then(() => { settled = true; });
    await w.advance(HOST_BOARD_READ_DEADLINE_MS - 1);
    expect(settled).toBe(false);
    await w.advance(1);
    expect(settled).toBe(true);
    expect(await reading).toEqual({ status: "unavailable" });
  });

  it("counts from readAt, so time spent before the call shortens it", async () => {
    let w = world();
    let readAt = w.now;
    await w.advance(4_000);
    let reading = readByDeadline(readAt, () => new Promise(() => {}), { now: () => w.now, sleep: ms => w.ports.sleep(ms) });
    let settled = false;
    void reading.then(() => { settled = true; });
    await w.advance(HOST_BOARD_READ_DEADLINE_MS - 4_000);
    expect(settled).toBe(true);
  });
});
