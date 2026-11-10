// FAC-112: a run a person asked for executes in the workspace's own Durable Object, from its stored
// record, after the call that started it has returned: the firing's callback only queues it
// (durably, beside its FAC-111 run record), and the Overseer's alarm runs it in a run-scoped worker
// loaded from its pinned commit. So it carries on when the browser that asked is gone, resumes
// after a restart with the same run id, revision and authority, never runs newer code, and each
// write it makes names it, so a replay repeats none.
//
// Over a real Overseer Durable Object. The run-scoped worker's seams (the pinned commit's modules,
// the dynamic worker, the binding loopback and the gadget's bindings) are replaced on the shared
// prototype, so a restarted instance reaches the same stand-ins: a real dynamic worker and git
// commit can't be made from a test. Everything the run is checked and executed from is the
// workspace's own storage.
import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { RUN_REQUESTER_REVOKED, type OverseerDurableObject } from "../src/overseer.js";
import { manualOnly } from "../src/auto-approval.js";
import { actionDescriptionDigest } from "../src/system-run.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const ADA = { type: "user" as const, id: "ada-profile", name: "Ada" };
const PERSON = "operator-profile";
const GADGET = 3;
const HOOK = 11;
const CONNECTION = 7;
const REF = "5b2c1d8e-0000-4000-8000-0000000000b1";
const FIRING = { scheduleId: "s1", firedAt: "2026-11-06T00:00:00.000Z" };
const commit = (n: number) => n.toString(16).padStart(40, "0");

/** What the stand-in hook code saw, across instances: one entry per call, with the run's state then. */
let calls: { method: string; args: unknown[] }[] = [];
let statesSeen: unknown[] = [];
/** How the stand-in answers its next call; a test can hold it. */
let answer: () => Promise<unknown> = async () => "done";
let restore: (() => void)[] = [];

afterEach(() => {
  for (let undo of restore.splice(0)) undo();
  calls = [];
  statesSeen = [];
  loaded = { commitIds: [], envs: [] };
  gatekeeper = { next: 1, staged: new Map(), withdrawn: [], failWithdraws: 0 };
  workflowRun = defaultWorkflowRun;
  answer = async () => "done";
});

/** Replaces `name` on the Overseer implementation's prototype until the test ends. */
function onPrototype(impl: any, name: string, value: unknown) {
  let proto = Object.getPrototypeOf(impl);
  let had = Object.getOwnPropertyDescriptor(proto, name);
  Object.defineProperty(proto, name, { value, configurable: true, writable: true });
  restore.push(() => {
    if (had) Object.defineProperty(proto, name, had);
    else delete proto[name];
  });
}

async function withImpl<T>(name: string, fn: (impl: any) => Promise<T> | T): Promise<T> {
  let stub = env.TEST_OVERSEER.getByName(name);
  return runInDurableObject(stub, async (instance: OverseerDurableObject) => fn((instance as any).impl));
}

/** What the stand-in run-scoped worker loaded and ran, across instances. */
let loaded: { commitIds: string[]; envs: Record<string, any>[] } = { commitIds: [], envs: [] };
/** The stand-in `WorkflowRun.onSchedule` of the pinned code: gets the worker's env and the args. */
let workflowRun = defaultWorkflowRun;
/** By default the pinned code records each call, and the run's state when it came, then answers. */
async function defaultWorkflowRun(workerEnv: Record<string, any>, args: unknown[]): Promise<unknown> {
  calls.push({ method: "onSchedule", args });
  statesSeen.push(structuredClone([...workerEnv.BOARD.workspace.storage.workflowDeliveries.list()].at(-1)?.execution));
  return answer();
}

/**
 * The run-scoped worker's seams, on the shared prototype (a real dynamic worker and git commit can't
 * be made from a test): the pinned commit's modules, the worker loaded from them, the binding
 * loopback (plain, so a run's write can be made with the caller it carries), and the gadget's
 * bindings (BOARD, to the connection).
 */
