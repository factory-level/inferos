// FAC-122: one owner-maintained workflow definition shared with named accounts (profile ids, never
// email addresses) to read, run or edit it. Rights live on the definition, beside it in the
// workspace's own storage: a share grants the definition only, never a record, and running still
// needs the trigger's run control, the person's InferOps `workflow:invoke` and the run's company.
// Revoking a share or a right stops the next invocation, and a run already admitted at its next
// protected point. The audience rule (who reads and runs a published definition beyond its owner
// and the people it is shared with) is one switchable function; both values are covered.
import { describe, expect, it, vi } from "vitest";
import { MAX_WORKFLOW_DEFINITION_SHARES } from "@gadgets/workshop-shared/workflow-definition";
import {
  invokeWorkflowTrigger, makeOverseerStorage, requireRunRequester, RUN_REQUESTER_REVOKED, WORKFLOW_INVOKE_REFUSED,
} from "../src/overseer.js";
import {
  CANNOT_RUN, SHARED_ONLY_AUDIENCE, WORKSPACE_AUDIENCE, WorkspaceWorkflowDefinitionStore, type WorkflowDefinitionAudience,
} from "../src/workflow-definition-store.js";
import { openFakeOverseer } from "./fixtures.js";
import { makeMockStorage } from "./mock-storage.js";

const ADA = { type: "user" as const, id: "ada-profile", name: "Ada" };
const BEN = { type: "user" as const, id: "ben-profile", name: "Ben" };
const CARA = { type: "user" as const, id: "cara-profile", name: "Cara" };
const GADGET = 3;
const HOOK = 11;
const commit = (n: number) => n.toString(16).padStart(40, "0");
const READ = { read: true, run: false, edit: false };
const RUN = { read: true, run: true, edit: false };
const EDIT = { read: true, run: false, edit: true };
type Role = "build" | "use" | null;

/** One workspace: Ada's definition published at revision 1, then an unpublished revision 2. */
function workspace(audience: WorkflowDefinitionAudience = SHARED_ONLY_AUDIENCE) {
  let durable = makeMockStorage();
  let storage = makeOverseerStorage(durable);
  let store = new WorkspaceWorkflowDefinitionStore(durable, storage, undefined, audience);
  let head = commit(1);
  let headOf = (id: number) => (id === GADGET ? head : undefined);
  let saved = store.save(ADA, { title: "Refund", gadgetId: GADGET }, headOf, "build");
  store.publish(ADA, saved.id, 1);
  head = commit(2);
  store.save(ADA, { id: saved.id, title: "Refund", gadgetId: GADGET }, headOf, "build");
  return { durable, storage, store, id: saved.id, headOf, setHead: (n: number) => { head = commit(n); } };
}

describe("sharing a definition", () => {
  it("is its owner's, by account, only with collaborators, and edit only with someone who builds", () => {
    let { store, id } = workspace();
    expect(store.share(ADA, id, BEN.id, RUN, "use")).toEqual([
      expect.objectContaining({ definitionId: id, profileId: BEN.id, rights: RUN, sharedBy: ADA }),
    ]);
    // Someone it is shared with can't share it on.
    expect(() => store.share(BEN, id, CARA.id, READ, "use")).toThrow("Workflow definition not found.");
    expect(() => store.share(ADA, id, "cara@example.com", READ, "use")).toThrow("account, not an address");
    expect(() => store.share(ADA, id, CARA.id, READ, null)).toThrow("only with someone who can open this workspace");
    expect(() => store.share(ADA, id, CARA.id, EDIT, "use")).toThrow("Only someone who can build");
    expect(() => store.share(ADA, id, ADA.id, READ, "build")).toThrow("already own");
    expect(() => store.share(ADA, id, CARA.id, { read: false, run: false, edit: false }, "use")).toThrow(TypeError);
    // run and edit each include read.
    expect(store.share(ADA, id, CARA.id, { edit: true }, "build").find(s => s.profileId === CARA.id)?.rights).toEqual(EDIT);
    expect(store.shares(ADA, id).map(s => s.profileId)).toEqual([BEN.id, CARA.id]);
    expect(() => store.shares(BEN, id)).toThrow("Workflow definition not found.");
    // Null stops sharing.
    expect(store.share(ADA, id, BEN.id, null, "use").map(s => s.profileId)).toEqual([CARA.id]);
  });

  it(`holds at most ${MAX_WORKFLOW_DEFINITION_SHARES} people`, () => {
    let { store, id } = workspace();
    for (let i = 0; i < MAX_WORKFLOW_DEFINITION_SHARES; i++) store.share(ADA, id, `p${i}`, READ, "use");
    expect(() => store.share(ADA, id, "one-more", READ, "use")).toThrow(`at most ${MAX_WORKFLOW_DEFINITION_SHARES}`);
    // Changing an existing share is not adding one.
    expect(store.share(ADA, id, "p0", RUN, "use")).toHaveLength(MAX_WORKFLOW_DEFINITION_SHARES);
  });
});

