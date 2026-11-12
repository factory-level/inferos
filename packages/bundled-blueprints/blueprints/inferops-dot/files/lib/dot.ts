// The Dot gadget's pure rules: what a refusal means, what the client may see of a conversation, and
// the words for each state. No DOM and no I/O, so both sides and the tests share them.

import type {
  DotConversation, DotProgress, DotProposal, DotProposalRun, Failure, FailureReason, KnowledgeWrite, ShownConversation,
  ShownProgress, ShownProposal, WriteStatus,
} from "./protocol.ts";

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

/** The Dot's company knowledge reads (inferops FAC-136): reading makes no change anywhere. */
export const KNOWLEDGE_READ_TOOLS: ReadonlySet<string> = new Set([
  "knowledge_company_search", "knowledge_company_list", "knowledge_company_read",
]);

/** The longest title shown for a knowledge write; a longer one is cut. */
const TITLE_MAX = 200;

const LINK = /^inferops:\/\/[^\s]+$/;

/**
 * What knowledge write `tool` with arguments `input` (the JSON the gatekeeper reports) targets, or
 * undefined for any other tool, unreadable arguments, or a target that isn't a canonical
 * `inferops://` link. Only the link and a title are kept, never the body.
 */
export function knowledgeWrite(tool: string, input: string): KnowledgeWrite | undefined {
  if (tool !== "knowledge_page_edit" && tool !== "knowledge_page_create") return undefined;
  let fields: unknown;
  try {
    fields = JSON.parse(input);
  } catch {
    return undefined;
  }
  if (typeof fields !== "object" || fields === null) return undefined;
  const { page, workspace, title } = fields as Record<string, unknown>;
  const titled = typeof title === "string" && title.trim() !== "" ? title.trim().slice(0, TITLE_MAX) : undefined;
  if (tool === "knowledge_page_edit") {
    if (typeof page !== "string" || !LINK.test(page)) return undefined;
    return { kind: "edit", page, ...(titled ? { newTitle: titled } : {}) };
  }
  if (typeof workspace !== "string" || !LINK.test(workspace)) return undefined;
  return { kind: "create", workspace, ...(titled ? { title: titled } : {}) };
}

/** A change as the client may see it: its id, tool and status, and a knowledge write's target. */
export function shownProposal({ id, tool, status, input, run }: DotProposal): ShownProposal {
  const knowledge = knowledgeWrite(tool, input);
  return {
    id, tool, status, ...(knowledge ? { knowledge } : {}),
    // Its fixed fields only: never more of what InferOS reported than the page draws.
    ...(run ? { run: { ...(run.kind ? { kind: run.kind } : {}), runId: run.runId, outcome: run.outcome, ranAs: run.ranAs,
      ...(run.reasonCode ? { reasonCode: run.reasonCode } : {}) } } : {}),
  };
}

/** The Dot's InferOS workflow-run proposal (FAC-120): approving it starts a run there, not a change here. */
export const WORKFLOW_RUN_TOOL = "inferos_workflow_invoke";

/** The Dot's delegate proposal (FAC-134 capability 3): approving it in InferOS launches a delegate there. */
export const DELEGATE_TOOL = "inferos_delegate_launch";

/** The Dot's proposals whose hand-off starts something in InferOS that reports how it came out. */
export const RUN_TOOLS: ReadonlySet<string> = new Set([WORKFLOW_RUN_TOOL, DELEGATE_TOOL]);

/** Why a run failed or is uncertain, in words, by the reason InferOS gives; an unknown one says only that. */
const RUN_REASONS: Record<string, string> = {
  "runtime-error": "its code stopped with an error",
  "requester-revoked": "you could no longer run it when it started",
  "assignment-changed": "its trigger's assigned account changed after you approved it",
  "trigger-gone": "its trigger was removed",
  "bindings-needed": "its connections weren't set up",
  cancelled: "it was cancelled",
  "timed-out": "it ran past its time limit",
  "attempts-exhausted": "it was interrupted too many times",
  "lost-after-write": "it stopped after proposing a change, which may or may not have been made",
  "action-unknown": "a change it proposed may or may not have been made",
  "not-started": "it was admitted but never started",
  // A personal workflow's steps (FAC-134 capability 2): which check refused one stays in InferOS.
  "step-refused": "one of its steps was refused, so nothing after it was requested",
  "step-unknown": "one of its steps' requests may or may not have been placed",
};

/** A delegate's own words for the reasons that mean something else for it (FAC-134 capability 3). */
const DELEGATE_REASONS: Record<string, string> = {
  "requester-revoked": "your access in your operate session changed while it ran",
  cancelled: "it was stopped",
};

/** What a personal workflow's run that placed every request says (FAC-134 capability 2): never "done". */
export const PERSONAL_WORKFLOW_PLACED = "Requests placed. Each waits for the console's builders.";

/**
 * Shown with every recorded run outcome (FAC-134): InferOps keeps what InferOS reported, but can't
 * tell it from one the person produced themself through InferOS's public sign-in client.
 */
export const RUN_REPORTED = "Reported, not verified";

