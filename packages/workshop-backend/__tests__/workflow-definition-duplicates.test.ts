// FAC-123: duplicating a workflow definition makes an independently owned copy, in the same
// workspace: a fresh revision 1 of a new workflow gadget at the source revision's commit, with a
// record of where it came from that grants nothing. None of the source's connections, shares,
// publication, triggers, assignments or runs come with it. Each of the source gadget's connections
// becomes a requirement that only a connection the duplicator makes from their own account or model
// fills, checked as at install (InferOps' company included), and its runs are refused until each is
// set up (the run-start and write checks are in workflow-run-execution.test.ts, over a real Overseer).
import { describe, expect, it, vi } from "vitest";
import {
  MAX_WORKSPACE_WORKFLOW_DEFINITIONS, WORKFLOW_BINDINGS_NEEDED, WORKFLOW_DEFINITION_EXPIRED,
  type WorkflowRequiredBinding,
} from "@gadgets/workshop-shared/workflow-definition";
import { makeOverseerStorage, WORKFLOW_INVOKE_REFUSED } from "../src/overseer.js";
import {
  SHARED_ONLY_AUDIENCE, WORKSPACE_AUDIENCE, WorkspaceWorkflowDefinitionStore, shareKey,
  type WorkflowDefinitionAudience,
} from "../src/workflow-definition-store.js";
import {
  DUPLICATE_UNSUPPORTED_BINDING, checkAssignments, fills, requireBound, requirementsOf, unmetBindings,
} from "../src/workflow-duplicate.js";
import { WORKFLOW_BINDINGS_NOT_OWNERS, WORKFLOW_BINDINGS_UNATTRIBUTED } from "@gadgets/workshop-shared/workflow-definition";
import { openFakeOverseer } from "./fixtures.js";
import { makeMockStorage } from "./mock-storage.js";

const ADA = { type: "user" as const, id: "ada-profile", name: "Ada" };
const BEN = { type: "user" as const, id: "ben-profile", name: "Ben" };
const CARA = { type: "user" as const, id: "cara-profile", name: "Cara" };
const SOURCE_GADGET = 3;
const BOARD_CONNECTION = 60;
const MODEL_CONNECTION = 61;
const HOOK = 11;
const BOARD_PATTERN = "inferops://*/project/board/*";
const ACME_BOARD = "inferops://acme.operations/project/board/ENG";
const GLOBEX_BOARD = "inferops://globex.operations/project/board/OPS";
const commit = (n: number) => n.toString(16).padStart(40, "0");
const HOUR = 60 * 60 * 1000;

const BOARD_REQUIRED: WorkflowRequiredBinding = { name: "BOARD", type: "gatekeeper", vendorId: "inferops", typeUrlPattern: BOARD_PATTERN };
const MODEL_REQUIRED: WorkflowRequiredBinding = { name: "MODEL", type: "aiModel" };

/**
 * One workspace: Ada's workflow gadget binds an InferOps board connection and a model of hers; her
 * definition of it is published at revision 1 (commit 1), with an unpublished revision 2.
 */
function workspace(opts: { audience?: WorkflowDefinitionAudience; now?: () => number } = {}) {
  let durable = makeMockStorage();
  let storage = makeOverseerStorage(durable);
  let nextId = 100;
  let gadgets = new Map<number, any>([[SOURCE_GADGET, {
    type: "gadget", id: SOURCE_GADGET, title: "Refund", bindingName: "REFUND", commitId: commit(1),
    created: new Date(0),
    bindings: { BOARD: { target: BOARD_CONNECTION, blueprintAnnotation: { title: "Board", description: "" } }, MODEL: { target: MODEL_CONNECTION } },
  }]]);
  let gatekeepers = new Map<number, any>([
    [BOARD_CONNECTION, { id: BOARD_CONNECTION, creationSpec: { type: "gatekeeper", vendorId: "inferops", resourceUrl: ACME_BOARD, typeUrlPattern: BOARD_PATTERN } }],
    [MODEL_CONNECTION, { id: MODEL_CONNECTION, creationSpec: { type: "aiModel", modelId: "ada-model", provider: "anthropic", modelName: "m" } }],
  ]);
  let specOf = (target: number) => gatekeepers.get(target)?.creationSpec;
  let madeByOf = (target: number) => gatekeepers.get(target)?.connectedBy?.userId ?? gatekeepers.get(target)?.modelOf;
  let clock = { now: opts.now ?? (() => Date.now()) };
  let store = new WorkspaceWorkflowDefinitionStore(durable, storage,
    { now: () => clock.now(), dynamicTtlMs: () => 24 * HOUR },
    opts.audience ?? WORKSPACE_AUDIENCE,
    gadgetId => (gadgets.has(gadgetId) ? unmetBindings(gadgets.get(gadgetId), specOf, madeByOf) : []));
  let headOf = (id: number) => gadgets.get(id)?.commitId;
  let saved = store.save(ADA, { title: "Refund", gadgetId: SOURCE_GADGET }, headOf, "build");
  store.publish(ADA, saved.id, 1);
  gadgets.get(SOURCE_GADGET).commitId = commit(2);
  store.save(ADA, { id: saved.id, title: "Refund", gadgetId: SOURCE_GADGET }, headOf, "build");
  const makeGadget = (commitId: string) => {
    let id = nextId++;
    gadgets.set(id, { type: "gadget", id, title: "Copy", bindingName: `COPY_${id}`, commitId, created: new Date(), bindings: {} });
    return id;
  };
  return { durable, storage, store, gadgets, gatekeepers, specOf, headOf, makeGadget, sourceId: saved.id, clock,
    nextId: () => nextId++ };
}