function workerSeams(impl: any) {
  onPrototype(impl, "workflowRunModules", async (commitId: string) => {
    loaded.commitIds.push(commitId);
    return { "server.js": `// ${commitId}` };
  });
  onPrototype(impl, "loadWorkflowRunWorker", (code: { env: Record<string, any> }) => {
    loaded.envs.push(code.env);
    return { getEntrypoint: () => ({ onSchedule: (...args: unknown[]) => workflowRun(code.env, args) }) };
  });
  onPrototype(impl, "makeBindingLoopback", function (this: unknown, target: unknown, caller: unknown) {
    return { target, caller, workspace: this };
  });
  onPrototype(impl, "visibleBindings", () => [["BOARD", { target: CONNECTION }]]);
  // The person who asked is a collaborator here (FAC-122's run right reads their role).
  onPrototype(impl, "definitionRoles", async () => () => "use");
  onPrototype(impl, "getGadgetRecord", () => ({}));
}

/**
 * A workspace with a live trigger pinned at revision 1 (code `commit(1)`), a control listing
 * PERSON, and one admitted run PERSON asked for, fired. Returns the delivery.
 */
function admitted(impl: any, opts: { assigned?: boolean } = {}) {
  workerSeams(impl);
  onPrototype(impl, "getGadgetHead", (id: number) => (id === GADGET ? commit(1) : undefined));
  impl.storage.gatekeepers.put({
    id: CONNECTION, resourceTitle: "Scheduled Tasks", class: {} as any,
    creationSpec: { type: "gatekeeper", vendorId: "scheduler", resourceUrl: "scheduler://tasks", typeUrlPattern: "scheduler://*" },
  });
  impl.storage.boundHooks.put({
    id: HOOK, actionId: 1, gatekeeperId: CONNECTION, gadgetId: GADGET, vendorId: "scheduler",
    controller: null, callback: null, description: { title: "Every morning" }, enabled: true,
  });
  let store = impl.workflowDefinitionStore();
  const head = (id: number) => (id === GADGET ? commit(1) : undefined);
  let saved = store.save(ADA, { title: "Refund", gadgetId: GADGET }, head);
  store.publish(ADA, saved.id, 1);
  store.pinTrigger(ADA.id, HOOK, GADGET, { definitionId: saved.id, revision: 1 });
  store.setControl(ADA, HOOK, { label: "Run refunds", invokers: [PERSON] });
  if (opts.assigned) {
    impl.storage.workflowTriggerAssignments.put({
      hookId: HOOK, gatekeeperId: CONNECTION, credentialRef: REF, assignedBy: ADA, assignedAt: new Date(0),
    });
  }
  let invocation = store.beginInvocation(PERSON, HOOK, null);
  return store.fire(HOOK, GADGET, head, () => true, invocation.id)!;
}

const deliveryOf = (impl: any, id: number) => impl.storage.workflowDeliveries.get(id);
/** A write whose description reproduces all it sends (`descriptionIsComplete`), as a gatekeeper-kit card that fits does. */
const DESCRIPTION: Record<string, unknown> & { title: string } = {
  title: "Create issue", description: "Creates one issue.", implementsRevert: false, descriptionIsComplete: true,
};
/** One that doesn't: a summary, so two different operations can read the same. */
const SUMMARY: Record<string, unknown> & { title: string } = { title: "Update issue", description: "Updates one issue.", implementsRevert: false };

/**
 * A stand-in for a real gatekeeper's staging, across instances: each write it stages gets the next
 * key of a counter that only grows (as the InferOps gatekeeper's persisted one does), and a key the
 * workspace withdraws is dropped from what it holds staged.
 */
let gatekeeper = { next: 1, staged: new Map<number, unknown>(), withdrawn: [] as number[], failWithdraws: 0 };

/** Stage `description` at the stand-in gatekeeper and submit it through `caller`, as a session does. */
async function stage(workspace: any, caller: unknown, description: Record<string, unknown>) {
  let key = gatekeeper.next++;
  gatekeeper.staged.set(key, description);
  return workspace.submitActionNow(CONNECTION, key, description, caller, await actionDescriptionDigest(description));
}

/** A write through `caller` from outside a run's worker, at the stand-in gatekeeper's next key. */
const submitted = (impl: any, caller: unknown) => stage(impl, caller, DESCRIPTION);

