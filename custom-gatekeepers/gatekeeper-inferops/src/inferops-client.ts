import type { ServiceQueryName, ServiceQueryOptions, ServiceQueryPage } from "./types";
// The data-source contract the gatekeeper is written against. `mock-inferops.ts` implements it with
// seeded fixture data in a Durable Object (the default, and what the tests and the demo use);
// `http-inferops.ts` implements it over the InferOps HTTP API. `clientFor` in inferops.ts is the one
// place that chooses between them.

import type {
  Board, Issue, IssueActivity, IssueActivityEntry, IssueChanges, Priority, Project, Repo, Revision, Run, TableTargetKind,
  WikiDocumentNode, WikiProposal, WikiProposalFreshness, WikiProposalSource, WikiProposalState,
  WikiSearchHit, WikiStructure,
} from "./types";
import type { WorkflowHeadRecord } from "./workflow-policy";
import type { WidgetSearchResult } from "@gadgets/workshop-shared/gatekeeper";
import type { Event as DotEvent } from "@ag-ui/core";

/** One validated AG-UI event of a Dot run (`@ag-ui/core` 1.0.2, the version InferOps emits). */
export type { DotEvent };

/** Error codes a data source reports. Callers branch on these, never on message text. */
export type InferOpsErrorCode =
  /** The project or issue does not exist, or is outside the requested project. */
  | "NOT_FOUND"
  /** The expected revision no longer matches the issue's current revision. */
  | "STALE_REVISION"
  /** The target state's workflow differs from the issue's workflow. */
  | "WORKFLOW_MISMATCH"
  /** The target state does not belong to the issue's project. */
  | "INVALID_STATE"
  /** An idempotency key was reused for a different operation. */
  | "IDEMPOTENCY_CONFLICT"
  /** The request itself was malformed. */
  | "INVALID_REQUEST"
  /** The change is refused in the issue's current condition, such as a move already in progress. */
  | "CONFLICT"
  /** The issue already has a queued or running coding run (or a dispatch waiting for approval). */
  | "RUN_ACTIVE"
  /** InferOps rejected the connection's credential (expired or revoked). */
  | "UNAUTHORIZED"
  /** The connection is not permitted to do this in InferOps. */
  | "FORBIDDEN"
  /** InferOps could not be reached, or its response was not usable. */
  | "UNAVAILABLE"
  /** The deployment has the InferOps integration turned off (`INFEROPS_ENABLED`, enablement.ts). */
  | "DISABLED"
  /** A Dot proposal that wasn't decided before it expired; it can't be confirmed now (FAC-133). */
  | "EXPIRED";

const ERROR_CODES: ReadonlySet<string> = new Set<InferOpsErrorCode>([
  "NOT_FOUND", "STALE_REVISION", "WORKFLOW_MISMATCH", "INVALID_STATE", "IDEMPOTENCY_CONFLICT",
  "INVALID_REQUEST", "CONFLICT", "RUN_ACTIVE", "UNAUTHORIZED", "FORBIDDEN", "UNAVAILABLE", "DISABLED", "EXPIRED",
]);

/**
 * How far a failed write got, which is what its failure proves about its effect. A failure without
 * a stage proves nothing: the write may have been applied.
 * - `unsent`: it failed before the write request was sent (a check, or a read made first).
 * - `refused`: InferOps answered the write request itself with a refusal: a 401, or a 400, 403, 404
 *   or 409 carrying its error envelope. A credential confirmed dead after a request was sent with
 *   it counts too, since every send was answered 401.
 */
export type WriteStage = "unsent" | "refused";

/** What else a failure proves, beyond its code. */
export type InferOpsErrorFacts = {
  /** How far a failed write got; see `WriteStage`. */
  stage?: WriteStage;
  /** A FORBIDDEN that is InferOps' workflow policy refusing the change, not a missing permission. */
  policy?: boolean;
};

/**
 * A data-source failure. The code leads the message (`STALE_REVISION: ...`) because Workers RPC
 * carries an error's message across a Durable Object boundary but not its custom properties, so
 * `inferOpsErrorCode()` recovers it on the far side. The `facts` are such properties: they hold
 * only within the isolate that raised the error (the gatekeeper's, for the HTTP client), and
 * `atStage` restores a stage on the near side of the mock's boundary.
 */
