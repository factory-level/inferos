/** A work item's version, encoded as a nonnegative decimal string. */
export type Revision = string;

/** The work-item workflow that a state or issue belongs to. */
export type Workflow = "content" | "software";

/** An issue's priority; none means unset. */
export type Priority = "urgent" | "high" | "medium" | "low" | "none";

/** The canonical group used to order states and distinguish open from closed work. */
export type StateGroup = "backlog" | "unstarted" | "started" | "completed" | "cancelled";

/** Project metadata for the project this connection grants access to. */
export interface Project {
  /** Stable project UUID. */
  id: string;
  /** Human-readable project key, such as ENG. */
  identifier: string;
  /** Display name. */
  name: string;
}

/** One state in the connected project's workflow. */
export interface State {
  /** Stable state UUID. */
  id: string;
  /** Display name. */
  name: string;
  /** Canonical workflow group. */
  group: StateGroup;
  /** Order within the group. */
  position: number;
  /** Only issues with this workflow may enter the state. */
  workflow: Workflow;
}

/** The work-item fields needed for a project board. */
export interface Issue {
  /** Stable issue UUID. */
  id: string;
  /** Human-readable key, such as ENG-42. */
  identifier: string;
  /** Work-item title. */
  title: string;
  /** Priority; none means unset. */
  priority: Priority;
  /** State UUID belonging to the connected project. */
  stateId: string;
  /** Planned date as YYYY-MM-DD, or null. */
  targetDate: string | null;
  /** Workflow that constrains valid target states. */
  workflow: Workflow;
  /** Version to supply when changing this issue. Treat it as opaque; do not increment it. */
  revision: Revision;
  /** Assigned principal UUID, or null. */
  assigneeId: string | null;
  /** Explanation of a blocker, or null. */
  blockedReason: string | null;
  /**
   * Set while a change requested through this connection has not taken effect yet; absent
   * otherwise. "create": the issue does not exist yet. Its id is provisional and not accepted by
   * openIssue(), its identifier ends in "-new" and its revision is "0"; once created it appears
   * with its real id and identifier. "update" or "transition": the fields shown already include
   * the requested change, at the issue's unchanged revision.
   */
  pending?: "create" | "update" | "transition";
}

/** The fields of a new issue. */
export interface NewIssue {
  /** Title: 1 to 500 characters once surrounding whitespace is trimmed. */
  title: string;
  /** Body text, at most 20000 characters. */
  description?: string;
  /** Priority; defaults to none. */
  priority?: Priority;
  /**
   * The state to create the issue in, one of the board's states; its workflow becomes the issue's
   * workflow. Defaults to the first state of the software workflow, or of the content workflow on
   * a board that has no software states.
   */
  stateId?: string;
}

/** Changes to an issue's fields. Omitted fields keep their current value. */
export interface IssueChanges {
  /** New title: 1 to 500 characters once surrounding whitespace is trimmed. */
  title?: string;
  /** New body text, at most 20000 characters; null clears it. */
  description?: string | null;
  /** New priority. */
  priority?: Priority;
}

/** A complete board for exactly the project granted by this connection. */
export interface Board {
  /** The connected project; no other workspace projects are included. */
  project: Project;
  /** Ordered states and their issue cards. */
  columns: Array<{ state: State; issues: Issue[] }>;
}

/** Access to one issue, fixed when this capability is created. */
export interface InferOpsIssueSession {
  /** Read this issue. Fails if it was removed or access was revoked. */
  read(): Promise<Issue>;
  /**
   * Move this issue to a state in the same project and workflow.
   * Supply the revision returned by read(); a stale version fails with STALE_REVISION.
   * An incompatible target fails with WORKFLOW_MISMATCH or INVALID_STATE.
   * While an earlier move or update of this issue has not yet taken effect, another fails with
   * CONFLICT. Read again before retrying a stale change.
   */
  transition(toStateId: string, expectedRevision: Revision): Promise<void>;
  /**
   * Change this issue's title, description or priority. Supply the revision returned by read();
   * a stale version fails with STALE_REVISION. Reads show the new values at once. Values equal to
   * the current ones are not sent, and a change of nothing does nothing. An empty or overlong
   * field fails with INVALID_REQUEST. While an earlier move or update of this issue has not yet
   * taken effect, another fails with CONFLICT.
   */
  update(changes: IssueChanges, expectedRevision: Revision): Promise<void>;
}

/** Access to one project, fixed when this capability is created. */
export interface InferOpsProjectSession {
  /** Read the connected project's complete board. Large-board paging is not part of this version. */
  readBoard(): Promise<Board>;
  /**
   * Open one issue belonging to this project. An unknown or out-of-project UUID fails
   * without disclosing whether it exists elsewhere. The returned capability cannot switch issues.
   */
  openIssue(issueId: string): Promise<InferOpsIssueSession>;
  /**
   * Create an issue in this project. readBoard() shows it at once, marked pending "create", until
   * it exists. An empty or overlong field fails with INVALID_REQUEST; a state outside this project
   * fails with INVALID_STATE.
   */
  createIssue(issue: NewIssue): Promise<void>;
}