/**
 * Runs `body` as the run's pinned code, with the caller its writes carry: the gadget's own, naming
 * the run, or (assigned) the run-scoped `systemRun` one, registered as running for the attempt.
 * The connection's facet withdraws at the stand-in gatekeeper.
 */
function runsAs(impl: any, kind: "gadget-bindings" | "assigned",
                body: (workspace: any, caller: unknown) => Promise<unknown>) {
  const facet = {
    rejectAction: async (key: number) => {
      if (gatekeeper.failWithdraws > 0) {
        gatekeeper.failWithdraws--;
        throw new Error("the provider didn't answer");
      }
      gatekeeper.staged.delete(key);
      gatekeeper.withdrawn.push(key);
    },
  };
  onPrototype(impl, "getGatekeeperFacet", () => facet);
  onPrototype(impl, "openAssignedActionFacet", async () => ({ facet, close: () => {} }));
  if (kind === "gadget-bindings") {
    workflowRun = workerEnv => body(workerEnv.BOARD.workspace, workerEnv.BOARD.caller);
    return;
  }
  onPrototype(impl, "runAssignedDelivery", async function (this: any, hookId: number, d: { deliveryId: number }) {
    this.systemRuns.begin(d.deliveryId, { hookId, gatekeeperId: CONNECTION, credentialRef: REF });
    try {
      return await body(this, { from: "systemRun", hookId, deliveryId: d.deliveryId });
    } finally {
      this.systemRuns.end(d.deliveryId);
    }
  });
}
const actionsOf = (impl: any) => [...impl.storage.actions.list()].filter((a: any) => a.type === "action");

/** Runs the workspace's alarm once more: what withdraws a replay's staged copies (retryReplayWithdrawals). */
async function nextAlarm(name: string) {
  await runDurableObjectAlarm(env.TEST_OVERSEER.getByName(name));
}

async function settled(name: string, id: number) {
  let stub = env.TEST_OVERSEER.getByName(name);
  await runDurableObjectAlarm(stub);
  return withImpl(name, impl => vi.waitFor(() => {
    let execution = deliveryOf(impl, id)?.execution;
    expect(["finished", "failed"]).toContain(execution?.state);
    return deliveryOf(impl, id);
  }, { timeout: 10_000 }));
}

describe("a requested run executes in the workspace, not in the call that asked (FAC-112)", () => {
  it("queues durably and returns at once; the workspace's alarm then runs it to a recorded outcome", async () => {
    let name = `run-exec-queue-${crypto.randomUUID()}`;
    let id = await withImpl(name, impl => {
      let delivery = admitted(impl);
      // The firing's call returns once the run is recorded as queued, before any of it ran.
      expect(impl.queueWorkflowRun(HOOK, delivery.deliveryId, "onSchedule", [FIRING])).toBeUndefined();
      expect(calls).toEqual([]);
      expect(deliveryOf(impl, delivery.deliveryId).execution).toMatchObject({ state: "queued", attempts: 0 });
      return delivery.deliveryId;
    });
    // Nothing the caller holds is needed from here: the workspace's alarm runs it on its own.
    let done = await settled(name, id);
    expect(calls).toEqual([{ method: "onSchedule", args: [FIRING] }]);
    // Recorded as running, first attempt, when the hook code was called.
    expect(statesSeen).toEqual([expect.objectContaining({ state: "running", attempts: 1 })]);
    expect(done.execution).toMatchObject({ state: "finished", attempts: 1 });
    expect(done.execution.endedAt).toBeInstanceOf(Date);
  });

  it("refuses a second call on the same run, and arguments the workspace can't store", async () => {
    await withImpl(`run-exec-once-${crypto.randomUUID()}`, impl => {
      let delivery = admitted(impl);
      expect(() => impl.queueWorkflowRun(HOOK, delivery.deliveryId, "onSchedule", [() => 1]))
        .toThrow("can't be stored");
      expect(deliveryOf(impl, delivery.deliveryId).execution).toBeUndefined();
      impl.queueWorkflowRun(HOOK, delivery.deliveryId, "onSchedule", [FIRING]);
      expect(() => impl.queueWorkflowRun(HOOK, delivery.deliveryId, "onSchedule", [FIRING]))
        .toThrow("This run already started.");
    });
  });
});

