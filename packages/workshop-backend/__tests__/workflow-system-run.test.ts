// Assigned runs of configured system workflows (FAC-102, inferops ADR 0011 S1-S4, inferos ADR 0011):
// an admitted request for a trigger assigned to a service account runs the pinned commit in a fresh,
// run-scoped worker whose only bindings reach the assigned connection, and that connection's
// sessions open on its vendor's system class for the assignment, never a person's facet. Nothing
// falls back: anything else a run asks for is refused, and a session outlives no run.
import { RpcStub, RpcTarget } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ADMIN_CONFIG, serializeAdminConfig } from "../src/admin-config.js";
import {
  RUN_REQUESTER_REVOKED,
  OverseerDurableObject, PROVISION_REFUSED, makeOverseerStorage, provisionWorkflowTriggerCredential,
  TRIGGER_AUTO_RETIRED, WORKFLOW_ASSIGNMENTS_DISABLED, retireAssignmentsUsing, retireTriggerAssignment, retireUnboundAssignments,
  setWorkflowTriggerAssignment,
} from "../src/overseer.js";
import {
  SYSTEM_RUN_ASSIGNMENT_CHANGED, SYSTEM_RUN_ENDED, SYSTEM_RUN_UNSUPPORTED, SYSTEM_RUN_WRONG_CONNECTION,
  ASSIGNED_ACTION_STALE, SystemRunRegistry, assignedActionProblem, openSystemRunSession, revocableSession,
  runAssignedDelivery, systemGatekeeperFacetName,
  type SystemRunCaller, type SystemRunHost,
} from "../src/system-run.js";
import { WorkspaceWorkflowDefinitionStore } from "../src/workflow-definition-store.js";
import { openFakeOverseer } from "./fixtures.js";
import { makeMockStorage } from "./mock-storage.js";

vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));

const HOOK = 11;
const GADGET = 3;
const INFEROPS = 50;
const commit = (n: number) => n.toString(16).padStart(40, "0");
const ADA = { type: "user" as const, id: "ada-profile", name: "Ada" };

/** A host for system-run.ts with one assigned trigger and recording doubles. */
function host(opts: {
  bindings?: [string, { target: number }][];
  vendor?: SystemRunHost["vendor"];
  entry?: Record<string, (...a: unknown[]) => Promise<unknown>>;
} = {}) {
  let assignment: { hookId: number; gatekeeperId: number; credentialRef: string } | null = {
    hookId: HOOK, gatekeeperId: INFEROPS, credentialRef: "ref-1",
  };
  let loaded: { mainModule: string; modules: Record<string, string>; env: Record<string, unknown> }[] = [];
  let loopbacks: [number, SystemRunCaller][] = [];
  let sessions: [number, string, SystemRunCaller][] = [];
  let facets = new Map<string, unknown>();
  let duringRun: (() => Promise<void>) | undefined;
  let systemClass = { name: "SystemClass" } as unknown as DurableObjectClass<any>;
  let classRequests: [string, { resourceUrl: string }][] = [];
  let hookLive = true;
  let unbound = false;
  let abortedFacets = new Set<string>();
  let h: SystemRunHost & {
    setAssignment(a: typeof assignment): void; whileRunning(f: () => Promise<void>): void; deleteHook(): void;
    unbindConnection(): void;
  } = {
    systemRuns: new SystemRunRegistry(),
    assignmentOf: () => assignment && { ...assignment, assignedBy: ADA, assignedAt: new Date(0) },
    liveHookGadget: () => {
      if (!hookLive) throw new Error("Hook has been deleted or disabled.");
      return GADGET;
    },
    bindingsOf: () => (unbound ? [] : opts.bindings ?? [
      ["INFEROPS", { target: INFEROPS }], ["MAIL", { target: 60 }], ["BOARD", { target: INFEROPS }], ["TABLES", { target: 70 }],
    ]),
    abortFacet: name => { abortedFacets.add(name); },
    makeLoopback: (gatekeeperId, caller) => {
      loopbacks.push([gatekeeperId, caller]);
      return { loopback: gatekeeperId };
    },
    readModules: async commitId => ({ "server.js": `// ${commitId}` }),
    loadWorker: code => {
      loaded.push(code);
      let entry = opts.entry ?? {
        run: async (...args: unknown[]) => {
          if (duringRun) await duringRun();
          return { ran: args };
        },
      };
      return { getEntrypoint: (name: string) => (name === "WorkflowRun" ? entry : undefined) };
    },
    vendorIdOf: id => (id === INFEROPS ? "inferops" : "mail"),
    resourceUrlOf: id => (id === INFEROPS ? "inferops://grokbot.operations/project/board/GROK" : undefined),
    vendor: opts.vendor ?? (id => (id === "inferops" ? {
      getSystemGatekeeperClass: async (ref: string, connection: { resourceUrl: string }) => {
        classRequests.push([ref, connection]);
        return systemClass;
      },
    } : undefined)),
    facet: (name, cls) => {
      facets.set(name, cls);
      return { facet: name } as unknown as Fetcher<any>;
    },
    wrapSession: wrapper => wrapper,
    openSession: async (gatekeeperId, facet, caller) => {
      sessions.push([gatekeeperId, (facet as unknown as { facet: string }).facet, caller]);
      let facetName = (facet as unknown as { facet: string }).facet;
      return {
        session: gatekeeperId, readBoard: async () => "board", moveIssue: async (id: string) => `moved ${id}`,
        // A capability the session hands out lives in its facet, so it dies when the facet is aborted.
        subSession: async () => ({
          read: async () => {
            if (abortedFacets.has(facetName)) throw new Error("The facet was aborted.");
            return "sub";
          },
        }),
      };
    },
    setAssignment: a => { assignment = a; },
    whileRunning: f => { duringRun = f; },
    deleteHook: () => { hookLive = false; },
    unbindConnection: () => { unbound = true; },
  };
  return { h, loaded, loopbacks, sessions, facets, systemClass, classRequests, abortedFacets };
}

const DELIVERY = { deliveryId: 7, commitId: commit(1), credentialRef: "ref-1" };
const CALLER: SystemRunCaller = { from: "systemRun", hookId: HOOK, deliveryId: 7 };