describe("what a duplicate's gadget must have set up", () => {
  it("names each of the source's connections by name and kind, never its target, account or resource", () => {
    let { gadgets, specOf } = workspace();
    let required = requirementsOf(Object.entries(gadgets.get(SOURCE_GADGET).bindings), specOf);
    expect(required).toEqual([{ ...BOARD_REQUIRED, title: "Board" }, MODEL_REQUIRED]);
    expect(JSON.stringify(required)).not.toContain(ACME_BOARD);
    expect(JSON.stringify(required)).not.toContain(String(BOARD_CONNECTION));
    expect(JSON.stringify(required)).not.toContain("ada-model");
  });

  it("refuses a gadget binding a connection nothing could set up from the duplicator's own accounts", () => {
    let spawner = { type: "agentSpawner", config: { modelId: null, env: {} } };
    expect(() => requirementsOf([["AGENT", { target: 9 }]], () => spawner as never)).toThrow(DUPLICATE_UNSUPPORTED_BINDING);
    expect(() => requirementsOf([["GONE", { target: 9 }]], () => undefined)).toThrow(DUPLICATE_UNSUPPORTED_BINDING);
  });

  it("is unmet with no edge, a chat's provisional edge, or one of another vendor, kind or resource type", () => {
    let spec = (vendorId: string, typeUrlPattern = BOARD_PATTERN) => ({ type: "gatekeeper" as const, vendorId, resourceUrl: "x", typeUrlPattern });
    expect(fills(BOARD_REQUIRED, spec("InferOps"))).toBe(true);
    expect(fills(BOARD_REQUIRED, spec("google"))).toBe(false);
    expect(fills(BOARD_REQUIRED, spec("inferops", "inferops://*/chatbot/dot"))).toBe(false);
    expect(fills(BOARD_REQUIRED, { type: "aiModel", modelId: "m", provider: "p", modelName: "n" })).toBe(false);
    expect(fills(MODEL_REQUIRED, spec("inferops"))).toBe(false);
    let specs = new Map<number, any>([[1, spec("inferops")], [2, spec("google")], [3, spec("inferops")], [4, spec("inferops")]]);
    // Who made each: 1 the owner, 3 someone else, 4 not recorded (an older connection).
    let madeBy = new Map<number, string>([[1, "ben-user"], [2, "ben-user"], [3, "ada-user"]]);
    let gadget = (bindings: Record<string, any>) => ({ requiredBindings: [BOARD_REQUIRED], requiredBindingsOwner: "ben-user", bindings });
    let specOf = (t: number) => specs.get(t);
    let madeByOf = (t: number) => madeBy.get(t);
    let missing = [{ ...BOARD_REQUIRED, unmet: "missing" }];
    expect(unmetBindings(gadget({}), specOf, madeByOf)).toEqual(missing);
    expect(unmetBindings(gadget({ BOARD: { target: 1, pending: { chatId: 4 } } }), specOf, madeByOf)).toEqual(missing);
    expect(unmetBindings(gadget({ BOARD: { target: 2 } }), specOf, madeByOf)).toEqual(missing);
    expect(unmetBindings(gadget({ BOARD: { target: 404 } }), specOf, madeByOf)).toEqual(missing);
    expect(unmetBindings(gadget({ BOARD: { target: 1 } }), specOf, madeByOf)).toEqual([]);
    expect(() => requireBound(gadget({}), specOf, madeByOf)).toThrow(WORKFLOW_BINDINGS_NEEDED);
    // Any gadget that isn't a duplicate's has nothing to set up.
    expect(() => requireBound({ bindings: {} }, specOf, madeByOf)).not.toThrow();
    expect(() => requireBound(undefined, specOf, madeByOf)).not.toThrow();
  });

  it("is filled only by the owner's own connection: another person's, or one that doesn't record whose it is, fills nothing", () => {
    let spec = { type: "gatekeeper" as const, vendorId: "inferops", resourceUrl: "x", typeUrlPattern: BOARD_PATTERN };
    let madeBy = new Map<number, string>([[1, "ben-user"], [3, "ada-user"]]);
    let gadget = (bindings: Record<string, any>, owner: string | null = "ben-user") =>
      ({ requiredBindings: [BOARD_REQUIRED], ...(owner ? { requiredBindingsOwner: owner } : {}), bindings });
    let specOf = () => spec;
    let madeByOf = (t: number) => madeBy.get(t);
    // Ada's connection, bound by any route (a chat's accepted edge is just an edge): not Ben's.
    expect(unmetBindings(gadget({ BOARD: { target: 3 } }), specOf, madeByOf)).toEqual([{ ...BOARD_REQUIRED, unmet: "not-owners" }]);
    expect(() => requireBound(gadget({ BOARD: { target: 3 } }), specOf, madeByOf)).toThrow(WORKFLOW_BINDINGS_NOT_OWNERS);
    // Made before whose account a connection uses was recorded: it fills nothing, and says so.
    expect(unmetBindings(gadget({ BOARD: { target: 4 } }), specOf, madeByOf)).toEqual([{ ...BOARD_REQUIRED, unmet: "unattributed" }]);
    expect(() => requireBound(gadget({ BOARD: { target: 4 } }), specOf, madeByOf)).toThrow(WORKFLOW_BINDINGS_UNATTRIBUTED);
    // A duplicate that doesn't record its owner fills from nobody's.
    expect(unmetBindings(gadget({ BOARD: { target: 1 } }, null), specOf, madeByOf)).toEqual([{ ...BOARD_REQUIRED, unmet: "unattributed" }]);
    expect(unmetBindings(gadget({ BOARD: { target: 1 } }), specOf, madeByOf)).toEqual([]);
  });

  it("takes only named requirements, each of its kind, and never an agent spawner", () => {
    let required = [BOARD_REQUIRED, MODEL_REQUIRED];
    expect(checkAssignments(required, undefined).size).toBe(0);
    expect(() => checkAssignments(required, { OTHER: { type: "aiModel", modelId: "m" } })).toThrow('no connection named "OTHER"');
    expect(() => checkAssignments(required, { BOARD: { type: "aiModel", modelId: "m" } })).toThrow("connected accounts");
    expect(() => checkAssignments(required, { MODEL: { type: "agentSpawner", modelId: null } })).toThrow("one of your models");
    expect(() => checkAssignments(required, { BOARD: { type: "gatekeeper", accountId: "1", resourceUrl: ACME_BOARD } })).toThrow("connected accounts");
    expect(() => checkAssignments(required, [])).toThrow(TypeError);
    expect(checkAssignments(required, { BOARD: { type: "gatekeeper", accountId: 1, resourceUrl: ACME_BOARD } }).get("BOARD")?.requirement)
      .toEqual(BOARD_REQUIRED);
  });
});

