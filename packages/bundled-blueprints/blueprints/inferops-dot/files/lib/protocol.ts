// The contract between this gadget's client and its Durable Object, plus the slice of the InferOps
// gatekeeper's agent-facing API (InferOpsDotSession) the Durable Object calls. Imported type-only,
// so nothing of it ships.

/** Where a change stands, in FAC-97's words (the gatekeeper's `WriteStatus`). */
export interface WriteStatus {
  outcome: "waiting" | "running" | "succeeded" | "failed" | "rejected" | "unknown";
  result?: Record<string, string | number | boolean | null>;
  code?: string;
  /** One fixed sentence, never InferOps' own words. */
  reason?: string;
}

/** How a workflow run a proposal handed to InferOS came out (FAC-134), as the gatekeeper reports it. */
export interface DotProposalRun {
  /** A published workflow's run, or one of the person's personal workflows' (FAC-134 capability 2). */
  kind?: "workflow-run" | "personal-workflow" | "delegate";
  runId: string;
  outcome: "succeeded" | "failed" | "uncertain";
  reasonCode?: string;
  ranAs: "gadget_bindings" | "service_account" | "person";
}

/** A Dot run's stored status (FAC-135, inferops#2657's `RUN_STATUSES`). */
export type DotRunStatus = "running" | "complete" | "interrupted" | "error" | "awaiting_decision" | "refused";

/** A change the Dot proposed, as the gatekeeper reports it. */
export interface DotProposal {
  id: string;
  tool: string;
  input: string;
  status: WriteStatus;
  receipt: unknown;
  /** For a workflow run it handed to InferOS, how that run came out; null until then (FAC-134). */
  run?: DotProposalRun | null;
  /**
   * The status of the Dot run that proposed it (FAC-135, inferops#2657's `Proposal.runStatus`):
   * `awaiting_decision` while it waits for the person, then how its resume ended. Absent from an
   * older gatekeeper or InferOps.
   */
  runStatus?: DotRunStatus | null;
  /**
   * True while its decision waits here because its last confirm met a dead sign-in (FAC-135): it
   * waits for the person to reconnect InferOps. Absent from an older gatekeeper.
   */
  waitsForReconnect?: boolean;
  createdAt: string;
  expiresAt: string;
}

export interface DotMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "running" | "complete" | "error" | "interrupted";
  createdAt: string;
}

export interface DotConversation {
  id: string;
  title: string;
  messages: DotMessage[];
  nextCursor: string | null;
  running: boolean;
  proposals: DotProposal[];
}

/** Something that happened while the Dot answered. */
export type DotProgress =
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; status: "started" | "finished" }
  | { type: "proposal"; proposal: DotProposal }
  | { type: "error"; message: string };

export interface DotTurn {
  runId: string;
  status: "complete" | "error" | "interrupted";
  reply: string;
  proposals: DotProposal[];
}

export interface DotConversationSession {
  id(): Promise<string>;
  read(options?: { before?: string }): Promise<DotConversation>;
  ask(prompt: string, options?: { page?: string; record?: string; onProgress?: (event: DotProgress) => void }): Promise<DotTurn>;
  cancel(): Promise<void>;
}

/** The `dot` binding: the person's own Dot in one workspace, fixed by the connection. */
export interface InferOpsDotSession {
  startConversation(): Promise<DotConversationSession>;
  openConversation(conversationId: string): Promise<DotConversationSession>;
}

// ---------------------------------------------------------------------------
// This gadget's own protocol.

/**
 * A knowledge write the Dot proposed (inferops FAC-136), as the client draws it: what it targets, by
 * the canonical link InferOps gave it (a link names a target and grants nothing), and the page's
 * title where the proposal carries one. An edit carries only its page's link (and a new title,
 * when it renames the page); a create carries the workspace's link and the new page's title.
 */
export type KnowledgeWrite =
  | { kind: "edit"; page: string; newTitle?: string }
  | { kind: "create"; workspace: string; title?: string };

/** A change as the client draws it: only what it needs, never its receipt or raw arguments. */
export interface ShownProposal {
  id: string;
  tool: string;
  status: WriteStatus;
  /** Set for a knowledge write (FAC-136): what it changes, from its arguments, read on the server. */
  knowledge?: KnowledgeWrite;
  /** Set for a workflow run handed to InferOS (FAC-134): its run, once that run has an outcome. */
  run?: DotProposalRun;
  /** The status of the Dot run that proposed it (FAC-135), when the gatekeeper reports one. */
  runStatus?: DotRunStatus;
  /** Set when its decision waits for the person to reconnect InferOps (FAC-135). */
  waitsForReconnect?: true;
}

export interface ShownMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: DotMessage["status"];
}

/** The conversation as the client draws it; null before the first question. */
export interface ShownConversation {
  title: string;
  messages: ShownMessage[];
  running: boolean;
  proposals: ShownProposal[];
}

/**
 * Why there is no answer:
 * - not-connected: no Dot binding yet.
 * - refused: InferOps or the connection doesn't allow it (a shared connection, your access).
 * - unavailable: the Dot can't run now (InferOps down or its agent unavailable; a company with its
 *   own database also lands here today).
 * - busy: another turn of this conversation is still running.
 * - not-found: the page or record named isn't one you can open.
 * - disabled: the deployment has the Dot turned off.
 * - error: anything else.
 */
export type FailureReason = "not-connected" | "refused" | "unavailable" | "busy" | "not-found" | "disabled" | "error";

export type Failure = { ok: false; reason: FailureReason; message: string };

export type OpenResult = { ok: true; conversation: ShownConversation | null } | Failure;

export type AskResult =
  | { ok: true; status: DotTurn["status"]; conversation: ShownConversation }
  | Failure;

/** Something that happened while the Dot answered, as the client hears it: a change only as shown. */
export type ShownProgress =
  | Exclude<DotProgress, { type: "proposal" }>
  | { type: "proposal"; proposal: ShownProposal };

/** What the client hands the Durable Object to hear the answer as it comes. */
export interface ProgressTarget {
  progress(event: ShownProgress): void;
}

/** The Durable Object's RPC surface, as the client's `gadget` stub sees it. */
export interface GadgetStub {
  /** The conversation this gadget keeps, read again from InferOps; null before the first question. */
  open(): Promise<OpenResult>;
  /** Ask one turn, in this gadget's conversation (started on the first question). */
  ask(prompt: string, progress: ProgressTarget): Promise<AskResult>;
  /** Stop the turn running now, if any. */
  cancel(): Promise<{ ok: true } | Failure>;
  /** Forget this gadget's conversation, so the next question starts a new one. InferOps keeps it. */
  startOver(): Promise<void>;
}
