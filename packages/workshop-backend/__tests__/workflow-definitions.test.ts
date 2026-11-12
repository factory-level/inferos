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
  WORKFLOW_RUN_HISTORY_CAP_REFUSAL, WORKFLOW_RUN_HISTORY_SWEEP_BATCH, WORKFLOW_RUN_HISTORY_SWEEP_RETRY_MS,
  maxWorkflowDeliveries, workflowRunHistoryRetentionMs,
} from "@gadgets/workshop-shared/workflow-definition";
import type { WorkflowDefinitionDelivery } from "@gadgets/workshop-shared/workflow-definition";
import { makeOverseerStorage } from "../src/overseer.js";
import { MAX_WORKFLOW_OCCURRENCES_PER_TRIGGER, WorkspaceWorkflowDefinitionStore } from "../src/workflow-definition-store.js";
import { openFakeOverseer } from "./fixtures.js";
import { makeMockStorage } from "./mock-storage.js";

const ADA = { type: "user" as const, id: "ada-profile", name: "Ada" };
const BEN = { type: "user" as const, id: "ben-profile", name: "Ben" };
const GADGET = 3;
const OTHER_GADGET = 4;
const commit = (n: number) => n.toString(16).padStart(40, "0");

describe("workflow run-history settings", () => {
  it("uses the proposed defaults and accepts bounded whole-number overrides", () => {
    expect(workflowRunHistoryRetentionMs(undefined)).toBe(90 * 24 * 60 * 60_000);
    expect(workflowRunHistoryRetentionMs("3650")).toBe(3650 * 24 * 60 * 60_000);
    expect(maxWorkflowDeliveries(undefined)).toBe(10_000);
    expect(maxWorkflowDeliveries("1000")).toBe(1000);
  });

  it("rejects malformed or out-of-range values", () => {
    for (let value of ["", "1.5", "0", "3651", " 90"]) {
      expect(() => workflowRunHistoryRetentionMs(value)).toThrow("WORKFLOW_RUN_HISTORY_RETENTION_DAYS");
    }
    for (let value of ["", "1000.5", "999", "100001", " 10000"]) {
      expect(() => maxWorkflowDeliveries(value)).toThrow("WORKFLOW_MAX_RUN_HISTORY");
    }
  });
});

/** One workspace: its store, and the gadget heads its code is at. */
function workspace(options: { max?: number; ttlMs?: number; now?: () => number } = {}) {
  let durable = makeMockStorage();
  let storage = makeOverseerStorage(durable);
  let store = new WorkspaceWorkflowDefinitionStore(durable, storage, {
    now: options.now ?? (() => Date.now()), dynamicTtlMs: () => 24 * 60 * 60_000,
    maxWorkflowDeliveries: () => options.max ?? MAX_WORKFLOW_DELIVERIES,
    runHistoryTtlMs: () => options.ttlMs ?? 90 * 24 * 60 * 60_000,
  });
  let heads = new Map<number, string>([[GADGET, commit(1)], [OTHER_GADGET, commit(100)]]);
  let headOf = (id: number) => heads.get(id);
  return { store, storage, heads, headOf };
}

const everyoneBuilds = () => "build" as const;

/** Fill the retained-delivery cap with copies of one valid delivery, without exercising fire in a loop. */
function fillRetainedDeliveries(storage: ReturnType<typeof makeOverseerStorage>, template: WorkflowDefinitionDelivery, count = MAX_WORKFLOW_DELIVERIES) {
  for (let id = 0; id < count; id++) {
    if (storage.workflowDeliveries.get(id)) continue;
    storage.workflowDeliveries.put({ ...template, id });
  }
  storage.workflowDeliveryCount.put({ count, indexed: true });
  storage.nextWorkflowDeliveryId.put(count);
}

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

  // FAC-117 K2, the addition: Kernel 1's failure reasons are terminal, recorded result or not; a
  // cancelled run still running (it ends at its next guarded call) is still live work.
  it("treats a cancelled, timed-out or attempts-exhausted run as terminal, and a cancelled one still running as live", () => {
    for (let reason of ["cancelled", "timed-out", "attempts-exhausted"] as const) {
      expect(isLiveWorkflowDelivery({ run: {}, result: { outcome: "failed", reason } }), reason).toBe(false);
      expect(isLiveWorkflowDelivery({ run: {}, execution: { state: "failed" } }), reason).toBe(false);
    }
    expect(isLiveWorkflowDelivery({ run: {}, execution: { state: "running" } })).toBe(true);
  });
});