describe("a duplicate is independent of its source (acceptance 1)", () => {
  it("is the duplicator's own fresh revision 1 of a new gadget at the source revision's commit, unpublished", () => {
    let { store, sourceId, makeGadget } = workspace();
    let chosen = store.duplicateSource(BEN.id, sourceId, undefined, "build");
    // Ben can see only the published revision, so that is what he copies.
    expect(chosen.revision.revision).toBe(1);
    let copy = store.duplicate(BEN, chosen, { title: "My refund" }, "build", makeGadget);
    expect(copy).toMatchObject({ title: "My refund", owner: BEN, published: null, access: { read: true, run: true, edit: true } });
    expect(copy.id).not.toBe(sourceId);
    expect(copy.revisions).toEqual([{ revision: 1, source: { kind: "gadget", gadgetId: 100, commitId: commit(1) }, savedAt: expect.any(Date) }]);
    expect(copy.duplicatedFrom).toEqual({ at: expect.any(Date), definitionId: sourceId, title: "Refund", revision: 1 });
  });

  it("is unchanged by later saves, publication, shares and triggers of the source", () => {
    let { store, sourceId, makeGadget, gadgets, headOf } = workspace();
    let copy = store.duplicate(BEN, store.duplicateSource(BEN.id, sourceId, undefined, "build"), { title: "Mine" }, "build", makeGadget);
    let before = store.get(BEN.id, copy.id, "build");
    gadgets.get(SOURCE_GADGET).commitId = commit(3);
    store.save(ADA, { id: sourceId, title: "Refund v3", gadgetId: SOURCE_GADGET }, headOf, "build");
    store.publish(ADA, sourceId, 3);
    store.share(ADA, sourceId, CARA.id, { read: true, run: true, edit: false }, "use");
    store.pinTrigger(ADA.id, HOOK, SOURCE_GADGET, { definitionId: sourceId, revision: 3, mode: "pinned" });
    let after = store.get(BEN.id, copy.id, "build")!;
    expect(after.revisions).toEqual(before!.revisions);
    expect(after.title).toBe("Mine");
    expect(after.published).toBeNull();
    expect(store.shares(BEN, copy.id)).toEqual([]);
    // The record of where it came from follows only what Ben may see of the source now: its new
    // title, and no longer revision 1, which is not its published one any more.
    expect(before!.duplicatedFrom).toEqual({ at: expect.any(Date), definitionId: sourceId, title: "Refund", revision: 1 });
    expect(after.duplicatedFrom).toEqual({ at: before!.duplicatedFrom!.at, definitionId: sourceId, title: "Refund v3" });
  });

  it("copies no share, publication, pin, control, assignment, invocation or run", () => {
    let { store, storage, sourceId, makeGadget, headOf } = workspace();
    store.share(ADA, sourceId, BEN.id, { read: true, run: true, edit: true }, "build");
    store.pinTrigger(ADA.id, HOOK, SOURCE_GADGET, { definitionId: sourceId, revision: 1, mode: "pinned" });
    store.setControl(ADA, HOOK, { label: "Run", invokers: [BEN.id] });
    storage.workflowTriggerAssignments.put({ hookId: HOOK, gatekeeperId: BOARD_CONNECTION, credentialRef: "ref-1",
      assignedBy: ADA, assignedAt: new Date(0) });
    // A run of the source at revision 1's commit.
    let source = workspaceHeads(headOf);
    store.fire(HOOK, SOURCE_GADGET, source, () => "build", store.beginInvocation(BEN.id, HOOK, null).id);
    let copy = store.duplicate(BEN, store.duplicateSource(BEN.id, sourceId, 1, "build"), { title: "Mine" }, "build", makeGadget);
    let mentions = (rows: Iterable<unknown>) => [...rows].filter(row => JSON.stringify(row).includes(copy.id));
    expect(mentions(storage.workflowDefinitionShares.list())).toEqual([]);
    expect(mentions(storage.workflowTriggerPins.list())).toEqual([]);
    expect(mentions(storage.workflowDeliveries.list())).toEqual([]);
    expect([...storage.workflowTriggerAssignments.list()].map(a => a.hookId)).toEqual([HOOK]);
    expect(storage.workflowDefinitionShares.get(shareKey(copy.id, BEN.id))).toBeUndefined();
    expect(() => store.deliveries(BEN.id, copy.id, "build")).not.toThrow();
    expect(store.deliveries(BEN.id, copy.id, "build")).toEqual([]);
    expect(copy.published).toBeNull();
  });
});

