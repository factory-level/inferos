// What an unsuccessful apply of a recorded action proves, reported to the overseer as an
// `ActionApplyFailure` and kept in the record's `attempts` (actions.ts):
//
// - `notApplied`: known not to have taken effect, proven by where it failed (`WriteStage`): before
//   the write was sent, or, for board writes only, refused by InferOps in answer to the write
//   itself. Only when no earlier attempt may have reached InferOps: a later refusal never clears
//   that uncertainty. A refusal that will stand ends the record `failed`; one that reconnecting,
//   turning InferOps back on or a grant can fix leaves it pending.
// - `unknown`: anything else, including any failure of a record staged before attempts were kept.
//
// Board writes (transition, create, update) are replayable: InferOps answers a repeated key with
// its first result, so an unknown attempt may be sent again under the same key. Coding dispatches
// and cancels and Wiki edits are not yet: no same-key replay contract has been verified for them,
// so once an attempt may have reached InferOps they are reconcile-only, and every later apply
// returns the stored unknown without sending anything.

import type { ActionApplyFailure } from "@gadgets/workshop-shared/gatekeeper";
import { InferOpsError, type InferOpsErrorCode, type WriteStage } from "./inferops-client";

/** Codes whose refusal can pass: reconnecting, InferOps turned back on, or InferOps answering. */
const TRANSIENT: ReadonlySet<string> = new Set<InferOpsErrorCode>(["UNAUTHORIZED", "DISABLED", "UNAVAILABLE"]);

/** How an action of one kind may be applied again. */
export type ApplyPolicy = {
  /** Whether InferOps refusing the write itself proves it did not take effect. */
  refusalsProven: boolean;
  /** Whether an attempt that may have reached InferOps may be sent again under its key. */
  replayable: boolean;
};

/** Board transitions, creates and updates. */
export const BOARD_WRITES: ApplyPolicy = { refusalsProven: true, replayable: true };

/** Coding dispatches and cancels, and Wiki section and page edits. */
export const RECONCILE_ONLY: ApplyPolicy = { refusalsProven: false, replayable: false };

/** A failed attempt, as far as `classifyAttempt` reads it. */
export type AttemptFailure = {
  /** The data-source code, or null for any other error. */
  code: string | null;
  /** How far the write got; absent when the failure proves nothing. */
  stage: WriteStage | undefined;
  /** Whether a FORBIDDEN is InferOps' workflow policy refusing the change. */
  policy: boolean;
};

/**
 * A check made by the gatekeeper before sending refused the apply, with its own reason. Nothing
 * was sent.
 */
export class CheckRefused extends InferOpsError {
  constructor(code: InferOpsErrorCode, readonly reason: string) {
    super(code, reason, { stage: "unsent" });
  }
}

/**
 * Whether applying again may succeed after a refusal with `code`: a transient one, or a FORBIDDEN
 * that is a missing permission or product access (which can be granted) rather than the workflow
 * policy's decision.
 */
export function canPass(code: string | null, policy: boolean): boolean {
  if (code === "FORBIDDEN") return !policy;
  return code !== null && TRANSIENT.has(code);
}

/**
 * The outcome of a failed attempt. `earlierUncertain` is whether an earlier attempt may have
 * reached InferOps (or the record has no attempt history).
 */
export function classifyAttempt(failure: AttemptFailure, earlierUncertain: boolean,
                                policy: ApplyPolicy): Pick<ActionApplyFailure, "outcome" | "retryable"> {
  const proven = failure.stage === "unsent" || (failure.stage === "refused" && policy.refusalsProven);
  if (proven && !earlierUncertain) {
    return { outcome: "notApplied", retryable: canPass(failure.code, failure.policy) };
  }
  if (!policy.replayable) return { outcome: "unknown", retryable: false };
  // Sending again is safe; it can help unless InferOps answered with a refusal that will stand.
  return {
    outcome: "unknown",
    retryable: failure.stage === undefined || canPass(failure.code, failure.policy),
  };
}
