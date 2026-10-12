/** The single supported edit: choose a different target for an existing board transition. */
export type ApprovalEdit = {toStateId: string};

/** Safe, kernel-only proposal projection; never contains credentials or another queued action. */
export type ApprovalProposal = {
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
  /** Absolute bounded deadline in milliseconds. */
  expiresAt: number;
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
  /** ISO deadline; resolved receipts remain readable after it. */
  expiresAt: string;
  /** Stored proposal, never client-provided state. */
  proposal: ApprovalProposal;
  /** Application outcome; a successful HTTP run alone does not establish applied. */
  status: "pending" | "applied" | "rejected" | "failed" | "unknown" | "expired";
  /** Authoritative unsuccessful attempt, when one exists. */
  failure?: {outcome: "unknown" | "notApplied"; message: string; code?: string; retryable?: boolean};
};
