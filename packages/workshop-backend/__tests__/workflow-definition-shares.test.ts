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
  let store = new WorkspaceWorkflowDefinitionStore(durable, storage, audience);
  let head = commit(1);
  let headOf = (id: number) => (id === GADGET ? head : undefined);
  let saved = store.save(ADA, { title: "Refund", gadgetId: GADGET }, headOf);
  store.publish(ADA, saved.id, 1);
  head = commit(2);
  store.save(ADA, { id: saved.id, title: "Refund", gadgetId: GADGET }, headOf);
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
    expect(() => store.fire(HOOK, GADGET, headOf, () => true, invocation.id, () => "use")).toThrow(CANNOT_RUN);
    expect(store.isWaiting(invocation.id)).toBe(false);
  });

  it("stops a run already admitted at its next protected point once the run right is revoked or they leave", async () => {
    let { impl, store, id, headOf, roles } = overseerWith();
    store.share(ADA, id, BEN.id, RUN, "use");
    let delivery = store.fire(HOOK, GADGET, headOf, () => true, store.beginInvocation(BEN.id, HOOK, null).id, () => "use")!;
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
    let delivery = store.fire(HOOK, GADGET, headOf, () => true, requestId, () => "use")!;
    setAnswer({ holds: true, company: COMPANY_B });
    await expect(requireRunRequester(impl as never, HOOK, delivery.deliveryId)).rejects.toThrow(RUN_REQUESTER_REVOKED);
  });
});
