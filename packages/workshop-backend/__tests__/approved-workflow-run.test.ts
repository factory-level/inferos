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
import type { OverseerDurableObject } from "../src/overseer.js";

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
      return { id: "run-1", hookId: HOOK, definitionId: DEFINITION, revision: 2 };
    };
    await fn({ impl, instance, workspaceId: impl.ctx.id.toString(), people, invoked });
  }, name);
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
      h.impl.invokeTrigger = async () => ({ id: "run-2", hookId: HOOK, definitionId: DEFINITION, revision: 2 });
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
      h.impl.invokeTrigger = async () => ({ id: "run-2", hookId: HOOK, definitionId: DEFINITION, revision: 2 });
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
      try { await impl.applyPendingAction(record, options.resolvedBy ?? ADA, options.autoApproved ?? false); } catch { /* recorded */ }
      return { seen, impl };
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

  it("refuses at submit a declared run that isn't a workflow trigger reference", () =>
    runInDurableObject(env.TEST_OVERSEER.getByName("effects-malformed"), async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      impl.storage.gatekeepers.put({ id: 41, resourceTitle: "Connection", class: {} as any,
        creationSpec: { type: "gatekeeper", vendorId: "inferops", resourceUrl: "test://x", typeUrlPattern: "test://*" } });
      await expect(impl.submitAction(41, 1, { ...RUN, workflowRun: { reference: "https://example.com" } }, { from: "agent", chatId: 1 }))
        .rejects.toThrow(/must name an InferOS workflow trigger reference/);
    }));
});
