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
import { RUN_REQUESTER_REVOKED, type OverseerDurableObject } from "../src/overseer.js";
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
const PERSON = "operator-profile";
const RUN = "9c1e2d3f-0000-4000-8000-0000000000aa";
const COMPANY = "0b7e2c3a-1f00-4a00-8000-00000000000a";
/** What the action records about its run (FAC-104): the run, who asked, and who it acts as. */
const EXECUTED_AS = { hookId: HOOK, deliveryId: DELIVERY, credentialRef: REF, runId: RUN, requestedBy: PERSON };
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
    // The run's admitted record (FAC-111): a person asked, through the trigger's control, and the
    // run acts as the assignment. Written as the store writes it, so the apply can re-check it.
    impl.storage.workflowTriggerPins.put({ hookId: HOOK, definitionId: "def", revision: 1 });
    impl.storage.workflowTriggerControls.put({ hookId: HOOK, label: "Run", invokers: [PERSON], configuredBy: ADA, configuredAt: new Date(0) });
    // The assignment the run acts as, and the live hook: what the requester's re-check re-reads.
    impl.storage.workflowTriggerAssignments.put({ hookId: HOOK, gatekeeperId: CONNECTION, credentialRef: REF, assignedBy: ADA, assignedAt: new Date(0) });
    impl.storage.boundHooks = { get: (id: number) => (id === HOOK ? { id: HOOK, gadgetId: 1, enabled: true } : undefined), list: () => [] };
    impl.storage.workflowDeliveries.put({
      id: DELIVERY, hookId: HOOK, definitionId: "def", revision: 1, commitId: "c".repeat(40), at: new Date(0),
      invocation: { id: "inv", requestedBy: PERSON }, executedAs: { credentialRef: REF },
      run: {
        runId: RUN, correlationId: "inv", company: null, requester: { kind: "person", profileId: PERSON },
        executor: { kind: "service_account", gatekeeperId: CONNECTION, credentialRef: REF },
      },
    });
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
      expect(record.executedAs).toEqual(EXECUTED_AS);
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
      expect(opened).toEqual([{ executedAs: EXECUTED_AS, closed: true }]);
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
      // Checked before, after the requester's re-check (FAC-104, an await), and after the session opens.
      impl.assignedActionProblem = () => (++checks > 2 ? "This action's workflow assignment changed or ended since it was proposed, so it can't be applied. Reject it." : null);
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

/**
 * The deployment asks InferOps for the person's `workflow:invoke` through the trigger's board
 * (as requireWorkflowInvoke does): the hook's gadget binds the assigned connection, and the
 * person's user object answers `answer`.
 */
function askingInferOps(impl: any, answer: () => { holds: boolean; company: string | null } | Promise<{ holds: boolean; company: string | null }>) {
  impl.env = { ...impl.env, SHARED_CONFIGURATION_GATEKEEPER: "inferops" };
  impl.storage.boundHooks = { get: (id: number) => (id === HOOK ? { id: HOOK, gadgetId: 1, enabled: true } : undefined) };
  impl.getGadgetRecord = () => ({});
  impl.visibleBindings = () => [["BOARD", { target: CONNECTION }]];
  let asked: string[] = [];
  impl.users = {
    idFromName: (name: string) => ({ toString: () => `user-of-${name}` }),
    idFromString: (id: string) => id,
    get: (id: string) => ({ workflowInvokeAnswer: async () => { asked.push(id); return answer(); } }),
  };
  return asked;
}