describe("a requested run across a restart (FAC-112)", () => {
  it("queued before the restart, runs after it with the same run id, revision and authority", async () => {
    let name = `run-exec-restart-${crypto.randomUUID()}`;
    let { id, before } = await withImpl(name, impl => {
      let delivery = admitted(impl);
      impl.queueWorkflowRun(HOOK, delivery.deliveryId, "onSchedule", [FIRING]);
      let stored = deliveryOf(impl, delivery.deliveryId);
      return { id: delivery.deliveryId, before: { run: stored.run, revision: stored.revision, commitId: stored.commitId } };
    });
    await abortAllDurableObjects();
    let done = await settled(name, id);
    expect(calls).toEqual([{ method: "onSchedule", args: [FIRING] }]);
    expect({ run: done.run, revision: done.revision, commitId: done.commitId }).toEqual(before);
    expect(done.execution).toMatchObject({ state: "finished", attempts: 1 });
  });

  // Round 3: a write a run proposes is identified by its content (the connection, a digest of its
  // description, and which identical write of the attempt it is), never by the provider's action
  // key, which a real gatekeeper never reuses. Each case runs with keys that only grow, as the
  // InferOps gatekeeper's persisted counter does.
  for (const kind of ["gadget-bindings", "assigned"] as const) {
    it(`${kind}: interrupted after a write, runs again to finished with no second write and no copy left staged`, async () => {
      let name = `run-exec-replay-${kind}-${crypto.randomUUID()}`;
      let attempt = 0;
      let id = await withImpl(name, impl => {
        let delivery = admitted(impl, { assigned: kind === "assigned" });
        runsAs(impl, kind, async (workspace, caller) => {
          attempt++;
          await stage(workspace, caller, DESCRIPTION);
          if (attempt === 1) return new Promise(() => {}); // interrupted after its write
          return "ran";
        });
        impl.queueWorkflowRun(HOOK, delivery.deliveryId, "onSchedule", [FIRING]);
        void impl.runQueuedWorkflowRuns();
        return delivery.deliveryId;
      });
      await withImpl(name, impl => vi.waitFor(() => expect(actionsOf(impl)).toHaveLength(1)));
      await abortAllDurableObjects();
      let done = await settled(name, id);
      expect(attempt).toBe(2);
      expect(done.execution).toMatchObject({ state: "finished", attempts: 2 });
      let actions = await withImpl(name, impl => actionsOf(impl));
      expect(actions).toHaveLength(1);
      expect(actions[0].action).toBe(1);
      // The replay staged key 2 at the gatekeeper; matched to key 1's action, it was withdrawn there.
      await nextAlarm(name);
      expect(gatekeeper.withdrawn).toEqual([2]);
      expect([...gatekeeper.staged.keys()]).toEqual([1]);
    });
  }

  it("matches two identical writes of a replay by which of them each is", async () => {
    let name = `run-exec-twice-${crypto.randomUUID()}`;
    let attempt = 0;
    let id = await withImpl(name, impl => {
      let delivery = admitted(impl);
      runsAs(impl, "gadget-bindings", async (workspace, caller) => {
        attempt++;
        await stage(workspace, caller, DESCRIPTION);
        await stage(workspace, caller, DESCRIPTION);
        if (attempt === 1) return new Promise(() => {});
        return "ran";
      });
      impl.queueWorkflowRun(HOOK, delivery.deliveryId, "onSchedule", [FIRING]);
      void impl.runQueuedWorkflowRuns();
      return delivery.deliveryId;
    });
    await withImpl(name, impl => vi.waitFor(() => expect(actionsOf(impl)).toHaveLength(2)));
    await abortAllDurableObjects();
    let done = await settled(name, id);
    expect(done.execution).toMatchObject({ state: "finished", attempts: 2 });
    expect((await withImpl(name, impl => actionsOf(impl))).map((a: any) => a.action)).toEqual([1, 2]);
    await nextAlarm(name);
    expect(gatekeeper.withdrawn.toSorted()).toEqual([3, 4]);
  });

  it("records a write a replay makes that the first attempt didn't, and leaves it for a person", async () => {
    let name = `run-exec-newwrite-${crypto.randomUUID()}`;
    let attempt = 0;
    let id = await withImpl(name, impl => {
      let delivery = admitted(impl);
      runsAs(impl, "gadget-bindings", async (workspace, caller) => {
        attempt++;
        await stage(workspace, caller, DESCRIPTION);
        if (attempt === 1) return new Promise(() => {});
        await stage(workspace, caller, { ...DESCRIPTION, title: "Close issue" });
        return "ran";
      });
      impl.queueWorkflowRun(HOOK, delivery.deliveryId, "onSchedule", [FIRING]);
      void impl.runQueuedWorkflowRuns();
      return delivery.deliveryId;
    });
    await withImpl(name, impl => vi.waitFor(() => expect(actionsOf(impl)).toHaveLength(1)));
    await abortAllDurableObjects();
    let done = await settled(name, id);
    expect(done.execution).toMatchObject({ state: "finished", attempts: 2 });
    let actions = await withImpl(name, impl => actionsOf(impl));
    expect(actions.map((a: any) => [a.description.title, a.workflowRun.attempt])).toEqual([["Create issue", 1], ["Close issue", 2]]);
    expect(manualOnly(actions[1])).toBe(true);
  });

  // The InferOps gatekeeper joins a repeated create to its pending record and submits nothing.
  it("continues when a replayed create joins its pending record and submits nothing", async () => {
    let name = `run-exec-join-${crypto.randomUUID()}`;
    let attempt = 0;
    let id = await withImpl(name, impl => {
      let delivery = admitted(impl);
      runsAs(impl, "gadget-bindings", async (workspace, caller) => {
        attempt++;
        if (attempt === 1) {
          await stage(workspace, caller, DESCRIPTION);
          return new Promise(() => {});
        }
        return "ran"; // the gatekeeper joined the pending create: nothing reaches the workspace
      });
      impl.queueWorkflowRun(HOOK, delivery.deliveryId, "onSchedule", [FIRING]);
      void impl.runQueuedWorkflowRuns();
      return delivery.deliveryId;
    });
    await withImpl(name, impl => vi.waitFor(() => expect(actionsOf(impl)).toHaveLength(1)));
    await abortAllDurableObjects();
    let done = await settled(name, id);
    expect(done.execution).toMatchObject({ state: "finished", attempts: 2 });
    expect(await withImpl(name, impl => actionsOf(impl))).toHaveLength(1);
  });

  // The InferOps gatekeeper refuses a second edit of a target while the first is pending: the
  // replay fails, and the first write stays pending for a person, never applied twice.
  it("fails a replayed edit the gatekeeper refuses while the first is pending, leaving that one pending", async () => {
    let name = `run-exec-edit-${crypto.randomUUID()}`;
    let attempt = 0;
    let id = await withImpl(name, impl => {
      let delivery = admitted(impl);
      runsAs(impl, "gadget-bindings", async (workspace, caller) => {
        attempt++;
        if (attempt === 2) throw new Error("This issue already has a pending edit.");
        await stage(workspace, caller, DESCRIPTION);
        return new Promise(() => {});
      });
      impl.queueWorkflowRun(HOOK, delivery.deliveryId, "onSchedule", [FIRING]);
      void impl.runQueuedWorkflowRuns();
      return delivery.deliveryId;
    });
    await withImpl(name, impl => vi.waitFor(() => expect(actionsOf(impl)).toHaveLength(1)));
    await abortAllDurableObjects();
    let done = await settled(name, id);
    expect(done.execution).toMatchObject({ state: "failed", failure: "runtime-error", attempts: 2 });
    let actions = await withImpl(name, impl => actionsOf(impl));
    expect(actions).toEqual([expect.objectContaining({ state: "pending" })]);
  });

});

