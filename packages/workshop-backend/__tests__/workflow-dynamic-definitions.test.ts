// Dynamic, unsaved workflow definitions (FAC-124; inferops docs/human/architecture/workflows.md,
// Retention rules): a definition created with `retain: false` expires at its TTL unless saved. Expiry
// blocks new use only: a pinned (scheduled) definition is kept while its pin exists, one a live run
// names is kept until the run ends, and run records are never touched. Saving and cleanup are each
// one storage transaction reading the clock inside it, so whichever runs first wins by one time
// rule. Over the production overseer storage on a mock, with a clock the test moves.
import { describe, expect, it } from "vitest";
import { dynamicDefinitionTtlMs, isLiveWorkflowDelivery, MAX_WORKSPACE_WORKFLOW_DEFINITIONS, WORKFLOW_DEFINITION_EXPIRED } from "@gadgets/workshop-shared/workflow-definition";
import { makeOverseerStorage } from "../src/overseer.js";
import { WorkspaceWorkflowDefinitionStore } from "../src/workflow-definition-store.js";
import { makeMockStorage } from "./mock-storage.js";

const ADA = { type: "user" as const, id: "ada-profile", name: "Ada" };
const BEN = { type: "user" as const, id: "ben-profile", name: "Ben" };
const GADGET = 3;
const HOOK = 7;
const HOUR = 60 * 60 * 1000;
const START = Date.UTC(2026, 10, 10, 9, 0, 0);
const commit = (n: number) => n.toString(16).padStart(40, "0");
const everyoneBuilds = () => true;
const headOf = (id: number) => (id === GADGET ? commit(1) : undefined);

/** One workspace whose clock the test moves, with a 24 h TTL unless `ttl` says otherwise. */
function workspace(ttl: () => number = () => 24 * HOUR) {
  let durable = makeMockStorage();
  let storage = makeOverseerStorage(durable);
  let clock = { now: START };
  let store = new WorkspaceWorkflowDefinitionStore(durable, storage, { now: () => clock.now, dynamicTtlMs: ttl });
  let temporary = () => store.save(ADA, { title: "One-off", gadgetId: GADGET, retain: false }, headOf);
  return { store, storage, clock, temporary };
}

describe("a dynamic definition", () => {
  it("is created with retain: false, expiring at its TTL, and is its owner's like any other", () => {
    let { store, temporary } = workspace();
    let made = temporary();
    expect(made.expiresAt).toEqual(new Date(START + 24 * HOUR));
    expect(store.get(ADA.id, made.id)?.expiresAt).toEqual(new Date(START + 24 * HOUR));
    expect(store.get(BEN.id, made.id)).toBeNull();
  });

  it("is retained by saving it, keeping its id and revisions, and expires no more", () => {
    let { store, clock, temporary } = workspace();
    let made = temporary();
    clock.now = START + 23 * HOUR;
    let saved = store.save(ADA, { id: made.id, title: "Kept", gadgetId: GADGET }, headOf);
    expect(saved.id).toBe(made.id);
    expect(saved.revisions.map(r => r.revision)).toEqual([1]);
    expect(saved).not.toHaveProperty("expiresAt");
    clock.now = START + 1000 * HOUR;
    expect(store.sweepExpired()).toBe(0);
    expect(store.get(ADA.id, made.id)?.title).toBe("Kept");
  });

  it("refuses a retain that isn't a boolean, and making a saved definition temporary; true keeps one", () => {
    let { store } = workspace();
    expect(() => store.save(ADA, { title: "X", gadgetId: GADGET, retain: "no" } as never, headOf)).toThrow("retain");
    expect(store.save(ADA, { title: "Kept", gadgetId: GADGET, retain: true }, headOf)).not.toHaveProperty("expiresAt");
    let saved = store.save(ADA, { title: "Saved", gadgetId: GADGET }, headOf);
    expect(() => store.save(ADA, { id: saved.id, title: "Saved", gadgetId: GADGET, retain: false }, headOf))
      .toThrow("A saved workflow can't be made temporary.");
  });

  it("refuses to create one when the deployment's TTL is misconfigured, and still saves retained ones", () => {
    let { store, temporary } = workspace(() => dynamicDefinitionTtlMs("0"));
    expect(temporary).toThrow("WORKFLOW_DYNAMIC_DEFINITION_TTL_HOURS");
    expect(store.save(ADA, { title: "Saved", gadgetId: GADGET }, headOf).id).toBeTruthy();
  });
});

describe("the TTL setting", () => {
  it("defaults to 24 hours and takes a whole number of hours from 1 to 720", () => {
    expect(dynamicDefinitionTtlMs(undefined)).toBe(24 * HOUR);
    expect(dynamicDefinitionTtlMs("1")).toBe(HOUR);
    expect(dynamicDefinitionTtlMs("720")).toBe(720 * HOUR);
    for (let bad of ["0", "721", "1.5", "-3", "abc", ""]) {
      expect(() => dynamicDefinitionTtlMs(bad), bad).toThrow("WORKFLOW_DYNAMIC_DEFINITION_TTL_HOURS");
    }
  });
});