export class InferOpsError extends Error {
  constructor(readonly code: InferOpsErrorCode, readonly detail: string,
              readonly facts: InferOpsErrorFacts = {}) {
    super(`${code}: ${detail}`);
    this.name = "InferOpsError";
  }
}

/** The write stage a caught error proves, if any; see `WriteStage`. */
export function writeStage(error: unknown): WriteStage | undefined {
  return error instanceof InferOpsError ? error.facts.stage : undefined;
}

/** Whether a caught error is InferOps' workflow policy refusing the change. */
export function isPolicyRefusal(error: unknown): boolean {
  return error instanceof InferOpsError && error.facts.policy === true;
}

/**
 * `error` as an `InferOpsError` known to have failed at `stage`, keeping its code, detail and other
 * facts; an error without a data-source code is returned unchanged, proving nothing.
 */
export function atStage(error: unknown, stage: WriteStage): unknown {
  const code = inferOpsErrorCode(error);
  if (code === null) return error;
  if (error instanceof InferOpsError && error.facts.stage === stage) return error;
  if (error instanceof InferOpsError) return new InferOpsError(code, error.detail, { ...error.facts, stage });
  return new InferOpsError(code, (error as Error).message.slice(code.length + 2), { stage });
}

/** The data-source code a caught error carries, or null for any other failure. */
export function inferOpsErrorCode(error: unknown): InferOpsErrorCode | null {
  if (!(error instanceof Error)) return null;
  const match = /^([A-Z_]+): /.exec(error.message);
  return match && ERROR_CODES.has(match[1]!) ? match[1] as InferOpsErrorCode : null;
}

/** A project's board in source order: the project, every state, and every issue. */
export type ProjectSnapshot = {
  project: Project;
  states: Board["columns"][number]["state"][];
  issues: Issue[];
};

/**
 * A new issue as the gatekeeper sends it: the caller's fields, trimmed, with the state resolved
 * and the workflow named only when it is not InferOps' default (`software`).
 */
export type NewIssueRequest = {
  title: string;
  description?: string;
  priority?: Priority;
  stateId: string;
  workflow?: "content" | "service";
};

/** Changed fields of an issue as the gatekeeper sends them (trimmed, unchanged ones dropped). */
export type { IssueChanges } from "./types";

/** A workspace repository as InferOps lists it; whether this deployment allows it is added later. */
export type RepoRecord = Omit<Repo, "allowed">;

/** A coding run of an issue of the bound project, with that issue's key. */
export type RunRecord = Omit<Run, "pending">;

/** What a dispatch sends: always the `code` action, a repository and the revision it was read at. */
export type DispatchRequest = { repoId: string; baseRef?: string; expectedRevision: Revision };

/** A Wiki page as listed: its place in the tree, without content. */
export type WikiDocumentRecord = WikiDocumentNode;

/**
 * A Wiki page as read on its own: its identity, its authored body (empty when it has none), the
 * version a body edit must name, and its Master role. The body is document-level in InferOps
 * (workspace scope and `knowledge:read`); sections, read apart, are lens-gated.
 */
export type WikiDocumentHead = Pick<WikiDocumentNode, "id" | "slug" | "title"> & {
  body: string;
  /** InferOps' page version, bumped by every body, title or tree write. */
  version: number;
  masterRole: "root" | "pillar" | null;
};

/** The Wiki's structure as InferOps reports it, with page ids lowercased. */
export type WikiStructureRecord = WikiStructure;

/** One InferOS Blueprint widget version as `publishWidgetDefinition` lists it. */
export type WidgetDefinitionWrite = {
  /** The Blueprint's id. */
  sourceId: string;
  /** The Blueprint version, from 1. */
  sourceVersion: number;
  /** The widget's name, 1 to 120 characters. */
  title: string;
  /** What the widget is for, 1 to 2000 characters. */
  purpose: string;
};