// Round 4 (review HIGH): an incomplete description doesn't show the operation it stands for, so two
// different operations can read the same; such a write is never matched, so none is dropped.
describe("a replay's write with an incomplete description (FAC-112)", () => {
  it("is never matched: recorded again and left for a person, nothing withdrawn", async () => {
    let name = `run-exec-incomplete-${crypto.randomUUID()}`;
    let attempt = 0;
    let id = await withImpl(name, impl => {
      let delivery = admitted(impl);
      runsAs(impl, "gadget-bindings", async (workspace, caller) => {
        attempt++;
        // The same summary each time, whatever operation the gatekeeper staged under it.
        await stage(workspace, caller, SUMMARY);
        if (attempt === 1) return new Promise(() => {});
        return "ran";
      });
      impl.queueWorkflowRun(HOOK, delivery.deliveryId, "onSchedule", [FIRING]);
      void impl.runQueuedWorkflowRuns();
      return delivery.deliveryId;
    });
    await withImpl(name, impl => vi.waitFor(() => expect(actionsOf(impl)).toHaveLength(1)));
    await abortAllDurableObjects();
    let done = await settled(name, id);
    expect(done.execution).toMatchObject({ state: "finished", attempts: 2 });
    let actions = await withImpl(name, impl => actionsOf(impl));
    expect(actions.map((a: any) => [a.action, a.workflowRun.attempt])).toEqual([[1, 1], [2, 2]]);
    expect(manualOnly(actions[1])).toBe(true);
    expect(gatekeeper.withdrawn).toEqual([]);
  });
});