describe("what a share shows (acceptance 1)", () => {
  it("shows a reader only the published revision, never the owner's unpublished edit, and marks it shared", () => {
    let { store, id } = workspace();
    expect(store.get(BEN.id, id, "use")).toBeNull();
    store.share(ADA, id, BEN.id, READ, "use");
    let seen = store.get(BEN.id, id, "use")!;
    expect(seen.revisions.map(r => r.revision)).toEqual([1]);
    expect(seen).toMatchObject({ sharedWithMe: true, access: READ });
    expect(store.list(BEN.id, "use").map(d => d.id)).toEqual([id]);
    // The owner sees every revision.
    expect(store.get(ADA.id, id, "build")!.revisions.map(r => r.revision)).toEqual([1, 2]);
  });

  it("gives nothing to someone no longer a collaborator, whatever they were shared", () => {
    let { store, id } = workspace();
    store.share(ADA, id, BEN.id, RUN, "use");
    expect(store.get(BEN.id, id, null)).toBeNull();
    expect(() => store.requireRunRight(BEN.id, HOOK, null)).toThrow(CANNOT_RUN);
  });

  it("under today's workspace audience, shows the published revision to every collaborator, shared or not", () => {
    let { store, id } = workspace(WORKSPACE_AUDIENCE);
    expect(store.get(CARA.id, id, "use")).toMatchObject({ access: RUN, revisions: [expect.objectContaining({ revision: 1 })] });
    expect(store.get(CARA.id, id, "use")?.sharedWithMe).toBeUndefined();
    expect(store.get(CARA.id, id, null)).toBeNull();
  });
});

describe("editing a shared definition", () => {
  it("lets an editor who builds save revisions, recorded as theirs, that stay unpublished", () => {
    let { store, id, headOf, setHead } = workspace();
    store.share(ADA, id, BEN.id, EDIT, "build");
    expect(store.get(BEN.id, id, "build")!.revisions.map(r => r.revision)).toEqual([1, 2]);
    setHead(3);
    let saved = store.save(BEN, { id, title: "Refund v3", gadgetId: GADGET }, headOf, "build");
    expect(saved.revisions.at(-1)).toMatchObject({ revision: 3, savedBy: BEN });
    expect(saved.published?.revision).toBe(1);
    // A reader still sees revision 1 only; an editor demoted to use can't save.
    store.share(ADA, id, CARA.id, READ, "use");
    expect(store.get(CARA.id, id, "use")!.revisions.map(r => r.revision)).toEqual([1]);
    expect(() => store.save(BEN, { id, title: "Refund", gadgetId: GADGET }, headOf, "use")).toThrow("Workflow definition not found.");
    // Someone who may only run it can't save.
    store.share(ADA, id, CARA.id, RUN, "build");
    expect(() => store.save(CARA, { id, title: "Refund", gadgetId: GADGET }, headOf, "build")).toThrow("Workflow definition not found.");
  });

  it("lets an editor publish only where shared configuration is in force; the owner always may", () => {
    let { store, id } = workspace();
    store.share(ADA, id, BEN.id, EDIT, "build");
    expect(() => store.publish(BEN, id, 2)).toThrow("Workflow definition not found.");
    expect(() => store.publish(BEN, id, 2, { editorsMayPublish: false })).toThrow("Workflow definition not found.");
    expect(store.publish(BEN, id, 2, { editorsMayPublish: true, role: "build" }).published?.revision).toBe(2);
    expect(store.publish(ADA, id, 1).published?.revision).toBe(1);
    // Someone who may only run it never publishes.
    store.share(ADA, id, CARA.id, RUN, "build");
    expect(() => store.publish(CARA, id, 2, { editorsMayPublish: true, role: "build" })).toThrow("Workflow definition not found.");
  });

  it("lets an editor pin a trigger only to the published revision, never an unpublished one", () => {
    let { store, id } = workspace();
    store.share(ADA, id, BEN.id, EDIT, "build");
    expect(() => store.pinTrigger(BEN.id, HOOK, GADGET, { definitionId: id, revision: 2, mode: "pinned" }))
      .toThrow("Workflow definition not found.");
    store.pinTrigger(BEN.id, HOOK, GADGET, { definitionId: id, revision: 1, mode: "pinned" });
    expect(store.pinOf(HOOK)).toMatchObject({ definitionId: id, revision: 1 });
  });
});

