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
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { onlyExplicitAlarms, takeSkippedFiring } from "./test-worker.js";
import { RUN_REQUESTER_REVOKED, TRIGGER_AUTO_RETIRED, WORKFLOW_RUN_CANCELLED, invokeWorkflowTrigger, type OverseerDurableObject } from "../src/overseer.js";
import {
  DEFAULT_WORKFLOW_RUN_LIMITS, TRIGGER_DRAINING, TRIGGER_LIFECYCLE_REFUSED, WORKFLOW_BINDINGS_NEEDED, WORKFLOW_BINDINGS_NOT_OWNERS,
  WORKFLOW_RUN_RETRY_REFUSED, WORKFLOW_RUN_RETRY_WINDOW_MS, WORKFLOW_WRITE_SETTLE_REFUSED,
} from "@gadgets/workshop-shared/workflow-definition";
import { manualOnly } from "../src/auto-approval.js";
import { WORKFLOW_ASSIGNMENTS_DISABLED, actionDescriptionDigest } from "../src/system-run.js";
import { UNPUBLISHED_REVISION_OWNER_CANT_BUILD } from "../src/workflow-definition-store.js";

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
/**
 * Which workspace each entry of `calls` ran in (FAC-117): a run an earlier test left queued can be
 * started by its own workspace's alarm during a later test, so a test counting runs counts its own.
 */
let callWorkspaces: string[] = [];
/** How many runs the stand-in code ran in workspace `name`. */
const callsIn = (name: string) => callWorkspaces.filter(id => id === env.TEST_OVERSEER.getByName(name).id.toString()).length;
/**
 * The run limits the workspace sees (FAC-117): the deployment defaults, but with no backoff, so a
 * test that resets mid-run re-executes at once. The tests of the limits themselves set their own.
 */
let testLimits: Record<string, number> = { ...DEFAULT_WORKFLOW_RUN_LIMITS, backoffSeconds: 0 };

// Each test runs its workspace's alarm itself (`runAlarm`, below). One workerd fired on its own
// would race the test's calls (a replay's withdrawal is due at once) or wake an earlier test's
// workspace during a later one, through the stand-ins that test put on the shared prototype and
// into `calls` and `gatekeeper`.
beforeAll(() => onlyExplicitAlarms());

afterEach(() => {
  for (let undo of restore.splice(0)) undo();
  calls = [];
  callWorkspaces = [];
  statesSeen = [];
  loaded = { commitIds: [], envs: [] };
  gatekeeper = { next: 1, staged: new Map(), withdrawn: [], failWithdraws: 0 };
  workflowRun = defaultWorkflowRun;
  answer = async () => "done";
  testLimits = { ...DEFAULT_WORKFLOW_RUN_LIMITS, backoffSeconds: 0 };
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
  callWorkspaces.push(workerEnv.BOARD.workspace.ctx.id.toString());
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
  onPrototype(impl, "runLimits", () => testLimits);
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
  let saved = store.save(ADA, { title: "Refund", gadgetId: GADGET }, head, "build");
  store.publish(ADA, saved.id, 1);
  store.pinTrigger(ADA.id, HOOK, GADGET, { definitionId: saved.id, revision: 1 });
  store.setControl(ADA, HOOK, { label: "Run refunds", invokers: [PERSON] });
  if (opts.assigned) {
    impl.storage.workflowTriggerAssignments.put({
      hookId: HOOK, gatekeeperId: CONNECTION, credentialRef: REF, assignedBy: ADA, assignedAt: new Date(0),
    });
  }
  let invocation = store.beginInvocation(PERSON, HOOK, null);
  return store.fire(HOOK, GADGET, head, () => "build" as const, invocation.id)!;
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

/**
 * Runs the workspace's alarm handler now, as workerd would have: workerd's own firing never runs it
 * in this file (`onlyExplicitAlarms`, above), so each test runs it exactly when it means to. The
 * alarm must have been armed, still or until workerd fired it, so a run queued without arming its
 * alarm, which would never start in production, fails here. workerd can take an armed alarm before
 * its firing reaches the gate (`takeSkippedFiring`), so the check waits a moment for either.
 */
async function runAlarm(name: string) {
  let stub = env.TEST_OVERSEER.getByName(name);
  let id = stub.id.toString();
  let fired = false;
  await vi.waitFor(async () => {
    fired ||= takeSkippedFiring(id);
    let armed = await runInDurableObject(stub, async (_: OverseerDurableObject, state: DurableObjectState) =>
      (await state.storage.getAlarm()) !== null);
    expect(armed || fired, "the workspace's alarm was never armed").toBe(true);
  }, { timeout: 2_000 });
  await runInDurableObject(stub, async (instance: OverseerDurableObject, state: DurableObjectState) => {
    // Whatever was armed or fired until now, this run is it.
    await state.storage.deleteAlarm();
    takeSkippedFiring(id);
    await instance.alarm();
  });
}

/** Runs the workspace's alarm once more: what withdraws a replay's staged copies (retryReplayWithdrawals). */
async function nextAlarm(name: string) {
  await runAlarm(name);
}

async function settled(name: string, id: number) {
  await runAlarm(name);
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
      let second = store.fire(HOOK, GADGET, (gid: number) => (gid === GADGET ? commit(1) : undefined), () => "build" as const,
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
    let listed = await withImpl(name, impl => impl.workflowDefinitionStore().deliveries(ADA.id, definitionId, "build"));
    expect(JSON.stringify(listed)).not.toContain(SENTINEL);
  });
});