// Round 4 (review MEDIUM): withdrawing a replay's second copy is recorded with the match, retried by
// the alarm until it succeeds, and shown to a person, to reject, when it never does.
/** A run that wrote once, was interrupted, and ran again to its end: its replay staged one copy. */
async function replayed(name: string) {
  let attempt = 0;
  let id = await withImpl(name, impl => {
    let delivery = admitted(impl);
    runsAs(impl, "gadget-bindings", async (workspace, caller) => {
      attempt++;
      await stage(workspace, caller, DESCRIPTION);
      if (attempt === 1) return new Promise(() => {});
      return "ran";
    });
    impl.queueWorkflowRun(HOOK, delivery.deliveryId, "onSchedule", [FIRING]);
    void impl.runQueuedWorkflowRuns();
    return delivery.deliveryId;
  });
  await withImpl(name, impl => vi.waitFor(() => expect(actionsOf(impl)).toHaveLength(1)));
  await abortAllDurableObjects();
  return settled(name, id);
}

describe("withdrawing a replay's staged copy (FAC-112)", () => {
  it("is kept until the gatekeeper takes it: a failure is retried, then the entry goes", async () => {
    let name = `run-exec-withdraw-${crypto.randomUUID()}`;
    gatekeeper.failWithdraws = 1;
    await replayed(name);
    await withImpl(name, async impl => {
      // The first try fails and is kept, with a later try due; the next succeeds.
      await impl.retryReplayWithdrawals(Date.now() + 1e9);
      expect([...impl.storage.replayWithdrawals.list()]).toEqual([expect.objectContaining({ action: 2, attempts: 1 })]);
      await impl.retryReplayWithdrawals(Date.now() + 2e9);
      expect([...impl.storage.replayWithdrawals.list()]).toEqual([]);
    });
    expect(gatekeeper.withdrawn).toEqual([2]);
    expect([...gatekeeper.staged.keys()]).toEqual([1]);
  });

  // Round 5 (review HIGH): each assigned delivery's writes live on its own facet, which numbers its
  // actions from 1, so two deliveries on one connection can both stage the same key. Each copy is
  // tracked by the facet it lives on, so neither is orphaned.
  it("tracks and withdraws two assigned deliveries' copies with the same key, each on its own facet", async () => {
    await withImpl(`run-exec-withdraw-two-${crypto.randomUUID()}`, async impl => {
      let first = admitted(impl, { assigned: true });
      let store = impl.workflowDefinitionStore();
      let second = store.fire(HOOK, GADGET, (gid: number) => (gid === GADGET ? commit(1) : undefined), () => true,
          store.beginInvocation(PERSON, HOOK, null).id)!;
      let withdrawn: string[] = [];
      onPrototype(impl, "openAssignedActionFacet", async (record: any) => ({
        facet: { rejectAction: async (key: number) => { withdrawn.push(`${record.executedAs.deliveryId}:${key}`); } },
        close: () => {},
      }));
      for (let d of [first.deliveryId, second.deliveryId]) {
        let caller = { from: "systemRun", hookId: HOOK, deliveryId: d };
        impl.systemRuns.begin(d, { hookId: HOOK, gatekeeperId: CONNECTION, credentialRef: REF });
        let digest = await actionDescriptionDigest(DESCRIPTION);
        impl.startWorkflowRunProposals(d);
        impl.submitActionNow(CONNECTION, 1, DESCRIPTION, caller, digest); // its facet's first key
        impl.startWorkflowRunProposals(d); // the replay
        impl.submitActionNow(CONNECTION, 2, DESCRIPTION, caller, digest); // matched; the facet's next key
      }
      expect([...impl.storage.replayWithdrawals.list()]).toHaveLength(2);
      await impl.retryReplayWithdrawals(Date.now() + 1e9);
      expect(withdrawn.toSorted()).toEqual([`${first.deliveryId}:2`, `${second.deliveryId}:2`].toSorted());
      expect([...impl.storage.replayWithdrawals.list()]).toEqual([]);
    });
  });

  it("never taken, becomes a pending duplicate a person can only reject", async () => {
    let name = `run-exec-withdraw-stuck-${crypto.randomUUID()}`;
    gatekeeper.failWithdraws = 1_000;
    await replayed(name);
    await withImpl(name, async impl => {
      for (let i = 1; i <= 10; i++) await impl.retryReplayWithdrawals(Date.now() + i * 1e9);
      expect([...impl.storage.replayWithdrawals.list()]).toEqual([]);
      let [first, duplicate] = actionsOf(impl);
      expect(duplicate).toMatchObject({ action: 2, state: "pending", replayDuplicateOf: first.id });
      let refused = await impl.applyPendingAction(duplicate, ADA, false).then(() => "applied", (e: Error) => e.message);
      expect(refused).toContain("duplicate");
      expect(impl.storage.actions.get(duplicate.id).state).toBe("pending");
    });
  });
});

