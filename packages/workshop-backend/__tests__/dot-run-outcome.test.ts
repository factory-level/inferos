// FAC-134: a run a person starts by approving their Dot's proposal, end to end through the trigger's
// own workspace (invokeTriggerAs, then the real on-request admission, invokeWorkflowTrigger) rather
// than a stand-in for it. The run is the workspace's own: it carries on after the call that asked
// returned and every object restarted, and its outcome (a fixed category, never what the run
// returned) is reported once to the approved action, in the person's own operate session, which
// hands it to that action's gatekeeper. Admission refuses a trigger the person may not run and one
// their grant was answered for in another company, minting nothing; an assigned trigger runs only
// its pinned code as its assignment and gives the person nothing of it.
//
// Two real Overseer Durable Objects: W, the trigger's workspace, and S, the person's operate
// session. Stand-ins replace what can't be made from a test (the user Durable Object at admission,
// the hook's controller, the run-scoped worker, the gatekeeper facet), the first two on W's instance
// for admission only, the rest on the shared prototype so a restarted W reaches them.
//
// Synthetic bounded fixtures only.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import type { ApprovedRunOutcome } from "@gadgets/workshop-shared/gatekeeper";
import { workflowTriggerRef } from "@gadgets/workshop-shared/workflow-trigger-ref";
import type { ConsoleToolCaller } from "../src/console-tools";
import type { OverseerDurableObject } from "../src/overseer.js";
import { onlyExplicitAlarms, takeSkippedFiring } from "./test-worker.js";

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
const BOARD_CONNECTION = 8;
const ACTION = 5;
const ACTION_KEY = 41;
const REF = "5b2c1d8e-0000-4000-8000-0000000000c1";
const commit = (n: number) => n.toString(16).padStart(40, "0");
const uid = (profileId: string) => `${profileId}-user-id`;

// Each test runs W's alarm itself: workerd's own firing would race it (see onlyExplicitAlarms).
beforeAll(() => onlyExplicitAlarms());