describe("expiry blocks new use (acceptance 1)", () => {
  it("hides an expired definition and refuses every new use of it, exactly from its expiry", () => {
    let { store, clock, temporary } = workspace();
    let made = temporary();
    store.publish(ADA, made.id, 1);
    clock.now = START + 24 * HOUR - 1;
    expect(store.get(BEN.id, made.id)).not.toBeNull();
    clock.now = START + 24 * HOUR;
    expect(store.list(ADA.id)).toEqual([]);
    expect(store.get(ADA.id, made.id)).toBeNull();
    expect(store.get(BEN.id, made.id)).toBeNull();
    expect(() => store.publish(ADA, made.id, 1)).toThrow(WORKFLOW_DEFINITION_EXPIRED);
    expect(() => store.save(ADA, { id: made.id, title: "Late", gadgetId: GADGET }, headOf)).toThrow(WORKFLOW_DEFINITION_EXPIRED);
    expect(() => store.pinTrigger(ADA.id, HOOK, GADGET, { definitionId: made.id, revision: 1, mode: "pinned" })).toThrow();
  });

  it("leaves a run already admitted, and its records, running and readable past expiry; cleans up after it ends", () => {
    let { store, storage, clock, temporary } = workspace();
    let made = temporary();
    store.pinTrigger(ADA.id, HOOK, GADGET, { definitionId: made.id, revision: 1, mode: "pinned" });
    store.setControl(ADA, HOOK, { label: "Run it", invokers: [ADA.id] });
    let invocation = store.beginInvocation(ADA.id, HOOK, null);
    let delivery = store.fire(HOOK, GADGET, headOf, everyoneBuilds, invocation.id)!;
    store.queueRun(HOOK, delivery.deliveryId, null, []);
    // The trigger goes while its run waits; then the definition expires.
    store.pinTrigger(ADA.id, HOOK, GADGET, null);
    clock.now = START + 25 * HOUR;
    expect(store.get(ADA.id, made.id)).toBeNull();
    expect(store.sweepExpired()).toBe(0);
    expect(store.startRun(delivery.deliveryId)?.definitionId).toBe(made.id);
    expect(isLiveWorkflowDelivery(storage.workflowDeliveries.get(delivery.deliveryId)!)).toBe(true);
    expect(store.sweepExpired()).toBe(0);
    store.endRun(delivery.deliveryId);
    expect(store.sweepExpired()).toBe(1);
    // The run's record outlives its definition.
    expect(storage.workflowDeliveries.get(delivery.deliveryId)).toMatchObject({ definitionId: made.id, execution: { state: "finished" } });
    expect(storage.workflowDefinitions.get(made.id)).toBeUndefined();
  });

  it("deletes only expired dynamic definitions nothing keeps: never a saved one, an unexpired one or another workspace's", () => {
    let { store, clock, temporary } = workspace();
    let other = workspace();
    let expiring = temporary();
    clock.now = START + HOUR;
    let later = temporary();
    let saved = store.save(ADA, { title: "Saved", gadgetId: GADGET }, headOf);
    let elsewhere = other.temporary();
    clock.now = START + 24 * HOUR;
    expect(store.sweepExpired()).toBe(1);
    expect(store.get(ADA.id, expiring.id)).toBeNull();
    expect(store.get(ADA.id, later.id)).not.toBeNull();
    expect(store.get(ADA.id, saved.id)).not.toBeNull();
    // Another workspace has its own storage and clock.
    expect(other.store.get(ADA.id, elsewhere.id)).not.toBeNull();
  });

  it("names the next expiry to wake for, and none once nothing is temporary", () => {
    let { store, clock, temporary } = workspace();
    expect(store.nextExpiry()).toBeUndefined();
    let first = temporary();
    clock.now = START + HOUR;
    temporary();
    expect(store.nextExpiry()).toBe(START + 24 * HOUR);
    store.save(ADA, { id: first.id, title: "Kept", gadgetId: GADGET }, headOf);
    expect(store.nextExpiry()).toBe(START + 25 * HOUR);
  });
});

