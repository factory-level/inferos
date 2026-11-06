// Running a configured workflow on request (FAC-102, inferops ADR 0011 S5, S6, N1, N4): a builder
// sets a control on a pinned trigger naming who may ask it to run; a listed person's request is
// checked on the server and only then handed to the trigger's gatekeeper, as a server-minted
// invocation with nothing of the caller's in it. Invoking gives the caller nothing else: no access
// to the workflow, its trigger, its bindings or its configuration. The run itself is the trigger's
// own delivery (startHook), recorded with who asked as a claim, never as authority.
import { describe, expect, it, vi } from "vitest";
import { invokeWorkflowTrigger, makeOverseerStorage, WORKFLOW_INVOKE_REFUSED } from "../src/overseer.js";
import { WorkspaceWorkflowDefinitionStore } from "../src/workflow-definition-store.js";
import { openFakeOverseer } from "./fixtures.js";
import { makeMockStorage } from "./mock-storage.js";

const ADA = { type: "user" as const, id: "ada-profile", name: "Ada" };
const OPERATOR = "viewer-id-profile";
const BUILDER = "owner-id-profile";
const GADGET = 3;
const HOOK = 11;
const commit = (n: number) => n.toString(16).padStart(40, "0");
const headOf = (id: number) => (id === GADGET ? commit(1) : undefined);
const everyoneBuilds = () => true;

/** A workspace store with one published definition pinned to trigger HOOK. */
function pinned() {
  let durable = makeMockStorage();
  let storage = makeOverseerStorage(durable);
  let store = new WorkspaceWorkflowDefinitionStore(durable, storage);
  let saved = store.save(ADA, { title: "Refund", gadgetId: GADGET }, headOf);
  store.publish(ADA, saved.id, 1);
  store.pinTrigger(ADA.id, HOOK, GADGET, { definitionId: saved.id, revision: 1 });
  return { durable, storage, store, definitionId: saved.id };
}

describe("a trigger's control", () => {
  it("is set only on a pinned trigger, names who may run it, and goes with the pin", () => {
    let { store, definitionId } = pinned();
    expect(() => store.setControl(ADA, 12, { label: "Run", invokers: [OPERATOR] }))
      .toThrow("Only a trigger pinned to a workflow definition revision can have a control.");
    let control = store.setControl(ADA, HOOK, { label: " Issue refund ", invokers: [OPERATOR, OPERATOR] });
    expect(control).toMatchObject({
      hookId: HOOK, label: "Issue refund", invokers: [OPERATOR],
      definition: { definitionId, revision: 1 }, configuredBy: ADA,
    });
    expect(() => store.setControl(ADA, HOOK, { label: "", invokers: [OPERATOR] })).toThrow(TypeError);
    expect(() => store.setControl(ADA, HOOK, { label: "Run", invokers: [] })).toThrow(TypeError);
    // A builder sees every control; a person sees only the controls listing them, and only their label.
    expect(store.controls(null)).toHaveLength(1);
    expect(store.controls(OPERATOR)).toEqual([{ hookId: HOOK, label: "Issue refund" }]);
    expect(store.controls("someone-else")).toEqual([]);
    store.pinTrigger(ADA.id, HOOK, GADGET, null);
    expect(store.controls(null)).toEqual([]);
  });
});