// FAC-123: a duplicated workflow's gadget carries the connections it must have set up; until each is,
// nothing of it runs. Checked as a run is admitted, as it starts and before each write, over the
// workspace's own registry, so a connection removed after it was set up stops the next run again.
describe("a duplicate's connections, at admission, at run start and at a write (FAC-123)", () => {
  /**
   * The trigger's gadget as Ada's duplicate's: BOARD must be a scheduler connection made from her own
   * account, bound or not. `madeBy` says whose account the bound connection uses (FAC-123).
   */
  function asDuplicate(impl: any, bound: boolean, madeBy: string | null = "ada-user") {
    impl.storage.gadgets.put({
      type: "gadget", id: GADGET, title: "Refund copy", created: new Date(0), bindingName: "REFUND_COPY", commitId: commit(1),
      bindings: bound ? { BOARD: { target: CONNECTION } } : {},
      requiredBindings: [{ name: "BOARD", type: "gatekeeper", vendorId: "scheduler", typeUrlPattern: "scheduler://*" }],
      requiredBindingsOwner: "ada-user",
    });
    let connection = impl.storage.gatekeepers.get(CONNECTION);
    let { connectedBy: _was, ...rest } = connection;
    impl.storage.gatekeepers.put({ ...rest, ...(madeBy ? { connectedBy: { userId: madeBy, accountId: 1 } } : {}) });
  }
  const head = (id: number) => (id === GADGET ? commit(1) : undefined);
  /** Another run PERSON asks for, fired and queued. */
  function another(impl: any) {
    let store = impl.workflowDefinitionStore();
    let delivery = store.fire(HOOK, GADGET, head, () => "build" as const, store.beginInvocation(PERSON, HOOK, null).id)!;
    impl.queueWorkflowRun(HOOK, delivery.deliveryId, "onSchedule", [FIRING]);
    return delivery.deliveryId;
  }

  it("refuses a request while a connection isn't set up, before anything is admitted", async () => {
    await withImpl(`dup-admit-${crypto.randomUUID()}`, async impl => {
      admitted(impl);
      asDuplicate(impl, false);
      let before = [...impl.storage.workflowInvocations.list()].length;
      await expect(invokeWorkflowTrigger(impl, "operator-user", PERSON, HOOK)).rejects.toThrow(WORKFLOW_BINDINGS_NEEDED);
      expect([...impl.storage.workflowInvocations.list()]).toHaveLength(before);
    });
  });

  it("fails a run at its start until set up, runs once it is, and fails the next once a connection is removed", async () => {
    let name = `dup-start-${crypto.randomUUID()}`;
    let first = await withImpl(name, impl => {
      let delivery = admitted(impl);
      asDuplicate(impl, false);
      impl.queueWorkflowRun(HOOK, delivery.deliveryId, "onSchedule", [FIRING]);
      return delivery.deliveryId;
    });
    let refused = await settled(name, first);
    expect(calls).toEqual([]);
    expect(refused.execution).toMatchObject({ state: "failed", failure: "bindings-needed" });
    expect(JSON.stringify(refused)).not.toContain(WORKFLOW_BINDINGS_NEEDED);

    let second = await withImpl(name, impl => {
      workerSeams(impl);
      asDuplicate(impl, true);
      return another(impl);
    });
    expect((await settled(name, second)).execution).toMatchObject({ state: "finished" });
    expect(calls).toHaveLength(1);

    let third = await withImpl(name, impl => {
      workerSeams(impl);
      asDuplicate(impl, false);
      return another(impl);
    });
    expect((await settled(name, third)).execution).toMatchObject({ state: "failed", failure: "bindings-needed" });
    expect(calls).toHaveLength(1);
  });

  it("never runs on another person's connection, however it was bound, and runs on the owner's own", async () => {
    let name = `dup-owner-${crypto.randomUUID()}`;
    let theirs = await withImpl(name, async impl => {
      let delivery = admitted(impl);
      // Bound as a chat binds any connection of the workspace: an accepted edge to Ben's.
      asDuplicate(impl, true, "ben-user");
      expect(impl.bindingsNeeded(GADGET)).toEqual([expect.objectContaining({ name: "BOARD", unmet: "not-owners" })]);
      await expect(invokeWorkflowTrigger(impl, "operator-user", PERSON, HOOK)).rejects.toThrow(WORKFLOW_BINDINGS_NOT_OWNERS);
      impl.queueWorkflowRun(HOOK, delivery.deliveryId, "onSchedule", [FIRING]);
      return delivery.deliveryId;
    });
    expect((await settled(name, theirs)).execution).toMatchObject({ state: "failed", failure: "bindings-needed" });
    expect(calls).toEqual([]);
    // Unrecorded (an older connection): not filled either.
    await withImpl(name, impl => {
      asDuplicate(impl, true, null);
      expect(impl.bindingsNeeded(GADGET)).toEqual([expect.objectContaining({ unmet: "unattributed" })]);
    });
    let own = await withImpl(name, impl => {
      workerSeams(impl);
      asDuplicate(impl, true, "ada-user");
      expect(impl.bindingsNeeded(GADGET)).toEqual([]);
      return another(impl);
    });
    expect((await settled(name, own)).execution).toMatchObject({ state: "finished" });
    expect(calls).toHaveLength(1);
  });

  it("leaves a run's write pending, with nothing sent, once a connection it needs is removed", async () => {
    await withImpl(`dup-write-${crypto.randomUUID()}`, async impl => {
      let delivery = admitted(impl);
      asDuplicate(impl, true);
      let caller = { from: "gadget", gadgetId: GADGET, run: { hookId: HOOK, deliveryId: delivery.deliveryId } };
      impl.workflowDefinitionStore().startRun(delivery.deliveryId);
      impl.gadgetRuns.begin(delivery.deliveryId, { hookId: HOOK, gadgetId: GADGET });
      impl.startWorkflowRunProposals(delivery.deliveryId);
      let actionId = await submitted(impl, caller);
      asDuplicate(impl, false);
      impl.getGatekeeperFacet = () => { throw new Error("the write was sent"); };
      let refused = await impl.applyPendingAction(impl.storage.actions.get(actionId), ADA, false)
        .then(() => "applied", (e: Error) => e.message);
      expect(refused).toBe(WORKFLOW_BINDINGS_NEEDED);
      expect(impl.storage.actions.get(actionId)).toMatchObject({ state: "pending", blocked: { reason: WORKFLOW_BINDINGS_NEEDED } });
    });
  });
});

