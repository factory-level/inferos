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