describe("invoking a trigger", () => {
  it("admits only a listed person on a trigger that is still pinned, minting the invocation", () => {
    let { store, definitionId } = pinned();
    expect(() => store.beginInvocation(OPERATOR, HOOK)).toThrow("You can't run this trigger.");
    store.setControl(ADA, HOOK, { label: "Issue refund", invokers: [OPERATOR] });
    expect(() => store.beginInvocation("someone-else", HOOK)).toThrow("You can't run this trigger.");
    let invocation = store.beginInvocation(OPERATOR, HOOK);
    expect(invocation).toMatchObject({ hookId: HOOK, definitionId, revision: 1 });
    expect(invocation.id).toMatch(/^[0-9a-f-]{36}$/);
    store.pinTrigger(ADA.id, HOOK, GADGET, null);
    expect(() => store.beginInvocation(OPERATOR, HOOK)).toThrow("You can't run this trigger.");
  });

  it("records the run of an admitted invocation with who asked, once, and refuses any other", () => {
    let { store } = pinned();
    store.setControl(ADA, HOOK, { label: "Issue refund", invokers: [OPERATOR] });
    let invocation = store.beginInvocation(OPERATOR, HOOK);
    // A forged or reused invocation id never starts a run.
    expect(() => store.fire(HOOK, GADGET, headOf, everyoneBuilds, "not-an-invocation"))
      .toThrow("That run request is unknown or already ran.");
    let delivery = store.fire(HOOK, GADGET, headOf, everyoneBuilds, invocation.id);
    expect(delivery?.invocation).toEqual({ id: invocation.id, requestedBy: OPERATOR });
    expect(() => store.fire(HOOK, GADGET, headOf, everyoneBuilds, invocation.id))
      .toThrow("That run request is unknown or already ran.");
    // Another trigger can't take this one's invocation.
    let other = store.beginInvocation(OPERATOR, HOOK);
    expect(() => store.fire(12, GADGET, headOf, everyoneBuilds, other.id)).toThrow();
    // A scheduled firing records no invocation.
    expect(store.fire(HOOK, GADGET, headOf, everyoneBuilds)?.invocation).toBeUndefined();
  });
});

