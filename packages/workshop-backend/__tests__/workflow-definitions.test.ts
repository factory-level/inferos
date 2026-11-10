// Workflow definitions (workflow-definition-store.ts) over the production overseer storage on a
// mock: saving keeps a revision for its owner and publishes nothing, another person never sees an
// unpublished one, a trigger selects a definition, and a firing runs and
// records exactly that revision or is refused. The Overseer gates (build to save and pin, publish to
// publish, both through the shared-configuration authority in a shared workspace) are covered at
// the end through the real interface classes.
import { describe, expect, it } from "vitest";
import {
  isLiveWorkflowDelivery, MAX_WORKFLOW_DEFINITION_REVISIONS, MAX_WORKFLOW_DELIVERIES,
  MAX_WORKSPACE_WORKFLOW_DEFINITIONS, WORKFLOW_RUN_START_WINDOW_MS,
} from "@gadgets/workshop-shared/workflow-definition";
import { makeOverseerStorage } from "../src/overseer.js";
import { WorkspaceWorkflowDefinitionStore } from "../src/workflow-definition-store.js";
import { openFakeOverseer } from "./fixtures.js";
import { makeMockStorage } from "./mock-storage.js";

const ADA = { type: "user" as const, id: "ada-profile", name: "Ada" };
const BEN = { type: "user" as const, id: "ben-profile", name: "Ben" };
const GADGET = 3;
const OTHER_GADGET = 4;
const commit = (n: number) => n.toString(16).padStart(40, "0");

/** One workspace: its store, and the gadget heads its code is at. */
function workspace() {
  let durable = makeMockStorage();
  let storage = makeOverseerStorage(durable);
  let store = new WorkspaceWorkflowDefinitionStore(durable, storage);
  let heads = new Map<number, string>([[GADGET, commit(1)], [OTHER_GADGET, commit(100)]]);
  let headOf = (id: number) => heads.get(id);
  return { store, storage, heads, headOf };
}

const everyoneBuilds = () => true;

describe("workflow delivery retention", () => {
  it("keeps every live outcome and only evicts known terminal outcomes", () => {
    for (let outcome of ["queued", "running", "waiting"] as const) {
      expect(isLiveWorkflowDelivery({ run: {}, result: { outcome } })).toBe(true);
    }
    expect(isLiveWorkflowDelivery({ run: {}, result: { outcome: "uncertain", reason: "lost-after-write" } })).toBe(true);
    expect(isLiveWorkflowDelivery({ run: {}, result: { outcome: "uncertain", reason: "action-unknown" } })).toBe(true);
    expect(isLiveWorkflowDelivery({ run: {}, result: { outcome: "uncertain", reason: "not-started" } })).toBe(false);
    for (let outcome of ["succeeded", "failed"] as const) {
      expect(isLiveWorkflowDelivery({ run: {}, result: { outcome } })).toBe(false);
    }
    expect(isLiveWorkflowDelivery({ run: {} })).toBe(true);
    expect(isLiveWorkflowDelivery({ run: {}, at: new Date(Date.now() - WORKFLOW_RUN_START_WINDOW_MS - 1) })).toBe(false);
    expect(isLiveWorkflowDelivery({})).toBe(false);
  });
});

