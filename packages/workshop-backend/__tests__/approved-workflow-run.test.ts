// FAC-120, K1: a workflow run the Dot proposed starts only as the person approving it. The kernel
// hands a gatekeeper's applyAction its approved effects only for a person's own approval, revokes
// them when it returns, and the trigger's own workspace (`invokeTriggerAs`) verifies that person,
// needs `use` there and the definition and revision named, and only then admits the run through the
// person's own on-request path. Real Overseer Durable Objects in workerd with fake user Durable
// Objects; the on-request admission itself (invokeWorkflowTrigger) is covered by
// workflow-invocation.test.ts and is recorded here, not run.
//
// Synthetic bounded fixtures only.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { ApprovedEffects, ApprovedWorkflowRun } from "@gadgets/workshop-shared/gatekeeper";
import { workflowTriggerRef } from "@gadgets/workshop-shared/workflow-trigger-ref";
import type { ConsoleToolCaller } from "../src/console-tools";
import { actionContextOf, invokeWorkflowTrigger, WORKFLOW_RUN_FIELD_LABEL, type OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const OWNER = "owner";
const HOOK = 11;
const DEFINITION = "def-1";
const uid = (profileId: string) => `${profileId}-user-id`;

type Person = { profileId: string; session: string | null };
type Harness = { impl: any; instance: OverseerDurableObject; workspaceId: string; people: Map<string, Person>;
  invoked: unknown[][] };

let counter = 0;

// A real workspace W with trigger HOOK pinned to DEFINITION revision 2, and fake user DOs.
async function withTrigger(fn: (h: Harness) => Promise<void>, name = `approved-run-${++counter}`): Promise<void> {
  await runInDurableObject(env.TEST_OVERSEER.getByName(name), async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    let people = new Map<string, Person>();
    impl.users = {
      idFromName: (profileId: string) => ({ toString: () => uid(profileId) }),
      idFromString: (id: string) => id,
      get: (id: string) => ({
        id,
        whoami: async () => ({ type: "user", id: people.get(id)?.profileId ?? "nobody", name: "Someone" }),
        operateSessionWorkspaceId: async () => people.get(id)?.session ?? null,
        recordSharedGadgetOpen: async () => {},
      }),
    };
    impl.ensureAmbientCapsules = async () => {};
    impl.ownerId = uid(OWNER);
    impl.storage.ownerId.put(uid(OWNER));
    impl.ownerProfileId = OWNER;
    impl.storage.workflowTriggerPins.put({ hookId: HOOK, definitionId: DEFINITION, revision: 2, mode: "pinned" });
    impl.storage.boundHooks.put({ id: HOOK, gadgetId: 3, gatekeeperId: 50, enabled: true } as never);
    let invoked: unknown[][] = [];
    impl.invokeTrigger = async (...args: unknown[]) => {
      invoked.push(args);
      return minted(impl, "inv-1", "run-1");
    };
    await fn({ impl, instance, workspaceId: impl.ctx.id.toString(), people, invoked });
  }, name);
}

// An invocation as beginInvocation records it, with the id its run will have (FAC-134): what
// invokeTriggerAs answers with, never the invocation's own id.
function minted(impl: any, id: string, runId: string) {
  impl.storage.workflowInvocations.put({ id, hookId: HOOK, definitionId: DEFINITION, revision: 2,
    requestedAt: new Date(0), requestedBy: "p1", company: null, runId });
  return { id, hookId: HOOK, definitionId: DEFINITION, revision: 2 };
}

// `profileId` with that role in W (none: a stranger), their operate session `session`.
function person(h: Harness, profileId: string, role?: "use" | "build", session = `session-of-${profileId}`): ConsoleToolCaller {
  if (role) {
    h.impl.storage.collaborators.put({ profile: { type: "user", id: profileId, name: profileId },
      addedBy: [{ type: "user", sharer: OWNER, created: new Date(), role }] });
  }
  h.people.set(uid(profileId), { profileId, session });
  return { userId: uid(profileId), profileId, sessionWorkspaceId: session };
}