describe("through the Overseer", () => {

  async function session(role: "build" | "use", opts: { invoke?: (...args: unknown[]) => Promise<void>;
                                                          canBuild?: boolean;
                                                          mayInvoke?: () => Promise<boolean>;
                                                          assignmentsEnabled?: boolean } = {}) {
    let { durable, storage, store } = pinned();
    store.setControl(ADA, HOOK, { label: "Issue refund", invokers: [OPERATOR] });
    let invoke = vi.fn(opts.invoke ?? (async () => {}));
    let hook = { id: HOOK, gadgetId: GADGET, gatekeeperId: 50, enabled: true, controller: { invoke } };
    let takenInvocations = new Map<string, boolean>();
    let impl = {
      takenInvocations,
      env: {
        ...(opts.canBuild === undefined && opts.mayInvoke === undefined ? {} : { SHARED_CONFIGURATION_GATEKEEPER: "inferops" }),
        ...(opts.assignmentsEnabled ? { WORKFLOW_ASSIGNMENTS_ENABLED: "true" } : {}),
      },
      isSharedConfiguration: async () => true,
      workflowDefinitionStore: () => store,
      getGadgetHead: headOf,
      defaultGadgetId: GADGET,
      assertGatekeeperUsable: () => {},
      invokeTrigger(this: never, userId: string, profileId: string, hookId: number) {
        return invokeWorkflowTrigger(this, userId, profileId, hookId);
      },
      storage: Object.assign(storage, {
        containsRestrictedData: { get: () => false },
        title: { get: () => "Test Workspace" },
        operateSession: { get: () => false },
        boundHooks: { get: (id: number) => (id === HOOK ? hook : undefined), list: () => [hook] },
        gatekeepers: { get: () => undefined },
      }),
      users: {
        idFromString: (id: string) => id,
        get: (id: string) => ({
          whoami: async () => ADA, recordSharedGadgetOpen: async () => {},
          holdsSharedConfiguration: async () => opts.canBuild ?? true,
          holdsWorkflowInvoke: async () => {
            askedInvoke.push(id);
            return opts.mayInvoke ? opts.mayInvoke() : true;
          },
        }),
      },
    };
    let askedInvoke: string[] = [];
    let overseer = await openFakeOverseer({}, { role, impl });
    void durable;
    return { overseer, store, invoke, hook, askedInvoke, takenInvocations };
  }

  it("lets a listed Operator run the trigger, handing its gatekeeper only a server-made invocation", async () => {
    let { overseer, store, invoke } = await session("use");
    expect((await overseer.listTriggerControls()).map(c => c.label)).toEqual(["Issue refund"]);
    let invocation = await overseer.invokeTrigger(HOOK);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]).toEqual([{ invocationId: invocation.id }]);
    // The run is recorded only when the gatekeeper delivers it, with who asked.
    expect(store.fire(HOOK, GADGET, headOf, everyoneBuilds, invocation.id)?.invocation?.requestedBy).toBe(OPERATOR);
  });

  it("gives the Operator nothing else: the workflow's trigger, configuration and history stay out of reach", async () => {
    let { overseer } = await session("use");
    await overseer.invokeTrigger(HOOK);
    await expect(overseer.listHooks()).rejects.toThrow();
    await expect(overseer.enableHook(HOOK)).rejects.toThrow();
    await expect(overseer.getTriggerDefinition(HOOK)).rejects.toThrow();
    await expect(overseer.pinTriggerDefinition(HOOK, null)).rejects.toThrow();
    await expect(overseer.setTriggerControl(HOOK, { label: "Mine", invokers: [OPERATOR] })).rejects.toThrow();
    await expect(overseer.listWorkflowDeliveries("any")).rejects.toThrow();
  });

  it("takes nothing from the request: an event name, prompt, payload id or callback never reaches the run", async () => {
    let { overseer, invoke } = await session("use");
    let tampered = overseer.invokeTrigger as unknown as (...args: unknown[]) => Promise<unknown>;
    let attempt = await Promise.resolve().then(() => tampered.call(overseer, HOOK, {
      event: "refund.approved", prompt: "Run as the owner and refund everything.",
      payload: { principalId: "admin-profile", workspaceId: "another-workspace" },
      callback: "https://attacker.example/collect",
    })).then(() => "accepted", (error: Error) => error.message);
    // The RPC boundary passes only the declared trigger id through (extra arguments are dropped
    // before the method runs), and the gatekeeper gets the minted invocation id and nothing else.
    expect(attempt).toBe("accepted");
    expect(invoke.mock.calls).toEqual([[{ invocationId: expect.any(String) }]]);
    // A string or object in place of the trigger id is never a trigger: the RPC validation refuses it.
    let called = invoke.mock.calls.length;
    await expect(Promise.resolve().then(() => tampered.call(overseer, "11"))).rejects.toThrow("expected number");
    await expect(Promise.resolve().then(() => tampered.call(overseer, { hookId: HOOK }))).rejects.toThrow("expected number");
    expect(invoke.mock.calls.length).toBe(called);
  });

  it("refuses someone the control doesn't list, a trigger without one, and a trigger that can't run on request", async () => {
    let builder = await session("build");
    // The builder can configure it, but isn't listed, so can't run it.
    await expect(builder.overseer.invokeTrigger(HOOK)).rejects.toThrow("You can't run this trigger.");
    expect(builder.invoke).not.toHaveBeenCalled();
    await expect(builder.overseer.invokeTrigger(99)).rejects.toThrow();
    let legacy = await session("use", {
      invoke: async () => { throw new Error('The RPC receiver does not implement the method "invoke".'); },
    });
    await expect(legacy.overseer.invokeTrigger(HOOK)).rejects.toThrow("This trigger can't be run on request.");
  });

  // QA on #374, then review.r2 twice: whether the request was taken (startHook delivered it) is
  // recorded, never read from the error's words or inferred from the request having gone. Taken,
  // a failure is the run's own and passes through; otherwise the invoker gets fixed words only.
  const refusalOf = async (run: () => Promise<unknown>) => {
    let refused: unknown;
    try { await run(); } catch (error) { refused = error; }
    return String(refused);
  };

  it.for([
    'The RPC receiver does not implement the method "readBoard".',
    'The RPC receiver does not implement the method "invoke".',
    "env.BOARD.invoke is not a function",
  ])("passes a taken run's own failure through unchanged: %s", async message => {
    let made: Awaited<ReturnType<typeof session>> | undefined;
    made = await session("use", {
      invoke: async (...args: unknown[]) => {
        made!.takenInvocations.set((args[0] as { invocationId: string }).invocationId, true);
        throw new Error(message);
      },
    });
    let refused = await refusalOf(() => made!.overseer.invokeTrigger(HOOK));
    expect(refused).toContain(message);
    expect(refused).not.toContain("can't be run on request");
  });

  it("gives fixed words, never the raw error, when a change dropped the request before it was taken", async () => {
    let made: Awaited<ReturnType<typeof session>> | undefined;
    const internal = "internal: upstream reset at gatekeeper-host-7 (stack: x.ts:1)";
    for (const [message, words] of [
      ['The RPC receiver does not implement the method "invoke".', "This trigger can't be run on request."],
      [internal, "This trigger couldn't be run just now."],
    ] as const) {
      made = await session("use", {
        invoke: async () => {
          // A pin, control or assignment change lands meanwhile and drops the waiting request.
          made!.store.setControl(ADA, HOOK, { label: "Issue refund", invokers: [OPERATOR] });
          throw new Error(message);
        },
      });
      let refused = await refusalOf(() => made!.overseer.invokeTrigger(HOOK));
      expect(refused).toContain(words);
      expect(refused).not.toContain("upstream reset");
      expect(refused).not.toContain("does not implement");
    }
  });

  // Re-QA on #374: a fixed refusal must not carry the error it replaced. RPC serialises `cause`, so
  // a refusal built with one handed the invoker the gatekeeper's own words after all.
  it("never sends the replaced error along with a fixed refusal", async () => {
    const internal = "This scheduled task isn't running, so it can't be run now.";
    for (const message of ['The RPC receiver does not implement the method "invoke".', internal]) {
      let made = await session("use", { invoke: async () => { throw new Error(message); } });
      let refused: unknown;
      try { await made.overseer.invokeTrigger(HOOK); } catch (error) { refused = error; }
      expect(refused).toBeInstanceOf(Error);
      expect(Object.hasOwn(refused as object, "cause")).toBe(false);
      expect(JSON.stringify(refused, Object.getOwnPropertyNames(refused))).not.toContain(message);
    }
  });

  // FAC-102 follow-up B: a trigger whose assignment was retired automatically stays refused until an
  // Admin re-assigns it or removes the assignment.
  it("refuses at once, asking no gatekeeper, a trigger whose assignment was retired automatically", async () => {
    let marked = await session("use", { assignmentsEnabled: true });
    marked.store.markAutoRetired(HOOK);
    expect(await refusalOf(() => marked.overseer.invokeTrigger(HOOK))).toContain(
      "This trigger's service-account assignment was retired automatically. An Admin needs to assign it again or remove it.");
    expect(marked.invoke).not.toHaveBeenCalled();
  });

  it("refuses at once, asking no gatekeeper, a trigger assigned while assignments are off", async () => {
    let off = await session("use");
    off.store.setAssignment(ADA, HOOK, 50);
    expect(await refusalOf(() => off.overseer.invokeTrigger(HOOK))).toContain("Workflow assignments aren't enabled on this instance.");
    expect(off.invoke).not.toHaveBeenCalled();
    let on = await session("use", { assignmentsEnabled: true });
    on.store.setAssignment(ADA, HOOK, 50);
    await expect(on.overseer.invokeTrigger(HOOK)).resolves.toMatchObject({ hookId: HOOK });
  });

  it("refuses to run a disabled trigger", async () => {
    let { overseer, hook, invoke } = await session("use");
    hook.enabled = false;
    await expect(overseer.invokeTrigger(HOOK)).rejects.toThrow("Hook has been deleted or disabled.");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("lets only someone who may build set a control, and shows them every control", async () => {
    let builder = await session("build");
    let control = await builder.overseer.setTriggerControl(HOOK, { label: "Refund now", invokers: [OPERATOR, BUILDER] });
    expect(control?.invokers).toEqual([OPERATOR, BUILDER]);
    expect((await builder.overseer.listTriggerControls()).map(c => c.label)).toEqual(["Refund now"]);
    // Without the deployment's build authority a shared workspace opens read-only, which refuses it.
    let demoted = await session("build", { canBuild: false });
    await expect(demoted.overseer.setTriggerControl(HOOK, null)).rejects.toThrow(/only has permission to use/);
  });
});

