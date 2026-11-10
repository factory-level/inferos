/**
 * One vocabulary for where a gatekeeper action stands, and the provider's result once it applied.
 * A queued or accepted action is never reported as done: only an action the provider applied has
 * `succeeded`, and only then can it carry the provider's own result.
 */
import type { ActionLogEntry } from "./api.js";

/**
 * What the provider reported a successful apply produced, as a gatekeeper returns it from
 * `applyAction` (`{applied: {result}}`): a small flat record of scalars, such as a created
 * issue's key or the revision a write produced, within `ACTION_RESULT_LIMITS`.
 */
export type ActionResult = { [key: string]: string | number | boolean | null };

/** The bounds of an `ActionResult`, which the overseer checks before keeping one. */
export const ACTION_RESULT_LIMITS = { keys: 16, keyLength: 64, stringLength: 512 } as const;

/** Why `value` is not an `ActionResult` within `ACTION_RESULT_LIMITS`, or null if it is one. */
export function actionResultProblem(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "A result must be an object.";
  const entries = Object.entries(value);
  if (entries.length > ACTION_RESULT_LIMITS.keys) return `A result has at most ${ACTION_RESULT_LIMITS.keys} fields.`;
  for (const [key, field] of entries) {
    if (key.length === 0 || key.length > ACTION_RESULT_LIMITS.keyLength) {
      return `A result key is 1 to ${ACTION_RESULT_LIMITS.keyLength} characters.`;
    }
    if (typeof field === "string" && field.length > ACTION_RESULT_LIMITS.stringLength) {
      return `Result field ${key} is over ${ACTION_RESULT_LIMITS.stringLength} characters.`;
    }
    if (typeof field === "number" && !Number.isFinite(field)) return `Result field ${key} is not a finite number.`;
    if (field !== null && typeof field === "object") return `Result field ${key} is nested; a result is flat.`;
    if (typeof field !== "string" && typeof field !== "number" && typeof field !== "boolean" && field !== null) {
      return `Result field ${key} is not a string, number, boolean or null.`;
    }
  }
  return null;
}

/**
 * Where an action stands:
 * * waiting: queued for a decision, or pending again after a refusal that may be retried; nothing
 *   has happened at the provider because of it.
 * * running: approved, and its apply is in flight.
 * * succeeded: the provider applied it. The only outcome that means the work was done.
 * * failed: the provider refused it and it was not applied; it cannot be approved again.
 * * rejected: a person rejected it, and no attempt may have reached the provider.
 * * unknown: an attempt may have reached the provider (a timeout, a lost response, an interrupted
 *   apply), so it may or may not have happened, whatever was decided since.
 *
 * The kernel queues a submitted action at once, so there is no separate "requested" or "accepted"
 * outcome: both are `waiting` until a decision.
 */
export type ActionOutcome = "waiting" | "running" | "succeeded" | "failed" | "rejected" | "unknown";

/** Where `entry` stands (see `ActionOutcome`), from its state, its apply in flight and its last attempt. */
export function actionOutcome(entry: Extract<ActionLogEntry, { type: "action" }>): ActionOutcome {
  if (entry.state === "approved") return "succeeded";
  if (entry.state === "failed") return "failed";
  if (entry.lastAttempt?.outcome === "unknown") return "unknown";
  if (entry.state === "rejected") return "rejected";
  return entry.applying ? "running" : "waiting";
}

/** Plain words for each outcome. Only `succeeded` says the action was applied. */
export const ACTION_OUTCOME_TEXT: Record<ActionOutcome, string> = {
  waiting: "Waiting for approval, not applied yet",
  running: "Approved, applying now, not done yet",
  succeeded: "Applied",
  failed: "Failed, not applied",
  rejected: "Rejected, not applied",
  unknown: "Outcome unknown: it may or may not have applied",
};

/**
 * Why a write didn't simply succeed, as a write receipt tells its caller (FAC-97): one of a fixed
 * set, never a gatekeeper's or provider's own text. `PROVIDER_ERROR` is everything unmapped.
 */
