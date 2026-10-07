// What an unsuccessful apply reports and keeps (apply-attempts.ts): known not applied only when its
// stage proves it and no earlier attempt may have reached InferOps; unknown otherwise; terminal
// board refusals stored and replayed; reconcile-only kinds never sent again once uncertain.

import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { canPass, classifyAttempt, BOARD_WRITES, RECONCILE_ONLY } from "../src/apply-attempts";
import type { BindingProps } from "./worker";

const READY = "20000000-0000-4000-8000-000000000001";
const WORKING = "20000000-0000-4000-8000-000000000002";
const DONE = "20000000-0000-4000-8000-000000000003";
const DEMO_1 = "30000000-0000-4000-8000-000000000001";
const DEMO_APP = "40000000-0000-4000-8000-000000000001";

// The switches are deployment vars, read when each call is made (see enablement.test.ts).
const mutableEnv = env as unknown as { INFEROPS_ENABLED?: string };
afterEach(() => { delete mutableEnv.INFEROPS_ENABLED; });

function setup() {
  const props: BindingProps = { accountId: crypto.randomUUID(), host: "demo.local", projectKey: "DEMO" };
  const hooks = env.TEST_HOOKS.getByName(props.accountId);
  const mock = env.MOCK_INFEROPS.getByName(`demo.local/${props.accountId}`);
  return { props, hooks, mock, session: hooks.startSession(props) };
}

/** Where DEMO-1 shows on the board the session reads (with pending changes overlaid). */
async function shownState(board: { columns: Array<{ state: { id: string }; issues: Array<{ id: string }> }> }) {
  return board.columns.find(c => c.issues.some(i => i.id === DEMO_1))?.state.id;
}

describe("classifying an attempt", () => {
  it("knows not applied only from a proven stage on a first attempt", () => {
    const refused = { code: "STALE_REVISION", stage: "refused" as const, policy: false };
    expect(classifyAttempt(refused, false, BOARD_WRITES)).toEqual({ outcome: "notApplied", retryable: false });
    expect(classifyAttempt(refused, true, BOARD_WRITES)).toEqual({ outcome: "unknown", retryable: false });
    expect(classifyAttempt(refused, false, RECONCILE_ONLY)).toEqual({ outcome: "unknown", retryable: false });
    const unsent = { code: "DISABLED", stage: "unsent" as const, policy: false };
    expect(classifyAttempt(unsent, false, RECONCILE_ONLY)).toEqual({ outcome: "notApplied", retryable: true });
    expect(classifyAttempt(unsent, true, BOARD_WRITES)).toEqual({ outcome: "unknown", retryable: true });
    const lost = { code: "UNAVAILABLE", stage: undefined, policy: false };
    expect(classifyAttempt(lost, false, BOARD_WRITES)).toEqual({ outcome: "unknown", retryable: true });
    expect(classifyAttempt(lost, false, RECONCILE_ONLY)).toEqual({ outcome: "unknown", retryable: false });
  });

  it("lets a missing permission pass on a grant, but not a workflow-policy decision", () => {
    expect(canPass("FORBIDDEN", false)).toBe(true);
    expect(canPass("FORBIDDEN", true)).toBe(false);
    expect(canPass("UNAUTHORIZED", false)).toBe(true);
    expect(canPass("NOT_FOUND", false)).toBe(false);
    expect(canPass(null, false)).toBe(false);
  });
});