// FAC-104: authority carried to queued work and re-checked when it finally runs.
describe("a queued write of an assigned run, re-checked when it applies (FAC-104)", () => {
  it("names both the person who asked and the service account it acts as", async () => {
    await inAssigned("fac104-audit", async impl => {
      let record = await proposeAsRun(impl);
      expect(record.executedAs).toMatchObject({ runId: RUN, requestedBy: PERSON, credentialRef: REF });
      expect(record.gatekeeperId).toBe(CONNECTION);
    });
  });

  it("stops when the person was taken off the trigger's control after asking", async () => {
    await inAssigned("fac104-control", async (impl, opened, apply) => {
      let record = await proposeAsRun(impl);
      impl.storage.workflowTriggerControls.put({ hookId: HOOK, label: "Run", invokers: ["someone-else"], configuredBy: ADA, configuredAt: new Date(0) });
      expect(await refusalOf(() => impl.applyPendingAction(record, ADA, false))).toContain(RUN_REQUESTER_REVOKED);
      expect(apply).not.toHaveBeenCalled();
      expect(opened).toEqual([]);
      expect(impl.storage.actions.get(record.id).state).toBe("pending");
    });
  });

  it("stops when the person's workflow:invoke was revoked after asking, or answers in another company", async () => {
    for (const [label, answer] of [
      ["revoked", { holds: false, company: COMPANY }],
      ["another company", { holds: true, company: "0b7e2c3a-1f00-4a00-8000-00000000000b" }],
    ] as const) {
      await inAssigned(`fac104-grant-${label.replace(/ /g, "-")}`, async (impl, opened, apply) => {
        let record = await proposeAsRun(impl);
        // Admitted in COMPANY, as FAC-111 records it.
        let stored = impl.storage.workflowDeliveries.get(DELIVERY);
        impl.storage.workflowDeliveries.put({ ...stored, run: { ...stored.run, company: COMPANY } });
        let asked = askingInferOps(impl, () => answer);
        expect(await refusalOf(() => impl.applyPendingAction(record, ADA, false))).toContain(RUN_REQUESTER_REVOKED);
        expect(asked).toEqual([`user-of-${PERSON}`]);
        expect(apply).not.toHaveBeenCalled();
        expect(opened).toEqual([]);
        expect(impl.storage.actions.get(record.id).state).toBe("pending");
      });
    }
  });

  it("applies when the person still holds it, in the company the run was admitted in", async () => {
    await inAssigned("fac104-still", async (impl, opened, apply) => {
      let record = await proposeAsRun(impl);
      let stored = impl.storage.workflowDeliveries.get(DELIVERY);
      impl.storage.workflowDeliveries.put({ ...stored, run: { ...stored.run, company: COMPANY } });
      askingInferOps(impl, () => ({ holds: true, company: COMPANY }));
      await impl.applyPendingAction(record, ADA, false);
      expect(apply).toHaveBeenCalledOnce();
      expect(opened).toHaveLength(1);
    });
  });

  it("refuses a write whose run left no record, rather than skipping the check", async () => {
    await inAssigned("fac104-no-record", async (impl, opened, apply) => {
      let record = await proposeAsRun(impl);
      impl.storage.workflowDeliveries.delete(DELIVERY);
      expect(await refusalOf(() => impl.applyPendingAction(record, ADA, false))).toContain(RUN_REQUESTER_REVOKED);
      expect(apply).not.toHaveBeenCalled();
    });
  });
});

describe("a delayed run, re-checked when it starts (FAC-104)", () => {
  it("doesn't start when the person's grant was revoked between asking and the delivery", async () => {
    await inAssigned("fac104-start", async impl => {
      let stored = impl.storage.workflowDeliveries.get(DELIVERY);
      impl.storage.workflowDeliveries.put({ ...stored, run: { ...stored.run, company: COMPANY } });
      askingInferOps(impl, () => ({ holds: false, company: COMPANY }));
      impl.systemRuns.end(DELIVERY);
      expect(await refusalOf(() => impl.runAssignedDelivery(HOOK, { deliveryId: DELIVERY, commitId: "c".repeat(40), credentialRef: REF }, null, [])))
        .toContain(RUN_REQUESTER_REVOKED);
      // Refused before the run was registered: nothing of it is running.
      expect(() => impl.systemRuns.require({ from: "systemRun", hookId: HOOK, deliveryId: DELIVERY })).toThrow();
    });
  });
});