describe("a scheduled dynamic definition (acceptance 2)", () => {
  it("is kept, and stays usable, while a trigger is pinned to it; it expires once the pin goes", () => {
    let { store, clock, temporary } = workspace();
    let made = temporary();
    store.pinTrigger(ADA.id, HOOK, GADGET, { definitionId: made.id, revision: 1, mode: "pinned" });
    clock.now = START + 100 * HOUR;
    expect(store.sweepExpired()).toBe(0);
    expect(store.get(ADA.id, made.id)).not.toBeNull();
    let fired = store.fire(HOOK, GADGET, headOf, everyoneBuilds)!;
    expect(fired).toMatchObject({ definitionId: made.id });
    store.pinTrigger(ADA.id, HOOK, GADGET, null);
    expect(store.get(ADA.id, made.id)).toBeNull();
    // The scheduled firing's run is live until it settles (FAC-108's rule), and keeps it till then.
    expect(store.sweepExpired()).toBe(0);
    store.recordResult(fired.deliveryId, { outcome: "succeeded" });
    expect(store.sweepExpired()).toBe(1);
  });
});

describe("saving at the moment of cleanup (acceptance 2)", () => {
  it("is decided by one rule whichever runs first: a save before expiry keeps it, one at expiry loses", () => {
    // Save first, a millisecond before expiry: it wins, and the sweep after it keeps the definition.
    let a = workspace();
    let made = a.temporary();
    a.clock.now = START + 24 * HOUR - 1;
    a.store.save(ADA, { id: made.id, title: "Kept", gadgetId: GADGET }, headOf);
    a.clock.now = START + 24 * HOUR;
    expect(a.store.sweepExpired()).toBe(0);
    expect(a.store.get(ADA.id, made.id)).not.toBeNull();

    // At expiry, a save is refused even before any sweep has run; the sweep then deletes it.
    let b = workspace();
    let gone = b.temporary();
    b.clock.now = START + 24 * HOUR;
    expect(() => b.store.save(ADA, { id: gone.id, title: "Late", gadgetId: GADGET }, headOf)).toThrow(WORKFLOW_DEFINITION_EXPIRED);
    expect(b.store.sweepExpired()).toBe(1);

    // Sweep first, at expiry: the save after it finds nothing to keep.
    let c = workspace();
    let swept = c.temporary();
    c.clock.now = START + 24 * HOUR;
    expect(c.store.sweepExpired()).toBe(1);
    expect(() => c.store.save(ADA, { id: swept.id, title: "Late", gadgetId: GADGET }, headOf)).toThrow();
    expect(c.store.get(ADA.id, swept.id)).toBeNull();
  });
});

// #416 round 1: the store says when what it must sweep has changed, so the Overseer can reschedule
// its alarm; and the next expiry includes one already past that nothing keeps any more.
describe("telling the Overseer when to wake", () => {
  it("reports each change to what expires: a new dynamic definition, retaining it, a pin added or removed", () => {
    let durable = makeMockStorage();
    let clock = { now: START };
    let changes = 0;
    let store = new WorkspaceWorkflowDefinitionStore(durable, makeOverseerStorage(durable),
      { now: () => clock.now, dynamicTtlMs: () => 24 * HOUR, onChange: () => { changes++; } });
    let made = store.save(ADA, { title: "One-off", gadgetId: GADGET, retain: false }, headOf);
    expect(changes).toBeGreaterThanOrEqual(1);
    let before = changes;
    store.pinTrigger(ADA.id, HOOK, GADGET, { definitionId: made.id, revision: 1, mode: "pinned" });
    expect(changes).toBeGreaterThan(before);
    before = changes;
    store.pinTrigger(ADA.id, HOOK, GADGET, null);
    expect(changes).toBeGreaterThan(before);
    before = changes;
    store.save(ADA, { id: made.id, title: "Kept", gadgetId: GADGET }, headOf);
    expect(changes).toBeGreaterThan(before);
  });

  it("names an expired definition nothing keeps as due now, and never one a pin or a live run keeps", () => {
    let { store, clock, temporary } = workspace();
    let made = temporary();
    store.pinTrigger(ADA.id, HOOK, GADGET, { definitionId: made.id, revision: 1, mode: "pinned" });
    clock.now = START + 30 * HOUR;
    expect(store.nextExpiry()).toBeUndefined();
    store.pinTrigger(ADA.id, HOOK, GADGET, null);
    expect(store.nextExpiry()).toBe(START + 24 * HOUR);
  });
});

// #416 round 1, r1's LOW: expired definitions nothing keeps don't hold the definition limit, even
// before any alarm has swept them.
it("lets a new definition be created when the limit is full of expired, unkept ones", () => {
  let { store, clock, temporary } = workspace();
  for (let i = 0; i < MAX_WORKSPACE_WORKFLOW_DEFINITIONS; i++) temporary();
  expect(() => store.save(ADA, { title: "One more", gadgetId: GADGET }, headOf)).toThrow("limit");
  clock.now = START + 24 * HOUR;
  expect(store.save(ADA, { title: "One more", gadgetId: GADGET }, headOf).id).toBeTruthy();
  expect(store.list(ADA.id).map(d => d.title)).toEqual(["One more"]);
});