// #427 round 1 (r2): only the owner or an editor changes what a trigger runs, and run history is
// theirs alone, so a read or run share never reaches configuration or another run's data.
describe("trigger configuration and run history (#427 round 1)", () => {
  it("lets neither a read-only nor a run-only builder pin a trigger to the definition, or unpin it", () => {
    for (let rights of [READ, RUN]) {
      let { store, id } = workspace();
      store.share(ADA, id, BEN.id, rights, "build");
      expect(() => store.pinTrigger(BEN.id, HOOK, GADGET, { definitionId: id, revision: 1, mode: "pinned" }))
        .toThrow("Workflow definition not found.");
      store.pinTrigger(ADA.id, HOOK, GADGET, { definitionId: id, revision: 1, mode: "pinned" });
      expect(() => store.pinTrigger(BEN.id, HOOK, GADGET, null)).toThrow("can't change the workflow this trigger runs");
      expect(() => store.pinTrigger(BEN.id, HOOK, GADGET, { definitionId: id, revision: 1 }))
        .toThrow("can't change the workflow this trigger runs");
      expect(store.pinOf(HOOK)).toMatchObject({ definitionId: id, revision: 1, mode: "pinned" });
    }
  });

  it("lets an editor move a trigger off the definition only to one they may also edit", () => {
    let { store, id, headOf } = workspace();
    store.share(ADA, id, BEN.id, EDIT, "build");
    store.pinTrigger(ADA.id, HOOK, GADGET, { definitionId: id, revision: 1, mode: "pinned" });
    let other = store.save(CARA, { title: "Other", gadgetId: GADGET }, headOf, "build");
    store.publish(CARA, other.id, 1);
    // Cara's definition is published (the workspace reads it) but Ben may not edit it.
    expect(() => store.pinTrigger(BEN.id, HOOK, GADGET, { definitionId: other.id, revision: 1 })).toThrow("Workflow definition not found.");
    store.pinTrigger(BEN.id, HOOK, GADGET, null);
    expect(store.pinOf(HOOK)).toBeNull();
  });

  it("refuses a read-only builder's unpin through the Overseer before the trigger's assignment is touched", async () => {
    let { store, storage, id } = workspace();
    store.share(ADA, id, BEN.id, READ, "build");
    store.pinTrigger(ADA.id, HOOK, GADGET, { definitionId: id, revision: 1, mode: "pinned" });
    let retireTriggerAssignment = vi.fn();
    let overseer = await openFakeOverseer({}, { role: "build", impl: {
      env: {}, isSharedConfiguration: async () => false,
      workflowDefinitionStore: () => store, definitionRoles: async () => () => "build" as const,
      retireTriggerAssignment, defaultGadgetId: GADGET,
      storage: Object.assign(storage, {
        containsRestrictedData: { get: () => false }, title: { get: () => "Test Workspace" },
        operateSession: { get: () => false },
        boundHooks: { get: (hookId: number) => (hookId === HOOK ? { id: HOOK, gadgetId: GADGET } : undefined) },
      }),
      users: { idFromString: (value: string) => value, get: () => ({ whoami: async () => BEN, recordSharedGadgetOpen: async () => {} }) },
    } });
    await expect(overseer.pinTriggerDefinition(HOOK, null)).rejects.toThrow("can't change the workflow this trigger runs");
    expect(retireTriggerAssignment).not.toHaveBeenCalled();
    expect(store.pinOf(HOOK)).toMatchObject({ definitionId: id });
    // Nor does their deliveries read reach the run history.
    await expect(overseer.listWorkflowDeliveries(id)).rejects.toThrow("Workflow definition not found.");
  });

  it("shows run history to the owner and editors only: a reader and a runner get none, their own runs included", () => {
    let { store, id, headOf, setHead } = workspace();
    setHead(1);
    store.pinTrigger(ADA.id, HOOK, GADGET, { definitionId: id, revision: 1, mode: "pinned" });
    store.setControl(ADA, HOOK, { label: "Refund", invokers: [BEN.id] });
    store.share(ADA, id, BEN.id, RUN, "use");
    store.fire(HOOK, GADGET, headOf, () => "use", store.beginInvocation(BEN.id, HOOK, null).id);
    // An owner's unpublished revision's run too.
    store.pinTrigger(ADA.id, HOOK, GADGET, { definitionId: id, revision: 1, mode: "pinned" });
    for (let [who, rights, role] of [[BEN, RUN, "use"], [CARA, READ, "build"]] as const) {
      store.share(ADA, id, who.id, rights, role);
      expect(() => store.deliveries(who.id, id, role)).toThrow("Workflow definition not found.");
    }
    expect(store.deliveries(ADA.id, id, "build")).toHaveLength(1);
    store.share(ADA, id, CARA.id, EDIT, "build");
    expect(store.deliveries(CARA.id, id, "build")).toHaveLength(1);
    // A missing role grants nothing, an editor's included.
    expect(() => store.deliveries(CARA.id, id, null)).toThrow("Workflow definition not found.");
  });
});