describe("saving a workflow definition", () => {
  it("keeps a revision of the gadget's current code for its owner, and publishes nothing", () => {
    let { store, headOf } = workspace();
    let saved = store.save(ADA, { title: " Intake ", gadgetId: GADGET }, headOf, "build");
    expect(saved).toMatchObject({
      title: "Intake", owner: ADA, published: null,
      revisions: [{ revision: 1, source: { kind: "gadget", gadgetId: GADGET, commitId: commit(1) } }],
    });
    expect(store.list(ADA.id, "build").map(d => d.id)).toEqual([saved.id]);
  });

  it("is visible only to its owner until published, and then only at the published revision", () => {
    let { store, heads, headOf } = workspace();
    let saved = store.save(ADA, { title: "Intake", gadgetId: GADGET }, headOf, "build");
    expect(store.list(BEN.id, "build")).toEqual([]);
    expect(store.get(BEN.id, saved.id, "build")).toBeNull();
    expect(() => store.deliveries(BEN.id, saved.id, "build")).toThrow("Workflow definition not found.");

    store.publish(ADA, saved.id, 1);
    heads.set(GADGET, commit(2));
    store.save(ADA, { id: saved.id, title: "Intake", gadgetId: GADGET }, headOf, "build");
    expect(store.get(ADA.id, saved.id, "build")?.revisions.map(r => r.revision)).toEqual([1, 2]);
    // Ben sees the published revision only, never Ada's newer draft.
    expect(store.get(BEN.id, saved.id, "build")?.revisions.map(r => r.revision)).toEqual([1]);
  });

  it("adds a revision only when the code changed; saving again with the same commit renames", () => {
    let { store, heads, headOf } = workspace();
    let saved = store.save(ADA, { title: "Intake", gadgetId: GADGET }, headOf, "build");
    let renamed = store.save(ADA, { id: saved.id, title: "Intake v1", gadgetId: GADGET }, headOf, "build");
    expect(renamed.revisions).toHaveLength(1);
    expect(renamed.title).toBe("Intake v1");
    heads.set(GADGET, commit(2));
    expect(store.save(ADA, { id: saved.id, title: "Intake", gadgetId: GADGET }, headOf, "build").revisions)
      .toHaveLength(2);
  });

  it("refuses another person's definition at save and publish as if it didn't exist", () => {
    let { store, headOf } = workspace();
    let saved = store.save(ADA, { title: "Intake", gadgetId: GADGET }, headOf, "build");
    expect(() => store.save(BEN, { id: saved.id, title: "Mine now", gadgetId: GADGET }, headOf, "build"))
      .toThrow("Workflow definition not found.");
    expect(() => store.publish(BEN, saved.id, 1)).toThrow("Workflow definition not found.");
    store.publish(ADA, saved.id, 1);
    // Published doesn't make it Ben's to change.
    expect(() => store.publish(BEN, saved.id, 1)).toThrow("Workflow definition not found.");
    expect(store.get(ADA.id, saved.id, "build")?.title).toBe("Intake");
  });

  it("doesn't exist in another workspace", () => {
    let a = workspace();
    let b = workspace();
    let saved = a.store.save(ADA, { title: "Intake", gadgetId: GADGET }, a.headOf, "build");
    a.store.publish(ADA, saved.id, 1);
    expect(b.store.get(ADA.id, saved.id, "build")).toBeNull();
    expect(() => b.store.publish(ADA, saved.id, 1)).toThrow("Workflow definition not found.");
  });

  it("refuses a gadget with no committed code, a bad title, and past the limits", () => {
    let { store, heads, headOf } = workspace();
    expect(() => store.save(ADA, { title: "Pending", gadgetId: 99 }, headOf, "build")).toThrow("committed code");
    expect(() => store.save(ADA, { title: " ", gadgetId: GADGET }, headOf, "build")).toThrow(TypeError);
    for (let i = 0; i < MAX_WORKSPACE_WORKFLOW_DEFINITIONS; i++) {
      store.save(ADA, { title: `Definition ${i}`, gadgetId: GADGET }, headOf, "build");
    }
    expect(() => store.save(BEN, { title: "One more", gadgetId: GADGET }, headOf, "build"))
      .toThrow("Workspace workflow definition limit reached.");

    let fresh = workspace();
    let saved = fresh.store.save(ADA, { title: "Busy", gadgetId: GADGET }, fresh.headOf, "build");
    for (let n = 2; n <= MAX_WORKFLOW_DEFINITION_REVISIONS; n++) {
      fresh.heads.set(GADGET, commit(n));
      fresh.store.save(ADA, { id: saved.id, title: "Busy", gadgetId: GADGET }, fresh.headOf, "build");
    }
    fresh.heads.set(GADGET, commit(999));
    expect(() => fresh.store.save(ADA, { id: saved.id, title: "Busy", gadgetId: GADGET }, fresh.headOf, "build"))
      .toThrow("revision limit");
    void heads;
  });
});