/** The source gadget's head as revision 1 had it, for firing the source's run. */
const workspaceHeads = (headOf: (id: number) => string | undefined) =>
  (id: number) => (id === SOURCE_GADGET ? commit(1) : headOf(id));

describe("who may duplicate, and which revision", () => {
  it("needs the source to be visible to them, and gives a reader only its published revision", () => {
    let { store, sourceId } = workspace({ audience: SHARED_ONLY_AUDIENCE });
    expect(() => store.duplicateSource(BEN.id, sourceId, undefined, "build")).toThrow("Workflow definition not found.");
    expect(() => store.duplicateSource(BEN.id, "no-such", undefined, "build")).toThrow("Workflow definition not found.");
    store.share(ADA, sourceId, BEN.id, { read: true, run: false, edit: false }, "build");
    expect(store.duplicateSource(BEN.id, sourceId, undefined, "build").revision.revision).toBe(1);
    // Revision 2 is Ada's unpublished work: not Ben's to copy.
    expect(() => store.duplicateSource(BEN.id, sourceId, 2, "build")).toThrow("No such revision.");
    // An editor, and the owner, may copy any revision; with none named, the latest.
    expect(store.duplicateSource(ADA.id, sourceId, undefined, "build").revision.revision).toBe(2);
    store.share(ADA, sourceId, BEN.id, { read: true, run: false, edit: true }, "build");
    expect(store.duplicateSource(BEN.id, sourceId, 2, "build").revision.revision).toBe(2);
    // Someone who has no role here sees nothing, a share notwithstanding.
    expect(() => store.duplicateSource(BEN.id, sourceId, undefined, null)).toThrow("Workflow definition not found.");
  });

  it("checks the source again as it writes: one no longer visible by then is refused, and nothing is made", () => {
    let { store, sourceId, makeGadget, storage } = workspace({ audience: SHARED_ONLY_AUDIENCE });
    store.share(ADA, sourceId, BEN.id, { read: true, run: false, edit: false }, "build");
    let chosen = store.duplicateSource(BEN.id, sourceId, undefined, "build");
    store.share(ADA, sourceId, BEN.id, null, "build");
    let made = vi.fn(makeGadget);
    expect(() => store.duplicate(BEN, chosen, { title: "Mine" }, "build", made)).toThrow("Workflow definition not found.");
    expect(made).not.toHaveBeenCalled();
    expect([...storage.workflowDefinitions.list()]).toHaveLength(1);
  });

  it(`counts toward the ${MAX_WORKSPACE_WORKFLOW_DEFINITIONS}-definition limit`, () => {
    let { store, sourceId, makeGadget } = workspace();
    for (let i = 1; i < MAX_WORKSPACE_WORKFLOW_DEFINITIONS; i++) {
      store.duplicate(BEN, store.duplicateSource(BEN.id, sourceId, undefined, "build"), { title: `Copy ${i}` }, "build", makeGadget);
    }
    let made = vi.fn(makeGadget);
    expect(() => store.duplicate(BEN, store.duplicateSource(BEN.id, sourceId, undefined, "build"), { title: "One more" }, "build", made))
      .toThrow("limit reached");
    expect(made).not.toHaveBeenCalled();
  });
});