// FAC-117: a trigger's lifecycle (pause drains, retire only once drained), cancelling one run, and
// the run limits (concurrency, time, bounded attempts with a backoff). Over a real Overseer.
describe("a trigger's lifecycle and a run's cancellation and limits (FAC-117)", () => {
  const head = (id: number) => (id === GADGET ? commit(1) : undefined);
  /** Another run PERSON asks for, fired and queued; its delivery id and invocation id. */
  function another(impl: any) {
    let store = impl.workflowDefinitionStore();
    let invocation = store.beginInvocation(PERSON, HOOK, null);
    let delivery = store.fire(HOOK, GADGET, head, () => "build" as const, invocation.id)!;
    impl.queueWorkflowRun(HOOK, delivery.deliveryId, "onSchedule", [FIRING]);
    return { deliveryId: delivery.deliveryId, invocationId: invocation.id };
  }
  /** The first admitted run, queued; its delivery and invocation ids. */
  function queuedFirst(impl: any) {
    let delivery = admitted(impl);
    impl.queueWorkflowRun(HOOK, delivery.deliveryId, "onSchedule", [FIRING]);
    return { deliveryId: delivery.deliveryId, invocationId: deliveryOf(impl, delivery.deliveryId).invocation.id };
  }
  /**
   * Leaves no queued run and no alarm in this workspace: a run left queued would be started by its
   * alarm during a later test, and its stand-in code would record into that test's `calls`.
   */
  async function quiesce(impl: any) {
    for (let queued of Array.from(impl.storage.workflowRunQueue.list()) as { deliveryId: number }[]) {
      impl.storage.workflowRunQueue.delete(queued.deliveryId);
    }
    await impl.ctx.storage.deleteAlarm();
  }
  /**
   * The hook's controller, a stand-in the pause can disable: given on each read and dropped on each
   * write, since storage can't hold functions (a real controller is a stub it can).
   */
  function withController(impl: any) {
    let hooks = impl.storage.boundHooks;
    let get = hooks.get.bind(hooks);
    let put = hooks.put.bind(hooks);
    hooks.get = (id: number) => {
      let record = get(id);
      return record && { ...record, controller: { disable: async () => {}, enable: async () => {} } };
    };
    hooks.put = (record: any) => put({ ...record, controller: null });
    restore.push(() => { hooks.get = get; hooks.put = put; });
  }

  it("pausing drains: no new start, the run admitted before it finishes, and then it is paused", async () => {
    let name = `life-drain-${crypto.randomUUID()}`;
    let id = await withImpl(name, async impl => {
      let { deliveryId } = queuedFirst(impl);
      withController(impl);
      // Admitted strictly before the pause: a run admitted in its very millisecond isn't.
      await new Promise(resolve => setTimeout(resolve, 5));
      let lifecycle = await impl.pauseTrigger(HOOK, ADA);
      expect(lifecycle).toMatchObject({ state: "draining", changedBy: ADA });
      expect(impl.storage.boundHooks.get(HOOK).enabled).toBe(false);
      await expect(invokeWorkflowTrigger(impl, "operator-user", PERSON, HOOK)).rejects.toThrow();
      return deliveryId;
    });
    let done = await settled(name, id);
    expect(done.execution).toMatchObject({ state: "finished" });
    expect(callsIn(name)).toBe(1);
    await withImpl(name, impl => expect(impl.triggerLifecycleOf(HOOK)).toMatchObject({ state: "paused" }));
  });

  it("removing a workflow trigger pauses new starts, lets its admitted run finish, then retires on retry", async () => {
    let name = `life-remove-${crypto.randomUUID()}`;
    let id = await withImpl(name, async impl => {
      let { deliveryId } = queuedFirst(impl);
      withController(impl);
      await new Promise(resolve => setTimeout(resolve, 5));
      await expect(impl.removeHookWithDrain(HOOK, ADA)).rejects.toThrow(
        `${TRIGGER_DRAINING}: This workflow is paused while its run finishes. Remove it again when the run is complete.`);
      expect(impl.storage.boundHooks.get(HOOK).enabled).toBe(false);
      expect(impl.triggerLifecycleOf(HOOK)).toMatchObject({ state: "draining" });
      await expect(invokeWorkflowTrigger(impl, "operator-user", PERSON, HOOK)).rejects.toThrow();
      return deliveryId;
    });

    let completed = await settled(name, id);
    expect(completed.execution).toMatchObject({ state: "finished" });
    expect(callsIn(name)).toBe(1);
    await withImpl(name, async impl => {
      expect(impl.triggerLifecycleOf(HOOK)).toMatchObject({ state: "paused" });
      await impl.removeHookWithDrain(HOOK, ADA);
      expect(impl.storage.boundHooks.get(HOOK)).toBeUndefined();
      expect(impl.triggerLifecycleOf(HOOK)).toMatchObject({ state: "retired" });
      expect(deliveryOf(impl, id).execution).toMatchObject({ state: "finished" });
    });
  });

  it("deletes a non-workflow hook immediately", async () => {
    await withImpl(`life-remove-ordinary-${crypto.randomUUID()}`, async impl => {
      impl.storage.boundHooks.put({
        id: HOOK, actionId: 1, gatekeeperId: CONNECTION, gadgetId: GADGET, vendorId: "scheduler",
        controller: null, callback: null, description: { title: "Ordinary hook" }, enabled: true,
      });
      withController(impl);
      await impl.removeHookWithDrain(HOOK, ADA);
      expect(impl.storage.boundHooks.get(HOOK)).toBeUndefined();
      expect(impl.triggerLifecycleOf(HOOK)).toBeNull();
      expect(impl.storage.workflowTriggerLifecycles.get(HOOK)).toBeUndefined();
    });
  });

  it("refuses a run admitted after the pause's recorded time, and its write, while earlier ones go on", async () => {
    await withImpl(`life-narrow-${crypto.randomUUID()}`, async impl => {
      let { deliveryId } = queuedFirst(impl);
      withController(impl);
      await impl.pauseTrigger(HOOK, ADA);
      let lifecycle = impl.triggerLifecycleOf(HOOK);
      let admittedAt = deliveryOf(impl, deliveryId).at.getTime();
      // Recorded as paused just before this run was admitted: it may not go on.
      impl.storage.workflowTriggerLifecycles.put({ ...lifecycle, pausedAt: new Date(admittedAt - 1) });
      let caller = { from: "gadget", gadgetId: GADGET, run: { hookId: HOOK, deliveryId } };
      impl.workflowDefinitionStore().startRun(deliveryId);
      impl.gadgetRuns.begin(deliveryId, { hookId: HOOK, gadgetId: GADGET });
      impl.startWorkflowRunProposals(deliveryId);
      let actionId = await submitted(impl, caller);
      impl.getGatekeeperFacet = () => { throw new Error("the write was sent"); };
      let refused = await impl.applyPendingAction(impl.storage.actions.get(actionId), ADA, false)
        .then(() => "applied", (e: Error) => e.message);
      expect(refused).toBe(RUN_REQUESTER_REVOKED);
      // Paused just after it instead: the same write is decidable (it reaches the connection).
      impl.storage.workflowTriggerLifecycles.put({ ...lifecycle, pausedAt: new Date(admittedAt + 1) });
      impl.authorizeCollaborator = async () => true;
      let decided = await impl.applyPendingAction(impl.storage.actions.get(actionId), ADA, false)
        .then(() => "applied", (e: Error) => e.message);
      expect(decided).toBe("the write was sent");
      await quiesce(impl);
    });
  });

  it("retires only once drained, keeps the run's history, and a retired trigger never activates", async () => {
    let name = `life-retire-${crypto.randomUUID()}`;
    let id = await withImpl(name, async impl => {
      let { deliveryId } = queuedFirst(impl);
      withController(impl);
      await new Promise(resolve => setTimeout(resolve, 5));
      await impl.pauseTrigger(HOOK, ADA);
      await expect(impl.retireTrigger(HOOK, ADA)).rejects.toThrow(TRIGGER_LIFECYCLE_REFUSED.retire);
      return deliveryId;
    });
    await settled(name, id);
    await withImpl(name, async impl => {
      expect(await impl.retireTrigger(HOOK, ADA)).toMatchObject({ state: "retired" });
      expect(impl.storage.boundHooks.get(HOOK)).toBeUndefined();
      expect(deliveryOf(impl, id).execution.state).toBe("finished");
    });
  });

  // Round 2 (r1 MEDIUM): an ended `uncertain` run is history, not executing work, so it never holds
  // the drain; the write it left pending stays decidable while paused, then the trigger retires.
  it("pauses and retires a trigger whose earlier run ended uncertain, its pending write still decidable", async () => {
    await withImpl(`life-uncertain-${crypto.randomUUID()}`, async impl => {
      let { deliveryId } = queuedFirst(impl);
      let caller = { from: "gadget", gadgetId: GADGET, run: { hookId: HOOK, deliveryId } };
      let store = impl.workflowDefinitionStore();
      store.startRun(deliveryId);
      impl.gadgetRuns.begin(deliveryId, { hookId: HOOK, gadgetId: GADGET });
      impl.startWorkflowRunProposals(deliveryId);
      let actionId = await submitted(impl, caller);
      impl.gadgetRuns.end(deliveryId);
      store.endRun(deliveryId, "runtime-error");
      impl.settleRunOfAction(actionId);
      expect(deliveryOf(impl, deliveryId).result).toMatchObject({ outcome: "uncertain", reason: "lost-after-write" });
      withController(impl);
      await new Promise(resolve => setTimeout(resolve, 5));
      await impl.pauseTrigger(HOOK, ADA);
      expect(impl.triggerLifecycleOf(HOOK)).toMatchObject({ state: "paused" });
      // Paused, the earlier run's write is still decided: it reaches the connection.
      impl.authorizeCollaborator = async () => true;
      impl.getGatekeeperFacet = () => { throw new Error("the write was sent"); };
      let decided = await impl.applyPendingAction(impl.storage.actions.get(actionId), ADA, false)
        .then(() => "applied", (e: Error) => e.message);
      expect(decided).toBe("the write was sent");
      expect(await impl.retireTrigger(HOOK, ADA)).toMatchObject({ state: "retired" });
      expect(deliveryOf(impl, deliveryId).result.outcome).toBe("uncertain");
      await quiesce(impl);
    });
  });

  it("cancels a queued run for the person who asked or the owner, never anyone else, and nothing of it runs", async () => {
    let name = `life-cancel-queued-${crypto.randomUUID()}`;
    let id = await withImpl(name, async impl => {
      let first = queuedFirst(impl);
      let stranger = { type: "user" as const, id: "stranger-profile", name: "Stranger" };
      await expect(impl.cancelWorkflowRun(first.invocationId, stranger, "build")).rejects.toThrow("No such run.");
      await impl.cancelWorkflowRun(first.invocationId, { type: "user", id: PERSON, name: "Operator" }, "use");
      expect(deliveryOf(impl, first.deliveryId).execution).toMatchObject({
        state: "failed", failure: "cancelled", cancelled: { by: { id: PERSON } },
      });
      expect(deliveryOf(impl, first.deliveryId).result).toMatchObject({ outcome: "failed", reason: "cancelled" });
      // It is ended history, so FAC-125's retention indexes it for removal like any other.
      expect([...impl.storage.workflowDeliveryExpiries.list()].map(pointer => pointer.deliveryId))
        .toContain(first.deliveryId);
      await expect(impl.cancelWorkflowRun(first.invocationId, ADA, "build")).rejects.toThrow("already ended");
      let second = another(impl);
      await impl.cancelWorkflowRun(second.invocationId, ADA, "build");
      return second.deliveryId;
    });
    await runAlarm(name);
    expect(callsIn(name)).toBe(0);
    await withImpl(name, impl => expect(deliveryOf(impl, id).execution.failure).toBe("cancelled"));
  });

  it("cancels a running run: its pending write is rejected as cancelled, never sent, and it fails as cancelled", async () => {
    await withImpl(`life-cancel-running-${crypto.randomUUID()}`, async impl => {
      let first = queuedFirst(impl);
      let caller = { from: "gadget", gadgetId: GADGET, run: { hookId: HOOK, deliveryId: first.deliveryId } };
      impl.workflowDefinitionStore().startRun(first.deliveryId);
      impl.gadgetRuns.begin(first.deliveryId, { hookId: HOOK, gadgetId: GADGET });
      impl.startWorkflowRunProposals(first.deliveryId);
      let actionId = await submitted(impl, caller);
      impl.getGatekeeperFacet = () => ({ rejectAction: async () => {} });
      await impl.cancelWorkflowRun(first.invocationId, ADA, "build");
      expect(impl.storage.actions.get(actionId)).toMatchObject({ state: "rejected", rejectedBecause: "cancelled" });
      expect(impl.gadgetRuns.has(first.deliveryId)).toBe(false);
      impl.workflowDefinitionStore().endRun(first.deliveryId, "runtime-error");
      expect(deliveryOf(impl, first.deliveryId).execution.failure).toBe("cancelled");
      await quiesce(impl);
    });
  });

  // Round 2 (r1 MEDIUM): the cancel's rejection loop is cleanup; the apply path refuses a cancelled
  // run's write itself, so one approved while an earlier rejection is still awaited is never sent.
  it("refuses a write approved while a cancel's rejection is held, and rejects it as cancelled, never sent", async () => {
    await withImpl(`life-cancel-race-${crypto.randomUUID()}`, async impl => {
      let first = queuedFirst(impl);
      let caller = { from: "gadget", gadgetId: GADGET, run: { hookId: HOOK, deliveryId: first.deliveryId } };
      impl.workflowDefinitionStore().startRun(first.deliveryId);
      impl.gadgetRuns.begin(first.deliveryId, { hookId: HOOK, gadgetId: GADGET });
      impl.startWorkflowRunProposals(first.deliveryId);
      let one = await submitted(impl, caller);
      let two = await submitted(impl, caller);
      let release!: () => void;
      let held = new Promise<void>(resolve => { release = resolve; });
      let rejected: unknown[] = [];
      let sent: unknown[] = [];
      // The connection: the first rejection is held; anything but a rejection is the write sent.
      impl.getGatekeeperFacet = () => new Proxy({}, {
        get(_target, prop) {
          if (prop === "then") return undefined;
          if (prop === "rejectAction") {
            return async (key: unknown) => {
              rejected.push(key);
              if (rejected.length === 1) await held;
            };
          }
          return async () => {
            sent.push(prop);
            throw new Error("the write was sent");
          };
        },
      });
      // The person may use the workspace: nothing but the cancel stands between the write and its connection.
      impl.authorizeCollaborator = async () => true;
      let cancelling = impl.cancelWorkflowRun(first.invocationId, ADA, "build");
      await vi.waitFor(() => expect(rejected).toHaveLength(1));
      expect(impl.storage.actions.get(two).state).toBe("pending");
      let approved = await impl.applyPendingAction(impl.storage.actions.get(two), ADA, false)
        .then(() => "applied", (e: Error) => e.message);
      expect(approved).toBe(WORKFLOW_RUN_CANCELLED);
      expect(sent).toEqual([]);
      expect(impl.storage.actions.get(two)).toMatchObject({ state: "rejected", rejectedBecause: "cancelled" });
      release();
      await cancelling;
      expect(impl.storage.actions.get(one)).toMatchObject({ state: "rejected", rejectedBecause: "cancelled" });
      expect(sent).toEqual([]);
      impl.workflowDefinitionStore().endRun(first.deliveryId, "runtime-error");
      impl.settleRunOfAction(one);
      expect(deliveryOf(impl, first.deliveryId).result).toMatchObject({ outcome: "failed", reason: "cancelled" });
      await quiesce(impl);
    });
  });

  // Paused, an earlier run that never started (a firing delivered late) doesn't start: only an
  // ended run's writes go on.
  it("never starts a run admitted before the pause once the trigger is paused", async () => {
    let name = `life-paused-late-${crypto.randomUUID()}`;
    let id = await withImpl(name, async impl => {
      let delivery = admitted(impl);
      withController(impl);
      await new Promise(resolve => setTimeout(resolve, 5));
      let lifecycle = await impl.pauseTrigger(HOOK, ADA);
      // Its start window passed, so the drain let go of it.
      impl.storage.workflowTriggerLifecycles.put({ ...lifecycle, state: "paused" });
      impl.queueWorkflowRun(HOOK, delivery.deliveryId, "onSchedule", [FIRING]);
      return delivery.deliveryId;
    });
    let done = await settled(name, id);
    expect(done.execution).toMatchObject({ state: "failed" });
    expect(callsIn(name)).toBe(0);
  });

  it("bounds re-execution after resets: past its attempts it fails, and inside its backoff it waits", async () => {
    let name = `life-attempts-${crypto.randomUUID()}`;
    let ids = await withImpl(name, impl => {
      let first = queuedFirst(impl);
      // The deployment's own backoff, which this test is about.
      testLimits = { ...DEFAULT_WORKFLOW_RUN_LIMITS };
      let second = another(impl);
      let deliveries = impl.storage.workflowDeliveries;
      let exhausted = deliveries.get(first.deliveryId);
      deliveries.put({ ...exhausted, execution: { ...exhausted.execution, state: "running",
        attempts: DEFAULT_WORKFLOW_RUN_LIMITS.attempts, startedAt: new Date(0) } });
      let backing = deliveries.get(second.deliveryId);
      deliveries.put({ ...backing, execution: { ...backing.execution, state: "running", attempts: 1, startedAt: new Date() } });
      return [first.deliveryId, second.deliveryId];
    });
    await runAlarm(name);
    expect(callsIn(name)).toBe(0);
    await withImpl(name, async impl => {
      expect(deliveryOf(impl, ids[0]).execution).toMatchObject({ state: "failed", failure: "attempts-exhausted" });
      expect(deliveryOf(impl, ids[1]).execution).toMatchObject({ state: "running", attempts: 1 });
      let alarm = await impl.ctx.storage.getAlarm();
      expect(alarm).toBeGreaterThan(Date.now() + 20_000);
      await quiesce(impl);
    });
  });

  it("runs one run of a trigger at a time; the next waits queued until it ends", async () => {
    let name = `life-concurrency-${crypto.randomUUID()}`;
    let seenWhileFirstRan: unknown[] = [];
    let ran = 0;
    let active = 0;
    let mostActive = 0;
    let first = 0;
    let second = await withImpl(name, impl => {
      let waiting: number | undefined;
      // While the first run's code runs, the second waits queued: the trigger's limit is one. Only
      // this workspace's runs count (a run another test left queued may be started meanwhile). Each
      // alarm pass starts what the limit allows: the first, then, on the next pass the first's end
      // armed, the second (this file runs each pass itself: onlyExplicitAlarms).
      workflowRun = async workerEnv => {
        if (workerEnv.BOARD.workspace.ctx.id.toString() !== impl.ctx.id.toString()) return "done";
        let mine = ++ran;
        active++;
        mostActive = Math.max(mostActive, active);
        // Looked at once the first has been running a while: by then a second start would have happened.
        await scheduler.wait(50);
        if (mine === 1 && waiting !== undefined) {
          seenWhileFirstRan.push(deliveryOf(workerEnv.BOARD.workspace, waiting).execution.state);
        }
        active--;
        return "done";
      };
      first = queuedFirst(impl).deliveryId;
      waiting = another(impl).deliveryId;
      return waiting;
    });
    expect((await settled(name, first)).execution.state).toBe("finished");
    let done = await settled(name, second);
    expect(done.execution.state).toBe("finished");
    expect(ran).toBe(2);
    // Never both at once, and the second was still queued while the first ran.
    expect(mostActive).toBe(1);
    expect(seenWhileFirstRan).toEqual(["queued"]);
  });

  it("stops a run past its time limit, as timed out", async () => {
    let name = `life-timeout-${crypto.randomUUID()}`;
    let id = await withImpl(name, impl => {
      let first = queuedFirst(impl);
      testLimits = { ...DEFAULT_WORKFLOW_RUN_LIMITS, runMinutes: 0.001 };
      // Settles well after the limit, so nothing is left pending once the test ends.
      answer = () => new Promise(resolve => setTimeout(() => resolve("too late"), 1500));
      return first.deliveryId;
    });
    let done = await settled(name, id);
    expect(done.execution).toMatchObject({ state: "failed", failure: "timed-out" });
    expect(done.result).toMatchObject({ outcome: "failed", reason: "timed-out" });
  });

  it("pausing in one workspace changes nothing in another", async () => {
    // Two workspaces with the same trigger id; nothing is queued, so no alarm outlives the test.
    let other = `life-other-${crypto.randomUUID()}`;
    await withImpl(other, impl => { admitted(impl); });
    await withImpl(`life-paused-${crypto.randomUUID()}`, async impl => {
      admitted(impl);
      withController(impl);
      await impl.pauseTrigger(HOOK, ADA);
    });
    await withImpl(other, impl => {
      expect(impl.triggerLifecycleOf(HOOK)).toBeNull();
      expect(impl.storage.boundHooks.get(HOOK).enabled).toBe(true);
    });
  });
});

