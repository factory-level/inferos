// The contract between this gadget's client and its Durable Object, plus the slice of the InferOps
// gatekeeper's agent-facing API (InferOpsProjectSession) the Durable Object calls. Imported
// type-only, so nothing of it ships.

/** A work item's version, as a decimal string. Opaque: pass it back, never increment it. */
export type Revision = string;
export type Workflow = "content" | "software";
export type StateGroup = "backlog" | "unstarted" | "started" | "completed" | "cancelled";
export type Priority = "urgent" | "high" | "medium" | "low" | "none";

export interface Project {
  id: string;
  identifier: string;
  name: string;
}

export interface State {
  id: string;
  name: string;
  group: StateGroup;
  position: number;
  workflow: Workflow;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  priority: Priority;
  stateId: string;
  targetDate: string | null;
  workflow: Workflow;
  revision: Revision;
  assigneeId: string | null;
  blockedReason: string | null;
}

export interface Board {
  project: Project;
  columns: Array<{ state: State; issues: Issue[] }>;
}

/** The `board` binding: one InferOps project, fixed by the connection. */
export interface InferOpsIssueSession {
  read(): Promise<Issue>;
  transition(toStateId: string, expectedRevision: Revision): Promise<void>;
}

/**
 * `openIssue` returns a Cap'n Web promise, which pipelines: `transition` can be called on it before
 * it resolves, in one round trip. It is also disposable, releasing the issue capability.
 */
export interface InferOpsProjectSession {
  readBoard(): Promise<Board>;
  openIssue(issueId: string): Promise<InferOpsIssueSession> & InferOpsIssueSession & Disposable;
}

/** Why a move was refused, as the gatekeeper reports it. */
export type MoveFailureCode =
  | "STALE_REVISION" | "WORKFLOW_MISMATCH" | "INVALID_STATE" | "NOT_FOUND" | "NOT_CONNECTED" | "ERROR";

export type LoadBoardResult =
  | { ok: true; board: Board }
  | { ok: false; reason: "not-connected" }
  | { ok: false; reason: "error"; message: string };

export type MoveResult =
  | { ok: true }
  | { ok: false; code: MoveFailureCode; message: string };

/** The Durable Object's RPC surface, as the client's `gadget` stub sees it. */
export interface GadgetStub {
  loadBoard(): Promise<LoadBoardResult>;
  moveIssue(issueId: string, toStateId: string, expectedRevision: Revision): Promise<MoveResult>;
}