describe("saving a workflow definition", () => {
  it("keeps a revision of the gadget's current code for its owner, and publishes nothing", () => {
    let { store, headOf } = workspace();
    let saved = store.save(ADA, { title: " Intake ", gadgetId: GADGET }, headOf);
    expect(saved).toMatchObject({
      title: "Intake", owner: ADA, published: null,
      revisions: [{ revision: 1, source: { kind: "gadget", gadgetId: GADGET, commitId: commit(1) } }],
    });
    expect(store.list(ADA.id).map(d => d.id)).toEqual([saved.id]);
  });

  it("is visible only to its owner until published, and then only at the published revision", () => {
    let { store, heads, headOf } = workspace();
    let saved = store.save(ADA, { title: "Intake", gadgetId: GADGET }, headOf);
    expect(store.list(BEN.id)).toEqual([]);
    expect(store.get(BEN.id, saved.id)).toBeNull();
    expect(() => store.deliveries(BEN.id, saved.id)).toThrow("Workflow definition not found.");

    store.publish(ADA, saved.id, 1);
    heads.set(GADGET, commit(2));
    store.save(ADA, { id: saved.id, title: "Intake", gadgetId: GADGET }, headOf);
    expect(store.get(ADA.id, saved.id)?.revisions.map(r => r.revision)).toEqual([1, 2]);
    // Ben sees the published revision only, never Ada's newer draft.
    expect(store.get(BEN.id, saved.id)?.revisions.map(r => r.revision)).toEqual([1]);
  });

  it("adds a revision only when the code changed; saving again with the same commit renames", () => {
    let { store, heads, headOf } = workspace();
    let saved = store.save(ADA, { title: "Intake", gadgetId: GADGET }, headOf);
    let renamed = store.save(ADA, { id: saved.id, title: "Intake v1", gadgetId: GADGET }, headOf);
    expect(renamed.revisions).toHaveLength(1);
    expect(renamed.title).toBe("Intake v1");
    heads.set(GADGET, commit(2));
    expect(store.save(ADA, { id: saved.id, title: "Intake", gadgetId: GADGET }, headOf).revisions)
      .toHaveLength(2);
  });

  it("refuses another person's definition at save and publish as if it didn't exist", () => {
    let { store, headOf } = workspace();
    let saved = store.save(ADA, { title: "Intake", gadgetId: GADGET }, headOf);
    expect(() => store.save(BEN, { id: saved.id, title: "Mine now", gadgetId: GADGET }, headOf))
      .toThrow("Workflow definition not found.");
    expect(() => store.publish(BEN, saved.id, 1)).toThrow("Workflow definition not found.");
    store.publish(ADA, saved.id, 1);
    // Published doesn't make it Ben's to change.
    expect(() => store.publish(BEN, saved.id, 1)).toThrow("Workflow definition not found.");
    expect(store.get(ADA.id, saved.id)?.title).toBe("Intake");
  });

  it("doesn't exist in another workspace", () => {
    let a = workspace();
    let b = workspace();
    let saved = a.store.save(ADA, { title: "Intake", gadgetId: GADGET }, a.headOf);
    a.store.publish(ADA, saved.id, 1);
    expect(b.store.get(ADA.id, saved.id)).toBeNull();
    expect(() => b.store.publish(ADA, saved.id, 1)).toThrow("Workflow definition not found.");
  });

  it("refuses a gadget with no committed code, a bad title, and past the limits", () => {
    let { store, heads, headOf } = workspace();
    expect(() => store.save(ADA, { title: "Pending", gadgetId: 99 }, headOf)).toThrow("committed code");
    expect(() => store.save(ADA, { title: " ", gadgetId: GADGET }, headOf)).toThrow(TypeError);
    for (let i = 0; i < MAX_WORKSPACE_WORKFLOW_DEFINITIONS; i++) {
      store.save(ADA, { title: `Definition ${i}`, gadgetId: GADGET }, headOf);
    }
    expect(() => store.save(BEN, { title: "One more", gadgetId: GADGET }, headOf))
      .toThrow("Workspace workflow definition limit reached.");

    let fresh = workspace();
    let saved = fresh.store.save(ADA, { title: "Busy", gadgetId: GADGET }, fresh.headOf);
    for (let n = 2; n <= MAX_WORKFLOW_DEFINITION_REVISIONS; n++) {
      fresh.heads.set(GADGET, commit(n));
      fresh.store.save(ADA, { id: saved.id, title: "Busy", gadgetId: GADGET }, fresh.headOf);
    }
    fresh.heads.set(GADGET, commit(999));
    expect(() => fresh.store.save(ADA, { id: saved.id, title: "Busy", gadgetId: GADGET }, fresh.headOf))
      .toThrow("revision limit");
    void heads;
  });
});