// FAC-117 Kernel 2: a person retries a run that failed, as another attempt of the same run, and the
// person deciding a write whose outcome is unknown settles it. Neither ever applies a write again.
describe("retrying a failed run, and settling a write whose outcome is unknown (FAC-117 K2)", () => {
  const OPERATOR = { type: "user" as const, id: PERSON, name: "Operator" };
  /** The first admitted run, queued; its delivery and invocation ids. */
  function queued(impl: any) {
    let delivery = admitted(impl);
    impl.queueWorkflowRun(HOOK, delivery.deliveryId, "onSchedule", [FIRING]);
    return { deliveryId: delivery.deliveryId, invocationId: deliveryOf(impl, delivery.deliveryId).invocation.id };
  }
  /** Leaves no queued run and no alarm, so nothing of this workspace runs during a later test. */
  async function quiesce(impl: any) {
    for (let entry of Array.from(impl.storage.workflowRunQueue.list()) as { deliveryId: number }[]) {
      impl.storage.workflowRunQueue.delete(entry.deliveryId);
    }
    await impl.ctx.storage.deleteAlarm();
  }
  /**
   * A gatekeeper facet that withdraws as `runsAs`'s does and counts applies: a test that asks for no
   * apply checks the count stays where it started.
   */
  function countingFacet(impl: any, applies: { count: number }) {
    const facet = {
      rejectAction: async (key: number) => {
        gatekeeper.staged.delete(key);
        gatekeeper.withdrawn.push(key);
      },
      applyAction: async () => { applies.count++; },
    };
    onPrototype(impl, "getGatekeeperFacet", () => facet);
  }
  /** Runs run `ids` once with `body` as its pinned code, to its recorded end. */
  async function ranOnce(name: string, body: (workspace: any, caller: unknown) => Promise<unknown>) {
    let ids = await withImpl(name, impl => {
      let first = queued(impl);
      runsAs(impl, "gadget-bindings", body);
      return first;
    });
    await settled(name, ids.deliveryId);
    return ids;
  }
  const lost = async () => { throw new Error("worker lost"); };

  it("retries a failed run as another attempt of the same run, for the person who asked, once", async () => {
    let name = `k2-retry-${crypto.randomUUID()}`;
    let ids = await ranOnce(name, lost);
    let runId = await withImpl(name, async impl => {
      let before = deliveryOf(impl, ids.deliveryId);
      expect(before.result).toMatchObject({ outcome: "failed", reason: "runtime-error" });
      let read = await impl.retryWorkflowRun(ids.invocationId, OPERATOR);
      expect(read).toMatchObject({ runId: before.run.runId, outcome: "queued" });
      expect(deliveryOf(impl, ids.deliveryId).execution).toMatchObject({
        state: "queued", attempts: 1, retries: [{ by: { type: "user", id: PERSON, name: "Operator" } }],
      });
      // One retry: while it is queued, a second is refused.
      await expect(impl.retryWorkflowRun(ids.invocationId, OPERATOR)).rejects.toThrow(WORKFLOW_RUN_RETRY_REFUSED.notFailed);
      return before.run.runId;
    });
    workflowRun = defaultWorkflowRun;
    let done = await settled(name, ids.deliveryId);
    expect(done.execution).toMatchObject({ state: "finished", attempts: 2 });
    expect(done.run.runId).toBe(runId);
    expect(done.result).toMatchObject({ outcome: "succeeded" });
  });

  it("is refused to anyone but the person who asked, and once the trigger can't start or they may no longer run it", async () => {
    let name = `k2-retry-who-${crypto.randomUUID()}`;
    let ids = await ranOnce(name, lost);
    await withImpl(name, async impl => {
      let stranger = { type: "user" as const, id: "stranger-profile", name: "Stranger" };
      // The definition's owner may cancel a run, but not retry someone else's; nor may anyone else.
      for (let caller of [stranger, ADA]) {
        await expect(impl.retryWorkflowRun(ids.invocationId, caller)).rejects.toThrow("No such run.");
      }
      await expect(impl.retryWorkflowRun("no-such-invocation", OPERATOR)).rejects.toThrow("No such run.");
      // Their admission again (FAC-104): the control no longer lists them.
      let store = impl.workflowDefinitionStore();
      store.setControl(ADA, HOOK, { label: "Run refunds", invokers: ["someone-else"] });
      await expect(impl.retryWorkflowRun(ids.invocationId, OPERATOR)).rejects.toThrow(RUN_REQUESTER_REVOKED);
      store.setControl(ADA, HOOK, { label: "Run refunds", invokers: [PERSON] });
      // A paused or retired trigger starts nothing (FAC-117), and nor does a disabled one.
      impl.storage.workflowTriggerLifecycles.put({ hookId: HOOK, state: "paused", by: ADA, at: new Date() });
      await expect(impl.retryWorkflowRun(ids.invocationId, OPERATOR)).rejects.toThrow(TRIGGER_LIFECYCLE_REFUSED.paused);
      impl.storage.workflowTriggerLifecycles.delete(HOOK);
      impl.storage.boundHooks.put({ ...impl.storage.boundHooks.get(HOOK), enabled: false });
      await expect(impl.retryWorkflowRun(ids.invocationId, OPERATOR)).rejects.toThrow("Hook has been deleted or disabled.");
      // Nothing was queued by any of them.
      expect(deliveryOf(impl, ids.deliveryId).execution).toMatchObject({ state: "failed" });
      expect([...impl.storage.workflowRunQueue.list()]).toEqual([]);
      await quiesce(impl);
    });
  });

  it("is refused for a cancelled run, one out of attempts, an uncertain one, and one holding a write it can't match", async () => {
    let cancelled = `k2-retry-cancelled-${crypto.randomUUID()}`;
    await withImpl(cancelled, async impl => {
      let first = queued(impl);
      await impl.cancelWorkflowRun(first.invocationId, OPERATOR, "use");
      await expect(impl.retryWorkflowRun(first.invocationId, OPERATOR)).rejects.toThrow(WORKFLOW_RUN_RETRY_REFUSED.cancelled);
      await quiesce(impl);
    });
    testLimits = { ...testLimits, attempts: 1 };
    let exhausted = `k2-retry-exhausted-${crypto.randomUUID()}`;
    let once = await ranOnce(exhausted, lost);
    await withImpl(exhausted, async impl => {
      await expect(impl.retryWorkflowRun(once.invocationId, OPERATOR)).rejects.toThrow(WORKFLOW_RUN_RETRY_REFUSED.exhausted);
    });
    testLimits = { ...DEFAULT_WORKFLOW_RUN_LIMITS, backoffSeconds: 0 };
    // A write still waiting after its run threw: uncertain, so it is settled or decided first.
    let uncertain = `k2-retry-uncertain-${crypto.randomUUID()}`;
    let waiting = await ranOnce(uncertain, async (workspace, caller) => { await stage(workspace, caller, DESCRIPTION); throw new Error("lost"); });
    await withImpl(uncertain, async impl => {
      expect(deliveryOf(impl, waiting.deliveryId).result).toMatchObject({ outcome: "uncertain", reason: "lost-after-write" });
      await expect(impl.retryWorkflowRun(waiting.invocationId, OPERATOR)).rejects.toThrow(WORKFLOW_RUN_RETRY_REFUSED.notFailed);
    });
    // A write whose description isn't complete is never matched (FAC-112), so a retry could propose
    // and apply it again: refused even once it is decided.
    let unmatchable = `k2-retry-unmatchable-${crypto.randomUUID()}`;
    let summary = await ranOnce(unmatchable, async (workspace, caller) => { await stage(workspace, caller, SUMMARY); throw new Error("lost"); });
    await withImpl(unmatchable, async impl => {
      let [write] = actionsOf(impl);
      impl.storage.actions.put({ ...write, state: "rejected" });
      impl.settleRunOfAction(write.id);
      expect(deliveryOf(impl, summary.deliveryId).result).toMatchObject({ outcome: "failed" });
      await expect(impl.retryWorkflowRun(summary.invocationId, OPERATOR)).rejects.toThrow(WORKFLOW_RUN_RETRY_REFUSED.unmatchable);
    });
  });

  // r1 on FAC-117 K2: a retry re-runs the call as admitted, so it runs only what a fresh request
  // would: the trigger's current definition and revision, within a day of the run's admission, and
  // with assignments off never an assigned trigger's run.
  /**
   * Repins the trigger to another published definition at the same code, as a builder does when the
   * old one was wrong: still runnable (FAC-111), only not the run's own.
   */
  const repin = (impl: any) => {
    let store = impl.workflowDefinitionStore();
    let other = store.save(ADA, { title: "Refund, fixed", gadgetId: GADGET }, (id: number) => (id === GADGET ? commit(1) : undefined), "build");
    store.publish(ADA, other.id, 1);
    let pin = impl.storage.workflowTriggerPins.get(HOOK);
    impl.storage.workflowTriggerPins.put({ ...pin, definitionId: other.id, revision: 1, mode: "pinned" });
  };
  const nothingQueued = (impl: any, deliveryId: number) => {
    expect(deliveryOf(impl, deliveryId).execution).toMatchObject({ state: "failed" });
    expect(deliveryOf(impl, deliveryId).execution.retries).toBeUndefined();
    expect([...impl.storage.workflowRunQueue.list()]).toEqual([]);
  };

  it("is refused once the trigger runs another revision, and for a run admitted too long ago, queueing nothing", async () => {
    let name = `k2-retry-repinned-${crypto.randomUUID()}`;
    let ids = await ranOnce(name, lost);
    await withImpl(name, async impl => {
      repin(impl);
      await expect(impl.retryWorkflowRun(ids.invocationId, OPERATOR)).rejects.toThrow(WORKFLOW_RUN_RETRY_REFUSED.repinned);
      nothingQueued(impl, ids.deliveryId);
    });
    let old = `k2-retry-old-${crypto.randomUUID()}`;
    let aged = await ranOnce(old, lost);
    await withImpl(old, async impl => {
      let delivery = deliveryOf(impl, aged.deliveryId);
      impl.storage.workflowDeliveries.put({ ...delivery, at: new Date(Date.now() - WORKFLOW_RUN_RETRY_WINDOW_MS - 60_000) });
      await expect(impl.retryWorkflowRun(aged.invocationId, OPERATOR)).rejects.toThrow(WORKFLOW_RUN_RETRY_REFUSED.tooOld);
      nothingQueued(impl, aged.deliveryId);
    });
  });

  it("is refused when the trigger is repinned while the person's admission is re-checked", async () => {
    let name = `k2-retry-repin-race-${crypto.randomUUID()}`;
    let ids = await ranOnce(name, lost);
    await withImpl(name, async impl => {
      // The repin lands during requireRunRequester's await (the second roles read), after the early check passed.
      let reads = 0;
      onPrototype(impl, "definitionRoles", async function (this: any) {
        if (++reads === 2) repin(this);
        return () => "use";
      });
      await expect(impl.retryWorkflowRun(ids.invocationId, OPERATOR)).rejects.toThrow(WORKFLOW_RUN_RETRY_REFUSED.repinned);
      nothingQueued(impl, ids.deliveryId);
    });
  });

  it("is refused when the person loses the trigger's control while InferOps is asked again (FAC-104 order)", async () => {
    let name = `k2-retry-recheck-race-${crypto.randomUUID()}`;
    let ids = await ranOnce(name, lost);
    await withImpl(name, async impl => {
      // The run's company is asked again where the deployment names the authority; the control
      // listing them goes while that answer is pending, so only the re-read after it can see it.
      let delivery = deliveryOf(impl, ids.deliveryId);
      impl.storage.workflowDeliveries.put({ ...delivery, run: { ...delivery.run, company: "acme" } });
      let { env: realEnv, users: realUsers } = impl;
      impl.env = { ...realEnv, SHARED_CONFIGURATION_GATEKEEPER: "scheduler" };
      impl.users = {
        idFromName: (n: string) => realUsers.idFromName(n),
        idFromString: (id: string) => id,
        get: () => ({
          workflowInvokeAnswer: async () => {
            impl.workflowDefinitionStore().setControl(ADA, HOOK, { label: "Run refunds", invokers: ["someone-else"] });
            return { holds: true, company: "acme" };
          },
        }),
      };
      try {
        await expect(impl.retryWorkflowRun(ids.invocationId, OPERATOR)).rejects.toThrow(RUN_REQUESTER_REVOKED);
      } finally {
        impl.env = realEnv;
        impl.users = realUsers;
      }
      nothingQueued(impl, ids.deliveryId);
    });
  });

  it("is refused once the pinned revision can't run now, as a fresh request is (FAC-111)", async () => {
    // The gadget's code moved past the revision's commit.
    let moved = `k2-retry-head-moved-${crypto.randomUUID()}`;
    let ids = await ranOnce(moved, lost);
    await withImpl(moved, async impl => {
      onPrototype(impl, "getGadgetHead", (id: number) => (id === GADGET ? commit(2) : undefined));
      await expect(impl.retryWorkflowRun(ids.invocationId, OPERATOR)).rejects.toThrow("The workflow changed since revision 1 was saved");
      nothingQueued(impl, ids.deliveryId);
    });
    // Pinned to a revision that isn't published, whose owner can no longer build here (the fixture
    // answers "use" for everyone, the owner included).
    let unpublished = `k2-retry-unpublished-${crypto.randomUUID()}`;
    let run = await ranOnce(unpublished, lost);
    await withImpl(unpublished, async impl => {
      let pin = impl.storage.workflowTriggerPins.get(HOOK);
      impl.storage.workflowTriggerPins.put({ ...pin, mode: "pinned" });
      let definition = impl.storage.workflowDefinitions.get(pin.definitionId);
      impl.storage.workflowDefinitions.put({ ...definition, published: undefined });
      await expect(impl.retryWorkflowRun(run.invocationId, OPERATOR)).rejects.toThrow(UNPUBLISHED_REVISION_OWNER_CANT_BUILD);
      nothingQueued(impl, run.deliveryId);
    });
  });

  it("is refused at retry, not at its start, while the trigger's connections aren't set up (FAC-123)", async () => {
    let name = `k2-retry-unbound-${crypto.randomUUID()}`;
    let ids = await ranOnce(name, lost);
    await withImpl(name, async impl => {
      // The seam requireBound answers through; a duplicate with an unmet binding is refused so.
      onPrototype(impl, "requireHookBound", () => { throw new Error("This workflow needs its connections set up before it can run."); });
      await expect(impl.retryWorkflowRun(ids.invocationId, OPERATOR)).rejects.toThrow("needs its connections set up");
      nothingQueued(impl, ids.deliveryId);
    });
  });

  it("is refused at retry once the trigger's assignment was retired automatically, as a fresh request is", async () => {
    let name = `k2-retry-auto-retired-${crypto.randomUUID()}`;
    let ids = await ranOnce(name, lost);
    await withImpl(name, async impl => {
      impl.workflowDefinitionStore().markAutoRetired(HOOK);
      await expect(impl.retryWorkflowRun(ids.invocationId, OPERATOR)).rejects.toThrow(TRIGGER_AUTO_RETIRED);
      nothingQueued(impl, ids.deliveryId);
    });
  });

  it("is refused at retry for an assigned trigger's run while assignments are off, as a fresh request is", async () => {
    let name = `k2-retry-assigned-${crypto.randomUUID()}`;
    // Admitted as the trigger's assignment, and ended failed: assignments are off in this suite.
    let ids = await withImpl(name, impl => {
      let delivery = admitted(impl, { assigned: true });
      impl.queueWorkflowRun(HOOK, delivery.deliveryId, "onSchedule", [FIRING]);
      runsAs(impl, "gadget-bindings", lost);
      return { deliveryId: delivery.deliveryId, invocationId: deliveryOf(impl, delivery.deliveryId).invocation.id };
    });
    await settled(name, ids.deliveryId);
    await withImpl(name, async impl => {
      expect(deliveryOf(impl, ids.deliveryId)).toMatchObject({ run: { executor: { kind: "service_account" } }, result: { outcome: "failed" } });
      await expect(impl.retryWorkflowRun(ids.invocationId, OPERATOR)).rejects.toThrow(WORKFLOW_ASSIGNMENTS_DISABLED);
      nothingQueued(impl, ids.deliveryId);
    });
  });

  // The lead's addition: a person settles an unknown write as not applied, but it landed. The retry
  // proposes it again; that is matched to the write already recorded (same run, same digest), so the
  // gatekeeper's copy is withdrawn, no second action is made and nothing applies a second time.
  it("never writes twice after a wrong 'not-applied': the retried write is matched, and the gatekeeper's apply count stays 1", async () => {
    let name = `k2-wrong-not-applied-${crypto.randomUUID()}`;
    let applies = { count: 1 }; // The gatekeeper already holds the write: it landed once.
    let ids = await ranOnce(name, async (workspace, caller) => { await stage(workspace, caller, DESCRIPTION); throw new Error("lost"); });
    await withImpl(name, async impl => {
      countingFacet(impl, applies);
      let [write] = actionsOf(impl);
      // Its apply was cut off: it may or may not have happened.
      impl.storage.actions.put({ ...write, lastAttempt: { outcome: "unknown", message: "lost response", at: new Date() } });
      impl.settleRunOfAction(write.id);
      expect(deliveryOf(impl, ids.deliveryId).result).toMatchObject({ outcome: "uncertain", reason: "action-unknown" });
      await impl.resolveWorkflowRunWrite(write.id, "not-applied", ADA);
      expect(impl.storage.actions.get(write.id)).toMatchObject({
        state: "failed", settled: { outcome: "not-applied", by: { id: ADA.id } },
      });
      expect(deliveryOf(impl, ids.deliveryId).result).toMatchObject({ outcome: "failed", reason: "runtime-error" });
      await impl.retryWorkflowRun(ids.invocationId, OPERATOR);
    });
    // The retry proposes the same write again, then finishes.
    workflowRun = async workerEnv => {
      let id = await stage(workerEnv.BOARD.workspace, workerEnv.BOARD.caller, DESCRIPTION);
      return { proposed: id };
    };
    let done = await settled(name, ids.deliveryId);
    await nextAlarm(name);
    await withImpl(name, impl => {
      let writes = actionsOf(impl);
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({ state: "failed", settled: { outcome: "not-applied" } });
    });
    expect(done.execution).toMatchObject({ attempts: 2 });
    // The second attempt's staged copy was withdrawn, never applied.
    expect(gatekeeper.withdrawn).toEqual([2]);
    expect(applies.count).toBe(1);
  });

  it("settles only a run's write whose outcome is unknown, once, never applying it, and the run reads what it is", async () => {
    let name = `k2-settle-${crypto.randomUUID()}`;
    let applies = { count: 0 };
    let ids = await ranOnce(name, async (workspace, caller) => { await stage(workspace, caller, DESCRIPTION); throw new Error("lost"); });
    await withImpl(name, async impl => {
      countingFacet(impl, applies);
      let [write] = actionsOf(impl);
      // Still waiting for a decision, it isn't unknown: refused.
      await expect(impl.resolveWorkflowRunWrite(write.id, "applied", ADA)).rejects.toThrow(WORKFLOW_WRITE_SETTLE_REFUSED);
      await expect(impl.resolveWorkflowRunWrite(write.id, "maybe" as never, ADA)).rejects.toThrow(TypeError);
      await expect(impl.resolveWorkflowRunWrite(9999, "applied", ADA)).rejects.toThrow(WORKFLOW_WRITE_SETTLE_REFUSED);
      impl.storage.actions.put({ ...write, lastAttempt: { outcome: "unknown", message: "lost response", at: new Date() } });
      impl.settleRunOfAction(write.id);
      // An uncertain run is live work: it keeps no history expiry until settled.
      expect([...impl.storage.workflowDeliveryExpiries.list()].map((p: any) => p.deliveryId)).not.toContain(ids.deliveryId);
      await impl.resolveWorkflowRunWrite(write.id, "applied", ADA);
      expect(impl.storage.actions.get(write.id)).toMatchObject({
        state: "approved", settled: { outcome: "applied", by: { type: "user", id: ADA.id, name: ADA.name } },
      });
      // Its code still threw, so the run failed; with nothing unknown left, it is history.
      expect(deliveryOf(impl, ids.deliveryId).result).toMatchObject({ outcome: "failed", reason: "runtime-error" });
      expect([...impl.storage.workflowDeliveryExpiries.list()].map((p: any) => p.deliveryId)).toContain(ids.deliveryId);
      // Settled once: a second answer is refused, and the first stands.
      await expect(impl.resolveWorkflowRunWrite(write.id, "not-applied", ADA)).rejects.toThrow(WORKFLOW_WRITE_SETTLE_REFUSED);
      expect(impl.storage.actions.get(write.id).state).toBe("approved");
      // A write no run proposed is refused, whatever its outcome.
      let agentWrite = { ...write, id: write.id + 100, workflowRun: undefined, executedAs: undefined,
        state: "pending", settled: undefined, lastAttempt: { outcome: "unknown", message: "lost", at: new Date() } };
      impl.storage.actions.put(agentWrite);
      await expect(impl.resolveWorkflowRunWrite(agentWrite.id, "applied", ADA)).rejects.toThrow(WORKFLOW_WRITE_SETTLE_REFUSED);
    });
    expect(applies.count).toBe(0);
  });
});
