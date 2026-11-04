// Running a configured workflow on request (FAC-102, inferops ADR 0011 S5, S6, N1, N4): a builder
// sets a control on a pinned trigger naming who may ask it to run; a listed person's request is
// checked on the server and only then handed to the trigger's gatekeeper, as a server-minted
// invocation with nothing of the caller's in it. Invoking gives the caller nothing else: no access
// to the workflow, its trigger, its bindings or its configuration. The run itself is the trigger's
// own delivery (startHook), recorded with who asked as a claim, never as authority.
import { describe, expect, it, vi } from "vitest";
import { invokeWorkflowTrigger, makeOverseerStorage } from "../src/overseer.js";
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
    // A builder sees every control; a person sees only the controls listing them, as the only invoker.
    expect(store.controls(null)).toHaveLength(1);
    expect(store.controls(OPERATOR).map(c => c.invokers)).toEqual([[OPERATOR]]);
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
                                                          canBuild?: boolean } = {}) {
    let { durable, storage, store } = pinned();
    store.setControl(ADA, HOOK, { label: "Issue refund", invokers: [OPERATOR] });
    let invoke = vi.fn(opts.invoke ?? (async () => {}));
    let hook = { id: HOOK, gadgetId: GADGET, gatekeeperId: 50, enabled: true, controller: { invoke } };
    let impl = {
      env: opts.canBuild === undefined ? {} : { SHARED_CONFIGURATION_GATEKEEPER: "inferops" },
      isSharedConfiguration: async () => true,
      workflowDefinitionStore: () => store,
      getGadgetHead: headOf,
      defaultGadgetId: GADGET,
      assertGatekeeperUsable: () => {},
      invokeTrigger(this: never, profileId: string, hookId: number) { return invokeWorkflowTrigger(this, profileId, hookId); },
      storage: Object.assign(storage, {
        containsRestrictedData: { get: () => false },
        title: { get: () => "Test Workspace" },
        operateSession: { get: () => false },
        boundHooks: { get: (id: number) => (id === HOOK ? hook : undefined), list: () => [hook] },
        gatekeepers: { get: () => undefined },
      }),
      users: {
        idFromString: (id: string) => id,
        get: () => ({
          whoami: async () => ADA, recordSharedGadgetOpen: async () => {},
          holdsSharedConfiguration: async () => opts.canBuild ?? true,
        }),
      },
    };
    let overseer = await openFakeOverseer({}, { role, impl });
    void durable;
    return { overseer, store, invoke, hook };
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