/** What a run ran as, in words (inferops ADR 0011's two contexts). */
const RAN_AS: Record<DotProposalRun["ranAs"], string> = {
  gadget_bindings: "It ran on the workflow's own connections.",
  service_account: "It ran as the workflow's assigned account, not as you.",
  person: "It ran as you, with at most what you approved.",
};

/**
 * A workflow-run proposal's status (FAC-134): its hand-off to InferOS is never "made". Waiting,
 * declined, failed and uncertain read as for any change; handed off, it says the run started and
 * its outcome shows here once the run ends; with that outcome, it says how it came out (a fixed
 * reason, never what the run returned) and what it ran as.
 */
export function workflowRunWords(status: WriteStatus, run?: DotProposalRun): { label: string; detail?: string; note?: string } {
  if (status.outcome !== "succeeded") return proposalWords(status);
  if (!run) {
    return { label: "Started in InferOS", detail: "Its run belongs to InferOS now. How it came out shows here once it ends." };
  }
  // A delegate (FAC-134 capability 3) reports only how it ended, never what it did or said.
  if (run.kind === "delegate") {
    const label = run.outcome === "succeeded" ? "Delegate finished" : run.outcome === "failed" ? "Delegate failed" : "Delegate uncertain";
    const why = run.reasonCode ? DELEGATE_REASONS[run.reasonCode] ?? RUN_REASONS[run.reasonCode] : undefined;
    const ended = run.outcome === "succeeded" ? "Check what it changed in your operate session. "
      : why ? `It ${run.outcome === "failed" ? "failed" : "is uncertain"} because ${why}. ` : "";
    return { label, detail: `${ended}${RAN_AS[run.ranAs]}`, note: RUN_REPORTED };
  }
  const why = run.reasonCode ? RUN_REASONS[run.reasonCode] : undefined;
  const note = RUN_REPORTED;
  // A personal workflow's steps only place requests, decided by each console's builders.
  if (run.kind === "personal-workflow" && run.outcome === "succeeded") {
    return { label: "Requests placed", detail: PERSONAL_WORKFLOW_PLACED, note };
  }
  switch (run.outcome) {
    case "succeeded":
      return { label: "Run finished", detail: RAN_AS[run.ranAs], note };
    case "failed":
      return { label: "Run failed", detail: `${why ? `It failed because ${why}. ` : ""}${RAN_AS[run.ranAs]}`, note };
    case "uncertain":
      return {
        label: "Run uncertain",
        detail: `${why ? `It's uncertain because ${why}. ` : "Whether all of it happened isn't known. "}Check its run in InferOS. ${RAN_AS[run.ranAs]}`,
        note,
      };
  }
}

/** A step of the answer as the client may hear it: a proposed change only as shown. */
export function shownProgress(event: DotProgress): ShownProgress {
  return event.type === "proposal" ? { type: "proposal", proposal: shownProposal(event.proposal) } : event;
}

/** What the client may see of a conversation: its messages and each change's status, nothing else. */
export function shown(conversation: DotConversation): ShownConversation {
  return {
    title: conversation.title,
    messages: conversation.messages.map(({ id, role, content, status }) => ({ id, role, content, status })),
    running: conversation.running,
    proposals: conversation.proposals.map(shownProposal),
  };
}

/** How a change is named: a knowledge write in words, any other by its tool. */
export function proposalHeading(proposal: Pick<ShownProposal, "tool" | "knowledge">): string {
  switch (proposal.knowledge?.kind) {
    case "edit":
      return "A change to a wiki page";
    case "create":
      return proposal.knowledge.title ? `A new wiki page: ${proposal.knowledge.title}` : "A new wiki page";
    default:
      return proposal.tool;
  }
}

/** A step while the Dot answers: a knowledge read says it changes nothing. */
export function stepWords(name: string): string {
  return KNOWLEDGE_READ_TOOLS.has(name) ? "Reading your company's knowledge… Reading changes nothing." : `Using ${name}…`;
}

/** Where to decide a change: the one decision list, never a second one here. */
export const DECIDE_WHERE = "Decide it under Needs your approval.";

/** What a knowledge write does once approved (FAC-136): the person's own edit, live at once. */
export function knowledgeWords(knowledge: KnowledgeWrite): string {
  return knowledge.kind === "edit"
    ? "Your Dot will change this page as you, and readers see it right away."
    : "Your Dot will create this page as you, and readers see it right away.";
}

/**
 * A change's status as the person reads it. Waiting points at the one place changes are decided;
 * an uncertain outcome says so and never reads as done or not done. A knowledge write says, while
 * it waits, what approving it does, and once made that readers see it now.
 */
export function proposalWords(status: WriteStatus, knowledge?: KnowledgeWrite): { label: string; detail?: string } {
  switch (status.outcome) {
    case "waiting":
      return { label: "Waiting for your decision", detail: knowledge ? `${knowledgeWords(knowledge)} ${DECIDE_WHERE}` : DECIDE_WHERE };
    case "running":
      return { label: "Being made" };
    case "succeeded":
      return knowledge ? { label: "Made", detail: "Readers see it now." } : { label: "Made" };
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