/** One `knowledge.search` hit as InferOps returns it, without its `score` (decision 5). */
export type WikiSearchRecord = Omit<WikiSearchHit, "pending">;

/** What a body edit sends: the page's new markdown. */
export type WikiPageChanges = { body: string };

/** A page after a write: the version InferOps reports for it. */
export type WikiPageWrite = { id: string; version: number };

/** One section as InferOps stores it: its page, tag, markdown and version. */
export type WikiSectionRecord = {
  id: string;
  documentId: string;
  tag: string;
  body: string;
  /** InferOps' row version, bumped by every write. */
  version: number;
};

/** A Wiki proposal as InferOps returns it, field by field (no principals). */
export type WikiProposalRecord = Omit<WikiProposal, "pending">;

/** One proposal and its freshness for this account (`proposal.get`). */
export type WikiProposalRead = { proposal: WikiProposalRecord; freshness: WikiProposalFreshness };

/** What an approval sends: the hash reviewed and the cited sources at the versions reviewed. */
export type WikiProposalApproval = { proposalHash: string; sources: WikiProposalSource[] };

export type { WikiProposalState };

/**
 * What a refused approval says, by cause. InferOps' `proposal.approve` refusals map onto these in
 * the HTTP client, and the mock refuses with the same, so both read alike.
 */
export const PROPOSAL_APPROVE_REFUSED = {
  /** 409 `STALE_PROPOSAL` (another hash, other sources, or a superseded revision): STALE_REVISION. */
  stale: "The proposal changed since it was approved here; read it again.",
  /** Any other 409: CONFLICT. */
  conflict: "InferMind refused this approval in the proposal's current state (already decided, " +
    "decided by someone else, rejected, or failing its integrity check).",
  /** 403 `SELF_APPROVAL_DENIED`: CONFLICT, since no grant fixes it. */
  self: "You requested this draft or wrote this revision; another person must approve it.",
  /** Any other 403: FORBIDDEN, which a grant can fix. */
  forbidden: "Approving for publication needs knowledge:publish (Owner or Admin).",
  /** 422 `NEEDS_PLACEMENT`: INVALID_REQUEST. */
  placement: "A new page needs a parent; set one in InferMind.",
  /** 404, including the proposal routes absent while Wiki publishing is off: NOT_FOUND. */
  notFound: "No such proposal in this Wiki, or Wiki publishing is off in InferOps.",
} as const;

/**
 * One column of a custom table as InferOps defines it, personal ones included: the gatekeeper
 * projects them away (table.ts) before anything reaches a caller.
 */
export type TableColumnRecord = {
  key: string;
  name: string;
  label: string;
  type: "text" | "number" | "integer" | "boolean" | "date" | "timestamp";
  required: boolean;
  personal: boolean;
  enum?: string[];
};

/** A custom table's definition as InferOps returned it with the rows read beside it. */
export type TableRecordSchema = {
  id: string;
  label: string;
  version: number;
  columns: TableColumnRecord[];
  relations: { name: string; toKind: TableTargetKind }[];
};

/** One live link of a row, as InferOps returned it; its label and href are dropped on parsing. */
export type TableLinkRecord = { relation: string; toKind: TableTargetKind; ref: string };

/** One row as InferOps returned it: its values by column name, personal ones included. */
export type TableRowRecord = {
  id: string;
  typeId: string;
  typeVersion: number;
  values: Record<string, string | number | boolean | null>;
  links: TableLinkRecord[];
};

/**
 * One read of a custom table: its definition and the rows read with it, from one InferOps answer
 * (`object.embed`), whose rows InferOps already checked against that definition's version.
 */
export type TableRead = { table: TableRecordSchema; rows: TableRowRecord[] };

/** What a table read may narrow by. */
export type TableReadOptions = { relatedTo?: string; limit: number };

/**
 * One member of a workspace exactly as InferOps' `member.list` answers it (`GET /workspace/members`):
 * a principal holding a live grant there, with that grant's role and explicit denies only.
 */
