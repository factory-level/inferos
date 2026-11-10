// FAC-114: a requested run's result, recorded with the run and read back by the person who asked
// (inferos ADR 0012, proposed: the outcome, the history destination's delivery, and `uncertain`).
// The run's completion is its pinned code's `WorkflowRun` entrypoint settling; the outcome then
// also weighs the run's own writes, so a run is `succeeded` only once none of them is waiting or
// unknown, and stays `uncertain`, visibly, while one may or may not have happened.
//
// Over a real Overseer Durable Object, with the run-scoped worker's seams stood in for on the shared
// prototype, as in workflow-run-execution.test.ts, so a restarted instance reaches the same ones.
import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";
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
const FIRING = { scheduleId: "s1", firedAt: "2026-11-06T00:00:00.000Z" };
const DESCRIPTION = { title: "Create issue", description: "Creates one issue.", implementsRevert: false, descriptionIsComplete: true };
const commit = (n: number) => n.toString(16).padStart(40, "0");

/** The pinned code's `WorkflowRun.onSchedule`, across instances: gets the workspace and the run's caller. */
let workflowRun: (workspace: any, caller: unknown) => Promise<unknown> = async () => ({ summary: "done" });
let restore: (() => void)[] = [];
afterEach(() => {
  for (let undo of restore.splice(0)) undo();
  workflowRun = async () => ({ summary: "done" });
});

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
  return runInDurableObject(env.TEST_OVERSEER.getByName(name), async (instance: OverseerDurableObject) =>
    fn((instance as any).impl));
}

/** A live trigger pinned at revision 1, a control listing PERSON, and one run PERSON asked for, fired. */
function admitted(impl: any) {
  onPrototype(impl, "workflowRunModules", async () => ({ "server.js": "// pinned" }));
  onPrototype(impl, "loadWorkflowRunWorker", (code: { env: Record<string, any> }) => ({
    getEntrypoint: () => ({ onSchedule: () => workflowRun(code.env.BOARD.workspace, code.env.BOARD.caller) }),
  }));
  onPrototype(impl, "makeBindingLoopback", function (this: unknown, target: unknown, caller: unknown) {
    return { target, caller, workspace: this };
  });
  onPrototype(impl, "visibleBindings", () => [["BOARD", { target: CONNECTION }]]);
  // The person who asked is a collaborator here (FAC-122's run right reads their role).
  onPrototype(impl, "definitionRoles", async () => () => "use");
  onPrototype(impl, "getGadgetRecord", () => ({}));
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
  let invocation = store.beginInvocation(PERSON, HOOK, null);
  let delivery = store.fire(HOOK, GADGET, head, () => true, invocation.id)!;
  return { delivery, invocationId: invocation.id, definitionId: saved.id };
}

/** Queue the run and let the workspace's alarm run it; returns the invocation id. */
async function ranOnce(name: string) {
  let { invocationId, id } = await withImpl(name, impl => {
    let made = admitted(impl);
    impl.queueWorkflowRun(HOOK, made.delivery.deliveryId, "onSchedule", [FIRING]);
    return { invocationId: made.invocationId, id: made.delivery.deliveryId };
  });
  await runDurableObjectAlarm(env.TEST_OVERSEER.getByName(name));
  await withImpl(name, impl => vi.waitFor(() =>
    expect(["finished", "failed"]).toContain(impl.storage.workflowDeliveries.get(id)?.execution?.state)));
  return { invocationId, id };
}

/** The run's write, through the run's own caller, as its gatekeeper session would submit it. */
async function write(workspace: any, caller: unknown, key = 1) {
  return workspace.submitActionNow(CONNECTION, key, DESCRIPTION, caller, await actionDescriptionDigest(DESCRIPTION));
}