let restore: (() => void)[] = [];
/** What the run-scoped worker's code was called with, across instances. */
let ran: unknown[][] = [];
/** What each session's gatekeeper facet was told, across instances: [session id, action, outcome]. */
let reported: [string, number, ApprovedRunOutcome][] = [];
afterEach(() => {
  for (let undo of restore.splice(0)) undo();
  ran = [];
  reported = [];
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
  return runInDurableObject(env.TEST_OVERSEER.getByName(name),
      async (instance: OverseerDurableObject) => fn((instance as any).impl));
}
const idOf = (name: string) => env.TEST_OVERSEER.idFromName(name).toString();

/** Runs workspace `name`'s alarm now; it must have been armed, or fired and skipped. */
async function runAlarm(name: string) {
  let stub = env.TEST_OVERSEER.getByName(name);
  let fired = false;
  await vi.waitFor(async () => {
    fired ||= takeSkippedFiring(stub.id.toString());
    let armed = await runInDurableObject(stub, async (_: OverseerDurableObject, state: DurableObjectState) =>
      (await state.storage.getAlarm()) !== null);
    expect(armed || fired, "the workspace's alarm was never armed").toBe(true);
  }, { timeout: 2_000 });
  await runInDurableObject(stub, async (instance: OverseerDurableObject, state: DurableObjectState) => {
    await state.storage.deleteAlarm();
    takeSkippedFiring(stub.id.toString());
    await instance.alarm();
  });
}

/**
 * The seams on the shared prototype: the run-scoped worker (its pinned commit's modules, the worker,
 * the binding loopback, the gadget's bindings), the person's role (`use`), and each workspace's
 * gatekeeper facet, which records what it's told.
 */
function seams(impl: any) {
  onPrototype(impl, "workflowRunModules", async (commitId: string) => ({ "server.js": `// ${commitId}` }));
  onPrototype(impl, "loadWorkflowRunWorker", () => ({
    getEntrypoint: () => ({ onSchedule: async (...args: unknown[]) => { ran.push(args); return "done"; } }),
  }));
  onPrototype(impl, "makeBindingLoopback", function (this: unknown, target: unknown, caller: unknown) {
    return { target, caller, workspace: this };
  });
  onPrototype(impl, "visibleBindings", () => [["BOARD", { target: CONNECTION }]]);
  onPrototype(impl, "definitionRoles", async () => () => "use");
  onPrototype(impl, "getGadgetRecord", () => ({}));
  onPrototype(impl, "authorizeCollaborator", async () => "use");
  onPrototype(impl, "getGatekeeperFacet", function (this: any) {
    let session = this.ctx.id.toString();
    return { workflowRunOutcome: async (action: number, outcome: ApprovedRunOutcome) => {
      reported.push([session, action, outcome]);
    } };
  });
}

type Workspace = { name: string; id: string; definitionId: string; reference: string };

/**
 * W: a workspace with a live trigger HOOK pinned to a published definition (code `commit(1)`), a
 * control listing PERSON (or `opts.invokers`), and, with `opts.assigned`, an assignment.
 */
async function triggerWorkspace(opts: { invokers?: string[]; assigned?: boolean } = {}): Promise<Workspace> {
  let name = `dot-run-w-${crypto.randomUUID()}`;
  let definitionId = await withImpl(name, impl => {
    seams(impl);
    impl.ownerId = uid("ada");
    impl.storage.ownerId.put(uid("ada"));
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
    store.setControl(ADA, HOOK, { label: "Run refunds", invokers: opts.invokers ?? [PERSON] });
    if (opts.assigned) {
      impl.storage.workflowTriggerAssignments.put({
        hookId: HOOK, gatekeeperId: CONNECTION, credentialRef: REF, assignedBy: ADA, assignedAt: new Date(0),
      });
    }
    return saved.id;
  });
  let reference = workflowTriggerRef({ company: "acme", workspace: "operations", inferosWorkspaceId: idOf(name),
    hookId: HOOK, definitionId, revision: 1 });
  return { name, id: idOf(name), definitionId, reference };
}

/**
 * On W's instance, for one admission: the person (verified as `session`'s owner), and the hook's
 * controller, which fires and queues the invocation as startHook does.
 */
function admissionSeams(impl: any, session: string, opts: { vendor?: string; holds?: boolean; assigned?: boolean } = {}) {
  impl.users = {
    idFromName: (profileId: string) => ({ toString: () => uid(profileId) }),
    idFromString: (id: string) => id,
    get: () => ({
      whoami: async () => ({ type: "user", id: PERSON, name: "Operator" }),
      operateSessionWorkspaceId: async () => session,
      workflowInvokeAnswer: async () => (opts.holds === false
        ? { holds: false, company: null }
        : { holds: true, company: "0b7e2c3a-1f00-4a00-8000-00000000000a" }),
    }),
  };
  impl.env = {
    ...impl.env,
    ...(opts.vendor ? { SHARED_CONFIGURATION_GATEKEEPER: opts.vendor } : {}),
    ...(opts.assigned ? { WORKFLOW_ASSIGNMENTS_ENABLED: "true" } : {}),
  };
  if (opts.vendor) {
    // The gadget's InferOps board, in a company the person's grant is asked about.
    impl.storage.gatekeepers.put({
      id: BOARD_CONNECTION, resourceTitle: "Board ENG", class: {} as any,
      creationSpec: { type: "gatekeeper", vendorId: opts.vendor, resourceUrl: "inferops://globex.operations/project/board/ENG", typeUrlPattern: "" },
    });
    impl.visibleBindings = () => [["BOARD", { target: BOARD_CONNECTION }]];
  }
  let hooks = impl.storage.boundHooks;
  let realGet = hooks.get.bind(hooks);
  let controller = {
    invoke: async ({ invocationId }: { invocationId: string }) => {
      let store = impl.workflowDefinitionStore();
      let delivery = store.fire(HOOK, GADGET, (id: number) => (id === GADGET ? commit(1) : undefined),
          () => "build" as const, invocationId)!;
      impl.takenInvocations.set(invocationId, true);
      impl.queueWorkflowRun(HOOK, delivery.deliveryId, "onSchedule", [{ scheduleId: "s1", firedAt: "2026-11-12T00:00:00.000Z" }]);
    },
  };
  hooks.get = (id: number) => {
    let record = realGet(id);
    return record && id === HOOK ? { ...record, controller } : record;
  };
}

/** S: the person's operate session, with action ACTION approved by them, declaring a run of `reference`. */
async function sessionWith(reference: string, opts: { reportOutcome?: boolean; approvedBy?: string } = {}): Promise<string> {
  let name = `dot-run-s-${crypto.randomUUID()}`;
  await withImpl(name, impl => {
    impl.storage.actions.put({
      type: "action", id: ACTION, gatekeeperId: 50, action: ACTION_KEY, state: "approved",
      caller: { from: "agent", chatId: 1 }, createdAt: new Date(0), appliedAt: new Date(0),
      description: { title: "Run refunds", workflowRun: { reference, ...(opts.reportOutcome === false ? {} : { reportOutcome: true }) } },
      resolvedBy: { type: "user", id: opts.approvedBy ?? PERSON, name: "Operator" },
    });
  });
  return name;
}

const caller = (session: string): ConsoleToolCaller => ({ userId: uid(PERSON), profileId: PERSON, sessionWorkspaceId: session });
const request = (w: Workspace, reportOutcome = true) =>
  ({ hookId: HOOK, definitionId: w.definitionId, revision: 1, actionId: ACTION, reportOutcome });

describe("a run started by approving the Dot's proposal (FAC-134)", () => {
  it("is the workspace's own: it runs after every object restarted, and its outcome reaches the action once", async () => {
    let w = await triggerWorkspace();
    let s = await sessionWith(w.reference);
    let started = await withImpl(w.name, async impl => {
      admissionSeams(impl, idOf(s));
      return impl.invokeTriggerAs(caller(idOf(s)), request(w));
    });
    expect(started).toEqual({ status: "started", runId: expect.any(String) });
    let deliveryId = await withImpl(w.name, impl => {
      let [delivery] = [...impl.storage.workflowDeliveries.list()];
      // The run's own id, never the invocation's.
      expect(started.status === "started" && started.runId).toBe(delivery.run.runId);
      expect(started.status === "started" && started.runId).not.toBe(delivery.invocation.id);
      expect(delivery.run.requester).toEqual({ kind: "person", profileId: PERSON });
      return delivery.id;
    });
    // The browser and every session gone: nothing the approval held is needed from here.
    await abortAllDurableObjects();
    await runAlarm(w.name);
    expect(ran).toHaveLength(1);
    await vi.waitFor(() => expect(reported).toHaveLength(1));
    expect(reported[0]).toEqual([idOf(s), ACTION_KEY, {
      runId: started.status === "started" ? started.runId : "", outcome: "succeeded", requestedBy: PERSON, ranAs: "gadget_bindings",
    }]);
    expect(await withImpl(w.name, impl => impl.storage.workflowDeliveries.get(deliveryId).delivery))
      .toMatchObject({ chat: "delivered" });
    expect(await withImpl(w.name, impl => [...impl.storage.runChatReports.list()])).toEqual([]);
    // Nothing is owed any more: a later pass reports nothing again.
    await withImpl(w.name, impl => impl.reportRunsToChat(Date.now() + 1e9));
    expect(reported).toHaveLength(1);
  });

  it("refuses a trigger the person isn't on, with nothing minted or owed", async () => {
    let w = await triggerWorkspace({ invokers: ["someone-else"] });
    let s = await sessionWith(w.reference);
    let answer = await withImpl(w.name, async impl => {
      admissionSeams(impl, idOf(s));
      return impl.invokeTriggerAs(caller(idOf(s)), request(w));
    });
    expect(answer).toMatchObject({ status: "refused", kind: "permission" });
    await withImpl(w.name, impl => {
      expect([...impl.storage.workflowInvocations.list()]).toEqual([]);
      expect([...impl.storage.workflowDeliveries.list()]).toEqual([]);
      expect([...impl.storage.runChatReports.list()]).toEqual([]);
    });
  });

  it("refuses a person whose grant for the trigger's board is answered in another company, leaving it unchanged", async () => {
    let w = await triggerWorkspace();
    let s = await sessionWith(w.reference);
    let answer = await withImpl(w.name, async impl => {
      admissionSeams(impl, idOf(s), { vendor: "inferops", holds: false });
      return impl.invokeTriggerAs(caller(idOf(s)), request(w));
    });
    expect(answer).toMatchObject({ status: "refused", kind: "permission" });
    await withImpl(w.name, impl => {
      expect([...impl.storage.workflowInvocations.list()]).toEqual([]);
      expect([...impl.storage.workflowDeliveries.list()]).toEqual([]);
      expect([...impl.storage.workflowRunQueue.list()]).toEqual([]);
    });
    expect(ran).toEqual([]);
  });

  it("runs an assigned trigger only as its assignment, on its pinned code, and tells the person only the run", async () => {
    let w = await triggerWorkspace({ assigned: true });
    let s = await sessionWith(w.reference);
    let assignedRuns: unknown[][] = [];
    let started = await withImpl(w.name, async impl => {
      admissionSeams(impl, idOf(s), { assigned: true });
      onPrototype(impl, "runAssignedDelivery", async (...args: unknown[]) => { assignedRuns.push(args); return "ran"; });
      return impl.invokeTriggerAs(caller(idOf(s)), request(w));
    });
    // The person is told the run and nothing else: no credential, no facet, no assignment.
    expect(Object.keys(started).toSorted()).toEqual(["runId", "status"]);
    await withImpl(w.name, impl => {
      let [delivery] = [...impl.storage.workflowDeliveries.list()];
      expect(delivery.run.executor).toEqual({ kind: "service_account", gatekeeperId: CONNECTION, credentialRef: REF });
      expect(delivery.commitId).toBe(commit(1));
    });
    await runAlarm(w.name);
    expect(assignedRuns).toEqual([[HOOK, expect.objectContaining({ commitId: commit(1), credentialRef: REF }), "onSchedule", expect.any(Array)]]);
    await vi.waitFor(() => expect(reported).toHaveLength(1));
    expect(reported[0]![2]).toMatchObject({ outcome: "succeeded", ranAs: "service_account", requestedBy: PERSON });
  });

  it("refuses an assigned trigger while assignments are off, with nothing minted", async () => {
    let w = await triggerWorkspace({ assigned: true });
    let s = await sessionWith(w.reference);
    let answer = await withImpl(w.name, async impl => {
      admissionSeams(impl, idOf(s));
      return impl.invokeTriggerAs(caller(idOf(s)), request(w));
    });
    expect(answer).toMatchObject({ status: "refused" });
    await withImpl(w.name, impl => expect([...impl.storage.workflowDeliveries.list()]).toEqual([]));
  });

  it("tells the person nothing when, by the time it ends, they may no longer run it", async () => {
    let w = await triggerWorkspace();
    let s = await sessionWith(w.reference);
    await withImpl(w.name, async impl => {
      admissionSeams(impl, idOf(s));
      await impl.invokeTriggerAs(caller(idOf(s)), request(w));
      // Taken off the control after asking: the run fails at its start (FAC-104's re-check).
      impl.workflowDefinitionStore().setControl(ADA, HOOK, { label: "Run refunds", invokers: ["someone-else"] });
    });
    await runAlarm(w.name);
    expect(ran).toEqual([]);
    await withImpl(w.name, impl => vi.waitFor(() =>
      expect([...impl.storage.workflowDeliveries.list()][0].delivery).toMatchObject({ chat: "undelivered" })));
    expect(reported).toEqual([]);
  });

  it("reports nothing for an approval that didn't ask for the outcome", async () => {
    let w = await triggerWorkspace();
    let s = await sessionWith(w.reference, { reportOutcome: false });
    await withImpl(w.name, async impl => {
      admissionSeams(impl, idOf(s));
      expect(await impl.invokeTriggerAs(caller(idOf(s)), request(w, false))).toMatchObject({ status: "started" });
      expect([...impl.storage.runChatReports.list()]).toEqual([]);
    });
    await runAlarm(w.name);
    expect(ran).toHaveLength(1);
    expect(reported).toEqual([]);
  });
});

describe("the session receiving a run's outcome (FAC-134)", () => {
  const outcome = (overrides: Partial<ApprovedRunOutcome> = {}): ApprovedRunOutcome =>
    ({ runId: "run-1", outcome: "succeeded", requestedBy: PERSON, ranAs: "gadget_bindings", ...overrides });

  it("hands it to the action's gatekeeper only for its own approved action, from the workspace it names", async () => {
    let w = await triggerWorkspace();
    let s = await sessionWith(w.reference);
    await withImpl(s, async impl => {
      seams(impl);
      // Another workspace, another person, an action that isn't there: refused, nothing handed on.
      expect(await impl.reportApprovedRunOutcome(ACTION, idOf("elsewhere"), outcome())).toBe("refused");
      expect(await impl.reportApprovedRunOutcome(ACTION, w.id, outcome({ requestedBy: "someone-else" }))).toBe("refused");
      expect(await impl.reportApprovedRunOutcome(ACTION + 1, w.id, outcome())).toBe("refused");
      expect(await impl.reportApprovedRunOutcome(ACTION, w.id, outcome({ ranAs: "person" as never }))).toBe("refused");
      expect(reported).toEqual([]);
      // Its own: handed on once; a repeat is delivered again without a second hand-off.
      expect(await impl.reportApprovedRunOutcome(ACTION, w.id, outcome())).toBe("delivered");
      expect(await impl.reportApprovedRunOutcome(ACTION, w.id, outcome())).toBe("delivered");
      expect(reported).toEqual([[idOf(s), ACTION_KEY, outcome()]]);
    });
  });

  it("refuses one for an action that didn't ask for it", async () => {
    let w = await triggerWorkspace();
    let s = await sessionWith(w.reference, { reportOutcome: false });
    await withImpl(s, async impl => {
      seams(impl);
      expect(await impl.reportApprovedRunOutcome(ACTION, w.id, outcome())).toBe("refused");
      expect(reported).toEqual([]);
    });
  });
});