describe("a run-scoped worker", () => {
  it("loads the delivery's commit with only the bindings to the assigned connection, each as the run", async () => {
    let { h, loaded, loopbacks } = host();
    await expect(runAssignedDelivery(h, HOOK, DELIVERY, null, ["firing"])).resolves.toEqual({ ran: ["firing"] });
    expect(loaded).toHaveLength(1);
    expect(loaded[0].mainModule).toBe("server.js");
    expect(loaded[0].modules).toEqual({ "server.js": `// ${commit(1)}` });
    // Only the assigned connection's names: no GADGET, GIT, or any other binding of the gadget.
    expect(Object.keys(loaded[0].env).toSorted()).toEqual(["BOARD", "INFEROPS"]);
    expect(loopbacks).toEqual([[INFEROPS, CALLER], [INFEROPS, CALLER]]);
  });

  it("calls the named WorkflowRun method, and ends the run whatever it does", async () => {
    let onSchedule = vi.fn(async () => { throw new Error("the workflow failed"); });
    let { h } = host({ entry: { onSchedule } });
    await expect(runAssignedDelivery(h, HOOK, DELIVERY, "onSchedule", [{ id: 1 }])).rejects.toThrow("the workflow failed");
    expect(onSchedule).toHaveBeenCalledWith({ id: 1 });
    expect(h.systemRuns.has(DELIVERY.deliveryId)).toBe(false);
  });

  it("refuses a run whose assignment changed, a delivery already running, and a gadget no longer bound", async () => {
    let changed = host();
    changed.h.setAssignment({ hookId: HOOK, gatekeeperId: INFEROPS, credentialRef: "ref-2" });
    await expect(runAssignedDelivery(changed.h, HOOK, DELIVERY, null, [])).rejects.toThrow(SYSTEM_RUN_ASSIGNMENT_CHANGED);
    expect(changed.loaded).toEqual([]);

    let removed = host();
    removed.h.setAssignment(null);
    await expect(runAssignedDelivery(removed.h, HOOK, DELIVERY, null, [])).rejects.toThrow(SYSTEM_RUN_ASSIGNMENT_CHANGED);

    let twice = host();
    twice.h.systemRuns.begin(DELIVERY.deliveryId, { hookId: HOOK, gatekeeperId: INFEROPS, credentialRef: "ref-1" });
    await expect(runAssignedDelivery(twice.h, HOOK, DELIVERY, null, [])).rejects.toThrow("This run already started.");

    let unbound = host({ bindings: [["MAIL", { target: 60 }]] });
    await expect(runAssignedDelivery(unbound.h, HOOK, DELIVERY, null, [])).rejects.toThrow("no longer binds");
    expect(unbound.loaded).toEqual([]);
  });
});

describe("a run's sessions", () => {
  it("open only while the run runs, on the vendor's system class for the assignment, never the connection's own facet", async () => {
    let made = host();
    let opened: unknown;
    made.h.whileRunning(async () => { opened = await openSystemRunSession(made.h, { type: "gatekeeper", id: INFEROPS }, CALLER); });
    await runAssignedDelivery(made.h, HOOK, DELIVERY, null, []);
    await expect((opened as any).readBoard()).rejects.toThrow(SYSTEM_RUN_ENDED);
    // The facet is the delivery's own, and is aborted when the run ends.
    expect(made.sessions).toEqual([[INFEROPS, systemGatekeeperFacetName("ref-1", 7), CALLER]]);
    expect(made.facets.get(systemGatekeeperFacetName("ref-1", 7))).toBe(made.systemClass);
    expect(made.abortedFacets.has(systemGatekeeperFacetName("ref-1", 7))).toBe(true);
    // The vendor is told which resource the connection serves, from the connection's own record.
    expect(made.classRequests).toEqual([["ref-1", { resourceUrl: "inferops://grokbot.operations/project/board/GROK" }]]);
    // After the run, the same binding reaches nothing.
    await expect(openSystemRunSession(made.h, { type: "gatekeeper", id: INFEROPS }, CALLER)).rejects.toThrow(SYSTEM_RUN_ENDED);
  });

  // FAC-104: the caller's synchronous re-check runs after the run's last await (the module read)
  // and before the run registers, so a refusal there starts nothing.
  it("refuse to start when the caller's re-check refuses after the module read", async () => {
    let made = host();
    let refusal = await runAssignedDelivery(made.h, HOOK, DELIVERY, null, [], () => { throw new Error("revoked meanwhile"); })
        .then(() => "started", (e: Error) => e.message);
    expect(refusal).toBe("revoked meanwhile");
    expect(made.h.systemRuns.has(DELIVERY.deliveryId)).toBe(false);
    expect(made.sessions).toEqual([]);
  });

  it("refuse another connection, a gadget, git, another delivery and another hook", async () => {
    let made = host();
    let attempts: string[] = [];
    made.h.whileRunning(async () => {
      for (let [target, caller] of [
        [{ type: "gatekeeper", id: 60 }, CALLER],
        [{ type: "gadget", id: GADGET }, CALLER],
        [{ type: "git" }, CALLER],
        [{ type: "gatekeeper", id: INFEROPS }, { ...CALLER, deliveryId: 8 }],
        [{ type: "gatekeeper", id: INFEROPS }, { ...CALLER, hookId: 12 }],
      ] as const) {
        attempts.push(await openSystemRunSession(made.h, target, caller).then(() => "opened", (e: Error) => e.message));
      }
    });
    await runAssignedDelivery(made.h, HOOK, DELIVERY, null, []);
    expect(attempts).toEqual([
      SYSTEM_RUN_WRONG_CONNECTION, SYSTEM_RUN_WRONG_CONNECTION, SYSTEM_RUN_WRONG_CONNECTION,
      SYSTEM_RUN_ENDED, SYSTEM_RUN_ENDED,
    ]);
    expect(made.sessions).toEqual([]);
  });

  it("refuse when the vendor has no system credentials, or can't give the class", async () => {
    for (let vendor of [
      () => undefined,
      () => ({}),
      () => ({ getSystemGatekeeperClass: async () => { throw new Error("nothing provisioned"); } }),
    ] as SystemRunHost["vendor"][]) {
      let made = host({ vendor });
      let attempt: string | undefined;
      made.h.whileRunning(async () => {
        attempt = await openSystemRunSession(made.h, { type: "gatekeeper", id: INFEROPS }, CALLER)
          .then(() => "opened", (e: Error) => e.message);
      });
      await runAssignedDelivery(made.h, HOOK, DELIVERY, null, []);
      expect(attempt).toBe(SYSTEM_RUN_UNSUPPORTED);
      expect(made.sessions).toEqual([]);
    }
  });

  it("refuse when the assignment changes while the class is being fetched", async () => {
    let made = host({
      vendor: () => ({
        getSystemGatekeeperClass: async () => {
          made.h.setAssignment({ hookId: HOOK, gatekeeperId: INFEROPS, credentialRef: "ref-2" });
          return {} as DurableObjectClass<any>;
        },
      }),
    });
    let attempt: string | undefined;
    made.h.whileRunning(async () => {
      attempt = await openSystemRunSession(made.h, { type: "gatekeeper", id: INFEROPS }, CALLER)
        .then(() => "opened", (e: Error) => e.message);
    });
    await runAssignedDelivery(made.h, HOOK, DELIVERY, null, []);
    expect(attempt).toBe(SYSTEM_RUN_ASSIGNMENT_CHANGED);
    expect(made.sessions).toEqual([]);
  });
});

/** A store with one published definition pinned to HOOK and a control listing OPERATOR. */
function pinnedStore() {
  let durable = makeMockStorage();
  let storage = makeOverseerStorage(durable);
  let store = new WorkspaceWorkflowDefinitionStore(durable, storage);
  let saved = store.save(ADA, { title: "Refund", gadgetId: GADGET }, () => commit(1));
  store.publish(ADA, saved.id, 1);
  store.pinTrigger(ADA.id, HOOK, GADGET, { definitionId: saved.id, revision: 1 });
  store.setControl(ADA, HOOK, { label: "Refund", invokers: ["operator"] });
  return { store, saved };
}
const headOf = () => commit(1);
const everyoneBuilds = () => true;

