// FAC-137 K2: a temporary canvas the Dot proposed is created only by the person's own approval, in
// their own live operate session, from what the kernel checked at submit. The kernel shows it to
// every approver in its own words, never auto-approves it, hands the effect to nothing but that
// person's own approval, checks every widget again as one offered to them now, and creates all or
// nothing, once per action. Real Overseer Durable Objects in workerd with a fake user Durable Object.
//
// Synthetic bounded fixtures only.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { ApprovedEffects, ApprovedTemporaryCanvas } from "@gadgets/workshop-shared/gatekeeper";
import { workflowTriggerRef } from "@gadgets/workshop-shared/workflow-trigger-ref";
import { autoApprovalRule } from "../src/auto-approval";
import {
  actionContextOf, TEMPORARY_CANVAS_FIELD_LABEL, TEMPORARY_CANVAS_GONE, TEMPORARY_CANVAS_NEEDS_APPROVAL, TEMPORARY_CANVAS_NOT_YOURS,
  TEMPORARY_CANVAS_WIDGET_UNAVAILABLE, type OverseerDurableObject,
} from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const uid = (profileId: string) => `${profileId}-user-id`;
const ADA = { type: "user" as const, id: "ada", name: "Ada" };
const BOARD = { type: "builtin" as const, kind: "project/board", target: "inferops://acme.operations/project/board/ENG" };
const ISSUES = { type: "builtin" as const, kind: "project/issues", target: "inferops://acme.operations/project/board/ENG" };
const CANVAS = {
  title: "Ada's week",
  placements: [
    { ref: BOARD, layout: { x: 0, y: 0, w: 6, h: 4 } },
    { ref: ISSUES, layout: { x: 6, y: 0, w: 6, h: 4 }, filters: { status: "open" } },
  ],
};
const PROPOSAL = { title: "Your Dot proposes a temporary canvas", description: "A canvas of your board and issues.",
  implementsRevert: false, descriptionIsComplete: true, temporaryCanvas: CANVAS };
const ISSUE = { title: "Create an issue", description: "Creates an issue.", implementsRevert: false, descriptionIsComplete: true };

let counter = 0;

type Applied = {
  impl: any;
  effects?: ApprovedEffects;
  answers: ApprovedTemporaryCanvas[];
  stored: any;
  context: unknown;
  /** What the session holds once the apply has ended, read inside the Durable Object. */
  canvases: unknown[];
  shared: Record<string, unknown[]>;
  /** The effect's answer after the apply ended (revoked). */
  afterwards?: ApprovedTemporaryCanvas;
};

// Ada's own operate session (owner `uid("ada")`), whose user DO's widget search offers `offered` kinds.
// Submits `description` through a connection, approves it as `resolvedBy`, and records what the
// gatekeeper's applyAction was handed and what `during` asked of it.
async function applying(options: {
  description?: object; resolvedBy?: object; autoApproved?: boolean; executedAs?: object; retired?: boolean;
  offered?: string[]; during?: (effects: ApprovedEffects) => Promise<ApprovedTemporaryCanvas>;
} = {}): Promise<Applied> {
  return runInDurableObject(env.TEST_OVERSEER.getByName(`approved-canvas-${++counter}`), async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    let offered = options.offered ?? [BOARD.kind, ISSUES.kind];
    impl.users = {
      idFromName: (profileId: string) => ({ toString: () => uid(profileId) }),
      idFromString: (id: string) => id,
      get: () => ({
        searchWidgets: async (query: string) => ({
          status: "searched", ranking: "keyword", denied: 0, unsearched: 0, definitions: [],
          hits: offered.filter(kind => kind === query).map(kind => ({ kind, description: kind, score: 1 })),
        }),
      }),
    };
    impl.ownerId = uid(ADA.id);
    impl.storage.operateSession.put(true);
    if (options.retired) impl.storage.operateSessionRetired.put(true);
    impl.storage.gatekeepers.put({ id: 41, resourceTitle: "Your Dot", class: {} as any,
      creationSpec: { type: "gatekeeper", vendorId: "inferops", resourceUrl: "test://x", typeUrlPattern: "test://*" } });
    let applied: Applied = { impl, answers: [], stored: undefined, context: undefined, canvases: [], shared: {} };
    impl.getGatekeeperFacet = () => ({
      applyAction: async (_action: number, _cache: unknown, effects?: ApprovedEffects) => {
        applied.effects = effects;
        if (effects && options.during) applied.answers.push(await options.during(effects));
      },
    });
    await impl.submitAction(41, 1, options.description ?? PROPOSAL, { from: "gatekeeper" });
    let record = Array.from(impl.storage.actions.list()).find((a: any) => a.type === "action") as any;
    if (options.executedAs) record.executedAs = options.executedAs;
    applied.stored = structuredClone(record.description);
    applied.context = actionContextOf(record);
    try { await impl.applyPendingAction(record, options.resolvedBy ?? ADA, options.autoApproved ?? false); } catch { /* recorded */ }
    applied.canvases = Array.from(impl.storage.temporaryCanvases.list());
    for (let name of ["consoles", "canvases", "canvasPages", "widgetIndexOwed"]) applied.shared[name] = Array.from(impl.storage[name].list());
    if (applied.effects) applied.afterwards = await applied.effects.createTemporaryCanvas();
    return applied;
  });
}