export type WorkspaceMemberRecord = {
  principalId: string;
  type: "user" | "service_account";
  name: string;
  /** null for a service account. The gatekeeper never passes it on (members.ts). */
  email: string | null;
  role: string;
  deniedPermissions: string[];
};

/** The answer of `member.list`: the workspace it is about, and its members. */
export type WorkspaceMembersRead = {
  workspace: { workspaceId: string; workspaceName: string; product: "inferops" | "infermind" };
  members: WorkspaceMemberRecord[];
};

/** One custom table an account can open, as listed for the resource picker. */
export type TableSummary = { id: string; label: string };

/**
 * Every status InferOps names for a Dot proposal, its derived `expired` and `unknown` included: the
 * one list the parser accepts (`parseDotProposal`) and the receipt mapping switches over
 * (`dotProposalStatus`), so a status InferOps adds is refused until both follow. `handed-off`
 * (FAC-120, inferops#2627) is a confirmed hand-off to InferOS: an InferOS workflow-run proposal,
 * which InferOps itself never runs.
 */
export const DOT_PROPOSAL_STATUSES = ["proposed", "confirming", "confirmed", "handed-off", "declined", "failed", "expired", "unknown"] as const;

/** A Dot proposal as InferOps reads it (`chatbot.proposal_list`), its status derived at read time. */
/** A run outcome as `chatbot.proposal_run_outcome` takes it (FAC-134): fixed fields, never what the run returned. */
export type DotRunOutcomeWire = {
  kind: "workflow-run";
  runId: string;
  outcome: "succeeded" | "failed" | "uncertain";
  reasonCode?: string;
  ranAs: "gadget_bindings" | "service_account";
};

export type DotProposalWire = {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  status: (typeof DOT_PROPOSAL_STATUSES)[number];
  /** The capability's answer once confirmed, or its refusal in InferOps' words once failed. */
  outcome: unknown;
  /**
   * For a hand-off to InferOS (FAC-134), how the run it started came out, once InferOS reported it;
   * null otherwise, and on an InferOps that doesn't report it yet.
   */
  run: DotRunOutcomeWire | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
};

/** One message of a Dot conversation, as InferOps stores it. */
export type DotMessageWire = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "running" | "complete" | "error" | "interrupted";
  createdAt: string;
};

/** A Dot conversation as `chatbot.conversation_get` reads it. */
export type DotConversationWire = {
  id: string;
  title: string;
  messages: DotMessageWire[];
  nextCursor: string | null;
  activeRunId: string | null;
  proposals: DotProposalWire[];
};

/** One Dot turn to start: its run id is the caller's, unique per conversation. */
export type DotRunRequest = {
  runId: string;
  prompt: string;
  /** References only (`inferops://` links), never entity data; InferOps reads each as the person. */
  selection?: { page?: string; record?: string };
};

/**
 * How a relayed Dot run ended, as the relay saw its stream. `finished` and `error` are the run's
 * own ends (`RUN_FINISHED`, `RUN_ERROR`); the others are the relay's: the stream ended without
 * either (`cut`), an event that isn't valid AG-UI (`malformed`), one over a size cap (`oversized`),
 * the run's deadline (`deadline`), or no bytes for too long (`silent`).
 */
export type DotRunEnd =
  | { kind: "finished" | "cut" | "deadline" | "silent" }
  | { kind: "error"; message: string }
  | { kind: "malformed" | "oversized" };

/** One project an account can reach, as listed for the resource picker. */
export type ProjectSummary = Pick<Project, "identifier" | "name">;

/**
 * The InferOps operations the gatekeeper needs, scoped to one InferOps account and host. Every
 * method takes the project key explicitly; the gatekeeper passes only the key bound into its own
 * props, so a caller can never widen scope through it.
 */