describe("triggers and runs", () => {
  it("lets two triggers reference one definition revision, storing a reference, not a copy", () => {
    let { store, headOf } = workspace();
    let saved = store.save(ADA, { title: "Intake", gadgetId: GADGET }, headOf);
    store.pinTrigger(ADA.id, 11, GADGET, { definitionId: saved.id, revision: 1 });
    store.pinTrigger(ADA.id, 12, GADGET, { definitionId: saved.id, revision: 1 });
    expect(store.pinOf(11)).toEqual({ definitionId: saved.id, revision: 1, mode: "follow-latest" });
    expect(store.pinOf(12)).toEqual({ definitionId: saved.id, revision: 1, mode: "follow-latest" });
    expect(store.list(ADA.id)).toHaveLength(1);
  });

  it("records the revision and commit each firing ran", () => {
    let { store, headOf } = workspace();
    let saved = store.save(ADA, { title: "Intake", gadgetId: GADGET }, headOf);
    store.publish(ADA, saved.id, 1);
    store.pinTrigger(ADA.id, 11, GADGET, { definitionId: saved.id, revision: 1 });
    store.pinTrigger(ADA.id, 12, GADGET, { definitionId: saved.id, revision: 1 });
    expect(store.fire(11, GADGET, headOf, everyoneBuilds))
      .toMatchObject({ hookId: 11, definitionId: saved.id, revision: 1, commitId: commit(1) });
    store.fire(12, GADGET, headOf, everyoneBuilds);
    expect(store.deliveries(ADA.id, saved.id).map(d => [d.hookId, d.revision])).toEqual([[11, 1], [12, 1]]);
  });

  it("keeps an explicit revision pin and requires an explicit move", () => {
    let { store, heads, headOf } = workspace();
    let saved = store.save(ADA, { title: "Intake", gadgetId: GADGET }, headOf);
    store.publish(ADA, saved.id, 1);
    store.pinTrigger(BEN.id, 11, GADGET, { definitionId: saved.id, revision: 1, mode: "pinned" });
    heads.set(GADGET, commit(2));
    store.save(ADA, { id: saved.id, title: "Intake", gadgetId: GADGET }, headOf);
    store.publish(ADA, saved.id, 2);
    expect(store.pinOf(11)).toEqual({ definitionId: saved.id, revision: 1, mode: "pinned" });
    expect(() => store.fire(11, GADGET, headOf, everyoneBuilds)).toThrow("changed since revision 1");
    store.pinTrigger(BEN.id, 11, GADGET, { definitionId: saved.id, revision: 2, mode: "pinned" });
    expect(store.fire(11, GADGET, headOf, everyoneBuilds)).toMatchObject({ revision: 2, commitId: commit(2) });
    heads.set(GADGET, commit(3));
    store.save(ADA, { id: saved.id, title: "Intake", gadgetId: GADGET }, headOf);
    expect(() => store.fire(11, GADGET, headOf, everyoneBuilds)).toThrow("changed since revision 2");
  });

  it("keeps a stored legacy pin explicit when it has no mode field", () => {
    let { store, storage, heads, headOf } = workspace();
    let saved = store.save(ADA, { title: "Intake", gadgetId: GADGET }, headOf);
    store.publish(ADA, saved.id, 1);
    store.pinTrigger(BEN.id, 11, GADGET, { definitionId: saved.id, revision: 1, mode: "pinned" });
    let { mode: _mode, ...legacyPin } = storage.workflowTriggerPins.get(11)!;
    storage.workflowTriggerPins.put(legacyPin);
    heads.set(GADGET, commit(2));
    store.save(ADA, { id: saved.id, title: "Intake", gadgetId: GADGET }, headOf);
    store.publish(ADA, saved.id, 2);
    expect(store.pinOf(11)).toEqual({ definitionId: saved.id, revision: 1, mode: "pinned" });
    expect(() => store.fire(11, GADGET, headOf, everyoneBuilds)).toThrow("changed since revision 1");
  });

  it("refuses an admitted revision after the gadget head moves; new admissions follow latest", () => {
    let { store, heads, headOf } = workspace();
    let saved = store.save(ADA, { title: "Intake", gadgetId: GADGET }, headOf);
    store.publish(ADA, saved.id, 1);
    store.pinTrigger(BEN.id, 11, GADGET, { definitionId: saved.id, revision: 1 });
    store.setControl(ADA, 11, { label: "Run", invokers: [BEN.id] });
    let invocation = store.beginInvocation(BEN.id, 11);
    heads.set(GADGET, commit(2));
    store.save(ADA, { id: saved.id, title: "Intake", gadgetId: GADGET }, headOf);
    store.publish(ADA, saved.id, 2);
    expect(() => store.fire(11, GADGET, headOf, everyoneBuilds, invocation.id))
      .toThrow("The workflow changed; ask again");
    expect(store.deliveries(ADA.id, saved.id)).toEqual([]);
    let nextInvocation = store.beginInvocation(BEN.id, 11);
    expect(store.fire(11, GADGET, headOf, everyoneBuilds, nextInvocation.id))
      .toMatchObject({ revision: 2, commitId: commit(2) });
    expect(store.fire(11, GADGET, headOf, everyoneBuilds)).toMatchObject({ revision: 2, commitId: commit(2) });
  });

  it("refuses to fire a definition that has never been published", () => {
    let { store, headOf } = workspace();
    let saved = store.save(ADA, { title: "Draft", gadgetId: GADGET }, headOf);
    store.pinTrigger(ADA.id, 11, GADGET, { definitionId: saved.id, revision: 1 });
    expect(() => store.fire(11, GADGET, headOf, everyoneBuilds)).toThrow("This workflow has no published revision.");
    expect(store.deliveries(ADA.id, saved.id)).toEqual([]);
  });

  it("does not evict a queued run when later deliveries fill the retention window", () => {
    let { store, headOf } = workspace();
    let saved = store.save(ADA, { title: "Refund", gadgetId: GADGET }, headOf);
    store.publish(ADA, saved.id, 1);
    store.pinTrigger(ADA.id, 11, GADGET, { definitionId: saved.id, revision: 1 });
    store.setControl(ADA, 11, { label: "Run", invokers: [BEN.id] });
    let invocation = store.beginInvocation(BEN.id, 11);
    let first = store.fire(11, GADGET, headOf, everyoneBuilds, invocation.id)!;
    store.queueRun(11, first.deliveryId, "run", []);
    for (let n = 1; n < MAX_WORKFLOW_DELIVERIES; n++) store.fire(11, GADGET, headOf, everyoneBuilds);
    expect(store.run(first.run!.runId)).toMatchObject({ revision: 1, commitId: commit(1) });
    expect(store.queuedRuns()).toContainEqual({ deliveryId: first.deliveryId, hookId: 11, method: "run", args: [] });
  });

  it("refuses admission when every retained delivery is uncertain and reports the reconciliation count", () => {
    let { store, headOf } = workspace();
    let saved = store.save(ADA, { title: "Refund", gadgetId: GADGET }, headOf);
    store.publish(ADA, saved.id, 1);
    store.pinTrigger(ADA.id, 11, GADGET, { definitionId: saved.id, revision: 1 });
    for (let n = 0; n < MAX_WORKFLOW_DELIVERIES; n++) {
      let delivery = store.fire(11, GADGET, headOf, everyoneBuilds)!;
      store.recordResult(delivery.deliveryId, { outcome: "uncertain", reason: "lost-after-write" });
    }
    expect(() => store.fire(11, GADGET, headOf, everyoneBuilds))
      .toThrow(`Too many workflow runs are in progress; ${MAX_WORKFLOW_DELIVERIES} are waiting for reconciliation.`);
    expect(store.deliveries(ADA.id, saved.id)).toHaveLength(MAX_WORKFLOW_DELIVERIES);
  });

  it("evicts a not-started run after its start window", () => {
    let { store, storage, headOf } = workspace();
    let saved = store.save(ADA, { title: "Refund", gadgetId: GADGET }, headOf);
    store.publish(ADA, saved.id, 1);
    store.pinTrigger(ADA.id, 11, GADGET, { definitionId: saved.id, revision: 1 });
    let first = store.fire(11, GADGET, headOf, everyoneBuilds)!;
    for (let n = 1; n < MAX_WORKFLOW_DELIVERIES; n++) store.fire(11, GADGET, headOf, everyoneBuilds);
    let firstStored = storage.workflowDeliveries.get(first.deliveryId)!;
    storage.workflowDeliveries.put({
      ...firstStored, at: new Date(Date.now() - WORKFLOW_RUN_START_WINDOW_MS - 1),
    });
    store.fire(11, GADGET, headOf, everyoneBuilds);
    expect(store.run(first.run!.runId)).toBeNull();
    expect(store.deliveries(ADA.id, saved.id)).toHaveLength(MAX_WORKFLOW_DELIVERIES);
  });

  it("evicts the oldest terminal delivery before admitting another run", () => {
    let { store, headOf } = workspace();
    let saved = store.save(ADA, { title: "Refund", gadgetId: GADGET }, headOf);
    store.publish(ADA, saved.id, 1);
    store.pinTrigger(ADA.id, 11, GADGET, { definitionId: saved.id, revision: 1 });
    let first = store.fire(11, GADGET, headOf, everyoneBuilds)!;
    for (let n = 1; n < MAX_WORKFLOW_DELIVERIES; n++) store.fire(11, GADGET, headOf, everyoneBuilds);
    store.recordResult(first.deliveryId, { outcome: "failed", reason: "runtime-error" });
    store.fire(11, GADGET, headOf, everyoneBuilds);
    expect(store.deliveries(ADA.id, saved.id)).toHaveLength(MAX_WORKFLOW_DELIVERIES);
    expect(store.deliveries(ADA.id, saved.id).some(delivery => delivery.result?.outcome === "failed")).toBe(false);
  });

  it("refuses follow-latest when the gadget head is newer than the published commit", () => {
    let { store, heads, headOf } = workspace();
    let saved = store.save(ADA, { title: "Intake", gadgetId: GADGET }, headOf);
    store.publish(ADA, saved.id, 1);
    store.pinTrigger(ADA.id, 11, GADGET, { definitionId: saved.id, revision: 1 });
    heads.set(GADGET, commit(7));
    store.save(ADA, { id: saved.id, title: "Intake", gadgetId: GADGET }, headOf);
    expect(() => store.fire(11, GADGET, headOf, everyoneBuilds)).toThrow("changed since revision 1 was saved");
    expect(() => store.requireCurrentRevision(11, GADGET, headOf)).toThrow("changed since revision 1 was saved");
  });

  it("refuses a definition with no publication and allows a published one", () => {
    let { store, headOf } = workspace();
    let draft = store.save(ADA, { title: "Draft", gadgetId: GADGET }, headOf);
    let live = store.save(ADA, { title: "Live", gadgetId: GADGET }, headOf);
    store.publish(ADA, live.id, 1);
    store.pinTrigger(ADA.id, 11, GADGET, { definitionId: draft.id, revision: 1, mode: "follow-latest" });
    store.pinTrigger(ADA.id, 12, GADGET, { definitionId: live.id, revision: 1 });
    expect(() => store.fire(11, GADGET, headOf, everyoneBuilds)).toThrow("This workflow has no published revision.");
    expect(store.fire(12, GADGET, headOf, everyoneBuilds)).toMatchObject({ definitionId: live.id });
  });

  it("refuses to pin another person's unpublished revision, or one for another gadget", () => {
    let { store, headOf } = workspace();
    let saved = store.save(ADA, { title: "Intake", gadgetId: GADGET }, headOf);
    expect(() => store.pinTrigger(BEN.id, 11, GADGET, { definitionId: saved.id, revision: 1 }))
      .toThrow("Workflow definition not found.");
    expect(() => store.pinTrigger(ADA.id, 11, OTHER_GADGET, { definitionId: saved.id, revision: 1 }))
      .toThrow("another gadget");
    expect(() => store.pinTrigger(ADA.id, 11, null, { definitionId: saved.id, revision: 1 }))
      .toThrow("another gadget");
    expect(() => store.pinTrigger(ADA.id, 11, GADGET, { definitionId: saved.id, revision: 9 }))
      .toThrow("Workflow definition not found.");
    expect(store.pinOf(11)).toBeNull();
  });

  it("leaves an unpinned trigger as it was, and clears a pin with null", () => {
    let { store, headOf } = workspace();
    expect(store.fire(11, GADGET, headOf, everyoneBuilds)).toBeNull();
    let saved = store.save(ADA, { title: "Intake", gadgetId: GADGET }, headOf);
    store.pinTrigger(ADA.id, 11, GADGET, { definitionId: saved.id, revision: 1, mode: "pinned" });
    store.pinTrigger(ADA.id, 11, GADGET, null);
    expect(store.fire(11, GADGET, headOf, everyoneBuilds)).toBeNull();
  });
});