describe("where a duplicate came from, as each viewer may see it", () => {
  it("names the source only to someone who can see it, and its revision only if they can see that revision", () => {
    let { store, sourceId, makeGadget, gadgets, headOf } = workspace({ audience: SHARED_ONLY_AUDIENCE });
    store.share(ADA, sourceId, BEN.id, { read: true, run: false, edit: false }, "build");
    let copy = store.duplicate(BEN, store.duplicateSource(BEN.id, sourceId, undefined, "build"), { title: "Mine" }, "build", makeGadget);
    store.publish(BEN, copy.id, 1);
    // Cara reads Ben's copy, but not Ada's source: "duplicated from a workflow", nothing more.
    store.share(BEN, copy.id, CARA.id, { read: true, run: false, edit: false }, "use");
    let seenByCara = store.get(CARA.id, copy.id, "use")!;
    expect(seenByCara.duplicatedFrom).toEqual({ at: expect.any(Date) });
    expect(JSON.stringify(store.list(CARA.id, "use"))).not.toContain(sourceId);
    expect(JSON.stringify(store.list(CARA.id, "use"))).not.toContain("Refund");
    // Published and returned to Ben: as he may see it, never more.
    expect(store.publish(BEN, copy.id, 1, { role: "build" }).duplicatedFrom).toMatchObject({ definitionId: sourceId, revision: 1 });
    // Once Ada publishes another revision, Ben (a reader) still sees the source, but not revision 1.
    gadgets.get(SOURCE_GADGET).commitId = commit(3);
    store.save(ADA, { id: sourceId, title: "Refund", gadgetId: SOURCE_GADGET }, headOf, "build");
    store.publish(ADA, sourceId, 3);
    expect(store.get(BEN.id, copy.id, "build")!.duplicatedFrom).toEqual({ at: expect.any(Date), definitionId: sourceId, title: "Refund" });
    // And when his share of it ends, he sees only that it was copied.
    store.share(ADA, sourceId, BEN.id, null, "build");
    expect(store.get(BEN.id, copy.id, "build")!.duplicatedFrom).toEqual({ at: expect.any(Date) });
  });

  it("shows what still needs setting up to the owner only", () => {
    let { store, sourceId, makeGadget, gadgets, gatekeepers, nextId } = workspace();
    let copy = store.duplicate(BEN, store.duplicateSource(BEN.id, sourceId, undefined, "build"), { title: "Mine" }, "build", gadgetId => {
      let id = makeGadget(gadgetId);
      gadgets.get(id).requiredBindings = [BOARD_REQUIRED, MODEL_REQUIRED];
      gadgets.get(id).requiredBindingsOwner = "ben-user";
      return id;
    });
    expect(copy.bindingsNeeded).toEqual([{ ...BOARD_REQUIRED, unmet: "missing" }, { ...MODEL_REQUIRED, unmet: "missing" }]);
    store.publish(BEN, copy.id, 1);
    expect(store.get(CARA.id, copy.id, "use")!.bindingsNeeded).toBeUndefined();
    let board = nextId();
    gatekeepers.set(board, { id: board, connectedBy: { userId: "ben-user", accountId: 1 },
      creationSpec: { type: "gatekeeper", vendorId: "inferops", resourceUrl: ACME_BOARD, typeUrlPattern: BOARD_PATTERN } });
    gadgets.get(100).bindings.BOARD = { target: board };
    expect(store.get(BEN.id, copy.id, "build")!.bindingsNeeded).toEqual([{ ...MODEL_REQUIRED, unmet: "missing" }]);
    let model = nextId();
    gatekeepers.set(model, { id: model, modelOf: "ben-user", creationSpec: { type: "aiModel", modelId: "ben-model", provider: "p", modelName: "n" } });
    gadgets.get(100).bindings.MODEL = { target: model };
    expect(store.get(BEN.id, copy.id, "build")!.bindingsNeeded).toBeUndefined();
  });
});

describe("a temporary source (FAC-124)", () => {
  it("makes a temporary copy with a fresh expiry, a kept one with retain, and an expired one is refused", () => {
    let now = Date.parse("2026-11-10T12:00:00.000Z");
    let { store, makeGadget, headOf, clock } = workspace({ now: () => now });
    let temporary = store.save(ADA, { title: "One-off", gadgetId: SOURCE_GADGET, retain: false }, headOf, "build");
    now += 20 * HOUR;
    let copy = store.duplicate(ADA, store.duplicateSource(ADA.id, temporary.id, undefined, "build"), { title: "Copy" }, "build", makeGadget);
    expect(copy.expiresAt).toEqual(new Date(now + 24 * HOUR));
    let kept = store.duplicate(ADA, store.duplicateSource(ADA.id, temporary.id, undefined, "build"),
      { title: "Kept", retain: true }, "build", makeGadget);
    expect(kept.expiresAt).toBeUndefined();
    expect(() => store.duplicate(ADA, store.duplicateSource(ADA.id, temporary.id, undefined, "build"),
      { title: "Bad", retain: "yes" }, "build", makeGadget)).toThrow(TypeError);
    now += 5 * HOUR;
    expect(clock.now()).toBe(now);
    expect(() => store.duplicateSource(ADA.id, temporary.id, undefined, "build")).toThrow(WORKFLOW_DEFINITION_EXPIRED);
  });

  it("is never temporary for a saved source, whatever retain says", () => {
    let { store, sourceId, makeGadget } = workspace();
    let copy = store.duplicate(BEN, store.duplicateSource(BEN.id, sourceId, undefined, "build"), { title: "Mine", retain: false }, "build", makeGadget);
    expect(copy.expiresAt).toBeUndefined();
  });
});