export interface InferOpsClient {
  /** Start a new, empty conversation of the person's own Dot (`chatbot.conversation_create`). */
  createDotConversation(): Promise<{ id: string }>;
  /** One of the person's Dot conversations (`chatbot.conversation_get`); NOT_FOUND for any other. */
  readDotConversation(conversationId: string, before?: string): Promise<DotConversationWire>;
  /**
   * Run one Dot turn through InferOps' streaming run route, handing each validated AG-UI event to
   * `onEvent` in order, and resolve with how the stream ended. A refusal before the stream starts
   * (another person's conversation, a selection the person can't read, a turn already running,
   * the Dot unavailable) throws.
   */
  runDot(conversationId: string, run: DotRunRequest, onEvent: (event: DotEvent) => void,
         signal?: AbortSignal): Promise<DotRunEnd>;
  /** Stop a running turn (`chatbot.conversation_cancel`); one that already ended is left as it is. */
  cancelDotRun(conversationId: string, runId: string): Promise<void>;
  /** A conversation's proposals, newest first (`chatbot.proposal_list`). */
  listDotProposals(conversationId: string): Promise<DotProposalWire[]>;
  /**
   * Confirm one proposal (`chatbot.proposal_confirm`) under the person's own token; InferOps keys
   * the write by the proposal id. EXPIRED once it expired, CONFLICT once it was decided.
   */
  confirmDotProposal(conversationId: string, proposalId: string, idempotencyKey: string): Promise<DotProposalWire>;
  /** Decline one proposal (`chatbot.proposal_decline`); nothing is written. */
  declineDotProposal(conversationId: string, proposalId: string): Promise<DotProposalWire>;
  /**
   * Record how the InferOS run a confirmed hand-off started came out (`chatbot.proposal_run_outcome`,
   * FAC-134) under the person's own token. InferOps keeps it once per proposal: the same run again
   * answers as recorded, another is CONFLICT.
   */
  recordDotRunOutcome(conversationId: string, proposalId: string, run: DotRunOutcomeWire): Promise<DotProposalWire>;
  /** Add a comment to an issue in the bound project, with a replayable key and exact head. */
  commentIssue(projectKey: string, issueId: string, body: string, expectedRevision: Revision, idempotencyKey: string): Promise<void>;
  /** Published joined reads, narrowed to the bound project by the HTTP adapter. */
  readServiceQuery(projectKey: string, name: ServiceQueryName, options?: ServiceQueryOptions): Promise<ServiceQueryPage>;
  /** Projects this account may open, for the resource picker. */
  listProjects(): Promise<ProjectSummary[]>;

  /** The full board of one project. Fails with NOT_FOUND for an unknown project. */
  readProject(projectKey: string): Promise<ProjectSnapshot>;

  /**
   * One issue of one project. Fails with NOT_FOUND both for an unknown issue and for an issue of
   * another project, with the same message, so the two are indistinguishable.
   */
  readIssue(projectKey: string, issueId: string): Promise<Issue>;

  /**
   * One issue's recorded activity (`issue.history`: field changes and comments), newest first, at
   * most ISSUE_ACTIVITY_LIMIT entries. The issue must belong to the project, with readIssue's one
   * NOT_FOUND otherwise. Read with the connection's own InferOps access.
   */
  readIssueActivity(projectKey: string, issueId: string): Promise<IssueActivity>;

  /**
   * Move an issue to another state of its project, after checking scope, state membership,
   * workflow and the expected revision. The returned issue carries its new revision, which is
   * opaque: nothing may assume how far a move advances it. A repeated `idempotencyKey` for the same
   * operation returns the issue without applying the move again. The mock refuses a key reused for
   * a different operation with IDEMPOTENCY_CONFLICT; InferOps does not detect that, so callers must
   * never reuse one.
   */
  transition(
    projectKey: string, issueId: string, toStateId: string, expectedRevision: Revision,
    idempotencyKey: string,
  ): Promise<Issue>;

  /**
   * Create an issue in the project, in the state `issue.stateId` names, which must belong to the
   * project and to the issue's workflow. A repeated `idempotencyKey` returns the issue the first
   * request created instead of creating another, including when the first response was lost. The
   * mock refuses a key reused for a different request with IDEMPOTENCY_CONFLICT; InferOps does not
   * detect that, so callers must never reuse one.
   */
  createIssue(projectKey: string, issue: NewIssueRequest, idempotencyKey: string): Promise<Issue>;

