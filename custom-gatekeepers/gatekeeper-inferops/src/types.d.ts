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
   * it exists. Proposing the same issue again while that create is still pending (from another
   * tab, or a retry) joins it and queues nothing new. An empty or overlong field fails with
   * INVALID_REQUEST; a state outside this project fails with INVALID_STATE.
   */
  createIssue(issue: NewIssue): Promise<void>;
  /**
   * Find boards that match what the person described: its work or purpose, not necessarily its
   * title, key or workspace (1-200 characters). Searches this connection's InferOps workspace and,
   * when the connection is the person's own InferLab sign-in, every other InferOps workspace they
   * belong to. Only projects the person's own account lists right now are considered, so a project
   * they cannot read is never named or counted. Returns at most 8 candidates, best first, each with why it matched; an empty
   * list means nothing matched. Several candidates mean the person must choose: never pick one for
   * them. A candidate names a board but grants nothing; open it only through a connection made for
   * its boardRef. Recorded as an observation, and refused in a workspace shared with others.
   */
  findBoards(query: string): Promise<BoardCandidate[]>;
}

/** A board findBoards() matched, identified by validated ids rather than its display name. */
export interface BoardCandidate {
  /** The tenant label of the connection's workspace. */
  tenant: string;
  /** The InferOps workspace slug of the board, which may differ from the connection's. */
  workspace: string;
  /** The project key, such as ENG. */
  projectKey: string;
  /** The board's canonical reference: inferops://<tenant>.<workspace>/project/board/<KEY>. */
  boardRef: string;
  /** The project's display name. */
  title: string;
  /** Why it matched, for the person choosing between candidates. */
  reasons: string[];
}

/** Where a coding run stands. queued and running are active; the rest are final. */
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";

/** A repository the workspace may hand coding work to. */
export interface Repo {
  /** Stable repository UUID; pass it to dispatch(). */
  id: string;
  /** Short handle, such as web-app. */
  slug: string;
  /** The branch a run starts from when dispatch() names none. */
  defaultBaseRef: string;
  /** A disabled repository takes no new dispatch. */
  enabled: boolean;
  /** Whether this deployment allows coding against it; dispatch() refuses any other. */
  allowed: boolean;
}

/** The patch a run left in its local checkout, when it produced one. */
export interface RunPatch {
  /** Where the patch file is on the machine that ran it. */
  path: string;
  /** SHA-256 of the patch file, hex. */
  sha256: string;
  /** Files changed. */
  files: number;
  /** Lines added. */
  insertions: number;
  /** Lines removed. */
  deletions: number;
}

/** One configured test command the runner ran in the run's checkout after the coding turn. */
export interface RunTestCommand {
  /** 1-based position in the repository's configured test commands. */
  index: number;
  /** The command and its arguments. */
  argv: string[];
  /** The exit code; null when the command timed out or could not start. Only 0 passes. */
  exitCode: number | null;
  /** Whether the command was stopped for running too long. */
  timedOut: boolean;
  /** How long it ran, in milliseconds. */
  durationMs: number;
  /** Whether its output was longer than the runner keeps (it keeps the tail). */
  truncated: boolean;
  /** Where its captured output and record are on the machine that ran it. */
  artifacts: { stdout: string; stderr: string; record: string };
}

/** The test evidence a run captured: every configured command it ran, with pass and fail counts. */
export interface RunTests {
  /** The artifacts directory on the machine that ran it. */
  directory: string;
  /** Commands that exited 0. */
  passed: number;
  /** Commands that did not. */
  failed: number;
  /** Each command run; empty when the repository has none configured. */
  commands: RunTestCommand[];
}

/**
 * Why a run that did not succeed ended as it did, when the runner can say so. AUTH_BLOCKED: the
 * coding tool's own sign-in is missing or expired. QUOTA_BLOCKED: its plan's usage limit is
 * exhausted. Both pause the runner until someone fixes it. TESTS_FAILED: the run produced a patch
 * but a configured test command did not pass.
 */
export type RunReasonCode = "AUTH_BLOCKED" | "QUOTA_BLOCKED" | "TESTS_FAILED";

/** What a finished run reported. */
export interface RunResult {
  /** The runner's own account of what it did. Not evidence that tests passed. */
  summary: string;
  /** Test results the runner captured by running the configured commands, when it reports them. */
  testSummary?: string;
  /** The local patch, when the run produced one. */
  patch?: RunPatch;
  /** The test commands the runner ran and what each left behind, when it ran any. */
  tests?: RunTests;
  /** Why the run did not succeed, when the runner names a reason. */
  reasonCode?: RunReasonCode;
  /** The branch the run pushed, when it published its work. */
  branch?: string;
  /** The commit the run pushed, when it published its work. */
  commitSha?: string;
  /** The pull request the run opened, when it published its work. */
  prUrl?: string;
}