describe("board writes", () => {
  it("ends a first-attempt refusal failed, unsimulated, and replays it without writing", async () => {
    const { props, hooks, mock, session } = setup();
    await session.openIssue(DEMO_1).transition(WORKING, "1");
    await mock.transition("DEMO", DEMO_1, DONE, "1", "someone-else");

    const refused = await hooks.applyOutcome(props, 1);

    expect(refused).toMatchObject({ outcome: "notApplied", retryable: false, code: "STALE_REVISION" });
    expect((refused as { message: string }).message).toContain("changed in InferOps after this move was proposed");
    expect(await hooks.getRaw(props, "action:1")).toMatchObject({
      status: "failed", attempts: { failure: { outcome: "notApplied", code: "STALE_REVISION" } },
    });
    expect(await hooks.getRaw(props, "action:1")).not.toHaveProperty("attempts.dispatchedAt");
    expect(await shownState(await session.readBoard())).toBe(DONE);
    expect(await hooks.applyOutcome(props, 1)).toEqual(refused);
    expect(await mock.readIssue("DEMO", DEMO_1)).toMatchObject({ stateId: DONE, revision: "2" });
    // The issue is free for another proposal.
    await session.openIssue(DEMO_1).transition(WORKING, "2");
  });

  it("keeps a refusal that can pass pending, simulated and unmarked, and applies it later", async () => {
    const { props, hooks, mock, session } = setup();
    await session.openIssue(DEMO_1).transition(WORKING, "1");
    mutableEnv.INFEROPS_ENABLED = "false";

    expect(await hooks.applyOutcome(props, 1)).toMatchObject({
      outcome: "notApplied", retryable: true, code: "DISABLED",
    });
    expect(await hooks.getRaw(props, "action:1")).toMatchObject({ status: "pending", attempts: {} });
    expect(await hooks.getRaw(props, "action:1")).not.toHaveProperty("attempts.dispatchedAt");

    delete mutableEnv.INFEROPS_ENABLED;
    expect(await shownState(await session.readBoard())).toBe(WORKING);
    expect(await hooks.applyOutcome(props, 1)).toBeNull();
    expect(await mock.readIssue("DEMO", DEMO_1)).toMatchObject({ stateId: WORKING, revision: "2" });
  });

  it("refuses a request that no longer matches its fingerprint for good, unsent", async () => {
    const { props, hooks, mock, session } = setup();
    await session.openIssue(DEMO_1).update({ title: "Approved title" }, "1");
    const record = await hooks.getRaw(props, "action:1") as { changes: { title: string } };
    record.changes.title = "Something else";
    await hooks.putRaw(props, "action:1", record);

    expect(await hooks.applyOutcome(props, 1)).toMatchObject({
      outcome: "notApplied", retryable: false, code: "IDEMPOTENCY_CONFLICT",
    });
    expect(await hooks.getRaw(props, "action:1")).toMatchObject({ status: "failed" });
    expect(await mock.readIssue("DEMO", DEMO_1)).toMatchObject({ revision: "1" });
  });

  it("never lets a later refusal clear an earlier attempt that may have applied", async () => {
    const { props, hooks, mock, session } = setup();
    await session.openIssue(DEMO_1).transition(WORKING, "1");
    // An earlier attempt was sent and its answer lost.
    const record = await hooks.getRaw(props, "action:1") as Record<string, unknown>;
    await hooks.putRaw(props, "action:1", { ...record, attempts: { dispatchedAt: "2026-10-07T00:00:00.000Z" } });
    await mock.transition("DEMO", DEMO_1, DONE, "1", "someone-else");

    const outcome = await hooks.applyOutcome(props, 1);

    expect(outcome).toMatchObject({ outcome: "unknown", retryable: false, code: "STALE_REVISION" });
    expect((outcome as { message: string }).message).toContain("may already have been applied by an earlier attempt");
    expect(await hooks.getRaw(props, "action:1")).toMatchObject({
      status: "pending", attempts: { dispatchedAt: "2026-10-07T00:00:00.000Z", failure: { outcome: "unknown" } },
    });
  });

  it("replays an uncertain board write under its key, which InferOps applies once", async () => {
    const { props, hooks, mock, session } = setup();
    await session.openIssue(DEMO_1).transition(WORKING, "1");
    // The first attempt reaches InferOps and commits; its answer is lost.
    await mock.failNextWrite("lost");
    expect(await hooks.applyOutcome(props, 1)).toMatchObject({ outcome: "unknown", retryable: true });
    expect(await hooks.getRaw(props, "action:1")).toMatchObject({
      status: "pending", attempts: { dispatchedAt: expect.any(String), failure: { outcome: "unknown" } },
    });

    expect(await hooks.applyOutcome(props, 1)).toBeNull();
    expect(await mock.readIssue("DEMO", DEMO_1)).toMatchObject({ stateId: WORKING, revision: "2" });
    expect(await hooks.getRaw(props, "action:1")).toMatchObject({ status: "applied" });
  });

  it("treats any refusal of a record from before attempts were kept as unknown", async () => {
    const { props, hooks, mock } = setup();
    await hooks.putRaw(props, "action:5", {
      actionId: 5, issueId: DEMO_1, identifier: "DEMO-1", fromStateId: READY,
      toStateId: WORKING, toStateName: "Working", expectedRevision: "1", status: "pending",
    });
    await mock.transition("DEMO", DEMO_1, DONE, "1", "someone-else");

    expect(await hooks.applyOutcome(props, 5)).toMatchObject({ outcome: "unknown", code: "STALE_REVISION" });
    expect(await hooks.getRaw(props, "action:5")).toMatchObject({
      status: "pending", attempts: { dispatchedAt: expect.any(String) },
    });
  });
});

describe("reconcile-only writes", () => {
  it("never sends a legacy dispatch whose attempts were not kept", async () => {
    const { props, hooks, mock } = setup();
    await hooks.putDispatchRaw(props, "action:3", {
      kind: "dispatch", actionId: 3, status: "pending", issueId: DEMO_1, identifier: "DEMO-1",
      repoId: DEMO_APP, repoSlug: "demo-app", expectedRevision: "1", proposedAt: "2026-10-01T00:00:00.000Z",
    });

    const outcome = await hooks.applyOutcome(props, 3, "dispatch");

    expect(outcome).toMatchObject({ outcome: "unknown", retryable: false });
    expect((outcome as { message: string }).message).toContain("proposed before apply attempts were recorded");
    expect(await mock.listRuns("DEMO")).toEqual([]);
  });
});