// FAC-104 round 1 (review HIGH): the person's answer is awaited, so local authority can change
// while it's pending. It is re-read synchronously right before the work: a change meanwhile refuses.
describe("local authority changed while the person's answer was pending (FAC-104)", () => {
  /** An answer that stays pending until released, and a promise of the moment it was asked. */
  function deferredAnswer() {
    let release!: (answer: { holds: boolean; company: string | null }) => void;
    let pending = new Promise<{ holds: boolean; company: string | null }>(resolve => { release = resolve; });
    return { pending, release };
  }
  const admittedIn = (impl: any) => {
    let stored = impl.storage.workflowDeliveries.get(DELIVERY);
    impl.storage.workflowDeliveries.put({ ...stored, run: { ...stored.run, company: COMPANY } });
  };
  const offTheControl = (impl: any) =>
    impl.storage.workflowTriggerControls.put({ hookId: HOOK, label: "Run", invokers: ["someone-else"], configuredBy: ADA, configuredAt: new Date(0) });

  it("refuses the apply when the person is taken off the control meanwhile", async () => {
    await inAssigned("fac104-race-control", async (impl, opened, apply) => {
      let record = await proposeAsRun(impl);
      admittedIn(impl);
      let answer = deferredAnswer();
      let asked = askingInferOps(impl, () => answer.pending);
      let applying = refusalOf(() => impl.applyPendingAction(record, ADA, false));
      await vi.waitFor(() => expect(asked).toHaveLength(1));
      offTheControl(impl);
      answer.release({ holds: true, company: COMPANY });
      expect(await applying).toContain(RUN_REQUESTER_REVOKED);
      expect(apply).not.toHaveBeenCalled();
      expect(opened.every(entry => entry.closed)).toBe(true);
      expect(impl.storage.actions.get(record.id).state).toBe("pending");
    });
  });

  it("refuses the apply when the assignment changes meanwhile", async () => {
    await inAssigned("fac104-race-assignment", async (impl, opened, apply) => {
      let record = await proposeAsRun(impl);
      admittedIn(impl);
      let answer = deferredAnswer();
      let asked = askingInferOps(impl, () => answer.pending);
      // The liveness check reads the real assignment here, so a change is seen by both checks.
      impl.assignedActionProblem = (r: any) =>
        impl.workflowDefinitionStore().assignmentOf(HOOK)?.credentialRef === r.executedAs.credentialRef ? null
          : "This action's workflow assignment changed or ended since it was proposed, so it can't be applied. Reject it.";
      impl.storage.workflowTriggerAssignments.put({ hookId: HOOK, gatekeeperId: CONNECTION, credentialRef: REF, assignedBy: ADA, assignedAt: new Date(0) });
      let applying = refusalOf(() => impl.applyPendingAction(record, ADA, false));
      await vi.waitFor(() => expect(asked).toHaveLength(1));
      impl.storage.workflowTriggerAssignments.put({ hookId: HOOK, gatekeeperId: CONNECTION, credentialRef: "another-ref", assignedBy: ADA, assignedAt: new Date(0) });
      answer.release({ holds: true, company: COMPANY });
      expect(await applying).toMatch(/can't run it now|changed or ended/);
      expect(apply).not.toHaveBeenCalled();
      expect(impl.storage.actions.get(record.id).state).toBe("pending");
    });
  });

  it("doesn't start a delayed run when the person is taken off the control meanwhile", async () => {
    await inAssigned("fac104-race-start", async impl => {
      admittedIn(impl);
      impl.storage.workflowTriggerAssignments.put({ hookId: HOOK, gatekeeperId: CONNECTION, credentialRef: REF, assignedBy: ADA, assignedAt: new Date(0) });
      impl.systemRuns.end(DELIVERY);
      let answer = deferredAnswer();
      let asked = askingInferOps(impl, () => answer.pending);
      let starting = refusalOf(() => impl.runAssignedDelivery(HOOK, { deliveryId: DELIVERY, commitId: "c".repeat(40), credentialRef: REF }, null, []));
      await vi.waitFor(() => expect(asked).toHaveLength(1));
      offTheControl(impl);
      answer.release({ holds: true, company: COMPANY });
      expect(await starting).toContain(RUN_REQUESTER_REVOKED);
      expect(() => impl.systemRuns.require({ from: "systemRun", hookId: HOOK, deliveryId: DELIVERY })).toThrow();
    });
  });
});