describe("triggers and runs", () => {
  it("lets two triggers reference one definition revision, storing a reference, not a copy", () => {
    let { store, headOf } = workspace();
    let saved = store.save(ADA, { title: "Intake", gadgetId: GADGET }, headOf, "build");
    store.pinTrigger(ADA.id, 11, GADGET, { definitionId: saved.id, revision: 1 });
    store.pinTrigger(ADA.id, 12, GADGET, { definitionId: saved.id, revision: 1 });
    expect(store.pinOf(11)).toEqual({ definitionId: saved.id, revision: 1, mode: "follow-latest" });
    expect(store.pinOf(12)).toEqual({ definitionId: saved.id, revision: 1, mode: "follow-latest" });
    expect(store.list(ADA.id, "build")).toHaveLength(1);
  });

  it("records the revision and commit each firing ran", () => {
    let { store, headOf } = workspace();
    let saved = store.save(ADA, { title: "Intake", gadgetId: GADGET }, headOf, "build");
    store.publish(ADA, saved.id, 1);
    store.pinTrigger(ADA.id, 11, GADGET, { definitionId: saved.id, revision: 1 });
    store.pinTrigger(ADA.id, 12, GADGET, { definitionId: saved.id, revision: 1 });
    expect(store.fire(11, GADGET, headOf, everyoneBuilds))
      .toMatchObject({ hookId: 11, definitionId: saved.id, revision: 1, commitId: commit(1) });
    store.fire(12, GADGET, headOf, everyoneBuilds);
    expect(store.deliveries(ADA.id, saved.id, "build").map(d => [d.hookId, d.revision])).toEqual([[11, 1], [12, 1]]);
  });

  it("deduplicates a schedule slot by trigger and planned UTC instant", () => {
    let { store, headOf, storage } = workspace();
    let saved = store.save(ADA, { title: "Intake", gadgetId: GADGET }, headOf);
    store.publish(ADA, saved.id, 1);
    store.pinTrigger(ADA.id, 11, GADGET, { definitionId: saved.id, revision: 1 });

    const slot = 1_800_000_000_000;
    let admitted = store.fire(11, GADGET, headOf, everyoneBuilds, undefined,
      { kind: "schedule", scheduledTime: slot })!;
    let retried = store.fire(11, GADGET, headOf, everyoneBuilds, undefined,
      { kind: "schedule", scheduledTime: slot })!;
    expect(admitted).toMatchObject({ deliveryId: 0, hookId: 11 });
    expect(retried).toMatchObject({ deliveryId: 0, hookId: 11 });
    expect(admitted).not.toHaveProperty("historyOwnerProfileId");
    expect(retried).not.toHaveProperty("historyOwnerProfileId");
    expect(store.fire(11, GADGET, headOf, everyoneBuilds, undefined,
      { kind: "schedule", scheduledTime: slot + 60_000 })).toMatchObject({ deliveryId: 1 });
    expect(Array.from(storage.workflowDeliveries.list(), d => d.hookId)).toEqual([11, 11]);
  });

  it("deduplicates trusted event deliveries per trigger and provider identity", () => {
    let { store, headOf, storage } = workspace();
    let saved = store.save(ADA, { title: "Email intake", gadgetId: GADGET }, headOf);
    store.publish(ADA, saved.id, 1);
    store.pinTrigger(ADA.id, 21, GADGET, { definitionId: saved.id, revision: 1 });
    store.pinTrigger(ADA.id, 22, GADGET, { definitionId: saved.id, revision: 1 });
    const occurrence = { kind: "event" as const, provider: "cloudflare-email", deliveryId: "sha256:abc" };

    store.fire(21, GADGET, headOf, everyoneBuilds, undefined, occurrence);
    expect(store.fire(21, GADGET, headOf, everyoneBuilds, undefined, occurrence))
      .toMatchObject({ deliveryId: 0, hookId: 21 });
    // Same provider delivery is independent for another trigger; a distinct byte digest is distinct
    // even when the email's sender-supplied Message-ID happens to match.
    expect(store.fire(22, GADGET, headOf, everyoneBuilds, undefined, occurrence)).toMatchObject({ deliveryId: 1 });
    expect(store.fire(21, GADGET, headOf, everyoneBuilds, undefined,
      { ...occurrence, deliveryId: "sha256:different-bytes" })).toMatchObject({ deliveryId: 2 });
    expect(Array.from(storage.workflowDeliveries.list())).toHaveLength(3);
  });

  it("gives separate manual presses separate server-minted occurrences", () => {
    let { store, headOf, storage } = workspace();
    let saved = store.save(ADA, { title: "Intake", gadgetId: GADGET }, headOf);
    store.publish(ADA, saved.id, 1);
    store.pinTrigger(ADA.id, 11, GADGET, { definitionId: saved.id, revision: 1 });
    store.fire(11, GADGET, headOf, everyoneBuilds);
    store.fire(11, GADGET, headOf, everyoneBuilds);
    expect(Array.from(storage.workflowDeliveries.list())).toHaveLength(2);
    expect(Array.from(storage.workflowOccurrences.list())).toHaveLength(2);
  });

  it("sweeps expired tombstones in bounded expiry order and deduplicates by key", () => {
    const now = Date.now();
    let { store, storage, headOf } = workspace();
    let saved = store.save(ADA, { title: "Intake", gadgetId: GADGET }, headOf);
    store.publish(ADA, saved.id, 1);
    store.pinTrigger(ADA.id, 11, GADGET, { definitionId: saved.id, revision: 1 });
    for (let index = 0; index < 101; index++) {
      let key = `11:expired:${index}`;
      let expiryKey = `${String(now - 1).padStart(16, "0")}:${key}`;
      storage.workflowOccurrences.put({ key, hookId: 11, deliveryId: index, expiresAt: now - 1 });
      storage.workflowOccurrenceExpiries.put({ key: expiryKey, occurrenceKey: key, hookId: 11 });
    }
    storage.workflowOccurrenceCounts.put({ hookId: 11, count: 101 });

    const occurrence = { kind: "schedule" as const, scheduledTime: 1_800_000_000_000 };
    let first = store.fire(11, GADGET, headOf, everyoneBuilds, undefined, occurrence)!;
    expect(Array.from(storage.workflowOccurrences.list())).toHaveLength(2); // 100 swept, one expired, one new
    expect(store.fire(11, GADGET, headOf, everyoneBuilds, undefined, occurrence))
      .toMatchObject({ deliveryId: first.deliveryId });
  });

  it("refuses at the per-trigger dedupe cap without deleting live tombstones", () => {
    let { store, storage, headOf } = workspace();
    let saved = store.save(ADA, { title: "Intake", gadgetId: GADGET }, headOf);
    store.publish(ADA, saved.id, 1);
    store.pinTrigger(ADA.id, 11, GADGET, { definitionId: saved.id, revision: 1 });
    storage.workflowOccurrenceCounts.put({ hookId: 11, count: MAX_WORKFLOW_OCCURRENCES_PER_TRIGGER });
    let existing = { key: "11:live", hookId: 11, deliveryId: 0, expiresAt: Date.now() + 60_000 };
    storage.workflowOccurrences.put(existing);
    storage.workflowOccurrenceExpiries.put({
      key: `${String(existing.expiresAt).padStart(16, "0")}:${existing.key}`,
      occurrenceKey: existing.key,
      hookId: 11,
    });

    expect(() => store.fire(11, GADGET, headOf, everyoneBuilds, undefined,
      { kind: "schedule", scheduledTime: 1_800_000_000_000 })).toThrow(/deduplication limit/);
    expect(storage.workflowOccurrences.get(existing.key)).toEqual(existing);
  });

  it("resumes an admitted occurrence after a crash and queues it only once", () => {
    let { store, headOf } = workspace();
    let saved = store.save(ADA, { title: "Scheduled", gadgetId: GADGET }, headOf);
    store.publish(ADA, saved.id, 1);
    store.pinTrigger(ADA.id, 11, GADGET, { definitionId: saved.id, revision: 1 });
    const occurrence = { kind: "schedule" as const, scheduledTime: 1_800_000_000_000 };
    let admitted = store.fire(11, GADGET, headOf, everyoneBuilds, undefined, occurrence)!;
    let retried = store.fire(11, GADGET, headOf, everyoneBuilds, undefined, occurrence)!;
    expect(retried.deliveryId).toBe(admitted.deliveryId);
    store.queueRun(11, admitted.deliveryId, "onSchedule", [{ scheduledTime: occurrence.scheduledTime }]);
    store.queueRun(11, retried.deliveryId, "onSchedule", [{ scheduledTime: occurrence.scheduledTime }]);
    expect(store.queuedRuns()).toEqual([{
      deliveryId: admitted.deliveryId,
      hookId: 11,
      method: "onSchedule",
      args: [{ scheduledTime: occurrence.scheduledTime }],
    }]);
  });

  it("keeps an explicit revision pin and requires an explicit move", () => {
    let { store, heads, headOf } = workspace();
    let saved = store.save(ADA, { title: "Intake", gadgetId: GADGET }, headOf, "build");
    store.publish(ADA, saved.id, 1);
    store.pinTrigger(ADA.id, 11, GADGET, { definitionId: saved.id, revision: 1, mode: "pinned" });
    heads.set(GADGET, commit(2));
    store.save(ADA, { id: saved.id, title: "Intake", gadgetId: GADGET }, headOf, "build");
    store.publish(ADA, saved.id, 2);
    expect(store.pinOf(11)).toEqual({ definitionId: saved.id, revision: 1, mode: "pinned" });
    expect(() => store.fire(11, GADGET, headOf, everyoneBuilds)).toThrow("changed since revision 1");
    store.pinTrigger(ADA.id, 11, GADGET, { definitionId: saved.id, revision: 2, mode: "pinned" });
    expect(store.fire(11, GADGET, headOf, everyoneBuilds)).toMatchObject({ revision: 2, commitId: commit(2) });
    heads.set(GADGET, commit(3));
    store.save(ADA, { id: saved.id, title: "Intake", gadgetId: GADGET }, headOf, "build");
    expect(() => store.fire(11, GADGET, headOf, everyoneBuilds)).toThrow("changed since revision 2");
  });

  it("keeps a stored legacy pin explicit when it has no mode field", () => {
    let { store, storage, heads, headOf } = workspace();
    let saved = store.save(ADA, { title: "Intake", gadgetId: GADGET }, headOf, "build");
    store.publish(ADA, saved.id, 1);
    store.pinTrigger(ADA.id, 11, GADGET, { definitionId: saved.id, revision: 1, mode: "pinned" });
    let { mode: _mode, ...legacyPin } = storage.workflowTriggerPins.get(11)!;
    storage.workflowTriggerPins.put(legacyPin);
    heads.set(GADGET, commit(2));
    store.save(ADA, { id: saved.id, title: "Intake", gadgetId: GADGET }, headOf, "build");
    store.publish(ADA, saved.id, 2);
    expect(store.pinOf(11)).toEqual({ definitionId: saved.id, revision: 1, mode: "pinned" });
    expect(() => store.fire(11, GADGET, headOf, everyoneBuilds)).toThrow("changed since revision 1");
  });

  it("refuses an admitted revision after the gadget head moves; new admissions follow latest", () => {
    let { store, heads, headOf } = workspace();
    let saved = store.save(ADA, { title: "Intake", gadgetId: GADGET }, headOf, "build");
    store.publish(ADA, saved.id, 1);
    store.pinTrigger(ADA.id, 11, GADGET, { definitionId: saved.id, revision: 1 });
    store.setControl(ADA, 11, { label: "Run", invokers: [BEN.id] });
    let invocation = store.beginInvocation(BEN.id, 11);
    heads.set(GADGET, commit(2));
    store.save(ADA, { id: saved.id, title: "Intake", gadgetId: GADGET }, headOf, "build");
    store.publish(ADA, saved.id, 2);
    expect(() => store.fire(11, GADGET, headOf, everyoneBuilds, invocation.id))
      .toThrow("The workflow changed; ask again");
    expect(store.deliveries(ADA.id, saved.id, "build")).toEqual([]);
    let nextInvocation = store.beginInvocation(BEN.id, 11);
    expect(store.fire(11, GADGET, headOf, everyoneBuilds, nextInvocation.id))
      .toMatchObject({ revision: 2, commitId: commit(2) });
    expect(store.fire(11, GADGET, headOf, everyoneBuilds)).toMatchObject({ revision: 2, commitId: commit(2) });
  });

  it("refuses to fire a definition that has never been published", () => {
    let { store, headOf } = workspace();
    let saved = store.save(ADA, { title: "Draft", gadgetId: GADGET }, headOf, "build");
    store.pinTrigger(ADA.id, 11, GADGET, { definitionId: saved.id, revision: 1 });
    expect(() => store.fire(11, GADGET, headOf, everyoneBuilds)).toThrow("This workflow has no published revision.");
    expect(store.deliveries(ADA.id, saved.id, "build")).toEqual([]);
  });

  it("does not evict a queued run when later deliveries fill the retention window", () => {
    let { store, storage, headOf } = workspace();
    let saved = store.save(ADA, { title: "Refund", gadgetId: GADGET }, headOf, "build");
    store.publish(ADA, saved.id, 1);
    store.pinTrigger(ADA.id, 11, GADGET, { definitionId: saved.id, revision: 1 });
    store.setControl(ADA, 11, { label: "Run", invokers: [BEN.id] });
    let invocation = store.beginInvocation(BEN.id, 11);
    let first = store.fire(11, GADGET, headOf, everyoneBuilds, invocation.id)!;
    store.queueRun(11, first.deliveryId, "run", []);
    fillRetainedDeliveries(storage, first);
    expect(store.run(first.run!.runId)).toMatchObject({ revision: 1, commitId: commit(1) });
    expect(store.queuedRuns()).toContainEqual({ deliveryId: first.deliveryId, hookId: 11, method: "run", args: [] });
  });


  it("refuses at the cap without evicting uncertain or in-window terminal history", () => {
    let { store, storage, headOf } = workspace({ max: 3 });
    let saved = store.save(ADA, { title: "Refund", gadgetId: GADGET }, headOf, "build");

    store.publish(ADA, saved.id, 1);
    store.pinTrigger(ADA.id, 11, GADGET, { definitionId: saved.id, revision: 1 });
    let first = store.fire(11, GADGET, headOf, everyoneBuilds)!;
    store.recordResult(first.deliveryId, { outcome: "uncertain", reason: "lost-after-write" });
    fillRetainedDeliveries(storage, { ...first, result: { outcome: "uncertain", reason: "lost-after-write" } }, 3);
    expect(() => store.fire(11, GADGET, headOf, everyoneBuilds))

      .toThrow("Wait for older completed runs to expire");
    expect(store.deliveries(ADA.id, saved.id, "build")).toHaveLength(3);
    expect(store.run(first.run!.runId)).not.toBeNull();
  });

  // FAC-117 K2, the addition: each of Kernel 1's failure reasons gets a history expiry, so its
  // definition can be swept; an uncertain run keeps none until it is settled.
  it("indexes a cancelled, timed-out or attempts-exhausted run for expiry, and an uncertain one not until settled", () => {
    let { store, storage, headOf } = workspace({ max: 10 });
    let saved = store.save(ADA, { title: "Refund", gadgetId: GADGET }, headOf, "build");
    store.publish(ADA, saved.id, 1);
    store.pinTrigger(ADA.id, 11, GADGET, { definitionId: saved.id, revision: 1 });
    const indexed = () => [...storage.workflowDeliveryExpiries.list()].map(pointer => pointer.deliveryId);
    for (let reason of ["cancelled", "timed-out", "attempts-exhausted"] as const) {
      let delivery = store.fire(11, GADGET, headOf, everyoneBuilds)!;
      store.recordResult(delivery.deliveryId, { outcome: "failed", reason });
      expect(indexed(), reason).toContain(delivery.deliveryId);
    }
    let uncertain = store.fire(11, GADGET, headOf, everyoneBuilds)!;
    store.recordResult(uncertain.deliveryId, { outcome: "uncertain", reason: "action-unknown" });
    expect(indexed()).not.toContain(uncertain.deliveryId);
    store.recordResult(uncertain.deliveryId, { outcome: "failed", reason: "runtime-error" });
    expect(indexed()).toContain(uncertain.deliveryId);
  });

  it("expires not-started history after the start window", () => {
    let now = Date.now();
    let { store, headOf } = workspace({ max: 3, ttlMs: 1, now: () => now });
    let saved = store.save(ADA, { title: "Refund", gadgetId: GADGET }, headOf, "build");

    store.publish(ADA, saved.id, 1);
    store.pinTrigger(ADA.id, 11, GADGET, { definitionId: saved.id, revision: 1 });
    let first = store.fire(11, GADGET, headOf, everyoneBuilds)!;
    store.fire(11, GADGET, headOf, everyoneBuilds);
    store.fire(11, GADGET, headOf, everyoneBuilds);
    now += WORKFLOW_RUN_START_WINDOW_MS + 10_000;
    let admitted = store.fire(11, GADGET, headOf, everyoneBuilds)!;
    expect(store.run(first.run!.runId)).toBeNull();
    expect(store.deliveries(ADA.id, saved.id, "build")).toHaveLength(1);
    expect(admitted.run).toBeDefined();
  });

  it("expires legacy finished history without a result using endedAt", () => {
    let now = Date.now();
    let { store, headOf } = workspace({ max: 3, ttlMs: 1, now: () => now });
    let saved = store.save(ADA, { title: "Refund", gadgetId: GADGET }, headOf, "build");

    store.publish(ADA, saved.id, 1);
    store.pinTrigger(ADA.id, 11, GADGET, { definitionId: saved.id, revision: 1 });
    let first = store.fire(11, GADGET, headOf, everyoneBuilds)!;
    store.queueRun(11, first.deliveryId, "run", []);
    store.endRun(first.deliveryId);
    now += 10_000;

    expect(store.sweepExpiredRunHistory(now)).toBe(1);
    let admitted = store.fire(11, GADGET, headOf, everyoneBuilds)!;
    expect(store.run(first.run!.runId)).toBeNull();
    expect(admitted.run).toBeDefined();
  });

  it("sweeps expired history across multiple bounded batches before refusing admission", () => {
    let now = Date.now();
    let { store, storage, headOf } = workspace({ max: 1_000, ttlMs: 1, now: () => now });
    let saved = store.save(ADA, { title: "Refund", gadgetId: GADGET }, headOf, "build");

    store.publish(ADA, saved.id, 1);
    store.pinTrigger(ADA.id, 11, GADGET, { definitionId: saved.id, revision: 1 });
    let first = store.fire(11, GADGET, headOf, everyoneBuilds)!;
    fillRetainedDeliveries(storage, first, 1_105);
    let oldAt = new Date(now - WORKFLOW_RUN_START_WINDOW_MS - 10_000);
    for (let delivery of storage.workflowDeliveries.list()) {
      storage.workflowDeliveries.put({ ...delivery, at: oldAt });
    }
    storage.workflowDeliveryCount.put({ count: 1_105, indexed: false });
    now += WORKFLOW_RUN_START_WINDOW_MS + 10_000;

    let admitted = store.fire(11, GADGET, headOf, everyoneBuilds)!;
    expect(store.deliveries(ADA.id, saved.id, "build")).toHaveLength(906);
    expect(admitted.run).toBeDefined();
  });

  it("limits each admission to two history batches and leaves a due backlog for later alarm passes", () => {
    let now = Date.now();
    let { store, storage, headOf } = workspace({ max: 1_000, ttlMs: 1, now: () => now });
    let saved = store.save(ADA, { title: "Refund", gadgetId: GADGET }, headOf, "build");
    store.publish(ADA, saved.id, 1);
    store.pinTrigger(ADA.id, 11, GADGET, { definitionId: saved.id, revision: 1 });
    let template = store.fire(11, GADGET, headOf, everyoneBuilds)!;
    let count = 2_505;
    fillRetainedDeliveries(storage, template, count);
    for (let pointer of storage.workflowDeliveryExpiries.list()) {
      storage.workflowDeliveryExpiries.delete(pointer.key);
    }
    let oldAt = new Date(now - WORKFLOW_RUN_START_WINDOW_MS - 10_000);
    let expiry = oldAt.getTime() + WORKFLOW_RUN_START_WINDOW_MS + 1;
    for (let delivery of storage.workflowDeliveries.list()) {
      storage.workflowDeliveries.put({ ...delivery, at: oldAt });
      storage.workflowDeliveryExpiries.put({
        key: `${String(expiry).padStart(16, "0")}:${String(delivery.id).padStart(16, "0")}`,
        deliveryId: delivery.id,
      });
    }
    now += WORKFLOW_RUN_START_WINDOW_MS + 20_000;

    expect(() => store.fire(11, GADGET, headOf, everyoneBuilds)).toThrow(WORKFLOW_RUN_HISTORY_CAP_REFUSAL);
    expect(storage.workflowDeliveryCount.get()?.count).toBe(count - 2 * WORKFLOW_RUN_HISTORY_SWEEP_BATCH);
    expect(store.hasDueRunHistory(now)).toBe(true);
    expect(store.nextRunHistorySweep(now)).toBe(now + WORKFLOW_RUN_HISTORY_SWEEP_RETRY_MS);

    let passes = 0;
    while (store.hasDueRunHistory(now)) {
      expect(store.sweepExpiredRunHistory(now)).toBeLessThanOrEqual(WORKFLOW_RUN_HISTORY_SWEEP_BATCH);
      passes++;
    }
    expect(passes).toBeGreaterThan(1);
    expect(storage.workflowDeliveryCount.get()?.count).toBe(0);
    expect(store.nextRunHistorySweep(now)).toBeUndefined();
  });

  it("expires reconciled terminal history before admitting at the cap", () => {
    let now = Date.now();
    let { store, storage, headOf } = workspace({ max: 3, ttlMs: 1, now: () => now });
    let saved = store.save(ADA, { title: "Refund", gadgetId: GADGET }, headOf, "build");

    store.publish(ADA, saved.id, 1);
    store.pinTrigger(ADA.id, 11, GADGET, { definitionId: saved.id, revision: 1 });
    let first = store.fire(11, GADGET, headOf, everyoneBuilds)!;
    let template = store.fire(11, GADGET, headOf, everyoneBuilds)!;
    fillRetainedDeliveries(storage, template, 3);
    store.recordResult(first.deliveryId, { outcome: "failed", reason: "runtime-error" });
    now = Date.now() + 10_000;
    store.fire(11, GADGET, headOf, everyoneBuilds);

    expect(store.deliveries(ADA.id, saved.id, "build")).toHaveLength(3);
    expect(store.deliveries(ADA.id, saved.id, "build").some(delivery => delivery.result?.outcome === "failed")).toBe(false);

  });

  it("keeps an owner's run history listable after its temporary definition is swept", () => {
    let now = Date.now();
    let { store, storage, headOf } = workspace({ now: () => now });
    let saved = store.save(ADA, { title: "Temporary", gadgetId: GADGET, retain: false }, headOf, "build");
    store.publish(ADA, saved.id, 1);
    store.pinTrigger(ADA.id, 11, GADGET, { definitionId: saved.id, revision: 1 });
    let run = store.fire(11, GADGET, headOf, everyoneBuilds)!;
    store.recordResult(run.deliveryId, { outcome: "succeeded" });
    store.pinTrigger(ADA.id, 11, GADGET, null);
    let legacy = storage.workflowDeliveries.get(run.deliveryId)!;
    delete legacy.historyOwnerProfileId;
    storage.workflowDeliveries.put(legacy);
    storage.workflowDeliveryCount.put(null);
    now += 25 * 60 * 60_000;

    expect(store.sweepExpired()).toBe(1);
    expect(store.get(ADA.id, saved.id)).toBeNull();
    expect(store.deliveries(ADA.id, saved.id, "build")).toHaveLength(1);
    expect(() => store.deliveries(BEN.id, saved.id, "build")).toThrow("Workflow definition not found.");
    expect(store.deliveries(ADA.id, saved.id, "build")[0]).not.toHaveProperty("historyOwnerProfileId");
    expect(() => store.deliveries(BEN.id, saved.id, null)).toThrow("Workflow definition not found.");
  });

  it('returns the server-computed retention date for terminal history and no date for live history', () => {
    let { store, headOf } = workspace({ ttlMs: 90 * 24 * 60 * 60_000 });
    let saved = store.save(ADA, { title: 'Refund', gadgetId: GADGET }, headOf, 'build');
    store.publish(ADA, saved.id, 1);
    store.pinTrigger(ADA.id, 11, GADGET, { definitionId: saved.id, revision: 1 });
    let settled = store.fire(11, GADGET, headOf, everyoneBuilds)!;
    store.recordResult(settled.deliveryId, { outcome: 'succeeded' });
    let live = store.fire(11, GADGET, headOf, everyoneBuilds)!;

    let rows = store.deliveries(ADA.id, saved.id, 'build');
    let terminal = rows.find(delivery => delivery.result?.outcome === 'succeeded')!;
    let waiting = rows.find(delivery => delivery.run?.runId === live.run?.runId)!;
    expect(terminal.historyExpiresAt).toEqual(
      new Date(terminal.result!.settledAt!.getTime() + 90 * 24 * 60 * 60_000),
    );
    expect(waiting.historyExpiresAt).toBeNull();
  });

  it("builds the legacy history index from the former 1,000-delivery cap on first admission", () => {
    let { store, storage, headOf } = workspace({ max: 10_000 });
    let saved = store.save(ADA, { title: "Legacy", gadgetId: GADGET }, headOf, "build");
    store.publish(ADA, saved.id, 1);
    store.pinTrigger(ADA.id, 11, GADGET, { definitionId: saved.id, revision: 1 });
    let template = store.fire(11, GADGET, headOf, everyoneBuilds)!;

    // Simulate the bounded pre-FAC-125 history in a workspace upgrading for the first time.
    fillRetainedDeliveries(storage, template, 1_000);
    storage.workflowDeliveryCount.put(null);
    for (let pointer of storage.workflowDeliveryExpiries.list()) {
      storage.workflowDeliveryExpiries.delete(pointer.key);
    }

    let admitted = store.fire(11, GADGET, headOf, everyoneBuilds)!;
    expect(admitted.run).toBeDefined();
    expect(storage.workflowDeliveryCount.get()).toEqual({ count: 1_001, indexed: true });

    let indexedLegacyDelivery = storage.workflowDeliveries.get(0)!;
    delete indexedLegacyDelivery.historyOwnerProfileId;
    storage.workflowDeliveries.put(indexedLegacyDelivery);
    store.fire(11, GADGET, headOf, everyoneBuilds);
    expect(storage.workflowDeliveries.get(0)).not.toHaveProperty("historyOwnerProfileId");
    expect(storage.workflowDeliveryCount.get()).toEqual({ count: 1_002, indexed: true });
  });

  it("refuses follow-latest when the gadget head is newer than the published commit", () => {
    let { store, heads, headOf } = workspace();
    let saved = store.save(ADA, { title: "Intake", gadgetId: GADGET }, headOf, "build");
    store.publish(ADA, saved.id, 1);
    store.pinTrigger(ADA.id, 11, GADGET, { definitionId: saved.id, revision: 1 });
    heads.set(GADGET, commit(7));
    store.save(ADA, { id: saved.id, title: "Intake", gadgetId: GADGET }, headOf, "build");
    expect(() => store.fire(11, GADGET, headOf, everyoneBuilds)).toThrow("changed since revision 1 was saved");
    expect(() => store.requireCurrentRevision(11, GADGET, headOf)).toThrow("changed since revision 1 was saved");
  });

  it("refuses a definition with no publication and allows a published one", () => {
    let { store, headOf } = workspace();
    let draft = store.save(ADA, { title: "Draft", gadgetId: GADGET }, headOf, "build");
    let live = store.save(ADA, { title: "Live", gadgetId: GADGET }, headOf, "build");
    store.publish(ADA, live.id, 1);
    store.pinTrigger(ADA.id, 11, GADGET, { definitionId: draft.id, revision: 1, mode: "follow-latest" });
    store.pinTrigger(ADA.id, 12, GADGET, { definitionId: live.id, revision: 1 });
    expect(() => store.fire(11, GADGET, headOf, everyoneBuilds)).toThrow("This workflow has no published revision.");
    expect(store.fire(12, GADGET, headOf, everyoneBuilds)).toMatchObject({ definitionId: live.id });
  });

  it("refuses to pin another person's unpublished revision, or one for another gadget", () => {
    let { store, headOf } = workspace();
    let saved = store.save(ADA, { title: "Intake", gadgetId: GADGET }, headOf, "build");
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
    let saved = store.save(ADA, { title: "Intake", gadgetId: GADGET }, headOf, "build");
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
        workflowDefinitionStore: () => store, definitionRoles: async () => () => "use" as const,
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

  // FAC-124: a dynamic definition over the RPC, and a tampered `retain` refused there too.
  it("creates a dynamic definition over the RPC, with its expiry, and refuses a retain that isn't a boolean", async () => {
    let { overseer } = await session({ role: "build", answers: { build: true, publish: true } });
    let made = await overseer.saveWorkflowDefinition({ title: "One-off", gadgetId: GADGET, retain: false });
    expect(made.expiresAt).toBeInstanceOf(Date);
    let kept = await overseer.saveWorkflowDefinition({ id: made.id, title: "Kept", gadgetId: GADGET });
    expect(kept).not.toHaveProperty("expiresAt");
    // Refused at the RPC boundary, before the store.
    await expect(async () => overseer.saveWorkflowDefinition({ title: "X", gadgetId: GADGET, retain: "no" } as never))
      .rejects.toThrow("retain");
  });

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
    let draft = store.save(BEN, { title: "Draft", gadgetId: GADGET }, headOf, "build");
    let live = store.save(BEN, { title: "Live", gadgetId: GADGET }, headOf, "build");
    store.publish(BEN, live.id, 1);
    expect((await overseer.listWorkflowDefinitions()).map(d => d.id)).toEqual([live.id]);
    void draft;
    await expect(overseer.saveWorkflowDefinition({ title: "Mine", gadgetId: GADGET })).rejects.toThrow();
    await expect(overseer.exportWorkspaceRecords()).rejects.toThrow();
    await expect(overseer.publishWorkflowDefinition(live.id, 1)).rejects.toThrow();
    await expect(overseer.pinTriggerDefinition(11, null)).rejects.toThrow();
    await expect(overseer.listReadableWorkflowHistories()).rejects.toThrow();
  });
});

