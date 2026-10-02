/** A work item's version, encoded as a nonnegative decimal string. */
export type Revision = string;

/** The work-item workflow that a state or issue belongs to. */
export type Workflow = "content" | "software";

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
  priority: "urgent" | "high" | "medium" | "low" | "none";
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
   * Read again before retrying a stale change.
   */
  transition(toStateId: string, expectedRevision: Revision): Promise<void>;
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
}