describe("a second workspace", () => {
  it("has none of the first's controls or invocations", () => {
    let first = pinned();
    first.store.setControl(ADA, HOOK, { label: "Issue refund", invokers: [OPERATOR] });
    let invocation = first.store.beginInvocation(OPERATOR, HOOK);
    let second = pinned();
    expect(() => second.store.beginInvocation(OPERATOR, HOOK)).toThrow("You can't run this trigger.");
    expect(() => second.store.fire(HOOK, GADGET, headOf, everyoneBuilds, invocation.id))
      .toThrow("That run request is unknown or already ran.");
  });
});

// FAC-102 round 2 (review on #340).
describe("an invocation stays on the revision it was admitted for", () => {
  /** `pinned()` with a second saved revision of the same definition, for repinning. */
  function twoRevisions() {
    let base = pinned();
    let heads = new Map([[GADGET, commit(1)]]);
    let at = (id: number) => heads.get(id);
    heads.set(GADGET, commit(2));
    base.store.save(ADA, { id: base.definitionId, title: "Refund", gadgetId: GADGET }, at);
    base.store.publish(ADA, base.definitionId, 2);
    base.store.setControl(ADA, HOOK, { label: "Issue refund", invokers: [OPERATOR] });
    return { ...base, at };
  }

  it("is dropped when the trigger is repinned, so the request never runs the other revision", () => {
    let { store, definitionId, at } = twoRevisions();
    let invocation = store.beginInvocation(OPERATOR, HOOK);
    expect(invocation.revision).toBe(1);
    store.pinTrigger(ADA.id, HOOK, GADGET, { definitionId, revision: 2 });
    expect(() => store.fire(HOOK, GADGET, at, everyoneBuilds, invocation.id))
      .toThrow("That run request is unknown or already ran.");
  });

  it("is refused at delivery when the pin moved by any other path", () => {
    let { store, storage, definitionId, at } = twoRevisions();
    let invocation = store.beginInvocation(OPERATOR, HOOK);
    // A pin moved without going through pinTrigger still can't take the request to revision 2.
    storage.workflowTriggerPins.put({ hookId: HOOK, definitionId, revision: 2 });
    expect(() => store.fire(HOOK, GADGET, at, everyoneBuilds, invocation.id))
      .toThrow("That run request was for another revision of this workflow. Ask again.");
    expect(store.deliveries(ADA.id, definitionId)).toEqual([]);
  });

  it("is dropped when the control changes or is cleared", () => {
    let { store } = twoRevisions();
    let first = store.beginInvocation(OPERATOR, HOOK);
    store.setControl(ADA, HOOK, { label: "Refund now", invokers: [OPERATOR] });
    expect(() => store.fire(HOOK, GADGET, headOf, everyoneBuilds, first.id)).toThrow("unknown or already ran");
    let second = store.beginInvocation(OPERATOR, HOOK);
    store.setControl(ADA, HOOK, null);
    expect(() => store.fire(HOOK, GADGET, headOf, everyoneBuilds, second.id)).toThrow("unknown or already ran");
  });

  it("expires if it isn't delivered within a few minutes", () => {
    vi.useFakeTimers();
    try {
      let { store } = pinned();
      store.setControl(ADA, HOOK, { label: "Issue refund", invokers: [OPERATOR] });
      let invocation = store.beginInvocation(OPERATOR, HOOK);
      vi.advanceTimersByTime(6 * 60_000);
      expect(() => store.fire(HOOK, GADGET, headOf, everyoneBuilds, invocation.id))
        .toThrow("That run request expired. Ask again.");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("how often a trigger runs on request", () => {
  it("refuses a person past their rate, saying when to try again, and others keep theirs", () => {
    vi.useFakeTimers();
    try {
      let { store } = pinned();
      store.setControl(ADA, HOOK, { label: "Issue refund", invokers: [OPERATOR, BUILDER] });
      for (let i = 0; i < 3; i++) store.beginInvocation(OPERATOR, HOOK);
      expect(() => store.beginInvocation(OPERATOR, HOOK))
        .toThrow(/^You've run this trigger 3 times in the last 10 minutes\. Try again in \d+ minutes?\.$/);
      expect(() => store.beginInvocation(BUILDER, HOOK)).not.toThrow();
      vi.advanceTimersByTime(10 * 60_000 + 1);
      expect(() => store.beginInvocation(OPERATOR, HOOK)).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses everyone past the trigger's own hourly rate", () => {
    vi.useFakeTimers();
    try {
      let { store } = pinned();
      let invokers = Array.from({ length: 10 }, (_, i) => `person-${i}`);
      store.setControl(ADA, HOOK, { label: "Issue refund", invokers });
      // Each run is delivered (its waiting request cleared), so only the rate can refuse the next.
      for (let i = 0; i < 20; i++) {
        store.cancelInvocation(store.beginInvocation(invokers[i % 10]!, HOOK).id);
        vi.advanceTimersByTime(60_000);
      }
      expect(() => store.beginInvocation("person-0", HOOK))
        .toThrow(/^This trigger has run on request 20 times in the last hour\. Try again in \d+ minutes?\.$/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("what an invoker sees, and what reaches the gatekeeper", () => {
  it("shows an invoker only the control's label, never who configured it or what it runs", () => {
    let { store } = pinned();
    store.setControl(ADA, HOOK, { label: "Issue refund", invokers: [OPERATOR, BUILDER] });
    expect(store.controls(OPERATOR)).toEqual([{ hookId: HOOK, label: "Issue refund" }]);
  });

  it("passes the gatekeeper only the invocation id, even when called directly with more", async () => {
    let { store } = pinned();
    store.setControl(ADA, HOOK, { label: "Issue refund", invokers: [OPERATOR] });
    let invoke = vi.fn(async (_request: unknown) => {});
    let hook = { id: HOOK, gadgetId: GADGET, gatekeeperId: 50, enabled: true, controller: { invoke } };
    let impl = {
      env: {}, storage: { boundHooks: { get: () => hook } }, assertGatekeeperUsable: () => {},
      workflowDefinitionStore: () => store, takenInvocations: new Map<string, boolean>(),
    };
    let direct = invokeWorkflowTrigger as unknown as (...args: unknown[]) => Promise<unknown>;
    await direct(impl, "viewer-id", OPERATOR, HOOK, { event: "x", prompt: "y", payload: { principalId: "z" }, callback: "https://e.example" });
    expect(invoke.mock.calls).toEqual([[{ invocationId: expect.any(String) }]]);
  });
});

// The harness for the invoker's own grant: a pinned trigger whose control lists OPERATOR.
const OPS_BOARD = "inferops://acme.operations/project/board/OPS";
const SALES_BOARD = "inferops://acme.sales/project/board/SALES";
/** The connections the harness's gadget can bind: two InferOps boards and a mail account. */
const CONNECTIONS: Record<number, { vendorId: string; resourceUrl: string }> = {
  50: { vendorId: "inferops", resourceUrl: OPS_BOARD },
  51: { vendorId: "inferops", resourceUrl: SALES_BOARD },
  60: { vendorId: "mail", resourceUrl: "mail://ops" },
};

async function invokeSession(mayInvoke?: (resourceUrl: string) => Promise<boolean>,
                             bindings: [string, { target: number }][] = [["BOARD", { target: 50 }]]) {
  let { store } = pinned();
  store.setControl(ADA, HOOK, { label: "Issue refund", invokers: [OPERATOR] });
  let invoke = vi.fn(async () => {});
  let hook = { id: HOOK, gadgetId: GADGET, gatekeeperId: 50, enabled: true, controller: { invoke } };
  let askedInvoke: string[] = [];
  let impl = {
    env: mayInvoke ? { SHARED_CONFIGURATION_GATEKEEPER: "inferops" } : {},
    takenInvocations: new Map<string, boolean>(),
    isSharedConfiguration: async () => true,
    workflowDefinitionStore: () => store,
    getGadgetHead: headOf,
    defaultGadgetId: GADGET,
    assertGatekeeperUsable: () => {},
    getGadgetRecord: () => ({}),
    visibleBindings: () => bindings,
    storage: Object.assign(makeOverseerStorage(makeMockStorage()), {
      containsRestrictedData: { get: () => false },
      title: { get: () => "Test Workspace" },
      operateSession: { get: () => false },
      boundHooks: { get: (id: number) => (id === HOOK ? hook : undefined), list: () => [hook] },
      gatekeepers: {
        get: (id: number) => CONNECTIONS[id] && {
          creationSpec: { type: "gatekeeper", typeUrlPattern: "x", ...CONNECTIONS[id] },
        },
      },
    }),
    users: {
      idFromString: (id: string) => id,
      get: (id: string) => ({
        whoami: async () => ADA, recordSharedGadgetOpen: async () => {},
        holdsSharedConfiguration: async () => true,
        holdsWorkflowInvoke: async (resourceUrl: string) => {
          askedInvoke.push(`${id} ${resourceUrl}`);
          return mayInvoke ? mayInvoke(resourceUrl) : true;
        },
      }),
    },
  };
  (impl as Record<string, unknown>).invokeTrigger = function (this: never, ...args: unknown[]) {
    return (invokeWorkflowTrigger as (...a: unknown[]) => unknown).call(undefined, this, ...args);
  };
  let overseer = await openFakeOverseer({}, { role: "use", impl });
  return { overseer, store, invoke, askedInvoke };
}

describe("the invoker's own InferOps grant (workflow:invoke, inferops ADR 0011 D3)", () => {
  it("asks about the workflow's own InferOps board, read from its connection's record, nothing else", async () => {
    let { overseer, askedInvoke } = await invokeSession(async () => true,
        [["BOARD", { target: 50 }], ["MAIL", { target: 60 }]]);
    await overseer.invokeTrigger(HOOK);
    expect(askedInvoke).toEqual([`viewer-id ${OPS_BOARD}`]);
  });

  it("refuses a workflow with no InferOps connection to scope it, asking nothing", async () => {
    let { overseer, invoke, askedInvoke } = await invokeSession(async () => true, [["MAIL", { target: 60 }]]);
    await expect(overseer.invokeTrigger(HOOK)).rejects.toThrow(WORKFLOW_INVOKE_REFUSED);
    expect(askedInvoke).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("needs a yes for every InferOps board the workflow acts on", async () => {
    let { overseer, invoke, askedInvoke } = await invokeSession(async url => url === OPS_BOARD,
        [["OPS", { target: 50 }], ["SALES", { target: 51 }]]);
    await expect(overseer.invokeTrigger(HOOK)).rejects.toThrow(WORKFLOW_INVOKE_REFUSED);
    expect(askedInvoke).toEqual([`viewer-id ${OPS_BOARD}`, `viewer-id ${SALES_BOARD}`]);
    expect(invoke).not.toHaveBeenCalled();
  });


  it("refuses a listed Operator who doesn't hold it, before anything is minted or handed on", async () => {
    let { overseer, store, invoke, askedInvoke } = await invokeSession(async () => false);
    await expect(overseer.invokeTrigger(HOOK)).rejects.toThrow(WORKFLOW_INVOKE_REFUSED);
    expect(invoke).not.toHaveBeenCalled();
    // Asked about the person in this session, with their own account.
    expect(askedInvoke).toEqual([`viewer-id ${OPS_BOARD}`]);
    // Nothing was minted: the per-person rate still has all its runs.
    for (let i = 0; i < 3; i++) store.beginInvocation(OPERATOR, HOOK);
  });

  it("lets a listed Operator who holds it run the trigger", async () => {
    let { overseer, invoke } = await invokeSession(async () => true);
    let invocation = await overseer.invokeTrigger(HOOK);
    expect(invoke.mock.calls).toEqual([[{ invocationId: invocation.id }]]);
  });

  it("asks again at every request, so a removed grant stops the next run", async () => {
    let holds = true;
    let { overseer, invoke } = await invokeSession(async () => holds);
    await overseer.invokeTrigger(HOOK);
    holds = false;
    await expect(overseer.invokeTrigger(HOOK)).rejects.toThrow(WORKFLOW_INVOKE_REFUSED);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("refuses when the grant can't be read, and mints nothing", async () => {
    // The person's user object turns any failed answer into this refusal (user.ts holdsWorkflowInvoke).
    let { overseer, invoke } = await invokeSession(async () => {
      throw new Error("Couldn't check whether you may run workflows. Try again.");
    });
    await expect(overseer.invokeTrigger(HOOK)).rejects.toThrow("Couldn't check whether you may run workflows. Try again.");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("is not enough alone: a person the control doesn't list is refused even when they hold it", async () => {
    let builder = await (async () => {
      let made = await invokeSession(async () => true);
      return made;
    })();
    // The use session is OPERATOR's; drop them from the list so only the grant would admit them.
    builder.store.setControl(ADA, HOOK, { label: "Issue refund", invokers: [BUILDER] });
    await expect(builder.overseer.invokeTrigger(HOOK)).rejects.toThrow();
    expect(builder.invoke).not.toHaveBeenCalled();
  });

  it("isn't asked where the deployment names no service for it", async () => {
    let { overseer, invoke, askedInvoke } = await invokeSession(undefined);
    await overseer.invokeTrigger(HOOK);
    expect(askedInvoke).toEqual([]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
