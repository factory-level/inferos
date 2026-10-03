// The data-source contract the gatekeeper is written against. `mock-inferops.ts` implements it with
// seeded fixture data in a Durable Object (the default, and what the tests and the demo use);
// `http-inferops.ts` implements it over the InferOps HTTP API. `clientFor` in inferops.ts is the one
// place that chooses between them.

import type { Board, Issue, IssueChanges, Priority, Project, Repo, Revision, Run } from "./types";

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
  | "DISABLED";

const ERROR_CODES: ReadonlySet<string> = new Set<InferOpsErrorCode>([
  "NOT_FOUND", "STALE_REVISION", "WORKFLOW_MISMATCH", "INVALID_STATE", "IDEMPOTENCY_CONFLICT",
  "INVALID_REQUEST", "CONFLICT", "RUN_ACTIVE", "UNAUTHORIZED", "FORBIDDEN", "UNAVAILABLE", "DISABLED",
]);

/**
 * A data-source failure. The code leads the message (`STALE_REVISION: ...`) because Workers RPC
 * carries an error's message across a Durable Object boundary but not its custom properties, so
 * `inferOpsErrorCode()` recovers it on the far side.
 */
export class InferOpsError extends Error {
  constructor(readonly code: InferOpsErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "InferOpsError";
  }
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
  workflow?: "content";
};

/** Changed fields of an issue as the gatekeeper sends them (trimmed, unchanged ones dropped). */
export type { IssueChanges } from "./types";

/** A workspace repository as InferOps lists it; whether this deployment allows it is added later. */
export type RepoRecord = Omit<Repo, "allowed">;

/** A coding run of an issue of the bound project, with that issue's key. */
export type RunRecord = Omit<Run, "pending">;

/** What a dispatch sends: always the `code` action, a repository and the revision it was read at. */
export type DispatchRequest = { repoId: string; baseRef?: string; expectedRevision: Revision };

/** One project an account can reach, as listed for the resource picker. */
export type ProjectSummary = Pick<Project, "identifier" | "name">;

/**
 * The InferOps operations the gatekeeper needs, scoped to one InferOps account and host. Every
 * method takes the project key explicitly; the gatekeeper passes only the key bound into its own
 * props, so a caller can never widen scope through it.
 */
export interface InferOpsClient {
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

  /** Whether the account can open the project; used to admit observers of a shared gadget. */
  hasProject(projectKey: string): Promise<boolean>;

  /** Delete everything held for this account (the mock's data; nothing for a remote service). */
  forget(): Promise<void>;
}