/**
 * Ben's build session over the real RPCs, with a forged workspace: the gadget registry, connections
 * and Ben's own User (his connected accounts, models and InferOps answers) are stand-ins.
 */
async function session(opts: { role?: "build" | "use"; operate?: boolean; refuseSharedConfiguration?: boolean;
                               caller?: typeof BEN; sourceSpawner?: boolean } = {}) {
  let made = workspace();
  let { store, storage, gadgets, gatekeepers, specOf } = made;
  if (opts.sourceSpawner) {
    gatekeepers.set(62, { id: 62, creationSpec: { type: "agentSpawner", config: { modelId: null, env: {} } } });
    gadgets.get(SOURCE_GADGET).bindings.AGENT = { target: 62 };
  }
  let nextId = 200;
  // Ben's own accounts: 1 is an InferOps login, 2 a Google one. Anything else isn't his.
  let accounts: Record<number, { vendorId: string; typeUrlPattern: string }> = {
    1: { vendorId: "inferops", typeUrlPattern: BOARD_PATTERN },
    2: { vendorId: "google", typeUrlPattern: "https://docs.google.com/*" },
  };
  let created = { gatekeepers: [] as number[], gadgets: [] as number[] };
  let impl = {
    env: { SHARED_CONFIGURATION_GATEKEEPER: "inferops" },
    isSharedConfiguration: async () => false,
    ...(opts.refuseSharedConfiguration ? { requireSharedConfiguration: async () => { throw new Error("Only an Admin can change shared configuration."); } } : {}),
    workflowDefinitionStore: () => store,
    definitionRoles: async () => () => "build" as const,
    getGadgetHead: made.headOf,
    getGadgetRecord: (id: number) => {
      let gadget = gadgets.get(id);
      if (!gadget) throw new Error(`No such gadget: ${id}`);
      return gadget;
    },
    visibleBindings: (gadget: any) => Object.entries(gadget.bindings).filter(([, edge]: [string, any]) => !edge.pending),
    createGadget: (title: string, bindingName: string, _chat: unknown, output: unknown, commitId: string) => {
      let record = { type: "gadget", id: nextId++, title, bindingName, bindings: {}, commitId, created: new Date(), ...(output ? { output } : {}) };
      gadgets.set(record.id, record);
      created.gadgets.push(record.id);
      return record;
    },
    addGatekeeper: async (_cls: unknown, creationSpec: unknown, ..._rest: unknown[]) => {
      let id = nextId++;
      let connectedBy = _rest[5];
      gatekeepers.set(id, { id, creationSpec, ...(connectedBy ? { connectedBy } : {}) });
      created.gatekeepers.push(id);
      return { getId: async () => id };
    },
    bindWorkpiece: (gadgetId: number, name: string, target: number) => {
      let gadget = gadgets.get(gadgetId);
      if (gadget.bindings[name]) throw new Error(`There is already a binding named "${name}".`);
      gadget.bindings[name] = { target };
    },
    unbindWorkpiece: (gadgetId: number, name: string) => { delete gadgets.get(gadgetId).bindings[name]; },
    gadgetAuthorFor: (profile: unknown) => profile,
    recordGadgetAnalytics: () => {},
    ctx: { id: { toString: () => "workspace-id" }, exports: { LanguageModelGatekeeper: () => ({}) } },
    storage: Object.assign(storage, {
      containsRestrictedData: { get: () => false }, title: { get: () => "Test Workspace" },
      operateSession: { get: () => opts.operate === true },
      gadgets: { get: (id: number) => gadgets.get(id), put: (record: any) => { gadgets.set(record.id, record); },
        byBindingName: { get: (name: string) => [...gadgets.values()].find(g => g.bindingName === name) } },
      gatekeepers: { get: (id: number) => gatekeepers.get(id), put: (record: any) => { gatekeepers.set(record.id, record); } },
    }),
    users: {
      idFromString: (value: string) => value,
      idFromName: (value: string) => value,
      get: (() => ({})) as () => object,
      base: ({
        id: { toString: () => "ben-user" },
        whoami: async () => opts.caller ?? BEN,
        recordSharedGadgetOpen: async () => {},
        operateSessionWorkspaceId: async () => "workspace-id",
        getGatekeeperClassFor: async (accountId: number, resourceUrl: string) => {
          let account = accounts[accountId];
          if (!account) throw new Error("No such connected account.");
          return { class: {}, vendorId: account.vendorId, typeUrlPattern: account.typeUrlPattern, mock: false, resourceUrl };
        },
        // Ben holds workflow:invoke in Acme, not in Globex.
        workflowInvokeAnswer: async (resourceUrl: string) =>
          resourceUrl.includes("acme.") ? { holds: true, company: "acme" } : { holds: false },
        getChatContext: async (modelId: string) => {
          if (modelId !== "ben-model") throw new Error("No such model.");
          return { profile: BEN, aiModel: { profile: { name: "Ben's model" }, config: { provider: "anthropic", model: "m" } } };
        },
      }),
    },
  };
  let caller = opts.caller ?? BEN;
  impl.users.get = (() => ({ ...user, whoami: async () => caller })) as never;
  const user = (impl.users as any).base;
  let overseer = await openFakeOverseer({}, { role: opts.role ?? "build", impl });
  /** Another session over the same workspace, as `who`. */
  const openAs = async (who: typeof BEN) => {
    caller = who;
    return openFakeOverseer({}, { role: "build", impl });
  };
  const allDefinitions = () => [...storage.workflowDefinitions.list()];
  return { ...made, overseer, openAs, created, allDefinitions, specOf };
}

