// FAC-119: what kind of reason a failed apply was, as the gatekeeper's structured answer said it, is
// kept on the action's record by the real kernel: a workflow-policy refusal and a missing permission
// reach it as different kinds, an unknown kind or a thrown error reads as unavailable, and nothing
// is inferred from the message. Over the production Overseer Durable Object.
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { ActionApplyFailure } from "@gadgets/workshop-shared/gatekeeper";
import type { OverseerDurableObject } from "../src/overseer.js";

const ADA = { type: "user" as const, id: "ada-profile", name: "Ada" };
const CONNECTION = 41;
const DESCRIPTION = { title: "Move ENG-1", description: "Moves ENG-1 to Done.", implementsRevert: false, descriptionIsComplete: true };

/** Applies one pending action whose gatekeeper answers `answer`, and returns its record after. */
async function applied(name: string, answer: () => Promise<{ failed: ActionApplyFailure }>) {
  return runInDurableObject(env.TEST_OVERSEER.getByName(name), async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.storage.gatekeepers.put({
      id: CONNECTION, resourceTitle: "Board", class: {} as any,
      creationSpec: { type: "gatekeeper", vendorId: "test", resourceUrl: "test://board", typeUrlPattern: "test://*" },
    });
    impl.getGatekeeperFacet = () => ({ applyAction: answer });
    await impl.submitAction(CONNECTION, 1, DESCRIPTION, { from: "agent", chatId: 1 });
    let record = Array.from(impl.storage.actions.list()).find((a: any) => a.type === "action") as any;
    try { await impl.applyPendingAction(record, ADA, false); } catch { /* recorded, then thrown */ }
    return impl.storage.actions.get(record.id);
  });
}

const refusal = (kind: unknown, code = "FORBIDDEN"): ActionApplyFailure =>
  ({ outcome: "notApplied", retryable: false, message: "InferOps refused it.", code, kind: kind as never });

describe("a failed apply's kind, on the record", () => {
  it("keeps a policy refusal and a missing permission apart, though both are FORBIDDEN with the same words", async () => {
    let policy = await applied("fac119-kind-policy", async () => ({ failed: refusal("policy") }));
    let permission = await applied("fac119-kind-permission", async () => ({ failed: refusal("permission") }));
    expect(policy.lastAttempt).toMatchObject({ code: "FORBIDDEN", message: "InferOps refused it.", kind: "policy" });
    expect(permission.lastAttempt).toMatchObject({ code: "FORBIDDEN", message: "InferOps refused it.", kind: "permission" });
    expect(policy.state).toBe("failed");
  });

  it("keeps an expired sign-in, pending to approve again once reconnected", async () => {
    let signIn = await applied("fac119-kind-sign-in", async () =>
      ({ failed: { ...refusal("sign-in", "UNAUTHORIZED"), retryable: true } }));
    expect(signIn).toMatchObject({ state: "pending", lastAttempt: { kind: "sign-in", retryable: true } });
  });

  it("reads a kind it doesn't know as unavailable, and records none for a thrown error", async () => {
    let odd = await applied("fac119-kind-odd", async () => ({ failed: refusal("because-reasons") }));
    expect(odd.lastAttempt.kind).toBe("unavailable");
    let thrown = await applied("fac119-kind-thrown", async () => { throw new Error("FORBIDDEN: policy says no"); });
    expect(thrown.lastAttempt).toMatchObject({ outcome: "unknown" });
    expect(thrown.lastAttempt).not.toHaveProperty("kind");
  });
});
