// The person's own Dot (FAC-133, inferos ADR 0013): what a Dot binding shows of InferOps' answers,
// and the deployment switch for it.
//
// - Authority. InferOps runs the Dot (its chatbot domain and `shared-agentic`) as the person, with
//   every tool call re-authorized and every write only proposed. The binding is one person's own
//   sign-in in one workspace: the stopgap connection is refused, and a Dot is never shared.
// - State. InferOS keeps a conversation's id and the staged decision on each proposal, never its
//   messages: InferOps' `chatbot_conversation` and `chatbot_proposal` stay the authority.
// - Receipts. A proposal's status is InferOps' own, read when asked, in FAC-97's words
//   (`dotProposalStatus`). Nothing InferOps writes reaches a receipt but the bounded summary of a
//   confirmed proposal's answer (`summarizeDotOutcome`).
// - The switch (`INFEROPS_DOT_ENABLED`) is off unless set to "true", and needs InferOps itself on.
//   It is checked on every call, as the other switches are.

import {
  ACTION_RECEIPT_REASON, ACTION_RECEIPT_UNKNOWN_REASON, actionReceiptCode,
} from "@gadgets/workshop-shared/action-outcome";
import { InferOpsError, type DotProposalWire, type InferOpsClient } from "./inferops-client";
import { assertInferOpsEnabled, guarded, inferOpsEnabled } from "./enablement";
import type { WriteStatus } from "./types";

/** The message every call refused by the Dot switch carries after its `DISABLED: ` code. */
export const DOT_DISABLED_MESSAGE = "The InferOps Dot is turned off for this deployment.";

type DotEnv = Pick<Cloudflare.Env, "INFEROPS_ENABLED" | "INFEROPS_DOT_ENABLED">;

/** Whether Dot bindings are on: only `"true"`, and only while InferOps itself is on. */
export function dotEnabled(env: DotEnv): boolean {
  return env.INFEROPS_DOT_ENABLED === "true" && inferOpsEnabled(env);
}

/** Throw `DISABLED` while InferOps or the Dot is off, naming whichever is. */
export function assertDotEnabled(env: DotEnv): void {
  assertInferOpsEnabled(env);
  if (!dotEnabled(env)) throw new InferOpsError("DISABLED", DOT_DISABLED_MESSAGE);
}

/** A client for a Dot binding: every call (`forget` aside) is refused while either switch is off. */
export function whileDotEnabled(env: DotEnv, open: () => InferOpsClient): InferOpsClient {
  return guarded(() => assertDotEnabled(env), open);
}

/** Why a Dot binding refuses a connection that is not a person's own sign-in. */
export const DOT_NEEDS_OWN_SIGN_IN =
  "Your Dot needs your own InferLab sign-in: this connection is shared and is no one's Dot.";

/** The most fields a confirmed proposal's summary keeps, under `ACTION_RESULT_LIMITS`. */
const SUMMARY_FIELDS = 10;
/** The most characters of one summarized string. */
const SUMMARY_STRING = 200;
/** The fields of InferOps' answer a summary names, at the top level or one object down. */
const SUMMARY_KEYS = new Set(["id", "identifier", "key", "revision", "status", "state", "title", "name"]);

/**
 * A bounded summary of what confirming a proposal produced, for its receipt: the identifying
 * scalars of InferOps' answer (such as `issue.identifier`), at most `SUMMARY_FIELDS`, each string at
 * most `SUMMARY_STRING` characters. Nothing else of the answer is kept.
 */
export function summarizeDotOutcome(outcome: unknown): Record<string, string | number | boolean | null> {
  const summary: Record<string, string | number | boolean | null> = {};
  const add = (key: string, value: unknown) => {
    if (Object.keys(summary).length >= SUMMARY_FIELDS || !SUMMARY_KEYS.has(key.split(".").at(-1)!)) return;
    if (typeof value === "string") summary[key] = value.slice(0, SUMMARY_STRING);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) summary[key] = value;
  };
  if (outcome === null || typeof outcome !== "object" || Array.isArray(outcome)) return summary;
  for (const [key, value] of Object.entries(outcome)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [inner, scalar] of Object.entries(value)) add(`${key}.${inner}`, scalar);
    } else {
      add(key, value);
    }
  }
  return summary;
}

/**
 * A proposal's status in FAC-97's words, from InferOps' own status (derived at read time there):
 * proposed is waiting, confirming is running, confirmed and handed-off succeeded, failed failed (with the receipt
 * code for InferOps' refusal), declined rejected, expired failed `EXPIRED`, and a confirming one
 * past its bound unknown. A failure's reason is the receipt's fixed sentence, never InferOps' words.
 */
export function dotProposalStatus(proposal: DotProposalWire): WriteStatus {
  switch (proposal.status) {
    case "proposed":
      return { outcome: "waiting" };
    case "confirming":
      return { outcome: "running" };
    case "confirmed":
      return { outcome: "succeeded", result: summarizeDotOutcome(proposal.outcome) };
    // FAC-120: an InferOS workflow-run proposal, confirmed in InferOps only once InferOS admitted
    // the run as the person who approved it here. The hand-off is the write; the run's own
    // outcome is InferOS's (its run record and receipt), never this proposal's.
    case "handed-off":
      return { outcome: "succeeded", result: summarizeDotOutcome(proposal.outcome) };
    case "declined":
      return { outcome: "rejected" };
    case "expired":
      return { outcome: "failed", code: "EXPIRED", reason: ACTION_RECEIPT_REASON.EXPIRED };
    case "unknown":
      return { outcome: "unknown", reason: ACTION_RECEIPT_UNKNOWN_REASON };
    case "failed": {
      const wire = (proposal.outcome as { code?: unknown } | null)?.code;
      const code = actionReceiptCode(typeof wire === "string" ? wire : undefined);
      return { outcome: "failed", code, reason: ACTION_RECEIPT_REASON[code] };
    }
  }
}

/** The one answer for a Dot conversation that is missing or another person's. */
export function dotConversationNotFound(): InferOpsError {
  return new InferOpsError("NOT_FOUND", "No such Dot conversation of yours.");
}

/** The longest prompt InferOps takes (its `RunInputSchema`). */
export const DOT_PROMPT_MAX = 16_000;
/** The longest page or record reference InferOps takes (its `SelectionSchema`). */
export const DOT_REF_MAX = 2_000;
/** The most characters of a run's error the caller is shown. */
export const DOT_ERROR_MAX = 300;
/** What the caller is told when the Dot's reply couldn't be read (a malformed or oversized event). */
export const DOT_UNREADABLE = "The Dot's reply couldn't be read. Ask again.";