describe("readable workflow-history discovery", () => {
  it("lists owned and edit-shared histories after a definition is swept, but not a stranger's", () => {
    let now = Date.now();
    let { store, headOf } = workspace({ now: () => now });
    let saved = store.save(ADA, { title: "Temporary", gadgetId: GADGET, retain: false }, headOf, "build");
    store.publish(ADA, saved.id, 1);
    store.pinTrigger(ADA.id, 11, GADGET, { definitionId: saved.id, revision: 1 });
    let delivery = store.fire(11, GADGET, headOf, everyoneBuilds)!;
    store.recordResult(delivery.deliveryId, { outcome: "succeeded" });
    store.pinTrigger(ADA.id, 11, GADGET, null);
    now += 25 * 60 * 60_000;
    expect(store.sweepExpired()).toBe(1);

    expect(store.listReadableWorkflowHistories(ADA.id, "build")).toEqual([{ definitionId: saved.id }]);
    expect(store.listReadableWorkflowHistories(BEN.id, "use")).toEqual([]);
    expect(store.listReadableWorkflowHistories("stranger-profile", "build")).toEqual([]);
  });

  it("lists an existing history shared with an editor, using the delivery-read rule", () => {
    let { store, headOf } = workspace();
    let saved = store.save(ADA, { title: "Retained", gadgetId: GADGET, retain: true }, headOf, "build");
    store.publish(ADA, saved.id, 1);
    store.pinTrigger(ADA.id, 11, GADGET, { definitionId: saved.id, revision: 1 });
    store.fire(11, GADGET, headOf, everyoneBuilds);
    store.share(ADA, saved.id, BEN.id, { edit: true }, "build");

    expect(store.listReadableWorkflowHistories(BEN.id, "build")).toEqual([{ definitionId: saved.id }]);
    expect(store.listReadableWorkflowHistories(BEN.id, "use")).toEqual([]);
  });

  it("does not discover a different workspace's histories", () => {
    let first = workspace();
    let second = workspace();
    let saved = second.store.save(BEN, { title: "Other workspace", gadgetId: GADGET }, second.headOf, "build");
    second.store.publish(BEN, saved.id, 1);
    second.store.pinTrigger(BEN.id, 11, GADGET, { definitionId: saved.id, revision: 1 });
    second.store.fire(11, GADGET, second.headOf, everyoneBuilds);

    expect(first.store.listReadableWorkflowHistories(ADA.id, "build")).toEqual([]);
  });
});