const BOARD_AT = (resourceUrl: string, accountId = 1) => ({ type: "gatekeeper" as const, accountId, resourceUrl });
const BEN_MODEL = { type: "aiModel" as const, modelId: "ben-model" };

describe("duplicating through a build session", () => {
  it("makes the copy with Ben's own connections, never the source's, and nothing left to set up", async () => {
    let { overseer, sourceId, gadgets } = await session();
    let copy = await overseer.duplicateWorkflowDefinition({ sourceId, title: "Mine", bindings: { BOARD: BOARD_AT(ACME_BOARD), MODEL: BEN_MODEL } });
    expect(copy).toMatchObject({ owner: BEN, title: "Mine", published: null, duplicatedFrom: { definitionId: sourceId, revision: 1 } });
    expect(copy.bindingsNeeded).toBeUndefined();
    let gadget = gadgets.get(copy.revisions[0]!.source.gadgetId);
    expect(gadget).toMatchObject({ commitId: commit(1), bindingName: "REFUND_COPY", requiredBindings: [{ ...BOARD_REQUIRED, title: "Board" }, MODEL_REQUIRED] });
    let targets = Object.values(gadget.bindings).map((edge: any) => edge.target);
    expect(targets).toHaveLength(2);
    expect(targets).not.toContain(BOARD_CONNECTION);
    expect(targets).not.toContain(MODEL_CONNECTION);
  });

  it("starts unbound when no connection is given, saying what to set up", async () => {
    let { overseer, sourceId, gadgets, created } = await session();
    let copy = await overseer.duplicateWorkflowDefinition({ sourceId, title: "Mine" });
    expect(copy.bindingsNeeded).toEqual([{ ...BOARD_REQUIRED, title: "Board", unmet: "missing" }, { ...MODEL_REQUIRED, unmet: "missing" }]);
    expect(gadgets.get(copy.revisions[0]!.source.gadgetId).bindings).toEqual({});
    expect(created.gatekeepers).toEqual([]);
  });

  it("refuses a board in a company Ben can't run workflows in, and makes nothing", async () => {
    let { overseer, sourceId, created, allDefinitions } = await session();
    await expect(overseer.duplicateWorkflowDefinition({ sourceId, title: "Mine", bindings: { BOARD: BOARD_AT(GLOBEX_BOARD) } }))
      .rejects.toThrow(WORKFLOW_INVOKE_REFUSED);
    expect(created).toEqual({ gatekeepers: [], gadgets: [] });
    expect(allDefinitions()).toHaveLength(1);
  });

  it("refuses an account that isn't Ben's, one of another kind, and a model that isn't his, making nothing", async () => {
    let { overseer, sourceId, created, allDefinitions } = await session();
    await expect(overseer.duplicateWorkflowDefinition({ sourceId, title: "Mine", bindings: { BOARD: BOARD_AT(ACME_BOARD, 99) } }))
      .rejects.toThrow("No such connected account.");
    await expect(overseer.duplicateWorkflowDefinition({ sourceId, title: "Mine", bindings: { BOARD: BOARD_AT("https://docs.google.com/d/1", 2) } }))
      .rejects.toThrow("same kind of resource");
    await expect(overseer.duplicateWorkflowDefinition({ sourceId, title: "Mine", bindings: { MODEL: { type: "aiModel", modelId: "ada-model" } } }))
      .rejects.toThrow("No such model.");
    // A valid board beside a bad model: still nothing made.
    await expect(overseer.duplicateWorkflowDefinition({ sourceId, title: "Mine",
      bindings: { BOARD: BOARD_AT(ACME_BOARD), MODEL: { type: "aiModel", modelId: "ada-model" } } })).rejects.toThrow("No such model.");
    expect(created).toEqual({ gatekeepers: [], gadgets: [] });
    expect(allDefinitions()).toHaveLength(1);
  });

  it("refuses a source binding an agent spawner, and a source Ben can't see", async () => {
    let spawning = await session({ sourceSpawner: true });
    await expect(spawning.overseer.duplicateWorkflowDefinition({ sourceId: spawning.sourceId, title: "Mine" }))
      .rejects.toThrow(DUPLICATE_UNSUPPORTED_BINDING);
    expect(spawning.created.gadgets).toEqual([]);
    let { overseer } = await session();
    await expect(overseer.duplicateWorkflowDefinition({ sourceId: "someone-elses", title: "Mine" })).rejects.toThrow("Workflow definition not found.");
  });

  it("is refused without the deployment's build authority, and in use and operate sessions", async () => {
    let gated = await session({ refuseSharedConfiguration: true });
    await expect(gated.overseer.duplicateWorkflowDefinition({ sourceId: gated.sourceId, title: "Mine" })).rejects.toThrow("Only an Admin");
    await expect(gated.overseer.rebindWorkflowDefinition("any", { BOARD: BOARD_AT(ACME_BOARD) })).rejects.toThrow("Only an Admin");
    expect(gated.created).toEqual({ gatekeepers: [], gadgets: [] });
    let use = await session({ role: "use" });
    await expect(use.overseer.duplicateWorkflowDefinition({ sourceId: use.sourceId, title: "Mine" })).rejects.toThrow("Unauthorized");
    await expect(use.overseer.rebindWorkflowDefinition("any", {})).rejects.toThrow("Unauthorized");
    let operate = await session({ operate: true, caller: ADA });
    await expect(operate.overseer.duplicateWorkflowDefinition({ sourceId: operate.sourceId, title: "Mine" })).rejects.toThrow("operate session");
    await expect(operate.overseer.rebindWorkflowDefinition("any", {})).rejects.toThrow("operate session");
    expect(use.created.gadgets).toEqual([]);
    expect(operate.created.gadgets).toEqual([]);
  });
});