describe("a requested run's result, read by the person who asked (FAC-114)", () => {
  it("reads succeeded after a reconnect, naming its run and revision; nobody else reads it", async () => {
    let name = `run-result-ok-${crypto.randomUUID()}`;
    let { invocationId } = await ranOnce(name);
    await abortAllDurableObjects(); // the person reconnects later, to a restarted workspace
    let read = await withImpl(name, impl => impl.getRequestedRun(PERSON, invocationId));
    expect(read).toMatchObject({ invocationId, revision: 1, outcome: "succeeded", actions: [] });
    expect(read.runId).toEqual(expect.any(String));
    expect(await withImpl(name, impl => impl.getRequestedRun("someone-else", invocationId))).toBeNull();
    // The report the run returned is kept for builders, with history delivered.
    let [stored] = await withImpl(name, impl => [...impl.storage.workflowDeliveries.list()]);
    expect(stored.result).toMatchObject({ outcome: "succeeded", report: { summary: "done" } });
    expect(stored.delivery.history).toBe("delivered");
    // Delivery to the requester's page (FAC-116) is its own destination: their page shows nothing
    // here, and a restart can cut it off while pending, which never reads as delivered.
    expect(stored.delivery.canvas).not.toBe("delivered");
  });

  it("is waiting while a write it proposed waits, and succeeded once that write applies", async () => {
    let name = `run-result-waiting-${crypto.randomUUID()}`;
    workflowRun = async (workspace, caller) => { await write(workspace, caller); return { summary: "proposed" }; };
    let { invocationId } = await ranOnce(name);
    let actionId = await withImpl(name, async impl => {
      let read = await impl.getRequestedRun(PERSON, invocationId);
      expect(read).toMatchObject({ outcome: "waiting", actions: [{ outcome: "waiting" }] });
      return read.actions[0].actionId;
    });
    await withImpl(name, async impl => {
      impl.getGatekeeperFacet = () => ({ applyAction: async () => ({ applied: { result: {} } }) });
      await impl.applyPendingAction(impl.storage.actions.get(actionId), ADA, false);
      expect(await impl.getRequestedRun(PERSON, invocationId)).toMatchObject({
        outcome: "succeeded", actions: [{ actionId, outcome: "succeeded" }],
      });
    });
  });

  it("is uncertain while one of its writes may or may not have applied, and stays so after a reconnect", async () => {
    let name = `run-result-unknown-${crypto.randomUUID()}`;
    workflowRun = async (workspace, caller) => { await write(workspace, caller); return null; };
    let { invocationId } = await ranOnce(name);
    // The write's apply started, then the workspace restarted mid-apply: its outcome is unknown.
    await withImpl(name, impl => {
      let [action] = [...impl.storage.actions.list()].filter((a: any) => a.type === "action");
      impl.storage.actions.put({ ...action, applyStartedAt: new Date() });
    });
    await abortAllDurableObjects();
    let read = await withImpl(name, impl => impl.getRequestedRun(PERSON, invocationId));
    expect(read).toMatchObject({ outcome: "uncertain", reason: "action-unknown", actions: [{ outcome: "unknown" }] });
    await abortAllDurableObjects();
    expect(await withImpl(name, impl => impl.getRequestedRun(PERSON, invocationId)))
      .toMatchObject({ outcome: "uncertain", reason: "action-unknown" });
  });

  it("is uncertain when it threw after a write, and failed when it threw before any", async () => {
    let wrote = `run-result-lost-${crypto.randomUUID()}`;
    workflowRun = async (workspace, caller) => { await write(workspace, caller); throw new Error("worker lost"); };
    let lost = await ranOnce(wrote);
    expect(await withImpl(wrote, impl => impl.getRequestedRun(PERSON, lost.invocationId)))
      .toMatchObject({ outcome: "uncertain", reason: "lost-after-write" });
    let clean = `run-result-failed-${crypto.randomUUID()}`;
    workflowRun = async () => { throw new Error("nothing sent"); };
    let failed = await ranOnce(clean);
    expect(await withImpl(clean, impl => impl.getRequestedRun(PERSON, failed.invocationId)))
      .toMatchObject({ outcome: "failed", reason: "runtime-error", actions: [] });
  });

  it("reads uncertain when it was admitted but never started within the start window", async () => {
    let name = `run-result-notstarted-${crypto.randomUUID()}`;
    let read = await withImpl(name, async impl => {
      let made = admitted(impl);
      // The gatekeeper took the request and never called back: it's admitted, not queued.
      let stored = impl.storage.workflowDeliveries.get(made.delivery.deliveryId);
      impl.storage.workflowDeliveries.put({ ...stored, at: new Date(Date.now() - 60 * 60 * 1000) });
      return await impl.getRequestedRun(PERSON, made.invocationId);
    });
    expect(read).toMatchObject({ outcome: "uncertain", reason: "not-started" });
  });

  it("is one run however often its delivery repeats: a repeated delivery of the request is refused", async () => {
    let name = `run-result-dup-${crypto.randomUUID()}`;
    await withImpl(name, async impl => {
      let made = admitted(impl);
      let store = impl.workflowDefinitionStore();
      expect(() => store.fire(HOOK, GADGET, () => commit(1), () => true, made.invocationId))
        .toThrow("That run request is unknown or already ran.");
      expect([...impl.storage.workflowDeliveries.list()]).toHaveLength(1);
      expect(await impl.getRequestedRun(PERSON, made.invocationId)).toMatchObject({ outcome: "queued" });
    });
  });
});