  /**
   * Change fields of an issue of the project, after checking scope and the expected revision,
   * which is always sent. The returned issue carries its new revision. Idempotency as for
   * `createIssue`.
   */
  updateIssue(
    projectKey: string, issueId: string, changes: IssueChanges, expectedRevision: Revision,
    idempotencyKey: string,
  ): Promise<Issue>;

  /** The workspace's repositories (not project-scoped in InferOps). */
  listRepos(): Promise<RepoRecord[]>;

  /**
   * The project's recent coding runs, newest first: only runs of the project's own issues, each
   * with the issue's key. With `issueId`, only that issue's runs; an issue of another project fails
   * with NOT_FOUND.
   */
  listRuns(projectKey: string, issueId?: string): Promise<RunRecord[]>;

  /** One run, provided its issue belongs to the project; otherwise the one NOT_FOUND. */
  readRun(projectKey: string, runId: string): Promise<RunRecord>;

  /**
   * Hand an issue of the project to the coding runner (InferOps `issue:delegate`), after checking
   * scope. InferOps rechecks the workflow, the issue's state and lease, an active run (RUN_ACTIVE),
   * the repository and the expected revision. A repeated `idempotencyKey` for the same issue returns
   * the run the first request queued without queuing another.
   */
  dispatchIssue(
    projectKey: string, issueId: string, request: DispatchRequest, idempotencyKey: string,
  ): Promise<RunRecord>;

  /** Cancel a queued or running run of the project (InferOps `issue:delegate`). */
  cancelRun(projectKey: string, runId: string, idempotencyKey: string): Promise<RunRecord>;

  /**
   * The workspace's Wiki pages the account can see (InferMind `knowledge:read`), in InferOps' order.
   * Every Wiki call fails with FORBIDDEN when the workspace is not an InferMind workspace or the
   * account lacks the knowledge permission.
   */
  listDocuments(): Promise<WikiDocumentRecord[]>;

  /** One Wiki page by UUID; NOT_FOUND for one this workspace does not have (or not a UUID). */
  readDocument(documentId: string): Promise<WikiDocumentHead>;

  /**
   * The Wiki's root, pillars (with Masters and filed pages) and unfiled pages, listing only pages
   * `listDocuments` shows.
   */
  readStructure(): Promise<WikiStructureRecord>;

  /**
   * One page as InferOps composes its text for this account (`document.text`, the same string as
   * its `read_document`): the body or the sections the account's lens shows, a Master's generated
   * structure and documentation coverage computed with the account's own access, and embedded
   * widgets as their live text. Null when the page does not exist, cannot be seen or has nothing
   * to read.
   */
  readDocumentText(documentId: string): Promise<string | null>;

  /**
   * `knowledge.search` (`GET /knowledge/search`, `query` and `limit` only): the sections the account
   * can read that best match `query`, best first, at most `limit`. InferOps applies its row rules
   * and the InferMind lens before choosing candidates. An empty list means no readable match; a
   * search that could not run (a timeout, an outage, an InferOps without the route, a rate limit)
   * fails with UNAVAILABLE, never an empty list. The caller has already validated both arguments.
   */
  searchWiki(query: string, limit: number): Promise<WikiSearchRecord[]>;

  /**
   * Replace a page's body (InferMind `knowledge:write`), compare-and-swap on the page version: a
   * page not at `expectedVersion` fails with STALE_REVISION, even when it already holds this body,
   * except that a retry under the same `idempotencyKey` is replayed when the page is exactly one
   * version later and that key made its last write. NOT_FOUND for an unknown page.
   */
  updateDocument(
    documentId: string, changes: WikiPageChanges, expectedVersion: number, idempotencyKey: string,
  ): Promise<WikiPageWrite>;

  /** The page's sections the account can read, in page order; NOT_FOUND for an unknown page. */
  listSections(documentId: string): Promise<WikiSectionRecord[]>;

  /** One section by UUID; NOT_FOUND for one this workspace does not have (or not a UUID). */
  readSection(sectionId: string): Promise<WikiSectionRecord>;