const create = async (effects: ApprovedEffects) => await effects.createTemporaryCanvas();

describe("a declared temporary canvas at submit (FAC-137 K2)", () => {
  it("is checked, kept as checked, and shown to every approver in the kernel's own last field", async () => {
    let { stored, context } = await applying({ description: { ...PROPOSAL, fields: [{ label: "From", kind: "inline", value: "Your Dot" }] } });
    expect(stored.temporaryCanvas.title).toBe("Ada's week");
    expect(stored.temporaryCanvas.placements).toHaveLength(2);
    expect(stored.fields).toEqual([
      { label: "From", kind: "inline", value: "Your Dot" },
      { label: TEMPORARY_CANVAS_FIELD_LABEL, kind: "inline", value: "Ada's week (2 widgets)" },
    ]);
    // The compact surfaces' marker, from the kernel's own record.
    expect(context).toMatchObject({ declaredCanvas: { title: "Ada's week", widgets: 2 } });
  });

  it("refuses a malformed canvas, a canvas declared beside a run, and a gatekeeper field taking the kernel's label", () =>
    runInDurableObject(env.TEST_OVERSEER.getByName(`declared-canvas-refusals-${++counter}`), async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      impl.storage.gatekeepers.put({ id: 41, resourceTitle: "Your Dot", class: {} as any,
        creationSpec: { type: "gatekeeper", vendorId: "inferops", resourceUrl: "test://x", typeUrlPattern: "test://*" } });
      let submit = (description: object) => impl.submitAction(41, 1, description, { from: "gatekeeper" });
      await expect(submit({ ...PROPOSAL, temporaryCanvas: { ...CANVAS, placements: [] } })).rejects.toThrow(/temporary canvas isn't valid/);
      await expect(submit({ ...PROPOSAL, temporaryCanvas: { ...CANVAS, placements: [{ ...CANVAS.placements[0], placementId: "mine" }] } }))
        .rejects.toThrow(/temporary canvas isn't valid/);
      await expect(submit({ ...PROPOSAL, workflowRun: { reference: "inferops://acme.operations/inferos/workflow-trigger/x/1" } }))
        .rejects.toThrow(/not both/);
      for (let label of [TEMPORARY_CANVAS_FIELD_LABEL, ` ${TEMPORARY_CANVAS_FIELD_LABEL.toUpperCase()} `,
        TEMPORARY_CANVAS_FIELD_LABEL.replace("canvas", "can​vas")]) {
        await expect(submit({ ...ISSUE, fields: [{ label, kind: "inline", value: "decoy" }] })).rejects.toThrow(/reserved for InferOS/);
      }
      expect(Array.from(impl.storage.actions.list())).toEqual([]);
    }));

  it("never sets the marker from a gatekeeper's own text", async () => {
    let forged = { ...ISSUE, declaredCanvas: { title: "Forged", widgets: 9 }, context: { kind: "declared-canvas" } };
    expect((await applying({ description: forged })).context).toBeUndefined();
    expect(actionContextOf({ type: "action", caller: { from: "user" }, description: { ...ISSUE, temporaryCanvas: CANVAS } } as any))
      .toEqual({ kind: "declared-canvas", declaredCanvas: { title: "Ada's week", widgets: 2 } });
  });

  it("is never approved by a rule", () => {
    let storage = { containsRestrictedData: { get: () => false },
      autoApproveTags: { get: () => ({ enabledBy: { type: "user", id: "ada" } }) } };
    expect(autoApprovalRule(storage as any, () => "build" as any, 41,
      { ...PROPOSAL, autoApprovable: true, actionKind: { tag: "inferops.dot-canvas-compose" } } as any)).toBeUndefined();
  });
});

describe("the approved effect (FAC-137 K2)", () => {
  it("is handed only to a person's own approval: never an automatic one, an agent's, the system's or an assigned run's", async () => {
    expect((await applying()).effects).toBeDefined();
    expect((await applying({ description: ISSUE })).effects).toBeUndefined();
    expect((await applying({ autoApproved: true })).effects).toBeUndefined();
    for (let resolvedBy of [{ type: "agent", id: "a", name: "Agent" }, { type: "system", id: "s", name: "System" }]) {
      expect((await applying({ resolvedBy })).effects).toBeUndefined();
    }
    expect((await applying({ executedAs: { hookId: 11, deliveryId: 1 } })).effects).toBeUndefined();
  });

  it("creates the declared canvas for the approver, with the server's expiry, once, and is revoked after", async () => {
    let asked: ApprovedTemporaryCanvas[] = [];
    let applied = await applying({ during: async effects => {
      // Arguments are ignored: only the declared canvas is created.
      let first = await (effects.createTemporaryCanvas as (...args: unknown[]) => Promise<ApprovedTemporaryCanvas>)({ title: "Swapped" });
      asked.push(first, await effects.createTemporaryCanvas());
      return first;
    } });
    expect(asked[0]).toMatchObject({ status: "created", canvasId: expect.any(String), expiresAt: expect.any(Date) });
    expect(asked[1]).toEqual(asked[0]);
    let canvases = applied.canvases as any[];
    expect(canvases).toHaveLength(1);
    expect(canvases[0]).toMatchObject({ id: (asked[0] as any).canvasId, title: "Ada's week" });
    expect(canvases[0].expiresAt.getTime()).toBe((asked[0] as any).expiresAt.getTime());
    // It names no run, so asking for one is refused; after the apply, nothing is answered.
    expect(applied.afterwards).toEqual(
      { status: "refused", kind: "policy", reason: TEMPORARY_CANVAS_NEEDS_APPROVAL });
  });

  it("refuses a canvas for an action that declared none", async () => {
    let applied = await applying({ description: { ...ISSUE, workflowRun: { reference: workflowTriggerRef({ company: "acme", workspace: "operations",
      inferosWorkspaceId: "a".repeat(64), hookId: 11, definitionId: "def-1", revision: 2 }) } },
      during: create });
    // Whatever the run's own answer, a canvas was never declared: refused, nothing created.
    if (applied.effects) {
      expect(applied.answers).toEqual([{ status: "refused", kind: "policy", reason: TEMPORARY_CANVAS_NEEDS_APPROVAL }]);
    }
    expect(applied.canvases).toEqual([]);
  });
});

// Two applies of one action in Ada's own operate session: the first creates the canvas and then
// ends unknown but retryable, which leaves the action pending, so it can be approved again (as
// `second`). `between` runs in between; `before` before the first. Returns each answer and the
// canvases stored afterwards, read inside the Durable Object.
async function approvedTwice(second: object, options: {
  between?: (impl: any) => void; before?: (impl: any, actionId: number) => void;
} = {}): Promise<{ answers: ApprovedTemporaryCanvas[]; applies: number; canvases: any[] }> {
  return runInDurableObject(env.TEST_OVERSEER.getByName(`approved-canvas-twice-${++counter}`), async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.users = {
      idFromName: (profileId: string) => ({ toString: () => uid(profileId) }),
      idFromString: (id: string) => id,
      get: () => ({ searchWidgets: async (query: string) => ({ status: "searched", ranking: "keyword", denied: 0,
        unsearched: 0, definitions: [], hits: [BOARD.kind, ISSUES.kind].filter(kind => kind === query)
          .map(kind => ({ kind, description: kind, score: 1 })) }) }),
    };
    impl.ownerId = uid(ADA.id);
    impl.storage.operateSession.put(true);
    impl.storage.gatekeepers.put({ id: 41, resourceTitle: "Your Dot", class: {} as any,
      creationSpec: { type: "gatekeeper", vendorId: "inferops", resourceUrl: "test://x", typeUrlPattern: "test://*" } });
    let answers: ApprovedTemporaryCanvas[] = [];
    let applies = 0;
    impl.getGatekeeperFacet = () => ({
      applyAction: async (_action: number, _cache: unknown, effects?: ApprovedEffects) => {
        answers.push(await effects!.createTemporaryCanvas());
        // The first apply ends after the canvas was created with an outcome it can't be sure of,
        // which it says may be tried again: the kernel lets someone approve it again.
        if (++applies === 1) return { failed: { outcome: "unknown", retryable: true, message: "connection lost" } };
        return undefined;
      },
    });
    await impl.submitAction(41, 1, PROPOSAL, { from: "gatekeeper" });
    let actionId = (Array.from(impl.storage.actions.list()).find((a: any) => a.type === "action") as any).id;
    let current = () => impl.storage.actions.get(actionId);
    options.before?.(impl, actionId);
    try { await impl.applyPendingAction(current(), ADA, false); } catch { /* recorded as unknown, retryable */ }
    options.between?.(impl);
    try { await impl.applyPendingAction(current(), second, false); } catch { /* recorded */ }
    return { answers, applies, canvases: Array.from(impl.storage.temporaryCanvases.list()) as any[] };
  });
}