describe("an assignment", () => {
  it("is only for a pinned trigger, gets a fresh reference each time, and goes with the pin or the hook", () => {
    let { store, saved } = pinnedStore();
    expect(() => store.setAssignment(ADA, 99, INFEROPS)).toThrow("Only a trigger pinned");
    let first = store.setAssignment(ADA, HOOK, INFEROPS);
    let second = store.setAssignment(ADA, HOOK, INFEROPS);
    expect(first?.credentialRef).toMatch(/^[0-9a-f-]{36}$/);
    expect(second?.credentialRef).not.toBe(first?.credentialRef);
    expect(store.assignmentOf(HOOK)?.credentialRef).toBe(second?.credentialRef);
    store.pinTrigger(ADA.id, HOOK, GADGET, null);
    expect(store.assignmentOf(HOOK)).toBeNull();
    store.pinTrigger(ADA.id, HOOK, GADGET, { definitionId: saved.id, revision: 1 });
    store.setAssignment(ADA, HOOK, INFEROPS);
    store.forgetTrigger(HOOK);
    expect(store.assignmentOf(HOOK)).toBeNull();
  });

  it("drops runs waiting to start when it changes, so a run never executes under another assignment", () => {
    let { store } = pinnedStore();
    let waiting = store.beginInvocation("operator", HOOK);
    store.setAssignment(ADA, HOOK, INFEROPS);
    expect(() => store.fire(HOOK, GADGET, headOf, everyoneBuilds, waiting.id)).toThrow("unknown or already ran");
  });

  it("is recorded on an on-request delivery as what it executed as, and never on a scheduled one", () => {
    let { store } = pinnedStore();
    let assignment = store.setAssignment(ADA, HOOK, INFEROPS)!;
    let requested = store.fire(HOOK, GADGET, headOf, everyoneBuilds, store.beginInvocation("operator", HOOK).id);
    expect(requested?.executedAs).toEqual({ credentialRef: assignment.credentialRef });
    expect(requested?.invocation?.requestedBy).toBe("operator");
    expect(store.fire(HOOK, GADGET, headOf, everyoneBuilds)?.executedAs).toBeUndefined();
  });
});

/** An Overseer whose startHook fires HOOK from `store`, with a recording runAssignedDelivery. */
function overseerFor(store: WorkspaceWorkflowDefinitionStore, assignmentsEnabled = true) {
  let takenInvocations = new Map<string, boolean>();
  let gadgetCallback = { onSchedule: vi.fn(async () => "gadget's own") };
  let runSpy = vi.fn(async (..._args: unknown[]) => "as the service account");
  let overseer = Object.create(OverseerDurableObject.prototype) as OverseerDurableObject;
  Object.assign(overseer, {
    env: {
      BLUEPRINTS: { get: async () => serializeAdminConfig(DEFAULT_ADMIN_CONFIG) },
      ...(assignmentsEnabled ? { WORKFLOW_ASSIGNMENTS_ENABLED: "true" } : {}),
    },
    impl: {
      env: {},
      takenInvocations,
      assertGatekeeperUsable: () => {},
      getSharingManager: async () => ({ getEffectiveRole: () => undefined }),
      getOwnerProfileId: async () => ADA.id,
      workflowDefinitionStore: () => store,
      getGadgetHead: headOf,
      defaultGadgetId: GADGET,
      runAssignedDelivery: runSpy,
      storage: {
        boundHooks: { get: () => ({ id: HOOK, enabled: true, vendorId: "scheduler", gatekeeperId: 1, gadgetId: GADGET, callback: gadgetCallback }) },
        gatekeepers: { get: () => undefined },
      },
    },
  });
  return { overseer, gadgetCallback, runSpy, takenInvocations };
}