describe("setting up a duplicate's connections", () => {
  it("is the owner's, checked like duplicating, and replaces one already set up", async () => {
    let { overseer, sourceId, gadgets } = await session();
    let copy = await overseer.duplicateWorkflowDefinition({ sourceId, title: "Mine" });
    let gadgetId = copy.revisions[0]!.source.gadgetId;
    await expect(overseer.rebindWorkflowDefinition(copy.id, { BOARD: BOARD_AT(GLOBEX_BOARD) })).rejects.toThrow(WORKFLOW_INVOKE_REFUSED);
    await expect(overseer.rebindWorkflowDefinition(copy.id, { BOARD: BOARD_AT(ACME_BOARD), MODEL: { type: "aiModel", modelId: "ada-model" } }))
      .rejects.toThrow("No such model.");
    expect(gadgets.get(gadgetId).bindings).toEqual({});
    await expect(overseer.rebindWorkflowDefinition(copy.id, {})).rejects.toThrow("Choose a connection");
    let half = await overseer.rebindWorkflowDefinition(copy.id, { BOARD: BOARD_AT(ACME_BOARD) });
    expect(half.bindingsNeeded).toEqual([{ ...MODEL_REQUIRED, unmet: "missing" }]);
    let first = gadgets.get(gadgetId).bindings.BOARD.target;
    let done = await overseer.rebindWorkflowDefinition(copy.id, { BOARD: BOARD_AT(ACME_BOARD), MODEL: BEN_MODEL });
    expect(done.bindingsNeeded).toBeUndefined();
    expect(gadgets.get(gadgetId).bindings.BOARD.target).not.toBe(first);
  });

  it("refuses anyone but the owner, and a definition that isn't a duplicate", async () => {
    let ben = await session();
    let copy = await ben.overseer.duplicateWorkflowDefinition({ sourceId: ben.sourceId, title: "Mine" });
    // Ada, in the same workspace: Ben's copy isn't hers to set up, and her own source has nothing to.
    let ada = await ben.openAs(ADA);
    await expect(ada.rebindWorkflowDefinition(copy.id, { BOARD: BOARD_AT(ACME_BOARD) })).rejects.toThrow("Workflow definition not found.");
    await expect(ada.rebindWorkflowDefinition(ben.sourceId, { BOARD: BOARD_AT(ACME_BOARD) })).rejects.toThrow("no connections to set up");
    expect(ben.gadgets.get(copy.revisions[0]!.source.gadgetId).bindings).toEqual({});
  });

  it("fixes a duplicate made before its owner was recorded: rebinding records the owner, and it is then set up", async () => {
    let { overseer, sourceId, gadgets, store } = await session();
    let copy = await overseer.duplicateWorkflowDefinition({ sourceId, title: "Mine" });
    let gadget = gadgets.get(copy.revisions[0]!.source.gadgetId);
    // As #435 made it, before #438: requirements with no recorded owner.
    delete gadget.requiredBindingsOwner;
    let done = await overseer.rebindWorkflowDefinition(copy.id, { BOARD: BOARD_AT(ACME_BOARD), MODEL: BEN_MODEL });
    expect(gadget.requiredBindingsOwner).toBe("owner-id");
    expect(done.bindingsNeeded).toBeUndefined();
    expect(store.get(BEN.id, copy.id, "build")!.bindingsNeeded).toBeUndefined();
  });

  it("refuses to replace a connection a chat is changing", async () => {
    let { overseer, sourceId, gadgets, created } = await session();
    let copy = await overseer.duplicateWorkflowDefinition({ sourceId, title: "Mine" });
    gadgets.get(copy.revisions[0]!.source.gadgetId).bindings.BOARD = { target: 999, pending: { chatId: 4 } };
    await expect(overseer.rebindWorkflowDefinition(copy.id, { BOARD: BOARD_AT(ACME_BOARD) })).rejects.toThrow("A chat is changing");
    expect(created.gatekeepers).toEqual([]);
  });
});