describe("through the Overseer", () => {
  const REFUSED = "You don't have permission to share or publish configuration other people use.";
  const GATED = { SHARED_CONFIGURATION_GATEKEEPER: "inferops" };

  async function session(opts: { role: "build" | "use"; answers?: { build: boolean; publish: boolean };
                                 shared?: boolean }) {
    let durable = makeMockStorage();
    let storage = makeOverseerStorage(durable);
    let store = new WorkspaceWorkflowDefinitionStore(durable, storage);
    let opened = false;
    let overseer = await openFakeOverseer({}, {
      role: opts.role,
      impl: {
        env: opts.answers ? GATED : {},
        isSharedConfiguration: async () => opts.shared ?? true,
        workflowDefinitionStore: () => store,
        getGadgetHead: (id: number) => (id === GADGET ? commit(1) : undefined),
        defaultGadgetId: GADGET,
        storage: Object.assign(storage, {
          containsRestrictedData: { get: () => false },
          title: { get: () => "Test Workspace" },
          operateSession: { get: () => false },
          boundHooks: { get: (id: number) => (id === 11 ? { id: 11, gadgetId: GADGET } : undefined) },
        }),
        users: {
          idFromString: (id: string) => id,
          get: () => ({
            whoami: async () => ADA,
            recordSharedGadgetOpen: async () => {},
            holdsSharedConfiguration: async (action: "build" | "publish") =>
              !opened && action === "build" ? true : (opts.answers?.[action] ?? true),
          }),
        },
      },
    });
    opened = true;
    return { overseer, store };
  }

  it("saves and publishes as two acts for someone the deployment lets build and publish", async () => {
    let { overseer } = await session({ role: "build", answers: { build: true, publish: true } });
    let saved = await overseer.saveWorkflowDefinition({ title: "Intake", gadgetId: GADGET });
    expect(saved.published).toBeNull();
    expect((await overseer.publishWorkflowDefinition(saved.id, 1)).published?.revision).toBe(1);
  });

  it("refuses saving, pinning and publishing in a shared workspace without the authority", async () => {
    let builder = await session({ role: "build", answers: { build: true, publish: false } });
    let saved = await builder.overseer.saveWorkflowDefinition({ title: "Intake", gadgetId: GADGET });
    await expect(builder.overseer.publishWorkflowDefinition(saved.id, 1)).rejects.toThrow(REFUSED);
    let demoted = await session({ role: "build", answers: { build: false, publish: false } });
    await expect(demoted.overseer.saveWorkflowDefinition({ title: "Intake", gadgetId: GADGET }))
      .rejects.toThrow(REFUSED);
    await expect(demoted.overseer.pinTriggerDefinition(11, null)).rejects.toThrow(REFUSED);
  });

  it("gives a use session published definitions only, and nothing to change", async () => {
    let { overseer, store } = await session({ role: "use" });
    let headOf = (id: number) => (id === GADGET ? commit(1) : undefined);
    let draft = store.save(BEN, { title: "Draft", gadgetId: GADGET }, headOf);
    let live = store.save(BEN, { title: "Live", gadgetId: GADGET }, headOf);
    store.publish(BEN, live.id, 1);
    expect((await overseer.listWorkflowDefinitions()).map(d => d.id)).toEqual([live.id]);
    void draft;
    await expect(overseer.saveWorkflowDefinition({ title: "Mine", gadgetId: GADGET })).rejects.toThrow();
    await expect(overseer.exportWorkspaceRecords()).rejects.toThrow();
    await expect(overseer.publishWorkflowDefinition(live.id, 1)).rejects.toThrow();
    await expect(overseer.pinTriggerDefinition(11, null)).rejects.toThrow();
  });
});
