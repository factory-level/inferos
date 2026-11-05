import { describe, expect, test } from "vitest";
import type { ActionLogEntry } from "./api";
import { ACTION_OUTCOME_TEXT, ACTION_RECEIPT_CODES, ACTION_RECEIPT_REASON, actionOutcome, actionReceiptCode, actionResultProblem, type ActionOutcome } from "./action-outcome";

const at = new Date(0);
// Whether wording claims the work was done, once negated phrases ("not applied yet") are set aside.
const claimsDone = (text: string) =>
  /\b(applied|done|saved|succeeded|success)\b/i.test(text.replace(/not (applied|done)( yet)?|may or may not have applied/gi, ""));
const entry = (more: Partial<Extract<ActionLogEntry, { type: "action" }>> = {}): Extract<ActionLogEntry, { type: "action" }> => ({
  id: 1, resourceTitle: "Board", createdAt: at, state: "pending", type: "action",
  description: { title: "Move ENG-2 to Done" }, ...more,
} as Extract<ActionLogEntry, { type: "action" }>);

describe("an action's outcome", () => {
  test("a queued action is waiting, never done", () => {
    expect(actionOutcome(entry())).toBe("waiting");
    expect(claimsDone(ACTION_OUTCOME_TEXT.waiting)).toBe(false);
  });

  test("an apply in flight is running, not done", () => {
    expect(actionOutcome(entry({ applying: true }))).toBe("running");
  });

  test("only an applied action has succeeded", () => {
    expect(actionOutcome(entry({ state: "approved", appliedAt: at }))).toBe("succeeded");
    const done = (Object.keys(ACTION_OUTCOME_TEXT) as ActionOutcome[]).filter(outcome => claimsDone(ACTION_OUTCOME_TEXT[outcome]));
    expect(done).toEqual(["succeeded"]);
  });

  test("a refusal, a rejection and an unknown outcome stay distinct", () => {
    expect(actionOutcome(entry({ state: "failed", lastAttempt: { outcome: "notApplied", message: "Refused", at } }))).toBe("failed");
    expect(actionOutcome(entry({ state: "rejected" }))).toBe("rejected");
    // Pending after an attempt that may have reached the provider: unknown, not waiting.
    expect(actionOutcome(entry({ lastAttempt: { outcome: "unknown", message: "Timed out", at } }))).toBe("unknown");
    // Rejected after such an attempt may still have applied.
    expect(actionOutcome(entry({ state: "rejected", lastAttempt: { outcome: "unknown", message: "Timed out", at } }))).toBe("unknown");
    // Pending again after a known refusal that may be retried is waiting for a decision.
    expect(actionOutcome(entry({ lastAttempt: { outcome: "notApplied", message: "Reconnect", retryable: true, at } }))).toBe("waiting");
  });
});

describe("a provider's result", () => {
  test("accepts a small flat record of scalars", () => {
    expect(actionResultProblem({ createdIdentifier: "ENG-7", appliedRevision: "12", applied: true, count: 3, note: null })).toBeNull();
  });

  test("refuses anything else, saying why", () => {
    expect(actionResultProblem([])).toMatch(/object/);
    expect(actionResultProblem({ nested: { a: 1 } })).toMatch(/nested/);
    expect(actionResultProblem({ "": "x" })).toMatch(/key/);
    expect(actionResultProblem({ text: "x".repeat(513) })).toMatch(/text/);
    expect(actionResultProblem(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, i])))).toMatch(/16/);
    expect(actionResultProblem({ n: Number.NaN })).toMatch(/n/);
  });
});

describe("a write receipt's code (FAC-97)", () => {
  test("maps gatekeepers' error codes to a fixed set, and everything else to PROVIDER_ERROR", () => {
    expect(actionReceiptCode("STALE_REVISION")).toBe("STALE_REVISION");
    expect(actionReceiptCode("WORKFLOW_MISMATCH")).toBe("INVALID");
    expect(actionReceiptCode("UNAUTHORIZED")).toBe("FORBIDDEN");
    expect(actionReceiptCode("RUN_ACTIVE")).toBe("CONFLICT");
    expect(actionReceiptCode(undefined)).toBe("PROVIDER_ERROR");
    expect(actionReceiptCode("SOMETHING_NEW")).toBe("PROVIDER_ERROR");
    // An inherited name isn't a mapping.
    expect(actionReceiptCode("constructor")).toBe("PROVIDER_ERROR");
  });

  test("gives every code exactly one fixed sentence", () => {
    for (const code of ACTION_RECEIPT_CODES) expect(ACTION_RECEIPT_REASON[code]).toMatch(/^[A-Z].*\.$/);
  });
});