const GRACE = { type: "user" as const, id: "grace", name: "Grace" };
const NOT_YOURS = { status: "refused", kind: "permission", reason: TEMPORARY_CANVAS_NOT_YOURS };

describe("once per action, across applies, for the same approver in the same live session (FAC-137 K2, r1 and r2)", () => {
  it("answers the same approver's retry in the same session with the one canvas it created", async () => {
    let { answers, applies, canvases } = await approvedTwice(ADA);
    expect(applies).toBe(2);
    expect(answers[0]).toMatchObject({ status: "created" });
    expect(answers[1]).toEqual(answers[0]);
    expect(canvases.map(canvas => canvas.id)).toEqual([(answers[0] as any).canvasId]);
  });

  it("refuses a second approver's retry of the same action, handing them no canvas", async () => {
    let { answers, canvases } = await approvedTwice(GRACE);
    expect(answers[0]).toMatchObject({ status: "created" });
    expect(answers[1]).toEqual(NOT_YOURS);
    expect(JSON.stringify(answers[1])).not.toContain((answers[0] as any).canvasId);
    expect(canvases).toHaveLength(1);
  });

  it("refuses the approver's retry once a company change retired the session", async () => {
    let { answers } = await approvedTwice(ADA, { between: impl => impl.storage.operateSessionRetired.put(true) });
    expect(answers[0]).toMatchObject({ status: "created" });
    expect(answers[1]).toEqual(NOT_YOURS);
  });

  // r2's second HIGH: the stored answer needs the canvas to still be there.
  const GONE = { status: "refused", kind: "policy", reason: TEMPORARY_CANVAS_GONE };

  it("refuses the same approver's retry once the canvas it created has expired, and makes no second one", async () => {
    let { answers, canvases } = await approvedTwice(ADA, { between: impl => {
      let [created] = Array.from(impl.storage.temporaryCanvases.list()) as any[];
      impl.storage.temporaryCanvases.put({ ...created, expiresAt: new Date(Date.now() - 1_000) });
    } });
    let first = (answers[0] as any).canvasId;
    expect(answers[0]).toMatchObject({ status: "created" });
    expect(answers[1]).toEqual(GONE);
    expect(canvases.filter(canvas => canvas.id !== first)).toEqual([]);
  });

  it("refuses the same approver's retry once they removed the canvas, and makes no second one", async () => {
    let { answers, canvases } = await approvedTwice(ADA, { between: impl => {
      let [created] = Array.from(impl.storage.temporaryCanvases.list()) as any[];
      impl.temporaryCanvasesOf(uid(ADA.id)).remove(created.id, created.revision);
    } });
    expect(answers[0]).toMatchObject({ status: "created" });
    expect(answers[1]).toEqual(GONE);
    expect(canvases).toEqual([]);
  });

  it("never answers with a stored canvas recorded for another approver or session", async () => {
    // A record this approval didn't make (another approver's, from another session).
    let { answers, canvases } = await approvedTwice(ADA, { before: (impl, actionId) =>
      impl.ctx.storage.kv.put(`fac137:approvedCanvas:${actionId}`,
        { approver: uid(GRACE.id), sessionId: "another-session", canvasId: "graces-canvas", expiresAt: Date.now() + 60_000 }) });
    expect(answers[0]).toEqual(NOT_YOURS);
    expect(answers.every(answer => !JSON.stringify(answer).includes("graces-canvas"))).toBe(true);
    expect(canvases).toEqual([]);
  });
});