// #427 after #416 (FAC-124): history follows who may see it (owner or edit), not availability, and a
// dynamic, unsaved definition is never shared, so an expired one has no editor and no named reader.
describe("run history and dynamic definitions (#427 with #416)", () => {
  const HOUR = 3_600_000;
  function clocked() {
    let durable = makeMockStorage();
    let storage = makeOverseerStorage(durable);
    let clock = { now: Date.UTC(2026, 10, 10) };
    let store = new WorkspaceWorkflowDefinitionStore(durable, storage, { now: () => clock.now, dynamicTtlMs: () => HOUR },
      WORKSPACE_AUDIENCE);
    let headOf = (gadgetId: number) => (gadgetId === GADGET ? commit(1) : undefined);
    // One run of the definition trigger HOOK is pinned to, asked by Ben through its control.
    let ranOnce = (id: string) => {
      store.pinTrigger(ADA.id, HOOK, GADGET, { definitionId: id, revision: 1, mode: "pinned" });
      store.setControl(ADA, HOOK, { label: "Refund", invokers: [BEN.id] });
      store.fire(HOOK, GADGET, headOf, () => "use", store.beginInvocation(BEN.id, HOOK, null).id);
      store.pinTrigger(ADA.id, HOOK, GADGET, null);
    };
    return { store, clock, headOf, ranOnce };
  }
  const historyOf = (store: WorkspaceWorkflowDefinitionStore, who: string, id: string, role: Role) => {
    try { return store.deliveries(who, id, role).length; } catch (error) { return String(error); }
  };

  it("lets the owner and an editor read a live definition's history; a reader and a runner get none", () => {
    let { store, headOf, ranOnce } = clocked();
    let saved = store.save(ADA, { title: "Refund", gadgetId: GADGET }, headOf, "build");
    store.publish(ADA, saved.id, 1);
    ranOnce(saved.id);
    store.share(ADA, saved.id, CARA.id, EDIT, "build");
    store.share(ADA, saved.id, BEN.id, RUN, "use");
    store.share(ADA, saved.id, "dan-profile", READ, "use");
    expect(historyOf(store, ADA.id, saved.id, "build")).toBe(1);
    expect(historyOf(store, CARA.id, saved.id, "build")).toBe(1);
    expect(historyOf(store, BEN.id, saved.id, "use")).toContain("Workflow definition not found.");
    expect(historyOf(store, "dan-profile", saved.id, "use")).toContain("Workflow definition not found.");
  });

  it("keeps an expired definition's history its owner's: no reader or runner reads it, and none can be an editor", () => {
    let { store, clock, headOf, ranOnce } = clocked();
    let made = store.save(ADA, { title: "One-off", gadgetId: GADGET, retain: false }, headOf, "build");
    store.publish(ADA, made.id, 1);
    // A dynamic definition is never shared, to edit or otherwise; stopping a share always works.
    for (let rights of [EDIT, RUN, READ]) {
      expect(() => store.share(ADA, made.id, CARA.id, rights, "build")).toThrow("Save this workflow before sharing it");
    }
    expect(store.share(ADA, made.id, CARA.id, null, "build")).toEqual([]);
    ranOnce(made.id);
    clock.now += 2 * HOUR;
    // Expired, not yet swept: its record is there, and so is its history, for its owner only.
    expect(store.get(ADA.id, made.id, "build")).toBeNull();
    expect(historyOf(store, ADA.id, made.id, "build")).toBe(1);
    // Ben ran it, and the workspace audience let every collaborator read and run it: neither reaches history.
    expect(historyOf(store, BEN.id, made.id, "use")).toContain("Workflow definition not found.");
    expect(historyOf(store, CARA.id, made.id, "build")).toContain("Workflow definition not found.");
  });
});

