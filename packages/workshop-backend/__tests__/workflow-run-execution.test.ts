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
const DESCRIPTION = { title: "Create issue", description: "Creates one issue.", implementsRevert: false };
/** The run's one write, through `caller`: a pending action on the connection. */
const submitted = (impl: any, caller: unknown) => impl.submitActionNow(CONNECTION, 1, DESCRIPTION, caller);
const actionsOf = (impl: any) => [...impl.storage.actions.list()].filter((a: any) => a.type === "action");

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

  // Round 2 (the manager's (a)): a gadget-bindings run executes in a run-scoped worker from its
  // pinned commit, and its writes name it, so an interrupted run runs again from its start and its
  // repeated write is the one already recorded, never a second, applied or not.
  it("on the gadget's bindings, interrupted after an applied write, runs again without writing twice", async () => {
    let name = `run-exec-midrun-${crypto.randomUUID()}`;
    let attempt = 0;
    let id = await withImpl(name, impl => {
      let delivery = admitted(impl);
      workflowRun = async workerEnv => {
        attempt++;
        let workspace = workerEnv.BOARD.workspace;
        let actionId = workspace.submitActionNow(CONNECTION, 1, DESCRIPTION, workerEnv.BOARD.caller);
        // The write was applied (as an auto-approval would), then the restart interrupts the run.
        if (attempt === 1) {
          workspace.storage.actions.put({ ...workspace.storage.actions.get(actionId), state: "approved", autoApproved: true });
          return new Promise(() => {});
        }
        return "ran";
      };
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
    expect(actions[0]).toMatchObject({
      state: "approved", workflowRun: { runId: done.run.runId, deliveryId: id, proposal: 0, attempt: 1 },
    });
  });

  it("on the gadget's bindings, a replay that proposes a different write than before is refused", async () => {
    await withImpl(`run-exec-diverge-gadget-${crypto.randomUUID()}`, impl => {
      let delivery = admitted(impl);
      let caller = { from: "gadget", gadgetId: GADGET, run: { hookId: HOOK, deliveryId: delivery.deliveryId } };
      impl.workflowDefinitionStore().startRun(delivery.deliveryId);
      impl.gadgetRuns.begin(delivery.deliveryId, { hookId: HOOK, gadgetId: GADGET });
      impl.startWorkflowRunProposals(delivery.deliveryId);
      submitted(impl, caller);
      impl.startWorkflowRunProposals(delivery.deliveryId);
      expect(() => impl.submitActionNow(CONNECTION, 2, { ...DESCRIPTION, title: "Close issue" }, caller))
        .toThrow("proposed a different write");
      expect(actionsOf(impl)).toHaveLength(1);
    });
  });

  // Round 1 (review HIGH): an assigned run's writes name their run, so a replay's writes are the
  // ones it already proposed: matched by run and by order, never recorded or applied twice.
  it("assigned, interrupted after a write, runs again without proposing that write twice", async () => {
    let name = `run-exec-replay-${crypto.randomUUID()}`;
    let attempt = 0;
    let id = await withImpl(name, impl => {
      let delivery = admitted(impl, { assigned: true });
      onPrototype(impl, "runAssignedDelivery", async function (this: any, hookId: number, d: { deliveryId: number }) {
        attempt++;
        this.systemRuns.begin(d.deliveryId, { hookId, gatekeeperId: CONNECTION, credentialRef: REF });
        submitted(this, { from: "systemRun", hookId, deliveryId: d.deliveryId });
        if (attempt === 1) return new Promise(() => {}); // interrupted after its write
        this.systemRuns.end(d.deliveryId);
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
    expect(actions[0]).toMatchObject({ state: "pending", executedAs: { runId: done.run.runId } });
  });

  it("assigned, a replay that proposes a different write than before is refused, not recorded", async () => {
    await withImpl(`run-exec-diverge-${crypto.randomUUID()}`, impl => {
      let delivery = admitted(impl, { assigned: true });
      let caller = { from: "systemRun", hookId: HOOK, deliveryId: delivery.deliveryId };
      impl.systemRuns.begin(delivery.deliveryId, { hookId: HOOK, gatekeeperId: CONNECTION, credentialRef: REF });
      impl.startWorkflowRunProposals(delivery.deliveryId);
      submitted(impl, caller);
      impl.startWorkflowRunProposals(delivery.deliveryId); // the replay
      expect(() => impl.submitActionNow(CONNECTION, 2, { ...DESCRIPTION, title: "Close issue" }, caller))
        .toThrow("proposed a different write");
      expect(actionsOf(impl)).toHaveLength(1);
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
        workerEnv.BOARD.workspace.submitActionNow(CONNECTION, 1, DESCRIPTION, workerEnv.BOARD.caller);
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
      workflowRun: { runId: done.run.runId, hookId: HOOK, deliveryId: id, proposal: 0, attempt: 1 },
    })]);
  });

  it("on the gadget's bindings, re-checks the person at a queued write: taken off the control, it stays pending", async () => {
    await withImpl(`run-exec-write-${crypto.randomUUID()}`, async impl => {
      let delivery = admitted(impl);
      let caller = { from: "gadget", gadgetId: GADGET, run: { hookId: HOOK, deliveryId: delivery.deliveryId } };
      impl.workflowDefinitionStore().startRun(delivery.deliveryId);
      impl.gadgetRuns.begin(delivery.deliveryId, { hookId: HOOK, gadgetId: GADGET });
      impl.startWorkflowRunProposals(delivery.deliveryId);
      let actionId = submitted(impl, caller);
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