/** One coding run of an issue of this project. */
export interface Run {
  /** Stable run UUID. */
  id: string;
  /** The issue's UUID. */
  issueId: string;
  /** The issue's human-readable key, such as ENG-42. */
  issueIdentifier: string;
  /** The repository the run works on. */
  repoId: string;
  /** Where the run stands. */
  status: RunStatus;
  /** The git ref the work started from; null means the repository's default branch. */
  baseRef: string | null;
  /** The coding tool's own session id, once it has one. */
  externalRunId: string | null;
  /** Set once the run has finished with a result. */
  result: RunResult | null;
  /** Why the run failed or was cancelled, when it did. */
  error: string | null;
  /** When it was queued (ISO timestamp). */
  queuedAt: string;
  /** When the runner started it, or null. */
  startedAt: string | null;
  /** When it finished, or null. */
  finishedAt: string | null;
  /**
   * Set while a change requested through this connection has not taken effect yet; absent
   * otherwise. "dispatch": the run does not exist yet; its id is provisional ("pending-<n>") and not
   * accepted by getRun() or cancel(). "cancel": the run is shown as it is now, and will stop.
   */
  pending?: "dispatch" | "cancel";
}

/** What to run a dispatched issue against. */
export interface DispatchTarget {
  /** One of listRepos()'s ids that is enabled and allowed. */
  repoId: string;
  /** Start from this git ref instead of the repository's default branch. */
  baseRef?: string;
}

/**
 * Coding dispatch for one project, fixed when this capability is created: hand its software issues
 * to the local coding runner and follow the runs. Every method fails with DISABLED while the
 * deployment has coding dispatch turned off.
 */
export interface InferOpsDispatchSession {
  /** The workspace's repositories, each marked with whether this deployment allows coding against it. */
  listRepos(): Promise<Repo[]>;
  /**
   * Hand a software issue of this project to the coding runner. issueKey is its human-readable key,
   * such as ENG-42; supply the revision you read it at, and a stale one fails with STALE_REVISION.
   * listRuns() shows the run at once, marked pending "dispatch". Fails with FORBIDDEN for a
   * repository this deployment does not allow (or when your InferOps access lacks dispatch
   * permission), RUN_ACTIVE while the issue already has a queued or running run (or a pending
   * dispatch), WORKFLOW_MISMATCH for a content issue, CONFLICT for an issue that is already done or
   * cancelled, NOT_FOUND for an issue outside this project, and INVALID_REQUEST for a malformed
   * repository id, ref or revision, or a repository that is disabled or not in the workspace.
   */
  dispatch(issueKey: string, target: DispatchTarget, expectedRevision: Revision): Promise<void>;
  /** One run of an issue of this project. A run of another project fails with NOT_FOUND. */
  getRun(runId: string): Promise<Run>;
  /** This project's recent runs, newest first. */
  listRuns(): Promise<Run[]>;
  /**
   * Stop a queued or running run of this project. A queued run ends cancelled; a running one ends
   * unknown, because its work may be partly done. A finished run fails with CONFLICT.
   */
  cancel(runId: string): Promise<void>;
}

/** One page of the Wiki, as listed: where it sits in the page tree, without its content. */
export interface WikiDocumentNode {
  /** Stable page UUID. */
  id: string;
  /** The page's short name, as in inferops://<tenant>.<workspace>/knowledge/document/<slug>. */
  slug: string;
  /** Page title. */
  title: string;
  /** The parent page's UUID, or null for a top-level page. */
  parentId: string | null;
  /** Order among the pages with the same parent, ascending. */
  siblingOrder: number;
}

/** A [[target#tag]] link written in a section, naming another page's section. */
export interface WikiLink {
  /** The linked page, as written (a page slug or title). */
  target: string;
  /** The linked section's tag. */
  tag: string;
}

/** One section of a page: the unit that is read, linked and edited. */
export interface WikiSection {
  /** Stable section UUID; pass it to updateSection(). */
  id: string;
  /** The section's anchor tag. */
  tag: string;
  /** The section's markdown. */
  body: string;
  /** Version to supply when editing this section. It changes with every edit. */
  version: number;
  /** The [[target#tag]] links in the body, each once, in order of first appearance. */
  wikilinks: WikiLink[];
  /**
   * Set while an edit requested through this connection has not taken effect yet; absent
   * otherwise. The body shown already includes the edit, at the section's unchanged version.
   */
  pending?: "update";
}

/** A page as a structure read names it: where it sits in the page tree. */
export interface WikiStructurePage {
  /** Stable page UUID. */
  id: string;
  /** The page's short name. */
  slug: string;
  /** Page title. */
  title: string;
  /** The parent page's UUID, or null for a top-level page. Filing a page in a pillar never moves it. */
  parentId: string | null;
}

