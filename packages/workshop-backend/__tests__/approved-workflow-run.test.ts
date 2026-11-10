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

const request = (overrides: Record<string, unknown> = {}) => ({ hookId: HOOK, definitionId: DEFINITION, revision: 2, ...overrides });

describe("the trigger's own workspace", () => {
  it("admits the run for a verified person with use there, through their own on-request path", () =>
    withTrigger(async h => {
      let p1 = person(h, "p1", "use");
      expect(await h.instance.invokeTriggerAs(p1, request())).toEqual({ status: "started", runId: "run-1" });
      expect(h.invoked).toEqual([[uid("p1"), "p1", HOOK]]);
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

  it("starts nothing for an unknown or disabled hook, another definition, or a revision it no longer runs", () =>
    withTrigger(async h => {
      let p1 = person(h, "p1", "use");
      expect(await h.instance.invokeTriggerAs(p1, request({ hookId: 12 }))).toMatchObject({ status: "refused", kind: "permission" });
      expect(await h.instance.invokeTriggerAs(p1, request({ definitionId: "def-2" }))).toMatchObject({ status: "refused", kind: "permission" });
      expect(await h.instance.invokeTriggerAs(p1, request({ revision: 1 })))
        .toMatchObject({ status: "refused", kind: "policy", reason: expect.stringMatching(/changed since it was proposed/) });
      expect(await h.instance.invokeTriggerAs(p1, request({ hookId: "11" }))).toMatchObject({ status: "refused", kind: "invalid" });
      h.impl.storage.boundHooks.put({ id: HOOK, gadgetId: 3, gatekeeperId: 50, enabled: false } as never);
      expect(await h.instance.invokeTriggerAs(p1, request())).toMatchObject({ status: "refused", kind: "permission" });
      expect(h.invoked).toEqual([]);
    }));

  it("passes on the on-request path's own refusal (not an invoker, no workflow:invoke) without starting anything", () =>
    withTrigger(async h => {
      let p1 = person(h, "p1", "use");
      h.impl.invokeTrigger = async () => { throw new Error("You can't run this trigger."); };
      expect(await h.instance.invokeTriggerAs(p1, request()))
        .toEqual({ status: "refused", kind: "permission", reason: "You can't run this trigger." });
    }));
});

describe("the approved effects a gatekeeper's apply receives", () => {
  const ADA = { type: "user" as const, id: "ada-profile", name: "Ada" };
  const DESCRIPTION = { title: "Run it", description: "Runs it.", implementsRevert: false, descriptionIsComplete: true };

  // Applies one pending action of a gatekeeper that records the effects it was handed, and what
  // they answer during the apply.
  async function applying(name: string, autoApproved: boolean, during: (effects: ApprovedEffects) => Promise<ApprovedWorkflowRun>) {
    return runInDurableObject(env.TEST_OVERSEER.getByName(name), async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      impl.storage.gatekeepers.put({ id: 41, resourceTitle: "Dot", class: {} as any,
        creationSpec: { type: "gatekeeper", vendorId: "test", resourceUrl: "test://dot", typeUrlPattern: "test://*" } });
      let seen: { effects?: ApprovedEffects; answer?: ApprovedWorkflowRun } = {};
      impl.getGatekeeperFacet = () => ({
        applyAction: async (_action: number, _cache: unknown, effects?: ApprovedEffects) => {
          seen.effects = effects;
          if (effects) seen.answer = await during(effects);
        },
      });
      await impl.submitAction(41, 1, DESCRIPTION, { from: "agent", chatId: 1 });
      let record = Array.from(impl.storage.actions.list()).find((a: any) => a.type === "action") as any;
      try { await impl.applyPendingAction(record, ADA, autoApproved); } catch { /* recorded */ }
      return seen;
    });
  }

  it("are absent from an automatic approval, so nothing a gatekeeper sends can start a run", async () => {
    let seen = await applying("approved-run-auto", true, async () => ({ status: "started", runId: "x" }));
    expect(seen.effects).toBeUndefined();
  });

  it("start at most one run per approval, refuse a reference that isn't one, and are revoked once the apply returns", async () => {
    let seen = await applying("approved-run-manual", false, async effects => {
      let unreadable = await effects.invokeWorkflow("https://example.com/not-a-trigger");
      expect(unreadable).toMatchObject({ status: "refused", kind: "invalid" });
      return effects.invokeWorkflow(workflowTriggerRef({ company: "acme", workspace: "operations",
        inferosWorkspaceId: "a".repeat(64), hookId: HOOK, definitionId: DEFINITION, revision: 2 }));
    });
    expect(seen.effects).toBeDefined();
    // The first call, however it ended, was the approval's one call.
    expect(seen.answer).toEqual({ status: "refused", kind: "policy", reason: "This approval has already started a run." });
    expect(await seen.effects!.invokeWorkflow("anything")).toEqual(
      { status: "refused", kind: "policy", reason: "Starting a workflow run needs a person's approval." });
  });
});