describe("a requested run uses only its stored starting context (FAC-112)", () => {
  // Round 2 (the manager's (a)): the page edited mid-run reaches the gadget's own facet only; the
  // run's worker was loaded from the pinned commit, and it finishes on it.
  it("on the gadget's bindings, finishes on its pinned revision when the page is edited mid-run", async () => {
    let name = `run-exec-code-${crypto.randomUUID()}`;
    let id = await withImpl(name, impl => {
      let delivery = admitted(impl);
      workflowRun = async workerEnv => {
        // The page's code is edited while the run runs: the gadget's head moves on.
        onPrototype(workerEnv.BOARD.workspace, "getGadgetHead", (gid: number) => (gid === GADGET ? commit(2) : undefined));
        return "ran";
      };
      impl.queueWorkflowRun(HOOK, delivery.deliveryId, "onSchedule", [FIRING]);
      return delivery.deliveryId;
    });
    let done = await settled(name, id);
    expect(calls).toEqual([]); // never the gadget's own hook code
    expect(loaded.commitIds).toEqual([commit(1)]);
    expect(done.execution).toMatchObject({ state: "finished", attempts: 1 });
  });

  it("on the gadget's bindings, gives the worker only the gadget's connections, each carrying the run", async () => {
    let name = `run-exec-env-${crypto.randomUUID()}`;
    let id = await withImpl(name, impl => {
      let delivery = admitted(impl);
      workflowRun = async workerEnv => {
        await stage(workerEnv.BOARD.workspace, workerEnv.BOARD.caller, DESCRIPTION);
        return "ran";
      };
      impl.queueWorkflowRun(HOOK, delivery.deliveryId, "onSchedule", [FIRING]);
      return delivery.deliveryId;
    });
    let done = await settled(name, id);
    expect(Object.keys(loaded.envs[0]!)).toEqual(["BOARD"]);
    expect(loaded.envs[0]!.BOARD.caller).toEqual({ from: "gadget", gadgetId: GADGET, run: { hookId: HOOK, deliveryId: id } });
    let actions = await withImpl(name, impl => actionsOf(impl));
    expect(actions).toEqual([expect.objectContaining({
      workflowRun: { runId: done.run.runId, hookId: HOOK, deliveryId: id, writeKey: expect.any(String), attempt: 1 },
    })]);
  });

  it("on the gadget's bindings, re-checks the person at a queued write: taken off the control, it stays pending", async () => {
    await withImpl(`run-exec-write-${crypto.randomUUID()}`, async impl => {
      let delivery = admitted(impl);
      let caller = { from: "gadget", gadgetId: GADGET, run: { hookId: HOOK, deliveryId: delivery.deliveryId } };
      impl.workflowDefinitionStore().startRun(delivery.deliveryId);
      impl.gadgetRuns.begin(delivery.deliveryId, { hookId: HOOK, gadgetId: GADGET });
      impl.startWorkflowRunProposals(delivery.deliveryId);
      let actionId = await submitted(impl, caller);
      impl.workflowDefinitionStore().setControl(ADA, HOOK, { label: "Run refunds", invokers: ["someone-else"] });
      impl.getGatekeeperFacet = () => { throw new Error("the write was sent"); };
      let refused = await impl.applyPendingAction(impl.storage.actions.get(actionId), ADA, false)
        .then(() => "applied", (e: Error) => e.message);
      expect(refused).toBe(RUN_REQUESTER_REVOKED);
      expect(impl.storage.actions.get(actionId).state).toBe("pending");
    });
  });

  it("runs an assigned run from its pinned commit as its service account, whatever the page holds now", async () => {
    let name = `run-exec-assigned-${crypto.randomUUID()}`;
    let ran: unknown[] = [];
    let id = await withImpl(name, impl => {
      let delivery = admitted(impl, { assigned: true });
      onPrototype(impl, "runAssignedDelivery", async (...args: unknown[]) => { ran.push(args); return "ran"; });
      impl.queueWorkflowRun(HOOK, delivery.deliveryId, "onSchedule", [FIRING]);
      onPrototype(impl, "getGadgetHead", (gid: number) => (gid === GADGET ? commit(2) : undefined));
      return delivery.deliveryId;
    });
    let done = await settled(name, id);
    expect(calls).toEqual([]);
    expect(ran).toEqual([[HOOK, { deliveryId: id, commitId: commit(1), credentialRef: REF }, "onSchedule", [FIRING]]]);
    expect(done.execution).toMatchObject({ state: "finished" });
  });

  it("re-checks the person at its start: taken off the control after asking, nothing runs", async () => {
    let name = `run-exec-requester-${crypto.randomUUID()}`;
    let id = await withImpl(name, impl => {
      let delivery = admitted(impl);
      impl.queueWorkflowRun(HOOK, delivery.deliveryId, "onSchedule", [FIRING]);
      impl.workflowDefinitionStore().setControl(ADA, HOOK, { label: "Run refunds", invokers: ["someone-else"] });
      return delivery.deliveryId;
    });
    let done = await settled(name, id);
    expect(calls).toEqual([]);
    expect(done.execution).toMatchObject({ state: "failed", failure: "requester-revoked" });
    expect(JSON.stringify(done)).not.toContain(RUN_REQUESTER_REVOKED);
  });
});

// Round 1 (review HIGH): what a run threw can carry data only its executor may see, so the stored
// and listed outcome is a fixed category; the words stay in the server's log.
describe("a failed run's recorded outcome (FAC-112)", () => {
  it("is a fixed category, never what the run threw", async () => {
    let name = `run-exec-failure-${crypto.randomUUID()}`;
    const SENTINEL = "SENTINEL-only-the-service-account-sees-this";
    let { id, definitionId } = await withImpl(name, impl => {
      let delivery = admitted(impl);
      answer = async () => { throw new Error(SENTINEL); };
      impl.queueWorkflowRun(HOOK, delivery.deliveryId, "onSchedule", [FIRING]);
      return { id: delivery.deliveryId, definitionId: delivery.definitionId };
    });
    let done = await settled(name, id);
    expect(done.execution).toMatchObject({ state: "failed", failure: "runtime-error" });
    expect(JSON.stringify(done)).not.toContain(SENTINEL);
    let listed = await withImpl(name, impl => impl.workflowDefinitionStore().deliveries(ADA.id, definitionId));
    expect(JSON.stringify(listed)).not.toContain(SENTINEL);
  });
});