const request = (overrides: Record<string, unknown> = {}) =>
  ({ hookId: HOOK, definitionId: DEFINITION, revision: 2, actionId: 5, ...overrides });

describe("the trigger's own workspace", () => {
  it("admits the run for a verified person with use there, through their own on-request path", () =>
    withTrigger(async h => {
      let p1 = person(h, "p1", "use");
      expect(await h.instance.invokeTriggerAs(p1, request())).toEqual({ status: "started", runId: "run-1" });
      // With the definition and revision approved, which admission holds the run to (r2's HIGH).
      expect(h.invoked).toEqual([[uid("p1"), "p1", HOOK,
        { definitionId: DEFINITION, revision: 2, onAdmitted: expect.any(Function) }]]);
    }));

  // FAC-115's last criterion: a background result appears in the common run history. Here the
  // approved run takes the person's real on-request path (invokeWorkflowTrigger -> beginInvocation),
  // and the trigger's gatekeeper delivers it (store.fire, as startHook does), so the history entry is
  // the one the run itself leaves, not one the test writes.
  it("records the approved run in the definition's run history, as the approver's, readable only by who may read it", () =>
    withTrigger(async h => {
      let p1 = person(h, "p1", "use");
      let owner = { type: "user" as const, id: OWNER, name: "Owner" };
      let headOf = () => "a".repeat(40);
      let store = h.impl.workflowDefinitionStore();
      let saved = store.save(owner, { title: "Build", gadgetId: 3 }, headOf, "build");
      store.publish(owner, saved.id, 1);
      store.pinTrigger(OWNER, HOOK, 3, { definitionId: saved.id, revision: 1, mode: "pinned" });
      store.setControl(owner, HOOK, { label: "Build now", invokers: ["p1"] });
      // The gatekeeper's half, as startHook does it: the delivery names the invocation it was handed.
      let roles = await h.impl.definitionRoles();
      let hook = { id: HOOK, gadgetId: 3, gatekeeperId: 50, enabled: true, controller: {
        invoke: async ({ invocationId }: { invocationId: string }) => {
          h.impl.takenInvocations.set(invocationId, true);
          store.fire(HOOK, 3, headOf, roles, invocationId);
        },
      } };
      h.impl.storage.boundHooks = { get: (id: number) => (id === HOOK ? hook : undefined), list: () => [hook] };
      h.impl.assertGatekeeperUsable = () => {};
      h.impl.requireHookBound = () => {};
      h.impl.requireTriggerStarts = () => {};
      h.impl.getGadgetHead = headOf;
      h.impl.invokeTrigger = (userId: string, profileId: string, hookId: number, expected?: never) =>
        invokeWorkflowTrigger(h.impl, userId, profileId, hookId, expected);

      let started = await h.instance.invokeTriggerAs(p1, request({ definitionId: saved.id, revision: 1 }));
      expect(started).toMatchObject({ status: "started" });
      let runId = (started as { runId: string }).runId;

      // 1. One delivery for that run, requested by the approver.
      let deliveries = store.deliveries(OWNER, saved.id, "build");
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]!.invocation).toEqual({ id: runId, requestedBy: "p1" });
      // 2. The owner's readable histories discover it.
      expect(store.listReadableWorkflowHistories(OWNER, "build")).toContainEqual({ definitionId: saved.id });
      // 3. A person of another company holds no role in this workspace: not listed, and its
      // deliveries read as absent.
      expect(store.listReadableWorkflowHistories("other-company-person", null)).toEqual([]);
      expect(() => store.deliveries("other-company-person", saved.id, null)).toThrow();
      // 4. Nor a stranger of this company, nor the approver as a runner (who reads their own
      // requested runs through requestedDeliveries instead).
      expect(store.listReadableWorkflowHistories("stranger", null)).toEqual([]);
      expect(store.listReadableWorkflowHistories("p1", "use")).toEqual([]);
      expect(() => store.deliveries("p1", saved.id, "use")).toThrow();
    }));

  it("starts nothing for a stranger, an unverified caller, a caller naming W as its session, or in an operate session", () =>
    withTrigger(async h => {
      let p1 = person(h, "p1", "use");
      let stranger = person(h, "stranger");
      for (let caller of [stranger, { ...p1, profileId: "p2" }, { ...p1, sessionWorkspaceId: "elsewhere" },
        { ...p1, sessionWorkspaceId: h.workspaceId }]) {
        expect(await h.instance.invokeTriggerAs(caller, request())).toMatchObject({ status: "refused", kind: "permission" });
      }
      h.impl.storage.operateSession.put(true);
      expect(await h.instance.invokeTriggerAs(p1, request())).toMatchObject({ status: "refused", kind: "permission" });
      expect(h.invoked).toEqual([]);
    }));

  it("starts nothing for an unknown or disabled hook, another definition, a revision it no longer runs, or no action", () =>
    withTrigger(async h => {
      let p1 = person(h, "p1", "use");
      expect(await h.instance.invokeTriggerAs(p1, request({ hookId: 12 }))).toMatchObject({ status: "refused", kind: "permission" });
      expect(await h.instance.invokeTriggerAs(p1, request({ definitionId: "def-2" }))).toMatchObject({ status: "refused", kind: "permission" });
      expect(await h.instance.invokeTriggerAs(p1, request({ revision: 1 })))
        .toMatchObject({ status: "refused", kind: "policy", reason: expect.stringMatching(/changed since it was proposed/) });
      expect(await h.instance.invokeTriggerAs(p1, request({ hookId: "11" }))).toMatchObject({ status: "refused", kind: "invalid" });
      expect(await h.instance.invokeTriggerAs(p1, request({ actionId: undefined }))).toMatchObject({ status: "refused", kind: "invalid" });
      h.impl.storage.boundHooks.put({ id: HOOK, gadgetId: 3, gatekeeperId: 50, enabled: false } as never);
      expect(await h.instance.invokeTriggerAs(p1, request())).toMatchObject({ status: "refused", kind: "permission" });
      expect(h.invoked).toEqual([]);
    }));

  it("answers a refusal before anything is minted in a fixed sentence, and lets the same action try again", () =>
    withTrigger(async h => {
      let p1 = person(h, "p1", "use");
      h.impl.invokeTrigger = async () => { throw new Error("internal detail: workflow:invoke for workspace 123 denied"); };
      expect(await h.instance.invokeTriggerAs(p1, request()))
        .toEqual({ status: "refused", kind: "unavailable", reason: "This trigger couldn't be run just now." });
      h.impl.invokeTrigger = async () => { throw new Error("You can't run this trigger."); };
      expect(await h.instance.invokeTriggerAs(p1, request()))
        .toEqual({ status: "refused", kind: "permission", reason: "You can't run this trigger." });
    }));

  it("refuses as policy, starting nothing, when admission finds the trigger moved since approval, and lets it try again", () =>
    withTrigger(async h => {
      let p1 = person(h, "p1", "use");
      // invokeWorkflowTrigger's refusal after its last await: thrown before anything is minted.
      h.impl.invokeTrigger = async () => {
        throw new Error("The workflow changed since it was proposed: its trigger no longer runs that revision. Ask the Dot again.");
      };
      expect(await h.instance.invokeTriggerAs(p1, request())).toEqual({ status: "refused", kind: "policy",
        reason: "The workflow changed since it was proposed: its trigger no longer runs that revision. Ask the Dot again." });
      // Refused, not unknown: the record is gone, so the same action is answered afresh.
      h.impl.invokeTrigger = async () => minted(h.impl, "inv-2", "run-2");
      expect(await h.instance.invokeTriggerAs(p1, request())).toEqual({ status: "started", runId: "run-2" });
    }));

  it("refuses, and lets the same action try again, when another person's run is minted while this one waits and this one is refused before admission", () =>
    withTrigger(async h => {
      let p1 = person(h, "p1", "use");
      h.impl.invokeTrigger = async () => {
        // Someone else's run is minted while this call awaits its grant: the workspace's invocation
        // log moves, but this call never reaches beginInvocation.
        h.impl.storage.nextWorkflowInvocationLogId.put(h.impl.storage.nextWorkflowInvocationLogId.get() + 1);
        throw new Error("You can't run this trigger.");
      };
      expect(await h.instance.invokeTriggerAs(p1, request()))
        .toEqual({ status: "refused", kind: "permission", reason: "You can't run this trigger." });
      // No record is left: the same approved action is answered afresh, and starts.
      h.impl.invokeTrigger = async () => minted(h.impl, "inv-2", "run-2");
      expect(await h.instance.invokeTriggerAs(p1, request())).toEqual({ status: "started", runId: "run-2" });
    }));

  it("returns the same run for the same approved action, and starts no second one", () =>
    withTrigger(async h => {
      let p1 = person(h, "p1", "use");
      expect(await h.instance.invokeTriggerAs(p1, request())).toEqual({ status: "started", runId: "run-1" });
      expect(await h.instance.invokeTriggerAs(p1, request())).toEqual({ status: "started", runId: "run-1" });
      expect(h.invoked).toHaveLength(1);
      // Another action is its own approval.
      await h.instance.invokeTriggerAs(p1, request({ actionId: 6 }));
      expect(h.invoked).toHaveLength(2);
    }));

  it("answers a start that may have happened as unknown, never a refusal, and never starts it again", () =>
    withTrigger(async h => {
      let p1 = person(h, "p1", "use");
      // This call's invocation was minted, then the answer was lost: the run may exist.
      h.impl.invokeTrigger = async (...args: unknown[]) => {
        h.invoked.push(["minted"]);
        (args[3] as { onAdmitted(id: string): void }).onAdmitted("invocation-1");
        throw new Error("the run's own failure after it was taken");
      };
      expect(await h.instance.invokeTriggerAs(p1, request())).toMatchObject({ status: "unknown" });
      expect(await h.instance.invokeTriggerAs(p1, request())).toMatchObject({ status: "unknown" });
      expect(h.invoked).toHaveLength(1);
    }));
});