  /**
   * Replace a section's body (InferMind `knowledge:write`); the section's version advances. InferOps
   * takes no expected version and does not replay an idempotency key here: the caller reads the
   * section first and decides. The key is sent anyway, for when InferOps honors it.
   */
  updateSection(sectionId: string, body: string, idempotencyKey: string): Promise<WikiSectionRecord>;

  /**
   * The workspace's Wiki proposals, newest first (InferOps returns at most 200), optionally only
   * one state's (`proposal.list`, `knowledge:read`). NOT_FOUND while Wiki publishing is off in
   * InferOps (its routes are not mounted).
   */
  listProposals(state?: WikiProposalState): Promise<WikiProposalRecord[]>;

  /**
   * One proposal by UUID with its freshness, read under the account's lens (`proposal.get`).
   * NOT_FOUND for one this workspace does not have (or not a UUID), or while publishing is off.
   */
  readProposal(proposalId: string): Promise<WikiProposalRead>;

  /**
   * Approve one in_review proposal at `approval` (`proposal.approve`, `knowledge:publish`), which
   * also queues its publication. InferOps replays a resend by the same principal with the same
   * hash on a decided proposal, answering the proposal as it now is; the key is sent by convention
   * only. Refusals read as `PROPOSAL_APPROVE_REFUSED`. The answer must be this proposal, approved
   * at this hash, or it is UNAVAILABLE.
   */
  approveProposal(proposalId: string, approval: WikiProposalApproval, idempotencyKey: string):
    Promise<WikiProposalRecord>;

  /** The workspace's custom tables the account can open, for the resource picker. */
  listTables(): Promise<TableSummary[]>;

  /**
   * One custom table and up to `options.limit` of its rows, newest first, read through InferOps'
   * scoped `object.embed` with the reference `inferops://<host>/object/table-view/<tableId>`, so
   * InferOps checks the exact `<tenant>.<workspace>` of `host` against the reader. NOT_FOUND for a
   * table that is missing or not readable, without saying which.
   */
  readTable(host: string, tableId: string, options: TableReadOptions): Promise<TableRead>;

  /**
   * One custom table's definition alone, with no rows (`table.get`, the client's own workspace,
   * which `host` names), for checking a request before any row is read. NOT_FOUND, as `readTable`
   * says it, for a table that is missing or not readable. Its personal columns are included and
   * marked; the caller projects them out.
   */
  readTableDefinition(host: string, tableId: string): Promise<TableRecordSchema>;

  /**
   * One row and its table, read the same way through `inferops://<host>/object/record-card/<id>`.
   * The caller checks that the row belongs to its table; `rows` holds exactly that row.
   */
  readTableRow(host: string, recordId: string): Promise<TableRead>;

  /**
   * The members of the client's own workspace, as InferOps' `member.list` answers it under the
   * account's `member:read` there. `workspaceId`, when given, is the workspace the answer must be
   * about; an answer about any other is refused. NOT_FOUND when the list is missing or not readable
   * (no grant, no `member:read`, an explicit deny), without saying which.
   */
  listWorkspaceMembers(workspaceId?: string): Promise<WorkspaceMembersRead>;

  /**
   * Whether the account holds `permission` in the client's own workspace, as InferOps'
   * `auth.permissions` decides it there (the grant's role, its denies, any assumption ceiling).
   * A refusal of the question itself (no grant in the workspace, 403 or 404) is false.
   */
  holdsPermission(permission: string): Promise<boolean>;

  /**
   * Lists one published widget version in the client's own workspace, for the account's whole
   * company, as InferOps' `widget.publish` (FAC-11): a pointer to the InferOS Blueprint version, its
   * title and purpose, and nothing else. Writing the same version again replaces it, so a retry is
   * one definition. InferOps refuses an account without `configuration:publish` there (FORBIDDEN).
   */
  publishWidgetDefinition(entry: WidgetDefinitionWrite): Promise<void>;

  /**
   * Removes one widget version's listing from the client's own workspace, as InferOps'
   * `widget.withdraw`: true when InferOps removed one, false when there was none to remove.
   * Refused as `publishWidgetDefinition` is.
   */
  withdrawWidgetDefinition(sourceId: string, sourceVersion: number): Promise<boolean>;

