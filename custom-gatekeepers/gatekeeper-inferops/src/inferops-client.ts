// The data-source contract the gatekeeper is written against. Today `mock-inferops.ts` implements it
// with seeded fixture data in a Durable Object; a real InferOps HTTP client replaces that one module
// (and the single `openInferOpsClient` import in inferops.ts) without touching the gatekeeper,
// sessions, simulation or approval code.

import type { Board, Issue, Project, Revision } from "./types";

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
  | "INVALID_REQUEST";

const ERROR_CODES: ReadonlySet<string> = new Set<InferOpsErrorCode>([
  "NOT_FOUND", "STALE_REVISION", "WORKFLOW_MISMATCH", "INVALID_STATE", "IDEMPOTENCY_CONFLICT",
  "INVALID_REQUEST",
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
   * Move an issue to another state of its project. Checks scope, state membership, workflow and the
   * expected revision, in that order, and increments the revision on success. A repeated
   * `idempotencyKey` for the same operation returns the stored result without applying it again;
   * for a different operation it fails with IDEMPOTENCY_CONFLICT.
   */
  transition(
    projectKey: string, issueId: string, toStateId: string, expectedRevision: Revision,
    idempotencyKey: string,
  ): Promise<Issue>;

  /** Whether the account can open the project; used to admit observers of a shared gadget. */
  hasProject(projectKey: string): Promise<boolean>;

  /** Delete everything held for this account (the mock's data; nothing for a remote service). */
  forget(): Promise<void>;
}