export const ACTION_RECEIPT_CODES = [
  "STALE_REVISION", "CONFLICT", "NOT_FOUND", "FORBIDDEN", "INVALID", "RATE_LIMITED", "UNAVAILABLE", "PROVIDER_ERROR",
  "EXPIRED",
] as const;

/** One of `ACTION_RECEIPT_CODES`. */
export type ActionReceiptCode = typeof ACTION_RECEIPT_CODES[number];

/** The provider error codes gatekeepers report (`ActionAttempt.code`) that a receipt names, by its own code. */
const RECEIPT_CODE_OF: Readonly<Record<string, ActionReceiptCode>> = {
  STALE_REVISION: "STALE_REVISION",
  CONFLICT: "CONFLICT", RUN_ACTIVE: "CONFLICT",
  NOT_FOUND: "NOT_FOUND",
  FORBIDDEN: "FORBIDDEN", UNAUTHORIZED: "FORBIDDEN", DISABLED: "FORBIDDEN",
  INVALID_REQUEST: "INVALID", INVALID_STATE: "INVALID", WORKFLOW_MISMATCH: "INVALID", IDEMPOTENCY_CONFLICT: "INVALID",
  RATE_LIMITED: "RATE_LIMITED",
  UNAVAILABLE: "UNAVAILABLE", TIMEOUT: "UNAVAILABLE",
  EXPIRED: "EXPIRED", PROPOSAL_EXPIRED: "EXPIRED",
};

/** The receipt code for a gatekeeper's error code, or `PROVIDER_ERROR` when it gave none or one not listed. */
export function actionReceiptCode(code: string | undefined): ActionReceiptCode {
  return (code !== undefined && Object.hasOwn(RECEIPT_CODE_OF, code) ? RECEIPT_CODE_OF[code] : undefined) ?? "PROVIDER_ERROR";
}

/** The one fixed sentence a receipt gives for each code. */
export const ACTION_RECEIPT_REASON: Record<ActionReceiptCode, string> = {
  STALE_REVISION: "It changed since it was read. Read it again before changing it.",
  CONFLICT: "Another change to it hasn't taken effect yet. Try again once that one has.",
  NOT_FOUND: "It no longer exists, or can't be reached.",
  FORBIDDEN: "This change isn't permitted.",
  INVALID: "The service didn't accept this change as made.",
  RATE_LIMITED: "The service is limiting requests. Try again later.",
  UNAVAILABLE: "The service couldn't be reached. Try again later.",
  PROVIDER_ERROR: "The service refused this change.",
  EXPIRED: "It expired before it was decided. Ask for it again.",
};

/** The fixed sentence for an attempt whose effect isn't known, whatever its code. */
export const ACTION_RECEIPT_UNKNOWN_REASON = "It may or may not have been applied. Check before making it again.";

// Why an approved write an assigned workflow run proposed may not apply now (FAC-104, FAC-118): the
// kernel's own fixed words, recorded as a pending action's `blocked.reason` or thrown at an apply.
// Here so a decision can tell a known reason from any other (FAC-119).

/**
 * The refusal at a protected point of an assigned run (FAC-104) when the person who asked for it
 * may no longer: the work stops, and an approved write stays pending. Fixed words, naming no grant.
 */
export const RUN_REQUESTER_REVOKED =
  "The person who asked for this workflow run can't run it now, so this step didn't happen.";

/**
 * The refusal at a run write's apply when the trigger's workflow definition changed since the run
 * proposed it (FAC-118; inferops operate-policy: a changed policy revision needs fresh review, never a
 * silent replay). The write stays pending; running the workflow again proposes it afresh.
 */
export const RUN_DEFINITION_CHANGED =
  "This workflow changed since its run proposed this, so it can't be applied; run the workflow again to propose it afresh.";

/**
 * An approval of a run's write after its wait ended (FAC-118), even before the alarm got to it: the
 * write is rejected as expired, and nothing is sent.
 */
export const RUN_WRITE_EXPIRED =
  "Nobody decided this workflow run's write within 7 days, so it was rejected and nothing was changed.";
