import type { ActionField, ActionFailureKind } from "./gatekeeper.js";

/** The single supported edit: choose a different target for an existing board transition. */
export type ApprovalEdit = {toStateId: string};

/**
 * A gatekeeper's own projection of a board transition (InferOps, `getApprovalProposal`): kernel-only,
 * never containing credentials or another queued action. The one kind of proposal that can be edited.
 * Records stored before FAC-119 have no `kind`, and are this kind.
 */
export type BoardTransitionProposal = {
  kind?: "board-transition";
  /** Immutable resource scope. */
  scope: string;
  /** Exact proposed arguments. */
  args: ApprovalEdit;
  /** Source revision at proposal time. */
  expectedRevision: string;
  /** Hash of the normalized request and scope. */
  fingerprint: string;
  /** Provider key reused for every attempt of this proposal. */
  idempotencyKey: string;
  /** Reference-only simulation, not an assertion that the provider changed. */
  simulation: {issueId: string; fromStateId: string; toStateId: string};
};

/**
 * Any other pending action (FAC-119), as the kernel derives it from the action's own journal
 * record: its gatekeeper's description of it, which the approver reviews, and the resource it acts
 * on. It reproduces only what the record already holds, so it carries no credential and nothing of
 * another action. It can be approved or rejected, never edited.
 */
export type ActionApprovalProposal = {
  kind: "action";
  /** The connection's resource the action acts on. */
  scope: string;
  /** The action's one-line title, as its gatekeeper wrote it. */
  title: string;
  /** Its full description, in the gatekeeper's Markdown. */
  description: string;
  /** The values the approver reviews, shown literally. */
  fields?: ActionField[];
  /** Whether the gatekeeper asserts the description shows everything the action will send. */
  descriptionIsComplete: boolean;
};

/** What a person approves: a board transition's own projection, or any other action's record. */
export type ApprovalProposal = BoardTransitionProposal | ActionApprovalProposal;

/** An explicit answer; editing proposes again and never applies under this answer. */
export type ApprovalAnswer = {approved: boolean; editedArgs?: ApprovalEdit};

/** Caller-authenticated bridge request; the person is derived from the server session. */
export type OperateApprovalRequest = {
  /** Existing action journal id, scoped by the workspace capability. */
  actionId: number;
  /** Conversation correlation, never an authority token. */
  threadId: string;
  /** Current run, distinct from the initial run for a resume. */
  runId: string;
  /** Exactly one answer, or absent to open/reconcile the current proposal. */
  answer?: {interruptId: string; payload: ApprovalAnswer};
};

/** Durable bridge correlation stored on the existing action journal record. */
export type ActionApprovalCorrelation = {
  /** Authenticated person's server-side user id. */
  person: string;
  /** Conversation whose single action this is. */
  threadId: string;
  /** Run which first emitted the interrupt. */
  runId: string;
  /** Server-minted interrupt id. */
  interruptId: string;
  /**
   * The interrupt's own deadline in milliseconds, or absent for none (FAC-119): the action's own
   * state decides, and a workflow run's write expires by FAC-118's deadline. Correlations stored
   * before FAC-119 keep the deadline they were given.
   */
  expiresAt?: number;
  /** Exact immutable proposal approved by the person. */
  proposal: ApprovalProposal;
  /** Persisted answer for conflict checking and recovery. */
  decision?: ApprovalAnswer;
  /** Replacement journal id after a validated edit. */
  replacement?: number;
};

/** Authoritative, bounded wire view of one caller-bound action. */
export type OperateApprovalSnapshot = {
  /** Current journal id (changes after an edit). */
  actionId: number;
  /** Server-minted correlation answered by resume. */
  interruptId: string;
  /** ISO deadline of the interrupt itself, or null for none (FAC-119); resolved receipts stay readable. */
  expiresAt: string | null;
  /** Stored proposal, never client-provided state. */
  proposal: ApprovalProposal;
  /** Whether an answer may edit the proposal (`editedArgs`): a board transition's own, only. */
  editable: boolean;
  /** Application outcome; a successful HTTP run alone does not establish applied. */
  status: "pending" | "applied" | "rejected" | "failed" | "unknown" | "expired";
  /** Authoritative unsuccessful attempt, when one exists, with what kind of reason it was (FAC-119). */
  failure?: {outcome: "unknown" | "notApplied"; message: string; code?: string; retryable?: boolean;
    kind: ActionFailureKind};
  /** Why a pending action can't be applied now, a re-check having refused it (FAC-118). */
  blocked?: {reason: string};
  /** Why the workspace itself rejected it (FAC-118): its deadline passed, or its workflow changed. */
  rejectedBecause?: "expired" | "definition-changed";
};

/**
 * Why the approval bridge answered with no snapshot (FAC-119), each told apart by code, never by
 * words. A failed apply is not one of these: it is a snapshot whose `failure.kind` says why.
 */
export const OPERATE_APPROVAL_ERROR_CODES = Object.freeze({
  /** The caller may not decide this action here, or the request names nothing it may (403). */
  refused: "APPROVAL_REFUSED",
  /** The action has been decided, or its interrupt ended (409). */
  notPending: "APPROVAL_NOT_PENDING",
  /** Another answer was already given for this interrupt, or the proposal changed (409). */
  conflict: "APPROVAL_CONFLICT",
  /** The workspace or its provider couldn't be reached to decide now (503). */
  unavailable: "APPROVAL_UNAVAILABLE",
});

/** One of `OPERATE_APPROVAL_ERROR_CODES`. */
export type OperateApprovalErrorCode = typeof OPERATE_APPROVAL_ERROR_CODES[keyof typeof OPERATE_APPROVAL_ERROR_CODES];

/** An error whose message starts with its code, which survives RPC. */
export function createOperateApprovalError(code: OperateApprovalErrorCode, message: string): Error {
  return new Error(`${code}: ${message}`);
}

/** The code an approval bridge error carries, or null for any other error. */
export function operateApprovalErrorCode(error: unknown): OperateApprovalErrorCode | null {
  let message = error instanceof Error ? error.message : String(error);
  let codes = Object.values(OPERATE_APPROVAL_ERROR_CODES) as string[];
  let found = codes.find(code => message.startsWith(`${code}: `) || message.includes(`Error: ${code}: `));
  return (found as OperateApprovalErrorCode | undefined) ?? null;
}
