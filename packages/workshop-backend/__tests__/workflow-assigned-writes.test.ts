// An assigned run's proposed write (FAC-102): a person approves it, and it applies as the trigger's
// service account through a short-lived session on the run's own system facet, never through the
// connection's own facet, which never saw the action (QA finding on #374). Over a real Overseer
// Durable Object, like git-push-actions.test.ts; the service-account facet is replaced through
// impl.openAssignedActionFacet, since a real gatekeeper class can't be minted from a test, and the
// liveness check through impl.assignedActionProblem (its own logic is tested in
// workflow-system-run.test.ts).

import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const CONNECTION = 7;
const HOOK = 3;
const DELIVERY = 41;
const REF = "5b2c1d8e-0000-4000-8000-0000000000b1";
const ADA = { type: "user" as const, id: "ada@example.com", name: "Ada" };
const DESCRIPTION: ActionDescription = { title: "Create issue", description: "Creates one issue.", implementsRevert: false };

type Opened = { executedAs: unknown; closed: boolean };

/** A workspace with the assigned connection, an assigned run in flight, and the two seams replaced. */
async function inAssigned(name: string, fn: (impl: any, opened: Opened[], apply: ReturnType<typeof vi.fn>) => Promise<void>) {
  let stub = env.TEST_OVERSEER.getByName(name);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.storage.gatekeepers.put({
      id: CONNECTION, resourceTitle: "Operations board", class: {} as any,
      creationSpec: { type: "gatekeeper", vendorId: "inferops", resourceUrl: "inferops://acme.operations/project/board/OPS", typeUrlPattern: "inferops://*" },
    });
    impl.systemRuns.begin(DELIVERY, { hookId: HOOK, gatekeeperId: CONNECTION, credentialRef: REF });
    let opened: Opened[] = [];
    let apply = vi.fn(async (_action: number, _cache: unknown) => {});
    impl.openAssignedActionFacet = async (record: { executedAs: unknown }) => {
      let entry: Opened = { executedAs: record.executedAs, closed: false };
      opened.push(entry);
      return { facet: { applyAction: apply, rejectAction: vi.fn(async () => {}) }, close: () => { entry.closed = true; } };
    };
    impl.assignedActionProblem = () => null;
    impl.getGatekeeperFacet = () => { throw new Error("the connection's own facet was used"); };
    await fn(impl, opened, apply);
  });
}

async function proposeAsRun(impl: any) {
  await impl.submitAction(CONNECTION, 1, DESCRIPTION, { from: "systemRun", hookId: HOOK, deliveryId: DELIVERY });
  return Array.from(impl.storage.actions.list()).find((a: any) => a.type === "action") as any;
}

async function refusalOf(run: () => Promise<unknown>) {
  let refused: unknown;
  try { await run(); } catch (error) { refused = error; }
  return String(refused);
}

describe("an assigned run's write, approved by a person", () => {
  it("records who the run acted as, and is never auto-approved", async () => {
    await inAssigned("assigned-record", async impl => {
      let record = await proposeAsRun(impl);
      expect(record.state).toBe("pending");
      expect(record.executedAs).toEqual({ hookId: HOOK, deliveryId: DELIVERY, credentialRef: REF });
      expect(record.caller).toEqual({ from: "systemRun", hookId: HOOK, deliveryId: DELIVERY });
    });
  });

  it("applies as the service account through the run's own facet, then closes it", async () => {
    await inAssigned("assigned-apply", async (impl, opened, apply) => {
      let record = await proposeAsRun(impl);
      // The run has ended by the time a person approves: the apply doesn't need it.
      impl.systemRuns.end(DELIVERY);
      await impl.applyPendingAction(record, ADA, false);
      expect(apply).toHaveBeenCalledOnce();
      expect(apply.mock.calls[0]![0]).toBe(1);
      expect(opened).toEqual([{ executedAs: { hookId: HOOK, deliveryId: DELIVERY, credentialRef: REF }, closed: true }]);
      let stored = impl.storage.actions.get(record.id);
      expect(stored).toMatchObject({ state: "approved", resolvedBy: ADA, autoApproved: false });
      expect(stored.caller.from).toBe("systemRun");
    });
  });

  it("refuses the apply in fixed words, sending nothing and leaving it pending, when the assignment changed, ended or is off", async () => {
    for (const problem of [
      "This action's workflow assignment changed or ended since it was proposed, so it can't be applied. Reject it.",
      "Workflow assignments aren't enabled on this instance.",
    ]) {
      await inAssigned(`assigned-stale-${problem.length}`, async (impl, opened, apply) => {
        let record = await proposeAsRun(impl);
        impl.assignedActionProblem = () => problem;
        expect(await refusalOf(() => impl.applyPendingAction(record, ADA, false))).toContain(problem);
        expect(apply).not.toHaveBeenCalled();
        expect(opened).toEqual([]);
        let stored = impl.storage.actions.get(record.id);
        expect(stored.state).toBe("pending");
        expect(stored.applyStartedAt).toBeUndefined();
        expect(stored.lastAttempt).toBeUndefined();
      });
    }
  });

  it("re-checks after opening the session, and closes it when the assignment changed meanwhile", async () => {
    await inAssigned("assigned-race", async (impl, opened, apply) => {
      let record = await proposeAsRun(impl);
      let checks = 0;
      impl.assignedActionProblem = () => (++checks > 1 ? "This action's workflow assignment changed or ended since it was proposed, so it can't be applied. Reject it." : null);
      expect(await refusalOf(() => impl.applyPendingAction(record, ADA, false))).toContain("changed or ended");
      expect(apply).not.toHaveBeenCalled();
      expect(opened).toHaveLength(1);
      expect(opened[0]!.closed).toBe(true);
    });
  });

  it("never sends it twice: a thrown apply is recorded as unknown and not retried", async () => {
    await inAssigned("assigned-retry", async (impl, opened, apply) => {
      let record = await proposeAsRun(impl);
      apply.mockRejectedValueOnce(new Error("InferOps did not answer"));
      await expect(impl.applyPendingAction(record, ADA, false)).rejects.toThrow("InferOps did not answer");
      let again = impl.storage.actions.get(record.id);
      await expect(impl.applyPendingAction(again, ADA, false)).rejects.toThrow();
      expect(apply).toHaveBeenCalledOnce();
      expect(opened.every(entry => entry.closed)).toBe(true);
    });
  });
});