/** A page filed in a pillar, and who filed it. */
export interface WikiPillarMember extends WikiStructurePage {
  /** "intake" when the company intake filed it, "human" when a person did. */
  source: "intake" | "human";
}

/** One business pillar of the Wiki: a lane of pages with its own Master page. */
export interface WikiPillar {
  /** The pillar's key, a lowercase slug such as engineering. */
  key: string;
  /** Pillar title. */
  title: string;
  /** Order among the pillars, ascending. */
  position: number;
  /** The pillar's Master page, or null when it has none you can open. */
  master: WikiStructurePage | null;
  /** The pages filed in the pillar, by title. One page may be filed in several pillars. */
  members: WikiPillarMember[];
}

/**
 * How the Wiki is organized: the company root page, the business pillars with their Masters and
 * filed pages, and the pages no pillar files. It lists only pages listDocuments() shows. Pillars
 * organize pages; they never decide who can read one.
 */
export interface WikiStructure {
  /** The company root page, or null when there is none you can open. */
  root: WikiStructurePage | null;
  /** The pillars, by position. */
  pillars: WikiPillar[];
  /** The pages that are neither a Master nor filed in a pillar. */
  unfiled: WikiStructurePage[];
}

/**
 * One page: its authored body and its sections.
 *
 * The body is the page's own markdown, readable by anyone who can open the page. Sections are the
 * separate units that are linked, indexed and edited one at a time; you see only the sections your
 * InferMind access shows, so a page may show fewer sections than it has. A page with a body reads
 * as its body, and its sections are never merged into it.
 */
export interface WikiDocument {
  /** Stable page UUID. */
  id: string;
  /** The page's short name. */
  slug: string;
  /** Page title. */
  title: string;
  /** The page's own markdown; empty when it has none. */
  body: string;
  /** Version to supply when editing the body. It changes with every change of the page. */
  version: number;
  /** "root" for the company root page, "pillar" for a pillar's Master page, null for any other page. */
  masterRole: "root" | "pillar" | null;
  /**
   * Set while a body edit requested through this connection has not taken effect yet; absent
   * otherwise. The body shown already includes the edit, at the page's unchanged version.
   */
  pendingBody?: true;
  /** The sections you can read, in page order. May be empty. */
  sections: WikiSection[];
  /**
   * The inferops:// references embedded in what the page reads as (its body, or its sections when
   * it has no body): links that stand alone as a paragraph, such as
   * [ENG board](inferops://acme.operations/project/board/ENG), each once, in order. A reference
   * names something and grants nothing; reading it needs its own connection.
   */
  references: string[];
}

/**
 * The InferMind Wiki of one workspace, fixed when this capability is created. Fails with
 * FORBIDDEN when the workspace is not an InferMind workspace or your InferOps access lacks
 * knowledge permission, and with NOT_FOUND for a page or section this Wiki does not have.
 */
export interface InferOpsWikiSession {
  /** Every page you can open, ordered by siblingOrder, then title; parentId places each in the tree. */
  listDocuments(): Promise<WikiDocumentNode[]>;
  /** The company root, the business pillars with their Masters and filed pages, and the unfiled pages. */
  readStructure(): Promise<WikiStructure>;
  /** One page by its slug or UUID, with its body, its sections and its embedded references. */
  readDocument(slugOrId: string): Promise<WikiDocument>;
  /**
   * One page as plain text: "# <title>", a blank line, then the page's body without a leading
   * "# ..." title line (or, for a page with no body, each section's markdown, separated by blank
   * lines). A Master page then adds a generated list of the pillars (the root) or of the pillar's
   * pages, marked by an "<!-- generated: wiki structure -->" line. Embedded references stay as the
   * links they are written as. Fails with NOT_FOUND for a page with nothing you can read.
   */
  readDocumentText(slugOrId: string): Promise<string>;
  /**
   * Replace a page's body. Supply the version readDocument() returned; a page changed since (its
   * body, title or place in the tree) fails with STALE_REVISION. Reads show the new body at once,
   * marked pendingBody. A body equal to the current one does nothing. While an earlier body edit of
   * the page has not taken effect, another fails with CONFLICT. A body over 200000 characters fails
   * with INVALID_REQUEST. Sections are not changed; edit them with updateSection().
   */
  updateDocumentBody(slugOrId: string, body: string, expectedVersion: number): Promise<void>;
  /**
   * Replace a section's markdown. Supply the version you read it at; a section edited since fails
   * with STALE_REVISION. Reads show the new body at once, marked pending "update". A body equal to
   * the current one does nothing. While an earlier edit of the section has not taken effect,
   * another fails with CONFLICT. A body over 100000 characters fails with INVALID_REQUEST.
   */
  updateSection(sectionId: string, body: string, expectedVersion: number): Promise<void>;
}