describe("startHook for a trigger with an assignment", () => {
  it("runs an admitted request as the assignment, once, and never through the gadget's own callback", async () => {
    let { store } = pinnedStore();
    let assignment = store.setAssignment(ADA, HOOK, INFEROPS)!;
    let { overseer, gadgetCallback, runSpy } = overseerFor(store);
    let invocation = store.beginInvocation("operator", HOOK);
    let { callback } = await overseer.startHook(HOOK, { invocationId: invocation.id });
    await expect((callback as any).onSchedule({ runId: "x" })).resolves.toBe("as the service account");
    expect(gadgetCallback.onSchedule).not.toHaveBeenCalled();
    expect(runSpy).toHaveBeenCalledWith(HOOK,
        expect.objectContaining({ commitId: commit(1), credentialRef: assignment.credentialRef }),
        "onSchedule", [{ runId: "x" }]);
    // A stored callback is no standing route to the service account.
    // Awaited directly (as overseer-hooks.test.ts does): an RPC rejection handled late reads as unhandled.
    let refusal: unknown;
    try { await (callback as any).onSchedule({ runId: "y" }); } catch (error) { refusal = error; }
    expect(String(refusal)).toMatch("This run already started.");
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps a scheduled firing on the gadget's own callback, as before", async () => {
    let { store } = pinnedStore();
    store.setAssignment(ADA, HOOK, INFEROPS);
    let { overseer, gadgetCallback, runSpy } = overseerFor(store);
    let { callback } = await overseer.startHook(HOOK);
    await expect((callback as any).onSchedule({ runId: "s" })).resolves.toBe("gadget's own");
    expect(runSpy).not.toHaveBeenCalled();
    expect(gadgetCallback.onSchedule).toHaveBeenCalled();
  });

  // FAC-104 (r1): a run a person asked for, on the gadget's own bindings, re-checks the person when
  // it starts; a delivery that starts after they were taken off the control never runs.
  it("doesn't start an unassigned request whose person was taken off the control before it started", async () => {
    let { store } = pinnedStore();
    let { overseer, gadgetCallback, runSpy } = overseerFor(store);
    let { callback } = await overseer.startHook(HOOK, { invocationId: store.beginInvocation("operator", HOOK).id });
    store.setControl(ADA, HOOK, { label: "Run", invokers: ["someone-else"] });
    let refusal: unknown;
    try { await (callback as any).onSchedule({ runId: "late" }); } catch (error) { refusal = error; }
    expect(String(refusal)).toContain(RUN_REQUESTER_REVOKED);
    expect(gadgetCallback.onSchedule).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("leaves a scheduled firing, which no person asked for, unaffected by the control", async () => {
    let { store } = pinnedStore();
    let { overseer, gadgetCallback } = overseerFor(store);
    let { callback } = await overseer.startHook(HOOK);
    store.setControl(ADA, HOOK, { label: "Run", invokers: ["someone-else"] });
    await expect((callback as any).onSchedule({ runId: "s2" })).resolves.toBe("gadget's own");
    expect(gadgetCallback.onSchedule).toHaveBeenCalled();
  });

  it("keeps an unassigned trigger's request on the gadget's own callback, as before", async () => {
    let { store } = pinnedStore();
    let { overseer, gadgetCallback, runSpy } = overseerFor(store);
    let { callback } = await overseer.startHook(HOOK, { invocationId: store.beginInvocation("operator", HOOK).id });
    await expect((callback as any).onSchedule({ runId: "r" })).resolves.toBe("gadget's own");
    expect(runSpy).not.toHaveBeenCalled();
    expect(gadgetCallback.onSchedule).toHaveBeenCalled();
  });
});

/** An Overseer impl for assignments: HOOK wakes GADGET, which binds INFEROPS (inferops) and 60 (mail). */
function assignmentImpl(given: Record<string, string>) {
  // Assignments are on unless a test turns them off (WORKFLOW_ASSIGNMENTS_ENABLED, default off).
  let env = { WORKFLOW_ASSIGNMENTS_ENABLED: "true", ...given };
  let { store } = pinnedStore();
  let aborted: string[] = [];
  let systemRuns = new SystemRunRegistry();
  let impl = {
    env,
    systemRuns,
    defaultGadgetId: GADGET,
    workflowDefinitionStore: () => store,
    getGadgetRecord: () => ({}),
    visibleBindings: () => [["INFEROPS", { target: INFEROPS }], ["MAIL", { target: 60 }]],
    ctx: { id: { toString: () => "overseer-id" }, facets: { abort: (name: string) => { aborted.push(name); } } },
    storage: {
      containsRestrictedData: { get: () => false },
      title: { get: () => "Test Workspace" },
      operateSession: { get: () => false },
      boundHooks: { get: (id: number) => (id === HOOK ? { id: HOOK, gadgetId: GADGET } : undefined) },
      gadgets: { get: (id: number) => (id === GADGET ? { id: GADGET, type: "gadget" } : undefined) },
      gatekeepers: {
        get: (id: number) => ({
          creationSpec: { type: "gatekeeper", vendorId: id === INFEROPS ? "InferOps" : "mail", resourceUrl: "x", typeUrlPattern: "x" },
        }),
      },
    },
  };
  /** Marks a delivery of `credentialRef` running, as a run in flight would be. */
  let running = (credentialRef: string, deliveryId = 7) =>
    systemRuns.begin(deliveryId, { hookId: HOOK, gatekeeperId: INFEROPS, credentialRef });
  return { impl: impl as unknown as Parameters<typeof setWorkflowTriggerAssignment>[0], store, aborted, running };
}

describe("assigning a trigger", () => {
  const GATED = { SHARED_CONFIGURATION_GATEKEEPER: "inferops" };

  it("takes only a connection the trigger's gadget binds, of the deployment's named vendor", () => {
    let { impl, store } = assignmentImpl(GATED);
    expect(() => setWorkflowTriggerAssignment(impl, ADA, HOOK, { gatekeeperId: 60 })).toThrow("Assign a inferops connection");
    expect(() => setWorkflowTriggerAssignment(impl, ADA, HOOK, { gatekeeperId: 99 })).toThrow("Assign a inferops connection");
    expect(() => setWorkflowTriggerAssignment(impl, ADA, HOOK, { gatekeeperId: "50" } as never)).toThrow("by its id");
    expect(() => setWorkflowTriggerAssignment(impl, ADA, 99, { gatekeeperId: INFEROPS })).toThrow("No such hook.");
    expect(store.assignmentOf(HOOK)).toBeNull();
    expect(setWorkflowTriggerAssignment(impl, ADA, HOOK, { gatekeeperId: INFEROPS })).toMatchObject({ hookId: HOOK, gatekeeperId: INFEROPS });
  });

  it("refuses where the deployment names no vendor for it", () => {
    let { impl } = assignmentImpl({});
    expect(() => setWorkflowTriggerAssignment(impl, ADA, HOOK, { gatekeeperId: INFEROPS })).toThrow("names no service");
  });

  it("ends the old reference's running system facets when it changes or goes", () => {
    let { impl, aborted, running } = assignmentImpl(GATED);
    let first = setWorkflowTriggerAssignment(impl, ADA, HOOK, { gatekeeperId: INFEROPS })!;
    running(first.credentialRef, 7);
    let second = setWorkflowTriggerAssignment(impl, ADA, HOOK, { gatekeeperId: INFEROPS })!;
    running(second.credentialRef, 8);
    setWorkflowTriggerAssignment(impl, ADA, HOOK, null);
    expect(aborted).toEqual([systemGatekeeperFacetName(first.credentialRef, 7), systemGatekeeperFacetName(second.credentialRef, 8)]);
  });
});

/** A session over assignmentImpl whose person holds (or not) the deployment's publish authority. */
async function assignmentSession(role: "build" | "use", holdsPublish: boolean, enabled = true) {
  let { impl, store } = assignmentImpl({ SHARED_CONFIGURATION_GATEKEEPER: "inferops", WORKFLOW_ASSIGNMENTS_ENABLED: String(enabled) });
  let asked: string[] = [];
  let full = Object.assign(impl as object, {
    isSharedConfiguration: async () => true,
    assertGatekeeperUsable: () => {},
    setTriggerAssignment(this: never, caller: typeof ADA, hookId: number, settings: { gatekeeperId: number } | null) {
      return setWorkflowTriggerAssignment(this, caller, hookId, settings);
    },
    provisionTriggerCredential(this: never, caller: typeof ADA, hookId: number, key: string) {
      return provisionWorkflowTriggerCredential(this, caller, hookId, key);
    },
    users: {
      idFromString: (id: string) => id,
      get: () => ({
        whoami: async () => ADA, recordSharedGadgetOpen: async () => {},
        holdsSharedConfiguration: async (action: string) => { asked.push(action); return action === "publish" ? holdsPublish : true; },
      }),
    },
  });
  let overseer = await openFakeOverseer({}, { role, impl: full });
  return { overseer, store, asked };
}

describe("who may assign", () => {

  it("is a builder holding the deployment's publish authority (an Admin's), asked every time", async () => {
    let admin = await assignmentSession("build", true);
    await expect(admin.overseer.setTriggerAssignment(HOOK, { gatekeeperId: INFEROPS })).resolves.toMatchObject({ gatekeeperId: INFEROPS });
    expect(admin.asked).toContain("publish");
    let builder = await assignmentSession("build", false);
    await expect(builder.overseer.setTriggerAssignment(HOOK, { gatekeeperId: INFEROPS })).rejects.toThrow();
    expect(builder.store.assignmentOf(HOOK)).toBeNull();
  });

  it("is never a use collaborator, who can't read an assignment either", async () => {
    let user = await assignmentSession("use", true);
    await expect(user.overseer.setTriggerAssignment(HOOK, { gatekeeperId: INFEROPS })).rejects.toThrow();
    await expect(user.overseer.getTriggerAssignment(HOOK)).rejects.toThrow();
    expect(user.store.assignmentOf(HOOK)).toBeNull();
  });
});

const KEY = "iex_live_SECRET_service_account_key_0123456789";

/** An impl for provisioning: assignmentImpl plus a vendor bound as GATEKEEPER_INFEROPS. */
function provisionImpl(vendor: Record<string, (...args: never[]) => Promise<unknown>>) {
  let made = assignmentImpl({ SHARED_CONFIGURATION_GATEKEEPER: "inferops" });
  let impl = made.impl as unknown as { env: Record<string, unknown>; storage: { gatekeepers: { get: (id: number) => unknown } } };
  impl.env = { ...impl.env, GATEKEEPER_INFEROPS: vendor };
  let gatekeepers = impl.storage.gatekeepers.get;
  impl.storage.gatekeepers.get = (id: number) => ({
    ...(gatekeepers(id) as object),
    creationSpec: { type: "gatekeeper", vendorId: id === INFEROPS ? "inferops" : "mail",
      resourceUrl: "inferops://grokbot.operations/project/board/GROK", typeUrlPattern: "x" },
  });
  return made;
}

/** Everything the console saw while `run` ran, as one string. */
async function consoleDuring(run: () => Promise<unknown>): Promise<{ text: string; result: unknown }> {
  let seen: unknown[] = [];
  let spies = (["log", "info", "warn", "error", "debug"] as const).map(level =>
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { seen.push(args); }));
  let result: unknown;
  try { result = await run().catch((error: unknown) => error); } finally { for (let spy of spies) spy.mockRestore(); }
  let text = seen.map(entry => { try { return JSON.stringify(entry, (_k, v) => (v instanceof Error ? `${v.message} ${String(v.cause)}` : v)); } catch { return String(entry); } }).join("\n");
  return { text, result };
}

describe("provisioning an assignment's key (FAC-102, the lead's option a)", () => {
  it("hands the key to the connection's vendor for the assignment's reference and records who and when, never the key", async () => {
    let provision = vi.fn(async (_ref: string, _connection: { resourceUrl: string }, _key: string) => {});
    let { impl, store } = provisionImpl({ provisionSystemCredential: provision });
    let assignment = setWorkflowTriggerAssignment(impl, ADA, HOOK, { gatekeeperId: INFEROPS })!;
    let { text, result } = await consoleDuring(() => provisionWorkflowTriggerCredential(impl, ADA, HOOK, KEY));
    expect(provision).toHaveBeenCalledWith(assignment.credentialRef,
        { resourceUrl: "inferops://grokbot.operations/project/board/GROK" }, KEY);
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(result).toMatchObject({ hookId: HOOK, provisionedBy: ADA });
    expect(store.assignmentOf(HOOK)).toMatchObject({ provisionedBy: ADA, provisionedAt: expect.any(Date) });
    expect(JSON.stringify(store.assignmentOf(HOOK))).not.toContain(KEY);
    expect(text).not.toContain(KEY);
  });

  it("refuses a key the vendor won't accept with fixed words, echoing nothing of the key or the vendor's reason", async () => {
    let provision = vi.fn(async () => { throw new Error(`InferOps said ${KEY} is not a service account`); });
    let { impl, store } = provisionImpl({ provisionSystemCredential: provision });
    setWorkflowTriggerAssignment(impl, ADA, HOOK, { gatekeeperId: INFEROPS });
    let { text, result } = await consoleDuring(() => provisionWorkflowTriggerCredential(impl, ADA, HOOK, KEY));
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe(PROVISION_REFUSED);
    expect(String((result as Error).cause ?? "")).not.toContain(KEY);
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(text).not.toContain(KEY);
    expect(store.assignmentOf(HOOK)?.provisionedBy).toBeUndefined();
  });

  it("refuses without an assignment, and for a key that isn't a string or is too long, before the vendor sees it", async () => {
    let provision = vi.fn(async () => {});
    let { impl } = provisionImpl({ provisionSystemCredential: provision });
    await expect(provisionWorkflowTriggerCredential(impl, ADA, HOOK, KEY)).rejects.toThrow("isn't assigned");
    setWorkflowTriggerAssignment(impl, ADA, HOOK, { gatekeeperId: INFEROPS });
    await expect(provisionWorkflowTriggerCredential(impl, ADA, HOOK, 42 as never)).rejects.toThrow(PROVISION_REFUSED);
    await expect(provisionWorkflowTriggerCredential(impl, ADA, HOOK, "x".repeat(1025))).rejects.toThrow(PROVISION_REFUSED);
    expect(provision).not.toHaveBeenCalled();
  });

  it("rotates on a second provisioning, and the stored credential goes when the assignment changes or goes", async () => {
    let provision = vi.fn(async () => {});
    let forget = vi.fn(async (_ref: string) => {});
    let { impl } = provisionImpl({ provisionSystemCredential: provision, forgetSystemCredential: forget });
    let first = setWorkflowTriggerAssignment(impl, ADA, HOOK, { gatekeeperId: INFEROPS })!;
    await provisionWorkflowTriggerCredential(impl, ADA, HOOK, KEY);
    await provisionWorkflowTriggerCredential(impl, ADA, HOOK, `${KEY}-rotated`);
    expect(provision).toHaveBeenCalledTimes(2);
    let second = setWorkflowTriggerAssignment(impl, ADA, HOOK, { gatekeeperId: INFEROPS })!;
    setWorkflowTriggerAssignment(impl, ADA, HOOK, null);
    await vi.waitFor(() => expect(forget.mock.calls.map(c => c[0])).toEqual([first.credentialRef, second.credentialRef]));
  });

  // #375 round 2: the vendor stores before the Workshop confirms the assignment is unchanged, so a
  // failure after the store must forget what was stored rather than leave a key at rest.
  it("forgets the key it just stored when the assignment changed while the key was being checked", async () => {
    let forget = vi.fn(async (_ref: string) => {});
    let made = provisionImpl({ forgetSystemCredential: forget, provisionSystemCredential: async () => {
      // Gone meanwhile without a retire, so only provisioning itself can forget the reference.
      made.store.removeAssignment(HOOK);
    } });
    let assignment = setWorkflowTriggerAssignment(made.impl, ADA, HOOK, { gatekeeperId: INFEROPS })!;
    let { text, result } = await consoleDuring(() => provisionWorkflowTriggerCredential(made.impl, ADA, HOOK, KEY));
    expect(String(result)).toContain("assignment changed");
    expect(forget).toHaveBeenCalledWith(assignment.credentialRef);
    expect(text).not.toContain(KEY);
  });

  it("forgets the key it just stored when recording who gave it fails", async () => {
    let forget = vi.fn(async (_ref: string) => {});
    let made = provisionImpl({ forgetSystemCredential: forget, provisionSystemCredential: async () => {} });
    let assignment = setWorkflowTriggerAssignment(made.impl, ADA, HOOK, { gatekeeperId: INFEROPS })!;
    made.store.markProvisioned = () => { throw new Error("storage reset"); };
    await expect(provisionWorkflowTriggerCredential(made.impl, ADA, HOOK, KEY)).rejects.toThrow();
    expect(forget).toHaveBeenCalledWith(assignment.credentialRef);
  });

  // #374, review.r2's recheck: a key provisioning refused must not stay usable because the vendor
  // couldn't forget it.
  it("retires the assignment when recording fails and the key can't be forgotten either", async () => {
    let forget = vi.fn(async (_ref: string) => { throw new Error("vendor unavailable"); });
    let made = provisionImpl({ forgetSystemCredential: forget, provisionSystemCredential: async () => {} });
    let assignment = setWorkflowTriggerAssignment(made.impl, ADA, HOOK, { gatekeeperId: INFEROPS })!;
    made.running(assignment.credentialRef);
    made.store.markProvisioned = () => { throw new Error("storage reset"); };
    let { text, result } = await consoleDuring(() => provisionWorkflowTriggerCredential(made.impl, ADA, HOOK, KEY));
    expect(result).toBeInstanceOf(Error);
    expect(made.store.assignmentOf(HOOK)).toBeNull();
    expect(made.aborted).toEqual([systemGatekeeperFacetName(assignment.credentialRef, 7)]);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(assignment.credentialRef);
  });
});

describe("who may provision", () => {
  it("is who may assign: a builder with the deployment's publish authority, never a use collaborator", async () => {
    let admin = await assignmentSession("build", true);
    await expect(admin.overseer.provisionTriggerCredential(HOOK, KEY)).rejects.toThrow("isn't assigned");
    let builder = await assignmentSession("build", false);
    await expect(builder.overseer.provisionTriggerCredential(HOOK, KEY)).rejects.toThrow();
    expect(builder.asked).toContain("publish");
    let user = await assignmentSession("use", true);
    await expect(user.overseer.provisionTriggerCredential(HOOK, KEY)).rejects.toThrow();
  });
});

/** Opens a session inside a run, runs `during(session)` there, and returns the held session. */
async function heldSession(during?: (session: any, made: ReturnType<typeof host>) => Promise<void>) {
  let made = host();
  let session: any;
  made.h.whileRunning(async () => {
    session = await openSystemRunSession(made.h, { type: "gatekeeper", id: INFEROPS }, CALLER);
    if (during) await during(session, made);
  });
  await runAssignedDelivery(made.h, HOOK, DELIVERY, null, []);
  return { session, made };
}

describe("a system session is bound to its run (#374 round 2)", () => {

  it("works while the run runs, and refuses every call once WorkflowRun returns", async () => {
    let seen: unknown[] = [];
    let { session } = await heldSession(async held => { seen.push(await held.readBoard(), await held.moveIssue("GROK-2")); });
    expect(seen).toEqual(["board", "moved GROK-2"]);
    await expect(session.readBoard()).rejects.toThrow(SYSTEM_RUN_ENDED);
    await expect(session.moveIssue("GROK-3")).rejects.toThrow(SYSTEM_RUN_ENDED);
  });

  it("stops in-flight work at its next call when the assignment is removed, changed, or the hook is deleted", async () => {
    for (let revoke of [
      (made: ReturnType<typeof host>) => made.h.setAssignment(null),
      (made: ReturnType<typeof host>) => made.h.setAssignment({ hookId: HOOK, gatekeeperId: INFEROPS, credentialRef: "ref-2" }),
      (made: ReturnType<typeof host>) => made.h.deleteHook(),
    ]) {
      let outcomes: string[] = [];
      await heldSession(async (held, made) => {
        outcomes.push(await held.readBoard());
        revoke(made);
        outcomes.push(await held.moveIssue("GROK-2").then(() => "moved", (e: Error) => e.message));
      });
      expect(outcomes).toEqual(["board", SYSTEM_RUN_ENDED]);
    }
  });
});

describe("retiring an assignment (#374 round 2)", () => {
  it("aborts its system facet and forgets its stored key, on every route that removes it", async () => {
    let forget = vi.fn(async (_ref: string) => {});
    let { impl, store, aborted, running } = provisionImpl({ forgetSystemCredential: forget });
    let assignment = setWorkflowTriggerAssignment(impl, ADA, HOOK, { gatekeeperId: INFEROPS })!;
    running(assignment.credentialRef);
    // Clearing the pin, deleting the hook or its connection: the store drops the assignment, and
    // the caller retires it first.
    retireTriggerAssignment(impl, HOOK);
    store.pinTrigger(ADA.id, HOOK, GADGET, null);
    expect(aborted).toEqual([systemGatekeeperFacetName(assignment.credentialRef, 7)]);
    await vi.waitFor(() => expect(forget).toHaveBeenCalledWith(assignment.credentialRef));
    // Nothing to retire is a no-op.
    retireTriggerAssignment(impl, HOOK);
    expect(aborted).toHaveLength(1);
  });

  it("happens when the pin is cleared through the Overseer", async () => {
    let forget = vi.fn(async (_ref: string) => {});
    let { impl, store, aborted, running } = provisionImpl({ forgetSystemCredential: forget });
    let assignment = setWorkflowTriggerAssignment(impl, ADA, HOOK, { gatekeeperId: INFEROPS })!;
    running(assignment.credentialRef);
    let full = Object.assign(impl as object, {
      isSharedConfiguration: async () => false,
      assertGatekeeperUsable: () => {},
      retireTriggerAssignment(this: never, hookId: number) { retireTriggerAssignment(this, hookId); },
      users: {
        idFromString: (id: string) => id,
        get: () => ({ whoami: async () => ADA, recordSharedGadgetOpen: async () => {}, holdsSharedConfiguration: async () => true }),
      },
    });
    let overseer = await openFakeOverseer({}, { role: "build", impl: full });
    await overseer.pinTriggerDefinition(HOOK, null);
    expect(store.assignmentOf(HOOK)).toBeNull();
    expect(aborted).toEqual([systemGatekeeperFacetName(assignment.credentialRef, 7)]);
  });
});

describe("#374 round 3: the assigned connection and what a session hands out", () => {
  it("stops a run at its next call once the assigned connection is no longer bound", async () => {
    let made = host();
    let outcomes: string[] = [];
    made.h.whileRunning(async () => {
      let held: any = await openSystemRunSession(made.h, { type: "gatekeeper", id: INFEROPS }, CALLER);
      outcomes.push(await held.readBoard());
      made.h.unbindConnection();
      outcomes.push(await held.readBoard().then(() => "read", (e: Error) => e.message));
    });
    await runAssignedDelivery(made.h, HOOK, DELIVERY, null, []);
    expect(outcomes).toEqual(["board", SYSTEM_RUN_ENDED]);
  });

  it("kills every capability the session handed out when the run ends", async () => {
    let made = host();
    let sub: any;
    made.h.whileRunning(async () => {
      let held: any = await openSystemRunSession(made.h, { type: "gatekeeper", id: INFEROPS }, CALLER);
      sub = await held.subSession();
      expect(await sub.read()).toBe("sub");
    });
    await runAssignedDelivery(made.h, HOOK, DELIVERY, null, []);
    await expect(sub.read()).rejects.toThrow("The facet was aborted.");
  });

  it("retires every assignment using a removed connection, even one the hook isn't hosted on", async () => {
    let forget = vi.fn(async (_ref: string) => {});
    let { impl, store, aborted, running } = provisionImpl({ forgetSystemCredential: forget });
    // The hook's host is another connection (1); the assignment uses INFEROPS.
    let assignment = setWorkflowTriggerAssignment(impl, ADA, HOOK, { gatekeeperId: INFEROPS })!;
    running(assignment.credentialRef);
    retireAssignmentsUsing(impl, 60);
    expect(store.assignmentOf(HOOK)).not.toBeNull();
    retireAssignmentsUsing(impl, INFEROPS);
    expect(store.assignmentOf(HOOK)).toBeNull();
    expect(aborted).toEqual([systemGatekeeperFacetName(assignment.credentialRef, 7)]);
    await vi.waitFor(() => expect(forget).toHaveBeenCalledWith(assignment.credentialRef));
  });
});

/** An assigned trigger with a run in flight, whose gadget's bindings and records a route can change. */
function assignedWithRun() {
  let forget = vi.fn(async (_ref: string) => {});
  let made = provisionImpl({ forgetSystemCredential: forget });
  let assignment = setWorkflowTriggerAssignment(made.impl, ADA, HOOK, { gatekeeperId: INFEROPS })!;
  made.running(assignment.credentialRef);
  let impl = made.impl as unknown as Record<string, unknown> & { storage: Record<string, { get: (id: number) => unknown }> };
  let setBindings = (bindings: [string, { target: number }][]) => { impl.visibleBindings = () => bindings; };
  return { ...made, impl: made.impl, raw: impl, assignment, forget, setBindings };
}
async function expectRetired(made: ReturnType<typeof assignedWithRun>) {
  retireUnboundAssignments(made.impl);
  expect(made.store.assignmentOf(HOOK)).toBeNull();
  // Its running delivery's facet is aborted, so every capability a session handed out dies.
  expect(made.aborted).toEqual([systemGatekeeperFacetName(made.assignment.credentialRef, 7)]);
  await vi.waitFor(() => expect(made.forget).toHaveBeenCalledWith(made.assignment.credentialRef));
}

describe("#374 round 4: every route that removes the assigned binding retires the assignment", () => {
  it("keeps an assignment whose connection is still bound", () => {
    let made = assignedWithRun();
    retireUnboundAssignments(made.impl);
    expect(made.store.assignmentOf(HOOK)?.credentialRef).toBe(made.assignment.credentialRef);
    expect(made.aborted).toEqual([]);
  });

  // Intended (lead, 2026-11-05): an assignment is tied to the connection, not the binding's name,
  // and a run's env takes the names bound when it loads.
  it("keeps it when the binding is renamed but still targets the assigned connection", () => {
    let made = assignedWithRun();
    made.setBindings([["BOARD", { target: INFEROPS }]]);
    retireUnboundAssignments(made.impl);
    expect(made.store.assignmentOf(HOOK)?.credentialRef).toBe(made.assignment.credentialRef);
    expect(made.aborted).toEqual([]);
    expect(made.forget).not.toHaveBeenCalled();
  });

  it("retires it when the binding to the assigned connection is unbound", async () => {
    let made = assignedWithRun();
    made.setBindings([["MAIL", { target: 60 }]]);
    await expectRetired(made);
  });

  it("retires it when the binding's name is rebound to another connection", async () => {
    let made = assignedWithRun();
    made.setBindings([["INFEROPS", { target: 60 }], ["MAIL", { target: 60 }]]);
    await expectRetired(made);
  });

  it("retires it when the trigger's gadget is deleted", async () => {
    let made = assignedWithRun();
    made.raw.getGadgetRecord = () => { throw new Error("No such workpiece: 3"); };
    made.raw.storage.gadgets = { get: () => undefined };
    await expectRetired(made);
  });

  it("retires it when the trigger's hook is gone", async () => {
    let made = assignedWithRun();
    made.raw.storage.boundHooks = { get: () => undefined };
    await expectRetired(made);
  });
});

// QA on the real runtime (#374): a run's binding is the session wrapper behind a native RPC stub,
// and Workers RPC must find its methods; the unit fakes above never cross RPC.
describe("a run's session over real Workers RPC", () => {
  it("serves the session's methods through a native RPC stub, checking the run is live on every call", async () => {
    let live = true;
    let session = { readBoard: async () => ({ issues: 3 }), createIssue: async (input: { title: string }) => input.title };
    let stub = new RpcStub(revocableSession(session, () => { if (!live) throw new Error(SYSTEM_RUN_ENDED); }) as RpcTarget) as unknown as
        { readBoard(): Promise<{ issues: number }>; createIssue(input: { title: string }): Promise<string> };
    expect(await stub.readBoard()).toEqual({ issues: 3 });
    expect(await stub.createIssue({ title: "Refund 42" })).toBe("Refund 42");
    live = false;
    let refused: unknown;
    try { await stub.readBoard(); } catch (error) { refused = error; }
    expect(String(refused)).toContain(SYSTEM_RUN_ENDED);
  });
});

// The manager, 2026-11-06: assignments are off by default (WORKFLOW_ASSIGNMENTS_ENABLED) until the
// fail-closed follow-up merges. Off, nothing new is assigned or given a key and no run takes the
// assigned path, while clearing and retiring still work so an Admin can always clean up.
describe("WORKFLOW_ASSIGNMENTS_ENABLED off", () => {
  const OFF = { SHARED_CONFIGURATION_GATEKEEPER: "inferops", WORKFLOW_ASSIGNMENTS_ENABLED: "false" };

  it("refuses assigning and giving a key, in fixed words", async () => {
    let { impl, store } = assignmentImpl(OFF);
    expect(() => setWorkflowTriggerAssignment(impl, ADA, HOOK, { gatekeeperId: INFEROPS })).toThrow(WORKFLOW_ASSIGNMENTS_DISABLED);
    expect(store.assignmentOf(HOOK)).toBeNull();
    store.setAssignment(ADA, HOOK, INFEROPS);
    let provision = vi.fn(async () => {});
    (impl as unknown as { env: Record<string, unknown> }).env = { ...OFF, GATEKEEPER_INFEROPS: { provisionSystemCredential: provision } };
    await expect(provisionWorkflowTriggerCredential(impl, ADA, HOOK, KEY)).rejects.toThrow(WORKFLOW_ASSIGNMENTS_DISABLED);
    expect(provision).not.toHaveBeenCalled();
  });

  it("still clears an assignment made before, retiring it", async () => {
    let { impl, store, aborted, running } = assignmentImpl(OFF);
    let before = store.setAssignment(ADA, HOOK, INFEROPS)!;
    running(before.credentialRef);
    expect(setWorkflowTriggerAssignment(impl, ADA, HOOK, null)).toBeNull();
    expect(store.assignmentOf(HOOK)).toBeNull();
    expect(aborted).toEqual([systemGatekeeperFacetName(before.credentialRef, 7)]);
  });

  it("never runs a request through an assignment made before, nor through the gadget's own callback", async () => {
    let { store } = pinnedStore();
    store.setAssignment(ADA, HOOK, INFEROPS);
    let { overseer, gadgetCallback, runSpy } = overseerFor(store, false);
    let invocation = store.beginInvocation("operator", HOOK);
    let refused: unknown;
    try { await overseer.startHook(HOOK, { invocationId: invocation.id }); } catch (error) { refused = error; }
    expect(String(refused)).toContain(WORKFLOW_ASSIGNMENTS_DISABLED);
    expect(runSpy).not.toHaveBeenCalled();
    expect(gadgetCallback.onSchedule).not.toHaveBeenCalled();
    // The request was not taken: it is still the store's to cancel, and no delivery was recorded.
    expect(store.isWaiting(invocation.id)).toBe(true);
  });

  it("reads as disabled, with any assignment made before, so the editor can say so", async () => {
    let off = await assignmentSession("build", true, false);
    off.store.setAssignment(ADA, HOOK, INFEROPS);
    expect(await off.overseer.getTriggerAssignment(HOOK)).toMatchObject({ enabled: false, assignment: { hookId: HOOK } });
    await expect(off.overseer.setTriggerAssignment(HOOK, null)).resolves.toBeNull();
    let on = await assignmentSession("build", true);
    expect(await on.overseer.getTriggerAssignment(HOOK)).toEqual({ enabled: true, assignment: null, retiredAutomatically: false });
  });
});

describe("a request is taken only when its delivery is (#374, review.r2)", () => {
  it("marks the invocation taken when startHook delivers it, and not for a scheduled firing", async () => {
    let { store } = pinnedStore();
    let { overseer, takenInvocations } = overseerFor(store);
    await overseer.startHook(HOOK);
    expect(takenInvocations.size).toBe(0);
    let invocation = store.beginInvocation("operator", HOOK);
    // invokeWorkflowTrigger registers the id it waits on before asking the gatekeeper.
    takenInvocations.set(invocation.id, false);
    await overseer.startHook(HOOK, { invocationId: invocation.id });
    expect(takenInvocations.get(invocation.id)).toBe(true);
  });
});

// FAC-102 follow-up A: an approved write from an assigned run applies only while the assignment that
// proposed it is still the trigger's, its connection still bound, and assignments are on.
describe("whether an assigned run's write may still apply", () => {
  const EXECUTED = { hookId: HOOK, deliveryId: 7, credentialRef: "ref-1" };

  it("is fine while the same assignment holds and the connection is bound, the run having ended", () => {
    let { h } = host();
    expect(h.systemRuns.has(7)).toBe(false);
    expect(assignedActionProblem(h, EXECUTED, INFEROPS, true)).toBeNull();
  });

  it("is refused while assignments are off", () => {
    let { h } = host();
    expect(assignedActionProblem(h, EXECUTED, INFEROPS, false)).toBe(WORKFLOW_ASSIGNMENTS_DISABLED);
  });

  it("is refused once the assignment changed, was retired, the hook went or the connection was unbound", () => {
    let changed = host();
    changed.h.setAssignment({ hookId: HOOK, gatekeeperId: INFEROPS, credentialRef: "ref-2" });
    let retired = host();
    retired.h.setAssignment(null);
    let hookGone = host();
    hookGone.h.deleteHook();
    let unbound = host();
    unbound.h.unbindConnection();
    let otherConnection = host();
    for (let made of [changed, retired, hookGone, unbound]) {
      expect(assignedActionProblem(made.h, EXECUTED, INFEROPS, true)).toBe(ASSIGNED_ACTION_STALE);
    }
    expect(assignedActionProblem(otherConnection.h, EXECUTED, 60, true)).toBe(ASSIGNED_ACTION_STALE);
  });
});

// FAC-102 follow-up B (r1): an automatic retirement leaves a mark that refuses runs on request
// until an Admin acts; a retirement a person chose leaves none.
describe("the mark an automatic retirement leaves", () => {
  it("is left when a refused key can't be forgotten, and an Admin's re-assignment or removal clears it", async () => {
    let forget = vi.fn(async (_ref: string) => { throw new Error("vendor unavailable"); });
    let made = provisionImpl({ forgetSystemCredential: forget, provisionSystemCredential: async () => {} });
    setWorkflowTriggerAssignment(made.impl, ADA, HOOK, { gatekeeperId: INFEROPS });
    made.store.markProvisioned = () => { throw new Error("storage reset"); };
    await provisionWorkflowTriggerCredential(made.impl, ADA, HOOK, KEY).catch(() => {});
    expect(made.store.assignmentOf(HOOK)).toBeNull();
    expect(made.store.autoRetiredOf(HOOK)).toMatchObject({ hookId: HOOK });
    setWorkflowTriggerAssignment(made.impl, ADA, HOOK, { gatekeeperId: INFEROPS });
    expect(made.store.autoRetiredOf(HOOK)).toBeNull();
    made.store.markAutoRetired(HOOK);
    setWorkflowTriggerAssignment(made.impl, ADA, HOOK, null);
    expect(made.store.autoRetiredOf(HOOK)).toBeNull();
  });

  it("isn't left by a retirement a person chose", () => {
    let { impl, store } = assignmentImpl({ SHARED_CONFIGURATION_GATEKEEPER: "inferops" });
    setWorkflowTriggerAssignment(impl, ADA, HOOK, { gatekeeperId: INFEROPS });
    setWorkflowTriggerAssignment(impl, ADA, HOOK, null);
    retireTriggerAssignment(impl, HOOK);
    expect(store.autoRetiredOf(HOOK)).toBeNull();
  });

  it("refuses a request in startHook before it is taken, as neither the service account nor the gadget", async () => {
    let { store } = pinnedStore();
    store.markAutoRetired(HOOK);
    let { overseer, gadgetCallback, runSpy } = overseerFor(store);
    let invocation = store.beginInvocation("operator", HOOK);
    let refused: unknown;
    try { await overseer.startHook(HOOK, { invocationId: invocation.id }); } catch (error) { refused = error; }
    expect(String(refused)).toContain(TRIGGER_AUTO_RETIRED);
    expect(runSpy).not.toHaveBeenCalled();
    expect(gadgetCallback.onSchedule).not.toHaveBeenCalled();
    expect(store.isWaiting(invocation.id)).toBe(true);
  });
});

// r1's LOW on the flag recheck: a delivery arriving after its invokeTrigger call returned can't
// leave its id behind.
describe("a late delivery", () => {
  it("records nothing for an invocation no invokeTrigger call is waiting on", async () => {
    let { store } = pinnedStore();
    let { overseer, takenInvocations } = overseerFor(store);
    let invocation = store.beginInvocation("operator", HOOK);
    await overseer.startHook(HOOK, { invocationId: invocation.id });
    expect(takenInvocations.has(invocation.id)).toBe(false);
    let waited = store.beginInvocation("operator", HOOK);
    takenInvocations.set(waited.id, false);
    await overseer.startHook(HOOK, { invocationId: waited.id });
    expect(takenInvocations.get(waited.id)).toBe(true);
  });
});