describe("who and what the approved canvas is for (FAC-137 K2: N2, N6, N7)", () => {
  it("creates nothing for anyone but the session's own person (N6)", async () => {
    let grace = { type: "user", id: "grace", name: "Grace" };
    let applied = await applying({ resolvedBy: grace, during: create });
    expect(applied.answers).toEqual([{ status: "refused", kind: "permission", reason: TEMPORARY_CANVAS_NOT_YOURS }]);
    expect(applied.canvases).toEqual([]);
  });

  it("creates nothing in a session a company change retired (N2)", async () => {
    let applied = await applying({ retired: true, during: create });
    expect(applied.answers).toEqual([{ status: "refused", kind: "permission", reason: TEMPORARY_CANVAS_NOT_YOURS }]);
    expect(applied.canvases).toEqual([]);
  });

  it("creates nothing when one widget isn't offered to the approver now, all or nothing (N7)", async () => {
    // A built-in kind their own widget search no longer returns.
    let notSearched = await applying({ offered: [BOARD.kind], during: create });
    expect(notSearched.answers).toEqual([{ status: "refused", kind: "permission", reason: TEMPORARY_CANVAS_WIDGET_UNAVAILABLE }]);
    expect(notSearched.canvases).toEqual([]);
    // A console widget its own workspace doesn't offer them (a workspace they hold no role in).
    let elsewhere = { type: "console-widget", workspaceId: env.TEST_OVERSEER.newUniqueId().toString(), consoleId: "c",
      sourceGadgetId: 7, blueprintId: "inferops-board", version: 1 };
    let notOffered = await applying({ during: create, description: { ...PROPOSAL,
      temporaryCanvas: { ...CANVAS, placements: [...CANVAS.placements, { ref: elsewhere, layout: { x: 0, y: 4, w: 6, h: 4 } }] } } });
    expect(notOffered.answers).toEqual([{ status: "refused", kind: "permission", reason: TEMPORARY_CANVAS_WIDGET_UNAVAILABLE }]);
    expect(notOffered.canvases).toEqual([]);
  });

  it("never touches shared configuration", async () => {
    let applied = await applying({ during: create });
    expect(applied.canvases).toHaveLength(1);
    for (let [name, records] of Object.entries(applied.shared)) expect(records, name).toEqual([]);
  });
});
