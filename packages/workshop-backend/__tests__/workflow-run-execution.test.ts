// FAC-112: a run a person asked for executes in the workspace's own Durable Object, from its stored
// record, after the call that started it has returned: the firing's callback only queues it
// (durably, beside its FAC-111 run record), and the Overseer's alarm runs it. So it carries on when
// the browser that asked is gone, resumes after a restart with the same run id, revision and
// authority, and runs only the code its revision pinned.
//
// Over a real Overseer Durable Object. The gadget's hook code is the one seam: the workspace reads
// it through `workflowRunCallback`, replaced here on the shared prototype so a restarted instance
// reaches the same stand-in (a real gadget facet can't be minted from a test). Everything the run
// is checked and executed from is the workspace's own storage.
import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { RUN_REQUESTER_REVOKED, WORKFLOW_RUN_CODE_CHANGED, type OverseerDurableObject } from "../src/overseer.js";

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

/** The stand-in hook code for `workspace`: records each call, and the run's state when it came. */
function standIn(workspace: any) {
  return {
    onSchedule: async (...args: unknown[]) => {
      calls.push({ method: "onSchedule", args });
      statesSeen.push(structuredClone([...workspace.storage.workflowDeliveries.list()].at(-1)?.execution));
      return answer();
    },
  };
}

/**
 * A workspace with a live trigger pinned at revision 1 (code `commit(1)`), a control listing
 * PERSON, and one admitted run PERSON asked for, fired. Returns the delivery.
 */
function admitted(impl: any, opts: { assigned?: boolean } = {}) {
  onPrototype(impl, "workflowRunCallback", function (this: any) {
    return standIn(this);
  });
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

  // Round 1 (review HIGH): a gadget-bindings run's writes go through the gadget's own sessions,
  // which name no run, so running it again could repeat an applied (even auto-approved) write.
  // Interrupted while running, it isn't run again: it ends as interrupted, with its one write.
  it("on the gadget's bindings, interrupted while running, isn't run again: no second write", async () => {
    let name = `run-exec-midrun-${crypto.randomUUID()}`;
    let id = await withImpl(name, impl => {
      let delivery = admitted(impl);
      answer = () => {
        // The run's write lands, then the restart interrupts the run before it ends.
        submitted(impl, { from: "gadget", gadgetId: GADGET });
        return new Promise(() => {});
      };
      impl.queueWorkflowRun(HOOK, delivery.deliveryId, "onSchedule", [FIRING]);
      void impl.runQueuedWorkflowRuns();
      return delivery.deliveryId;
    });
    await withImpl(name, impl => vi.waitFor(() => expect(actionsOf(impl)).toHaveLength(1)));
    answer = async () => "done";
    await abortAllDurableObjects();
    let done = await settled(name, id);
    expect(calls.map(c => c.method)).toEqual(["onSchedule"]);
    expect(done.execution).toMatchObject({ state: "failed", failure: "interrupted", attempts: 1 });
    expect(await withImpl(name, impl => actionsOf(impl))).toHaveLength(1);
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
  it("doesn't run code that changed after it was admitted, and says why", async () => {
    let name = `run-exec-code-${crypto.randomUUID()}`;
    let id = await withImpl(name, impl => {
      let delivery = admitted(impl);
      impl.queueWorkflowRun(HOOK, delivery.deliveryId, "onSchedule", [FIRING]);
      // The page's code is edited meanwhile: the gadget's head moves on from the pinned commit.
      onPrototype(impl, "getGadgetHead", (gid: number) => (gid === GADGET ? commit(2) : undefined));
      return delivery.deliveryId;
    });
    let done = await settled(name, id);
    expect(calls).toEqual([]);
    expect(done.execution).toMatchObject({ state: "failed", failure: "code-changed" });
    expect(JSON.stringify(done)).not.toContain(WORKFLOW_RUN_CODE_CHANGED);
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