describe("running a shared definition", () => {
  it("needs both the run right and the trigger's run control; an edit share gives no run", () => {
    let { store, id } = workspace();
    store.pinTrigger(ADA.id, HOOK, GADGET, { definitionId: id, revision: 1, mode: "pinned" });
    store.setControl(ADA, HOOK, { label: "Refund", invokers: [BEN.id, CARA.id] });
    // Listed on the control, but not shared with: refused.
    expect(() => store.requireRunRight(BEN.id, HOOK, "use")).toThrow(CANNOT_RUN);
    store.share(ADA, id, BEN.id, RUN, "use");
    store.requireRunRight(BEN.id, HOOK, "use");
    store.share(ADA, id, CARA.id, EDIT, "build");
    expect(() => store.requireRunRight(CARA.id, HOOK, "build")).toThrow(CANNOT_RUN);
    // The owner may run it.
    store.requireRunRight(ADA.id, HOOK, "build");
  });
});

// Through the Overseer's own admission and re-check paths, with a fake workspace whose roles and
// InferOps answers each test sets.
describe("revocation and records (acceptance 2)", () => {
  const COMPANY_A = "0b7e2c3a-1f00-4a00-8000-00000000000a";
  const COMPANY_B = "0b7e2c3a-1f00-4a00-8000-00000000000b";

  function overseerWith(opts: { gated?: boolean } = {}) {
    let made = workspace();
    // The gadget's code is back at revision 1's, the revision the trigger runs.
    made.setHead(1);
    let { store, storage, id } = made;
    store.pinTrigger(ADA.id, HOOK, GADGET, { definitionId: id, revision: 1, mode: "pinned" });
    store.setControl(ADA, HOOK, { label: "Refund", invokers: [BEN.id] });
    let roles = new Map<string, Role>([[BEN.id, "use"]]);
    let answer = { holds: true, company: COMPANY_A as string | null };
    let invoke = vi.fn(async (_request: { invocationId: string }) => {});
    let hook = { id: HOOK, gadgetId: GADGET, gatekeeperId: 50, enabled: true, controller: { invoke } };
    let impl = {
      env: opts.gated ? { SHARED_CONFIGURATION_GATEKEEPER: "inferops" } : {},
      takenInvocations: new Map<string, boolean>(),
      workflowDefinitionStore: () => store,
      definitionRoles: async () => (profileId: string) => (profileId === ADA.id ? "build" as const : roles.get(profileId) ?? null),
      getGadgetHead: made.headOf,
      defaultGadgetId: GADGET,
      assertGatekeeperUsable: () => {},
      visibleBindings: () => [["BOARD", { target: 60 }]],
      getGadgetRecord: () => ({}),
      storage: Object.assign(storage, {
        boundHooks: { get: (hookId: number) => (hookId === HOOK ? hook : undefined), list: () => [hook] },
        gatekeepers: { get: (gatekeeperId: number) => (gatekeeperId === 60 ? {
          id: 60, creationSpec: { type: "gatekeeper", vendorId: "inferops", resourceUrl: "inferops://acme.operations/project/board/ENG", typeUrlPattern: "inferops://*" },
        } : undefined) },
      }),
      users: {
        idFromName: (name: string) => name,
        idFromString: (value: string) => value,
        get: () => ({ workflowInvokeAnswer: async () => answer }),
      },
    };
    return { ...made, impl, roles, invoke, setAnswer: (next: typeof answer) => { answer = next; } };
  }

  const refusalOf = async (run: () => Promise<unknown>) => {
    try { await run(); return "accepted"; } catch (error) { return String(error); }
  };

  it("refuses the next invocation once the share or the run right is revoked, and runs again when restored", async () => {
    let { impl, store, id, invoke } = overseerWith();
    store.share(ADA, id, BEN.id, RUN, "use");
    await invokeWorkflowTrigger(impl as never, "ben-user", BEN.id, HOOK);
    expect(invoke).toHaveBeenCalledTimes(1);
    store.share(ADA, id, BEN.id, READ, "use");
    expect(await refusalOf(() => invokeWorkflowTrigger(impl as never, "ben-user", BEN.id, HOOK))).toContain(CANNOT_RUN);
    store.share(ADA, id, BEN.id, null, "use");
    expect(await refusalOf(() => invokeWorkflowTrigger(impl as never, "ben-user", BEN.id, HOOK))).toContain(CANNOT_RUN);
    expect(invoke).toHaveBeenCalledTimes(1);
    store.share(ADA, id, BEN.id, RUN, "use");
    await invokeWorkflowTrigger(impl as never, "ben-user", BEN.id, HOOK);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("refuses at delivery a request admitted before the share was revoked, and drops it", () => {
    let { store, id, headOf } = overseerWith();
    store.share(ADA, id, BEN.id, RUN, "use");
    let invocation = store.beginInvocation(BEN.id, HOOK, null);
    store.share(ADA, id, BEN.id, null, "use");
    expect(() => store.fire(HOOK, GADGET, headOf, () => "use", invocation.id)).toThrow(CANNOT_RUN);
    expect(store.isWaiting(invocation.id)).toBe(false);
  });

  it("stops a run already admitted at its next protected point once the run right is revoked or they leave", async () => {
    let { impl, store, id, headOf, roles } = overseerWith();
    store.share(ADA, id, BEN.id, RUN, "use");
    let delivery = store.fire(HOOK, GADGET, headOf, () => "use", store.beginInvocation(BEN.id, HOOK, null).id)!;
    let check = await requireRunRequester(impl as never, HOOK, delivery.deliveryId);
    check.revalidate();
    store.share(ADA, id, BEN.id, READ, "use");
    expect(() => check.revalidate()).toThrow(RUN_REQUESTER_REVOKED);
    await expect(requireRunRequester(impl as never, HOOK, delivery.deliveryId)).rejects.toThrow(RUN_REQUESTER_REVOKED);
    // Restored, then removed from the workspace: stopped again.
    store.share(ADA, id, BEN.id, RUN, "use");
    (await requireRunRequester(impl as never, HOOK, delivery.deliveryId)).revalidate();
    roles.delete(BEN.id);
    await expect(requireRunRequester(impl as never, HOOK, delivery.deliveryId)).rejects.toThrow(RUN_REQUESTER_REVOKED);
  });

  it("grants no record access: a recipient InferOps refuses workflow:invoke, or answers in another company, runs nothing", async () => {
    let { impl, store, id, invoke, headOf, setAnswer } = overseerWith({ gated: true });
    store.share(ADA, id, BEN.id, RUN, "use");
    setAnswer({ holds: false, company: null });
    expect(await refusalOf(() => invokeWorkflowTrigger(impl as never, "ben-user", BEN.id, HOOK))).toContain(WORKFLOW_INVOKE_REFUSED);
    expect(invoke).not.toHaveBeenCalled();
    // Admitted in company A, then answered in company B at the run's next protected point.
    setAnswer({ holds: true, company: COMPANY_A });
    await invokeWorkflowTrigger(impl as never, "ben-user", BEN.id, HOOK);
    let requestId = invoke.mock.calls[0]![0].invocationId;
    let delivery = store.fire(HOOK, GADGET, headOf, () => "use", requestId)!;
    setAnswer({ holds: true, company: COMPANY_B });
    await expect(requireRunRequester(impl as never, HOOK, delivery.deliveryId)).rejects.toThrow(RUN_REQUESTER_REVOKED);
  });
});