  /**
   * The widgets the person may use in the client's own workspace that match `query`, their intent
   * in their own words, as InferOps' `widget.search` (FAC-13): built-in kinds and published widget
   * definitions, best first, at most `k` of each. Definitions only, never an instance or a record.
   * An InferOps without it (404) or an outage is UNAVAILABLE, never "nothing found".
   */
  searchWidgets(query: string, k: number): Promise<WidgetSearchResult>;

  /**
   * The published content-workflow policy head of the project with key `projectKey`, as InferOps'
   * `workflow.get` answers it under the account's `project:read`: the key is resolved through the
   * project list of the client's own workspace first, then that one project's head is read and
   * parsed strictly (workflow-policy.ts). NOT_FOUND when the project or its policy is missing or not
   * readable, without saying which; UNAVAILABLE when the answer is malformed or not about that project.
   */
  readWorkflowPolicy(projectKey: string): Promise<WorkflowHeadRecord>;

  /** Whether the account can open the project; used to admit observers of a shared gadget. */
  hasProject(projectKey: string): Promise<boolean>;

  /** Delete everything held for this account (the mock's data; nothing for a remote service). */
  forget(): Promise<void>;
}

/** The most recent activity entries an issue's `activity()` returns. */
export const ISSUE_ACTIVITY_LIMIT = 100;

/** The longest comment or value an activity entry keeps; a longer one is shortened and marked. */
export const ACTIVITY_TEXT_MAX = 2000;

/** One `issue.history` entry as InferOps returns it (only the fields the gatekeeper reads). */
export interface HistoryEntryRecord {
  kind: "claim" | "comment";
  at: string;
  actorType: "user" | "service_account" | "system" | null;
  field: string | null;
  value: unknown;
  body: string | null;
}

const ACTORS = { user: "person", service_account: "agent", system: "system" } as const;

const shorten = (text: string | null): { text: string | null; shortened: boolean } =>
  text !== null && text.length > ACTIVITY_TEXT_MAX
    ? { text: text.slice(0, ACTIVITY_TEXT_MAX), shortened: true }
    : { text, shortened: false };

/** One history record as an activity entry, its long text already shortened. */
export function toActivityEntry(entry: HistoryEntryRecord): IssueActivityEntry {
  const value = entry.kind === "claim"
    ? shorten(typeof entry.value === "string" ? entry.value : entry.value == null ? null : JSON.stringify(entry.value))
    : { text: null, shortened: false };
  const body = entry.kind === "comment" ? shorten(entry.body) : { text: null, shortened: false };
  return {
    kind: entry.kind === "claim" ? "change" : "comment",
    at: entry.at,
    actor: entry.actorType ? ACTORS[entry.actorType] : null,
    field: entry.kind === "claim" ? entry.field : null,
    value: value.text,
    body: body.text,
    shortened: value.shortened || body.shortened,
  };
}

/**
 * The newest ISSUE_ACTIVITY_LIMIT of a history read oldest first, as it streams in: `add` keeps a
 * rolling window of already-shortened entries, so however long the history, what is held stays
 * within ISSUE_ACTIVITY_LIMIT entries of ACTIVITY_TEXT_MAX characters each. `result` is newest first.
 * Who acted is reduced to person, agent or system; no principal id is kept.
 */
export class ActivityWindow {
  #kept: IssueActivityEntry[] = [];
  #seen = 0;

  add(records: readonly HistoryEntryRecord[]): void {
    for (const record of records) {
      this.#seen++;
      this.#kept.push(toActivityEntry(record));
      if (this.#kept.length > ISSUE_ACTIVITY_LIMIT) this.#kept.shift();
    }
  }

  result(): IssueActivity {
    return { entries: this.#kept.toReversed(), omitted: this.#seen - this.#kept.length };
  }
}

/** A whole history at once, oldest first (the mock's), as `activity()` returns it. */
export function toIssueActivity(oldestFirst: readonly HistoryEntryRecord[]): IssueActivity {
  const window = new ActivityWindow();
  window.add(oldestFirst);
  return window.result();
}