describe("the approved effects a gatekeeper's apply receives", () => {
  const ADA = { type: "user" as const, id: "ada-profile", name: "Ada" };
  const REFERENCE = workflowTriggerRef({ company: "acme", workspace: "operations",
    inferosWorkspaceId: "a".repeat(64), hookId: HOOK, definitionId: DEFINITION, revision: 2 });
  const RUN = { title: "Run it", description: "Runs it.", implementsRevert: false, descriptionIsComplete: true,
    workflowRun: { reference: REFERENCE } };
  const ISSUE = { title: "Create an issue", description: "Creates an issue.", implementsRevert: false, descriptionIsComplete: true };

  // Applies one pending action of a gatekeeper (vendor `vendorId`) that records the effects it was
  // handed, and what they answer during the apply; `invoked` records each run the kernel asked for.
  async function applying(name: string, options: {
    description?: object; resolvedBy?: object; autoApproved?: boolean; executedAs?: object; vendorId?: string;
    during?: (effects: ApprovedEffects) => Promise<ApprovedWorkflowRun>;
  } = {}) {
    return runInDurableObject(env.TEST_OVERSEER.getByName(name), async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      impl.storage.gatekeepers.put({ id: 41, resourceTitle: "Connection", class: {} as any,
        creationSpec: { type: "gatekeeper", vendorId: options.vendorId ?? "inferops", resourceUrl: "test://x", typeUrlPattern: "test://*" } });
      let seen: { effects?: ApprovedEffects; answers: ApprovedWorkflowRun[] } = { answers: [] };
      impl.getGatekeeperFacet = () => ({
        applyAction: async (_action: number, _cache: unknown, effects?: ApprovedEffects) => {
          seen.effects = effects;
          if (effects && options.during) seen.answers.push(await options.during(effects));
        },
      });
      await impl.submitAction(41, 1, options.description ?? RUN, { from: "agent", chatId: 1 });
      let record = Array.from(impl.storage.actions.list()).find((a: any) => a.type === "action") as any;
      if (options.executedAs) record.executedAs = options.executedAs;
      // The description as submission stored it, before anything applies.
      let stored = structuredClone(record.description);
      let context = actionContextOf(record);
      try { await impl.applyPendingAction(record, options.resolvedBy ?? ADA, options.autoApproved ?? false); } catch { /* recorded */ }
      return { seen, impl, stored, context };
    });
  }

  it("are minted only for a person's own approval of an action that declared its run", async () => {
    expect((await applying("effects-declared")).seen.effects).toBeDefined();
    // QA: a non-Dot gatekeeper's ordinary write (vendor github, "Create an issue") gets none.
    expect((await applying("effects-github", { description: ISSUE, vendorId: "github" })).seen.effects).toBeUndefined();
    expect((await applying("effects-undeclared", { description: ISSUE })).seen.effects).toBeUndefined();
    expect((await applying("effects-auto", { autoApproved: true })).seen.effects).toBeUndefined();
    // QA: an agent or system resolver gets none.
    for (let [n, resolvedBy] of [["agent", { type: "agent", id: "a", name: "Agent" }], ["system", { type: "system", id: "s", name: "System" }]] as const) {
      expect((await applying(`effects-${n}`, { resolvedBy })).seen.effects).toBeUndefined();
    }
    // QA: an assigned run's write gets none.
    expect((await applying("effects-executed-as", { executedAs: { hookId: HOOK, deliveryId: 1 } })).seen.effects).toBeUndefined();
  });

  it("start the run the action declared, which nothing at apply can swap, give repeats the first answer, and are revoked after", async () => {
    let asked: unknown[] = [];
    let { seen } = await applying("effects-bound", {
      during: async effects => {
        // A gatekeeper can pass nothing: the declared reference is the run (extra arguments are ignored).
        let first = await (effects.invokeWorkflow as (...args: unknown[]) => Promise<ApprovedWorkflowRun>)("inferops://evil.co/inferos/workflow-trigger/x/1?definition=\"d\"&revision=\"1\"");
        let again = await effects.invokeWorkflow();
        asked.push(first, again);
        return first;
      },
    });
    expect(seen.effects).toBeDefined();
    // The trigger's workspace (a fresh id here) isn't reachable as the approver, so the run is
    // refused or unknown; either way the same answer twice, from one call.
    expect(asked[0]).toEqual(asked[1]);
    expect(await seen.effects!.invokeWorkflow()).toEqual(
      { status: "refused", kind: "policy", reason: "Starting a workflow run needs a person's approval." });
  });

  it("shows a declared run on the stored description in the kernel's words, whatever gatekeeper declared it", async () => {
    // r1: a non-Dot gatekeeper's write (vendor github, "Create an issue") that declares a run. The
    // gatekeeper's own title, prose and fields say nothing of it; the kernel's last field does.
    let declared = { ...ISSUE, fields: [{ label: "Repository", kind: "inline", value: "acme/app" }],
      workflowRun: { reference: REFERENCE } };
    let { stored } = await applying("shown-github", { description: declared, vendorId: "github" });
    expect(stored.fields).toEqual([
      { label: "Repository", kind: "inline", value: "acme/app" },
      { label: WORKFLOW_RUN_FIELD_LABEL, kind: "inline", value: REFERENCE },
    ]);
    // An action that declares no run gets no such field.
    expect((await applying("shown-none", { description: ISSUE, vendorId: "github" })).stored.fields ?? []).toEqual([]);
  });

  it("marks the action's context with the declared run, from the kernel's own record, and only then", async () => {
    // r1 round 6: what the compact approve surfaces read, without parsing fields.
    // These are an agent's turn's actions: the origin keeps its kind and carries the marker.
    expect((await applying("marked-github", { description: { ...ISSUE, workflowRun: { reference: REFERENCE } }, vendorId: "github" })).context)
      .toEqual({ kind: "agent-turn", declaredRun: { reference: REFERENCE } });
    expect((await applying("marked-agent")).context).toEqual({ kind: "agent-turn", declaredRun: { reference: REFERENCE } });
    // With no other origin to report, the context is the declared run alone.
    expect(actionContextOf({ type: "action", caller: { from: "user" }, description: { ...ISSUE, workflowRun: { reference: REFERENCE } } } as any))
      .toEqual({ kind: "declared-run", declaredRun: { reference: REFERENCE } });
    expect(actionContextOf({ type: "action", caller: { from: "user" }, description: ISSUE } as any)).toBeUndefined();
    // No declared run, no marker; and nothing a gatekeeper writes into its description sets one.
    expect((await applying("marked-none", { description: ISSUE, vendorId: "github" })).context).toEqual({ kind: "agent-turn" });
    let forged = { ...ISSUE, declaredRun: { reference: REFERENCE }, context: { kind: "declared-run", declaredRun: { reference: REFERENCE } } };
    expect((await applying("marked-forged", { description: forged, vendorId: "github" })).context).toEqual({ kind: "agent-turn" });
  });

  it("refuses at submit a gatekeeper's field that takes the kernel's reserved label, however it is cased or spaced", () =>
    runInDurableObject(env.TEST_OVERSEER.getByName("reserved-label"), async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      impl.storage.gatekeepers.put({ id: 41, resourceTitle: "Connection", class: {} as any,
        creationSpec: { type: "gatekeeper", vendorId: "github", resourceUrl: "test://x", typeUrlPattern: "test://*" } });
      let decoy = (label: string) => ({ ...ISSUE, fields: [{ label, kind: "inline", value: "inferops://elsewhere" }] });
      // Round 7: invisible characters, compatibility forms and collapsed spacing are folded first.
      let words = WORKFLOW_RUN_FIELD_LABEL.split(" ");
      let fullwidth = (text: string) => [...text].map(c => c >= "!" && c <= "~" ? String.fromCodePoint(c.codePointAt(0)! + 0xFEE0) : c).join("");
      for (let label of [WORKFLOW_RUN_FIELD_LABEL, ` ${WORKFLOW_RUN_FIELD_LABEL.toUpperCase()}  `, WORKFLOW_RUN_FIELD_LABEL.toLowerCase(),
        `Work\u200Bflow ${words.slice(1).join(" ")}`, `${fullwidth(words[0]!)} ${words.slice(1).join(" ")}`,
        words.join("   \t "), `\u2060${WORKFLOW_RUN_FIELD_LABEL.replace("run", "R\u00ADUN")}`]) {
        await expect(impl.submitAction(41, 1, decoy(label), { from: "agent", chatId: 1 })).rejects.toThrow(/reserved for InferOS/);
        // With a declared run too: the decoy is refused, not shown beside the kernel's field.
        await expect(impl.submitAction(41, 1, { ...decoy(label), workflowRun: { reference: REFERENCE } }, { from: "agent", chatId: 1 }))
          .rejects.toThrow(/reserved for InferOS/);
      }
      expect(Array.from(impl.storage.actions.list())).toEqual([]);
      // A genuinely different label still passes.
      await impl.submitAction(41, 1, decoy("Workflow run notes"), { from: "agent", chatId: 1 });
      expect(Array.from(impl.storage.actions.list()).filter((a: any) => a.type === "action")).toHaveLength(1);
    }));

  it("refuses at submit a declared run that isn't a workflow trigger reference", () =>
    runInDurableObject(env.TEST_OVERSEER.getByName("effects-malformed"), async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      impl.storage.gatekeepers.put({ id: 41, resourceTitle: "Connection", class: {} as any,
        creationSpec: { type: "gatekeeper", vendorId: "inferops", resourceUrl: "test://x", typeUrlPattern: "test://*" } });
      await expect(impl.submitAction(41, 1, { ...RUN, workflowRun: { reference: "https://example.com" } }, { from: "agent", chatId: 1 }))
        .rejects.toThrow(/must name an InferOS workflow trigger reference/);
    }));
});
