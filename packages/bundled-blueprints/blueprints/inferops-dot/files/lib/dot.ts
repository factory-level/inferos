// The Dot gadget's pure rules: what a refusal means, what the client may see of a conversation, and
// the words for each state. No DOM and no I/O, so both sides and the tests share them.

import type { DotConversation, Failure, FailureReason, ShownConversation, WriteStatus } from "./protocol.ts";

const CODES: ReadonlyArray<[string, FailureReason]> = [
  ["FORBIDDEN", "refused"], ["UNAUTHORIZED", "refused"],
  ["UNAVAILABLE", "unavailable"],
  ["CONFLICT", "busy"],
  ["NOT_FOUND", "not-found"],
  ["DISABLED", "disabled"],
];

/**
 * How a caught binding failure is shown: its kind, from the code the gatekeeper leads with, and the
 * gatekeeper's own sentence after it (fixed words, never InferOps' text).
 */
export function classify(error: unknown): Failure {
  const text = error instanceof Error ? error.message : String(error);
  const code = /^(?:\w*Error: )?([A-Z_]+): /.exec(text)?.[1];
  const reason = CODES.find(([name]) => name === code)?.[1] ?? "error";
  return { ok: false, reason, message: text.replace(/^(?:\w*Error: )?[A-Z_]+: /, "") };
}

/** What the client may see of a conversation: its messages and each change's status, nothing else. */
export function shown(conversation: DotConversation): ShownConversation {
  return {
    title: conversation.title,
    messages: conversation.messages.map(({ id, role, content, status }) => ({ id, role, content, status })),
    running: conversation.running,
    proposals: conversation.proposals.map(({ id, tool, status }) => ({ id, tool, status })),
  };
}

/** Where to decide a change: the one decision list, never a second one here. */
export const DECIDE_WHERE = "Decide it under Needs your approval.";

/**
 * A change's status as the person reads it. Waiting points at the one place changes are decided;
 * an uncertain outcome says so and never reads as done or not done.
 */
export function proposalWords(status: WriteStatus): { label: string; detail?: string } {
  switch (status.outcome) {
    case "waiting":
      return { label: "Waiting for your decision", detail: DECIDE_WHERE };
    case "running":
      return { label: "Being made" };
    case "succeeded":
      return { label: "Made" };
    case "rejected":
      return { label: "Declined", detail: "Nothing was made." };
    case "failed":
      return status.code === "EXPIRED"
        ? { label: "Expired", detail: "It wasn't decided in time, so nothing was made. Ask the Dot again." }
        : { label: "Not made", detail: status.reason ?? "InferOps refused it." };
    case "unknown":
      return {
        label: "Uncertain",
        detail: "It may or may not have been made. Check in InferOps before asking for it again.",
      };
  }
}

/** The notice for each failure: a heading, and what the person can do. */
export function failureWords(failure: Failure): { heading: string; body: string } {
  switch (failure.reason) {
    case "not-connected":
      return {
        heading: "No Dot connected",
        body: "Connect your own Dot as this gadget's dot binding (inferops://<organization>.<workspace>/chatbot/dot).",
      };
    case "refused":
      return {
        heading: "Your Dot isn't available to you here",
        body: `${failure.message} A shared connection has no Dot: it needs your own InferLab sign-in.`,
      };
    case "unavailable":
      return {
        heading: "Your Dot can't run right now",
        body: `${failure.message} If your company keeps its data in its own database, the Dot doesn't work for it yet.`,
      };
    case "busy":
      return { heading: "Your Dot is still answering", body: "Wait for it to finish, or stop it, then ask again." };
    case "not-found":
      return { heading: "Not found", body: failure.message };
    case "disabled":
      return { heading: "The Dot is turned off", body: "This deployment has the InferOps Dot turned off." };
    case "error":
      return { heading: "Something went wrong", body: failure.message };
  }
}
