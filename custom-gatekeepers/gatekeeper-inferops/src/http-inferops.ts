// LIVE InferOps data source: `InferOpsClient` over the InferOps HTTP API (the contract in
// docs/design/inferops-gatekeeper.md). The only module that talks HTTP.
//
// - Every response is parsed field by field; nothing is cast. A response that does not match is a
//   provider failure (`UNAVAILABLE`), never partial data.
// - InferOps authorizes an issue read, transition or update against the workspace, not a project,
//   so this client checks the issue's `projectId` against the bound project itself before every
//   one, and answers an issue of another project exactly as an unknown one. A create names the
//   bound project's UUID, resolved from its key on every use.
// - Every write carries `X-Idempotency-Key`. InferOps replays a known key per operation but does
//   not compare bodies; the gatekeeper's action fingerprint (actions.ts) is what keeps one key to
//   one request.
// - The board response also lists every workspace project and each card's lease and run, and the
//   issue response the description and comments; the parsers copy only the `Issue` fields.
// - Coding runs carry an issue id, not a project: a run is in scope only when its issue is, checked
//   the same way, and a run of another project is answered exactly as an unknown one. The runs list
//   is the workspace's, filtered here to the bound project's issues.
// - `listWorkspaceSlugs` reads the workspace slugs a connect stores beside the person's memberships
//   (`GET /workspaces`), since a resource URL names a workspace by slug.
// - The InferMind Wiki (`/knowledge/*`) is workspace-scoped by InferOps itself (row-level security on
//   the workspace header), so no extra scope check is made. Its responses are bare (no envelope),
//   a missing page or section is answered `200 null` (or an empty body), and a 403 means either
//   that the workspace is not an InferMind workspace or that the person lacks `knowledge:*`;
//   InferOps says which only in its message text, which is not read, so both get one message.
// - Nothing here logs a token, a header or a body, and InferOps' own error text is never passed on:
//   failures are reported by operation name, status and code.
//
// Two ways to be authorized (see `clientFor` in inferops.ts):
// - A connected account's own InferOps token and workspace (`InferOpsAuthorizedEndpoint`): the
//   authority is fetched per request, so a refreshed or replaced token is picked up and a rejected
//   one is adjudicated by the account before the gatekeeper gives up on it.
// - STOPGAP: a connection from worker vars (`connectionFromEnv`), shared by every account of the
//   deployment. Local development only; it never backs a connected person.

import { createLogger } from "@gadgets/observability/logger";
import {
  InferOpsError, type DispatchRequest, type InferOpsClient, type InferOpsErrorCode,
  type IssueChanges, type NewIssueRequest, type ProjectSnapshot, type ProjectSummary,
  type RepoRecord, type RunRecord, type WikiDocumentHead, type WikiDocumentRecord,
  type WikiSectionRecord,
} from "./inferops-client";
import { isSlug } from "./resources";
import type {
  Issue, Project, Revision, RunPatch, RunReasonCode, RunResult, RunStatus, RunTestCommand, RunTests,
  State, StateGroup, Workflow,
} from "./types";

type LogFields = { vendorId: string; operation: string; status: number; code: string };
const logger = createLogger<LogFields>({ component: "gatekeeper.inferops.http", vendorId: "inferops" });

/** Where the client calls InferOps. */
export type InferOpsEndpoint = {
  /** API base URL without a trailing slash. */
  baseUrl: string;
  /** The base URL's host (with port), for display only: a resource URL never names a deployment. */
  host: string;
};

/** As whom one request is made: a bearer token and the workspace it is made in. Never logged. */
export type InferOpsAuthority = { token: string; workspaceId: string };

/**
 * Runs one request under the current authority. The account's credential source implements it:
 * it fetches (and refreshes) the token, and when InferOps rejects it, asks the account whether the
 * grant is dead before failing the request.
 */
export type Authorize = <T>(operation: (authority: InferOpsAuthority) => Promise<T>) => Promise<T>;

/** An endpoint whose authority is fetched per request: a connected person's own token. */
export type InferOpsAuthorizedEndpoint = InferOpsEndpoint & { authorize: Authorize };

/**
 * Where and as whom the stopgap client calls InferOps: one fixed credential, and the slug of its
 * workspace, which is the `<workspace>` a resource URL must name to use it.
 */
export type InferOpsConnection = InferOpsEndpoint & InferOpsAuthority & { workspaceSlug: string };

/** The worker vars that configure the API endpoint and the stopgap connection. */
export type InferOpsConnectionVars = {
  INFEROPS_BASE_URL?: string;
  INFEROPS_API_TOKEN?: string;
  INFEROPS_WORKSPACE_ID?: string;
  INFEROPS_WORKSPACE_SLUG?: string;
};

/** Normalizes an API base URL, or throws naming the variable (never its value). */
export function parseInferOpsBaseUrl(raw: string, name: string): InferOpsEndpoint {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${name} must be an http(s) URL.`);
  }
  return { baseUrl: (url.origin + url.pathname).replace(/\/+$/, ""), host: url.host };
}

/**
 * The API endpoint configured through `INFEROPS_BASE_URL`, or null when unset. Connected accounts
 * call it with their own authority; it needs no token of its own.
 */
export function endpointFromEnv(env: InferOpsConnectionVars): InferOpsEndpoint | null {
  return env.INFEROPS_BASE_URL ? parseInferOpsBaseUrl(env.INFEROPS_BASE_URL, "INFEROPS_BASE_URL") : null;
}

/**
 * The stopgap connection configured through worker vars, or null when `INFEROPS_API_TOKEN` is
 * unset. A token without its base URL, workspace id or workspace slug throws, naming the missing
 * variable, rather than silently serving demo data. Local-development stopgap; see the module
 * comment.
 */
export function connectionFromEnv(env: InferOpsConnectionVars): InferOpsConnection | null {
  if (!env.INFEROPS_API_TOKEN) return null;
  for (const name of ["INFEROPS_BASE_URL", "INFEROPS_WORKSPACE_ID", "INFEROPS_WORKSPACE_SLUG"] as const) {
    if (!env[name]) throw new Error(`INFEROPS_API_TOKEN is set but ${name} is not.`);
  }
  const workspaceSlug = env.INFEROPS_WORKSPACE_SLUG!.trim();
  if (!isSlug(workspaceSlug)) throw new Error("INFEROPS_WORKSPACE_SLUG is not a workspace slug.");
  return {
    ...parseInferOpsBaseUrl(env.INFEROPS_BASE_URL!, "INFEROPS_BASE_URL"),
    token: env.INFEROPS_API_TOKEN,
    workspaceId: env.INFEROPS_WORKSPACE_ID!,
    workspaceSlug,
  };
}

const REQUEST_TIMEOUT_MS = 15_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVISION = /^\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const WIRE_CODE = /^[A-Z_]{1,40}$/;

const STATE_GROUPS: readonly StateGroup[] = ["backlog", "unstarted", "started", "completed", "cancelled"];
const WORKFLOWS: readonly Workflow[] = ["content", "software"];
const PRIORITIES: readonly Issue["priority"][] = ["urgent", "high", "medium", "low", "none"];
const RUN_STATUSES: readonly RunStatus[] = ["queued", "running", "succeeded", "failed", "cancelled", "unknown"];
const RUN_REASON_CODES: readonly RunReasonCode[] = ["AUTH_BLOCKED", "QUOTA_BLOCKED", "TESTS_FAILED"];
/** InferOps' own bound on the test commands one run reports. */
const RUN_TEST_COMMANDS_MAX = 100;
/** How many of the workspace's newest runs `listRuns` reads before keeping the project's. */
const RUN_LIST_LIMIT = 200;

// One message for "no such issue" and "issue of another project", so a caller cannot probe.
function issueNotFound(): InferOpsError {
  return new InferOpsError("NOT_FOUND", "No such issue in this project.");
}

/** The one message for a Wiki call InferOps refused with 403, whichever of the two causes it was. */
export const WIKI_FORBIDDEN =
  "InferOps refused the Wiki for this connection: the workspace is not an InferMind workspace, or " +
  "your access lacks knowledge permission (knowledge:read to read, knowledge:write to edit).";

function documentNotFound(): InferOpsError {
  return new InferOpsError("NOT_FOUND", "No such page in this Wiki.");
}

function sectionNotFound(): InferOpsError {
  return new InferOpsError("NOT_FOUND", "No such section in this Wiki.");
}

// The same for runs: an unknown run and a run of another project's issue read alike.
function runNotFound(): InferOpsError {
  return new InferOpsError("NOT_FOUND", "No such run in this project.");
}

// ---------------------------------------------------------------------------
// Response parsing. Each parser copies the fields it names and nothing else.

class Malformed extends Error {}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Malformed(`${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

function list(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new Malformed(`${what} is not an array`);
  return value;
}

function text(value: unknown, what: string, pattern?: RegExp): string {
  if (typeof value !== "string" || (pattern && !pattern.test(value))) {
    throw new Malformed(`${what} is not valid`);
  }
  return value;
}

function nullable(value: unknown, what: string, pattern?: RegExp): string | null {
  return value === null ? null : text(value, what, pattern);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  const match = allowed.find(candidate => candidate === value);
  if (match === undefined) throw new Malformed(`${what} is not valid`);
  return match;
}

function parseProject(value: unknown): Project {
  const project = record(value, "project");
  return {
    id: text(project.id, "project.id", UUID),
    identifier: text(project.identifier, "project.identifier"),
    name: text(project.name, "project.name"),
  };
}

function parseProjects(body: unknown): Project[] {
  return list(record(body, "response").projects, "projects").map(parseProject);
}

function parseState(value: unknown): State {
  const state = record(value, "state");
  if (typeof state.position !== "number" || !Number.isInteger(state.position)) {
    throw new Malformed("state.position is not valid");
  }
  return {
    id: text(state.id, "state.id", UUID),
    name: text(state.name, "state.name"),
    group: oneOf(state.group, STATE_GROUPS, "state.group"),
    position: state.position,
    workflow: oneOf(state.workflow, WORKFLOWS, "state.workflow"),
  };
}

/** The card fields of an issue; lease, run, description, comments and the rest are dropped. */
function parseIssue(value: unknown): Issue {
  const issue = record(value, "issue");
  return {
    id: text(issue.id, "issue.id", UUID),
    identifier: text(issue.identifier, "issue.identifier"),
    title: text(issue.title, "issue.title"),
    priority: oneOf(issue.priority, PRIORITIES, "issue.priority"),
    stateId: text(issue.stateId, "issue.stateId", UUID),
    targetDate: nullable(issue.targetDate, "issue.targetDate", DATE),
    workflow: oneOf(issue.workflow, WORKFLOWS, "issue.workflow"),
    revision: text(issue.revision, "issue.revision", REVISION),
    assigneeId: nullable(issue.assigneeId, "issue.assigneeId", UUID),
    blockedReason: nullable(issue.blockedReason, "issue.blockedReason"),
  };
}

function int(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Malformed(`${what} is not valid`);
  return value;
}

/** A listed Wiki page; `summary`, `pathway` and the rest are dropped. */
function parseDocument(value: unknown): WikiDocumentRecord {
  const document = record(value, "document");
  return {
    id: text(document.id, "document.id", UUID).toLowerCase(),
    slug: text(document.slug, "document.slug"),
    title: text(document.title, "document.title"),
    parentId: nullable(document.parentId, "document.parentId", UUID)?.toLowerCase() ?? null,
    siblingOrder: int(document.siblingOrder, "document.siblingOrder"),
  };
}

/** A section; nothing else of InferOps' is on it. */
function parseSection(value: unknown): WikiSectionRecord {
  const section = record(value, "section");
  return {
    id: text(section.id, "section.id", UUID).toLowerCase(),
    documentId: text(section.documentId, "section.documentId", UUID).toLowerCase(),
    tag: text(section.tag, "section.tag"),
    body: text(section.body, "section.body"),
    version: int(section.version, "section.version"),
  };
}

function parseRepo(value: unknown): RepoRecord {
  const repo = record(value, "repo");
  if (typeof repo.enabled !== "boolean") throw new Malformed("repo.enabled is not valid");
  return {
    id: text(repo.id, "repo.id", UUID).toLowerCase(),
    slug: text(repo.slug, "repo.slug"),
    defaultBaseRef: text(repo.defaultBaseRef, "repo.defaultBaseRef"),
    enabled: repo.enabled,
  };
}

const count = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0;

/**
 * The patch a result names, or undefined. The field is new in InferOps and still settling, so a
 * shape that does not match is left out rather than failing the whole run read.
 */
function parsePatch(value: unknown): RunPatch | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const patch = value as Record<string, unknown>;
  if (typeof patch.path !== "string" || typeof patch.sha256 !== "string" || !count(patch.files) ||
      !count(patch.insertions) || !count(patch.deletions)) {
    return undefined;
  }
  return {
    path: patch.path, sha256: patch.sha256, files: patch.files as number,
    insertions: patch.insertions as number, deletions: patch.deletions as number,
  };
}

function parseTestCommand(value: unknown): RunTestCommand | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const command = value as Record<string, unknown>;
  const artifacts = command.artifacts as Record<string, unknown> | null | undefined;
  if (!count(command.index) || (command.index as number) < 1 || !Array.isArray(command.argv) ||
      command.argv.length === 0 || !command.argv.every(arg => typeof arg === "string") ||
      !(command.exitCode === null || (typeof command.exitCode === "number" && Number.isInteger(command.exitCode))) ||
      typeof command.timedOut !== "boolean" || !count(command.durationMs) || typeof command.truncated !== "boolean" ||
      typeof artifacts !== "object" || artifacts === null || typeof artifacts.stdout !== "string" ||
      typeof artifacts.stderr !== "string" || typeof artifacts.record !== "string") {
    return undefined;
  }
  return {
    index: command.index as number, argv: [...command.argv as string[]], exitCode: command.exitCode as number | null,
    timedOut: command.timedOut, durationMs: command.durationMs as number, truncated: command.truncated,
    artifacts: { stdout: artifacts.stdout, stderr: artifacts.stderr, record: artifacts.record },
  };
}

/**
 * The test evidence a result names, or undefined. Like the patch it is new in InferOps, so a shape
 * that does not match is left out whole: a partial copy would misstate what ran.
 */
function parseTests(value: unknown): RunTests | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const tests = value as Record<string, unknown>;
  if (typeof tests.directory !== "string" || !count(tests.passed) || !count(tests.failed) ||
      !Array.isArray(tests.commands) || tests.commands.length > RUN_TEST_COMMANDS_MAX) {
    return undefined;
  }
  const commands = tests.commands.map(parseTestCommand);
  if (commands.some(command => command === undefined)) return undefined;
  return {
    directory: tests.directory, passed: tests.passed as number, failed: tests.failed as number,
    commands: commands as RunTestCommand[],
  };
}

/** A run's result: the summary is required; the optional fields are copied only when well formed. */
function parseResult(value: unknown): RunResult | null {
  if (value === null) return null;
  const result = record(value, "run.result");
  const optional = (key: "branch" | "commitSha" | "prUrl" | "testSummary") =>
    typeof result[key] === "string" ? { [key]: result[key] } : {};
  const patch = parsePatch(result.patch);
  const tests = parseTests(result.tests);
  // An unknown reason is left out rather than guessed at; the run's status still says how it ended.
  const reasonCode = RUN_REASON_CODES.find(code => code === result.reasonCode);
  return {
    summary: text(result.summary, "run.result.summary"),
    ...optional("testSummary"), ...(patch ? { patch } : {}), ...(tests ? { tests } : {}),
    ...(reasonCode ? { reasonCode } : {}),
    ...optional("branch"), ...optional("commitSha"), ...optional("prUrl"),
  };
}

/** A run, before its issue's key is known; requestedBy, the lease generation and the rest are dropped. */
function parseRun(value: unknown): Omit<RunRecord, "issueIdentifier"> {
  const run = record(value, "run");
  return {
    id: text(run.id, "run.id", UUID).toLowerCase(),
    issueId: text(run.issueId, "run.issueId", UUID).toLowerCase(),
    repoId: text(run.repoId, "run.repoId", UUID).toLowerCase(),
    status: oneOf(run.status, RUN_STATUSES, "run.status"),
    baseRef: nullable(run.baseRef, "run.baseRef"),
    externalRunId: nullable(run.externalRunId, "run.externalRunId"),
    result: parseResult(run.result),
    error: nullable(run.error, "run.error"),
    queuedAt: text(run.queuedAt, "run.queuedAt"),
    startedAt: nullable(run.startedAt, "run.startedAt"),
    finishedAt: nullable(run.finishedAt, "run.finishedAt"),
  };
}

/** A board response for `project`: its states and issues only, never the workspace project list. */
function parseBoard(body: unknown, project: Project): ProjectSnapshot {
  const board = record(body, "response");
  if (board.projectId !== project.id) throw new Malformed("the board is not the requested project's");
  const states: State[] = [];
  const issues: Issue[] = [];
  for (const value of list(board.columns, "columns")) {
    const column = record(value, "column");
    const state = parseState(column.state);
    states.push(state);
    for (const card of list(column.issues, "column.issues")) {
      const issue = parseIssue(card);
      if (issue.stateId !== state.id) throw new Malformed("an issue is in the wrong column");
      issues.push(issue);
    }
  }
  return { project, states, issues };
}

/** The InferOps error code of an error body, when it has a well-formed one. */
function wireCode(body: unknown): string | null {
  try {
    return text(record(record(body, "response").error, "error").code, "error.code", WIRE_CODE);
  } catch {
    return null;
  }
}

/** Whether a 403 body is a workflow-policy refusal (`details.decision`) rather than a permission. */
function isPolicyRefusal(body: unknown): boolean {
  try {
    const details = record(record(record(body, "response").error, "error").details, "details");
    return "decision" in details;
  } catch {
    return false;
  }
}

const POLICY_REFUSED = "InferOps' workflow policy does not allow this change.";

const FAILURE_DETAIL: Record<InferOpsErrorCode, string> = {
  NOT_FOUND: "InferOps has no such item.",
  STALE_REVISION: "The issue changed in InferOps. Read it again.",
  WORKFLOW_MISMATCH: "The target state belongs to another workflow than the issue.",
  INVALID_STATE: "The target state is not part of this project.",
  IDEMPOTENCY_CONFLICT: "This idempotency key was already used for a different change.",
  INVALID_REQUEST: "InferOps rejected the request as malformed.",
  CONFLICT: "InferOps refused the change in the issue's current condition.",
  RUN_ACTIVE: "The issue already has a queued or running coding run.",
  UNAUTHORIZED: "InferOps rejected this connection's credential. Reconnect InferOps.",
  FORBIDDEN: "This connection is not permitted to do that in InferOps.",
  UNAVAILABLE: "InferOps could not be reached or returned an unusable response.",
  // Never mapped from a response: the gatekeeper raises it itself (enablement.ts).
  DISABLED: "InferOps is turned off for this deployment.",
};

/** The gatekeeper code for a failed response, from its status and InferOps error code. */
function failureCode(status: number, code: string | null): InferOpsErrorCode {
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) {
    return code === "STALE_REVISION" || code === "WORKFLOW_MISMATCH" || code === "RUN_ACTIVE"
      ? code : "CONFLICT";
  }
  if (status === 400) return "INVALID_REQUEST";
  return "UNAVAILABLE";
}

/** Parse a successful body; a shape mismatch is a provider failure. */
function parsed<T>(operation: string, body: unknown, parse: (body: unknown) => T): T {
  try {
    return parse(body);
  } catch (error) {
    if (!(error instanceof Malformed)) throw error;
    // The message names a field, never its value.
    logger.error("InferOps response did not match the contract", {
      event: "http.response.malformed", operation, error,
    });
    throw new InferOpsError("UNAVAILABLE", FAILURE_DETAIL.UNAVAILABLE);
  }
}

/** One workspace of the caller's tenant, as `GET /workspaces` lists it: its id and its slug. */
export type WorkspaceSlug = { workspaceId: string; slug: string };

/**
 * The slugs of the workspaces `token` can list (`GET /workspaces`, InferLab's principal lane, so
 * no workspace header). Slugs are what a resource URL names; the caller maps them onto the
 * memberships it already holds and never widens those. Throws an `InferOpsError` like every
 * request, `UNAVAILABLE` for a response that does not match.
 */
export async function listWorkspaceSlugs(baseUrl: string, token: string,
                                         fetcher: typeof fetch = fetch): Promise<WorkspaceSlug[]> {
  const operation = "workspace.list";
  let response: Response;
  try {
    response = await fetcher(`${baseUrl}/workspaces`, {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    logger.warn("InferOps request failed", {
      event: "http.request.failed", operation, status: 0, code: "UNAVAILABLE", error,
    });
    throw new InferOpsError("UNAVAILABLE", FAILURE_DETAIL.UNAVAILABLE);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (!response.ok || body === undefined) {
    const code = response.ok ? "UNAVAILABLE" : failureCode(response.status, wireCode(body));
    logger.warn("InferOps request failed", {
      event: "http.request.failed", operation, status: response.status, code,
    });
    throw new InferOpsError(code, FAILURE_DETAIL[code]);
  }
  return parsed(operation, body, raw => list(raw, "workspaces").map(value => {
    const workspace = record(value, "workspace");
    const slug = text(workspace.slug, "workspace.slug");
    if (!isSlug(slug)) throw new Malformed("workspace.slug is not valid");
    return { workspaceId: text(workspace.id, "workspace.id", UUID).toLowerCase(), slug };
  }));
}

// ---------------------------------------------------------------------------
// Client

type Send = {
  method: "GET" | "POST" | "PATCH"; path: string; body?: unknown; idempotencyKey?: string;
  /** A successful response may have no body (InferOps' answer for a missing Wiki item). */
  maybeEmpty?: boolean;
};

/**
 * The InferOps HTTP data source for one connection: a fixed credential, or an endpoint whose
 * authority is fetched per request. `fetcher` is injectable for tests. Project keys are resolved to
 * ids through the project list on every use, so scope always follows what the connection can see
 * now.
 */
export function openHttpInferOpsClient(
  connection: InferOpsConnection | InferOpsAuthorizedEndpoint, fetcher: typeof fetch = fetch,
): InferOpsClient {
  const authorize: Authorize = "authorize" in connection
    ? connection.authorize
    : operation => operation({ token: connection.token, workspaceId: connection.workspaceId });

  /** Send one request and return its parsed JSON body, or throw the mapped `InferOpsError`. */
  function request(operation: string, send: Send): Promise<unknown> {
    return authorize(authority => sendAs(authority, operation, send));
  }

  async function sendAs(authority: InferOpsAuthority, operation: string, send: Send):
      Promise<unknown> {
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${authority.token}`,
      "x-workspace-id": authority.workspaceId,
    };
    if (send.body !== undefined) headers["content-type"] = "application/json";
    if (send.idempotencyKey) headers["x-idempotency-key"] = send.idempotencyKey;

    const unavailable = (status: number, error?: unknown) => {
      logger.warn("InferOps request failed", {
        event: "http.request.failed", operation, status, code: "UNAVAILABLE", error,
      });
      return new InferOpsError("UNAVAILABLE", FAILURE_DETAIL.UNAVAILABLE);
    };

    let response: Response;
    try {
      response = await fetcher(connection.baseUrl + send.path, {
        method: send.method,
        headers,
        body: send.body === undefined ? undefined : JSON.stringify(send.body),
        // A redirect is never followed: it would carry the credential to wherever it points.
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw unavailable(0, error);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      const wire = wireCode(body);
      const code = failureCode(response.status, wire);
      logger.warn("InferOps request failed", {
        event: "http.request.failed", operation, status: response.status, code: wire ?? code,
      });
      const policy = code === "FORBIDDEN" && isPolicyRefusal(body);
      throw new InferOpsError(code, policy ? POLICY_REFUSED : FAILURE_DETAIL[code]);
    }
    if (body === undefined) {
      if (send.maybeEmpty) return null;
      throw unavailable(response.status);
    }
    return body;
  }

  /** A Wiki request: a 403 gets the one Wiki message, whichever cause InferOps had. */
  async function knowledge(operation: string, send: Send): Promise<unknown> {
    try {
      return await request(operation, send);
    } catch (error) {
      if (error instanceof InferOpsError && error.code === "FORBIDDEN") {
        throw new InferOpsError("FORBIDDEN", WIKI_FORBIDDEN);
      }
      throw error;
    }
  }

  async function readDocument(documentId: string): Promise<WikiDocumentHead> {
    // Also keeps anything that is not an id out of the request path (InferOps answers one with 500).
    if (!UUID.test(documentId)) throw documentNotFound();
    const body = await knowledge("wiki.document.get", {
      method: "GET", path: `/knowledge/documents/${documentId}`, maybeEmpty: true,
    });
    if (body === null) throw documentNotFound();
    return parsed("wiki.document.get", body, raw => {
      const { id, slug, title } = parseDocument(raw);
      if (id !== documentId.toLowerCase()) throw new Malformed("another document was returned");
      return { id, slug, title };
    });
  }

  async function readSection(sectionId: string): Promise<WikiSectionRecord> {
    if (!UUID.test(sectionId)) throw sectionNotFound();
    const body = await knowledge("wiki.section.get", {
      method: "GET", path: `/knowledge/sections/${sectionId}`, maybeEmpty: true,
    });
    if (body === null) throw sectionNotFound();
    return parsed("wiki.section.get", body, raw => {
      const section = parseSection(raw);
      if (section.id !== sectionId.toLowerCase()) throw new Malformed("another section was returned");
      return section;
    });
  }

  async function projects(): Promise<Project[]> {
    const body = await request("project.list", { method: "GET", path: "/project/projects" });
    return parsed("project.list", body, parseProjects);
  }

  async function project(projectKey: string): Promise<Project> {
    const found = (await projects()).find(p => p.identifier === projectKey);
    if (!found) throw new InferOpsError("NOT_FOUND", `No such project: ${projectKey}.`);
    return found;
  }

  /** The issue, provided it belongs to `projectKey`'s project; otherwise the one NOT_FOUND. */
  async function readIssue(projectKey: string, issueId: string): Promise<Issue> {
    // Also keeps anything that is not an id out of the request path.
    if (!UUID.test(issueId)) throw issueNotFound();
    const bound = await project(projectKey);
    let body: unknown;
    try {
      body = await request("issue.get", { method: "GET", path: `/project/issues/${issueId}` });
    } catch (error) {
      if (error instanceof InferOpsError && error.code === "NOT_FOUND") throw issueNotFound();
      throw error;
    }
    const { issue, projectId } = parsed("issue.get", body, raw => {
      const detail = record(raw, "response").issue;
      return {
        issue: parseIssue(detail),
        projectId: text(record(detail, "issue").projectId, "issue.projectId", UUID),
      };
    });
    if (projectId !== bound.id || issue.id.toLowerCase() !== issueId.toLowerCase()) {
      throw issueNotFound();
    }
    return issue;
  }

  /** The run, provided its issue belongs to `projectKey`'s project; otherwise the one NOT_FOUND. */
  async function readRun(projectKey: string, runId: string): Promise<RunRecord> {
    if (!UUID.test(runId)) throw runNotFound();
    let body: unknown;
    try {
      body = await request("run.get", { method: "GET", path: `/project/runs/${runId}` });
    } catch (error) {
      if (error instanceof InferOpsError && error.code === "NOT_FOUND") throw runNotFound();
      throw error;
    }
    const run = parsed("run.get", body, raw => {
      const found = parseRun(record(raw, "response").run);
      if (found.id !== runId.toLowerCase()) throw new Malformed("another run was returned");
      return found;
    });
    // InferOps would hand out a run of any project in the workspace; its issue decides here.
    let issue: Issue;
    try {
      issue = await readIssue(projectKey, run.issueId);
    } catch (error) {
      if (error instanceof InferOpsError && error.code === "NOT_FOUND") throw runNotFound();
      throw error;
    }
    return { ...run, issueIdentifier: issue.identifier };
  }

  return {
    async listProjects(): Promise<ProjectSummary[]> {
      return (await projects()).map(({ identifier, name }) => ({ identifier, name }));
    },

    async hasProject(projectKey: string): Promise<boolean> {
      return (await projects()).some(p => p.identifier === projectKey);
    },

    async readProject(projectKey: string): Promise<ProjectSnapshot> {
      const bound = await project(projectKey);
      const body = await request("project.board", {
        method: "GET", path: `/project/board?projectId=${bound.id}`,
      });
      return parsed("project.board", body, raw => parseBoard(raw, bound));
    },

    readIssue,

    async transition(
      projectKey: string, issueId: string, toStateId: string, expectedRevision: Revision,
      idempotencyKey: string,
    ): Promise<Issue> {
      if (!idempotencyKey) throw new InferOpsError("INVALID_REQUEST", "An idempotency key is required.");
      if (!REVISION.test(expectedRevision)) {
        throw new InferOpsError("INVALID_REQUEST", "The expected revision must be a decimal string.");
      }
      if (!UUID.test(toStateId)) throw new InferOpsError("INVALID_STATE", FAILURE_DETAIL.INVALID_STATE);
      // InferOps would move an issue of any project in the workspace; refuse it here first.
      await readIssue(projectKey, issueId);
      let body: unknown;
      try {
        body = await request("issue.transition", {
          method: "POST",
          path: `/project/issues/${issueId}/transition`,
          body: { toStateId, expectedRevision },
          idempotencyKey,
        });
      } catch (error) {
        // InferOps answers a deleted issue and a state outside the issue's project alike.
        if (error instanceof InferOpsError && error.code === "NOT_FOUND") {
          throw new InferOpsError(
            "NOT_FOUND", "The issue or the target state is no longer in this project.");
        }
        throw error;
      }
      return parsed("issue.transition", body, raw => {
        const moved = parseIssue(record(raw, "response").issue);
        if (moved.id.toLowerCase() !== issueId.toLowerCase()) {
          throw new Malformed("another issue was returned");
        }
        return moved;
      });
    },

    async createIssue(projectKey: string, issue: NewIssueRequest, idempotencyKey: string):
        Promise<Issue> {
      if (!idempotencyKey) throw new InferOpsError("INVALID_REQUEST", "An idempotency key is required.");
      if (!UUID.test(issue.stateId)) throw new InferOpsError("INVALID_STATE", FAILURE_DETAIL.INVALID_STATE);
      const bound = await project(projectKey);
      let body: unknown;
      try {
        body = await request("issue.create", {
          method: "POST",
          path: "/project/issues",
          // Only the named fields, so nothing else of the caller's can reach InferOps.
          body: {
            projectId: bound.id, title: issue.title, description: issue.description,
            priority: issue.priority, stateId: issue.stateId, workflow: issue.workflow,
          },
          idempotencyKey,
        });
      } catch (error) {
        if (error instanceof InferOpsError && error.code === "NOT_FOUND") {
          throw new InferOpsError("NOT_FOUND", "The project or the target state is no longer available.");
        }
        throw error;
      }
      return parsed("issue.create", body, raw => parseIssue(record(raw, "response").issue));
    },

    async updateIssue(
      projectKey: string, issueId: string, changes: IssueChanges, expectedRevision: Revision,
      idempotencyKey: string,
    ): Promise<Issue> {
      if (!idempotencyKey) throw new InferOpsError("INVALID_REQUEST", "An idempotency key is required.");
      if (!REVISION.test(expectedRevision)) {
        throw new InferOpsError("INVALID_REQUEST", "The expected revision must be a decimal string.");
      }
      const { title, description, priority } = changes;
      if (title === undefined && description === undefined && priority === undefined) {
        throw new InferOpsError("INVALID_REQUEST", "An update must change at least one field.");
      }
      // InferOps would update an issue of any project in the workspace; refuse it here first.
      await readIssue(projectKey, issueId);
      let body: unknown;
      try {
        body = await request("issue.update", {
          method: "PATCH",
          path: `/project/issues/${issueId}`,
          body: { title, description, priority, expectedRevision },
          idempotencyKey,
        });
      } catch (error) {
        if (error instanceof InferOpsError && error.code === "NOT_FOUND") throw issueNotFound();
        throw error;
      }
      return parsed("issue.update", body, raw => {
        const updated = parseIssue(record(raw, "response").issue);
        if (updated.id.toLowerCase() !== issueId.toLowerCase()) {
          throw new Malformed("another issue was returned");
        }
        return updated;
      });
    },

    async listRepos(): Promise<RepoRecord[]> {
      const body = await request("repo.list", { method: "GET", path: "/project/repos" });
      return parsed("repo.list", body, raw => list(record(raw, "response").repos, "repos").map(parseRepo));
    },

    async listRuns(projectKey: string, issueId?: string): Promise<RunRecord[]> {
      // The project's issues and their keys: one issue (scope-checked), or the whole board.
      const keys = new Map<string, string>();
      if (issueId !== undefined) {
        const issue = await readIssue(projectKey, issueId);
        keys.set(issue.id.toLowerCase(), issue.identifier);
      } else {
        const bound = await project(projectKey);
        const board = await request("project.board", {
          method: "GET", path: `/project/board?projectId=${bound.id}`,
        });
        for (const issue of parsed("project.board", board, raw => parseBoard(raw, bound)).issues) {
          keys.set(issue.id.toLowerCase(), issue.identifier);
        }
      }
      const query = new URLSearchParams({ limit: String(RUN_LIST_LIMIT) });
      if (issueId !== undefined) query.set("issueId", issueId);
      const body = await request("run.list", { method: "GET", path: `/project/runs?${query}` });
      const runs = parsed("run.list", body, raw => list(record(raw, "response").runs, "runs").map(parseRun));
      return runs.flatMap(run => {
        const issueIdentifier = keys.get(run.issueId);
        return issueIdentifier === undefined ? [] : [{ ...run, issueIdentifier }];
      });
    },

    readRun,

    async dispatchIssue(
      projectKey: string, issueId: string, dispatch: DispatchRequest, idempotencyKey: string,
    ): Promise<RunRecord> {
      if (!idempotencyKey) throw new InferOpsError("INVALID_REQUEST", "An idempotency key is required.");
      if (!REVISION.test(dispatch.expectedRevision)) {
        throw new InferOpsError("INVALID_REQUEST", "The expected revision must be a decimal string.");
      }
      if (!UUID.test(dispatch.repoId)) {
        throw new InferOpsError("INVALID_REQUEST", "The repository id must be a UUID.");
      }
      // InferOps would dispatch an issue of any project in the workspace; refuse it here first.
      const issue = await readIssue(projectKey, issueId);
      let body: unknown;
      try {
        body = await request("issue.dispatch", {
          method: "POST",
          path: `/project/issues/${issueId}/dispatch`,
          // Only the named fields: the `code` action, the repository, the ref and the revision.
          body: {
            action: "code", repoId: dispatch.repoId, baseRef: dispatch.baseRef,
            expectedRevision: dispatch.expectedRevision,
          },
          idempotencyKey,
        });
      } catch (error) {
        if (error instanceof InferOpsError && error.code === "NOT_FOUND") throw issueNotFound();
        throw error;
      }
      return parsed("issue.dispatch", body, raw => {
        const run = parseRun(record(raw, "response").run);
        if (run.issueId !== issueId.toLowerCase()) throw new Malformed("a run of another issue was returned");
        return { ...run, issueIdentifier: issue.identifier };
      });
    },

    async cancelRun(projectKey: string, runId: string, idempotencyKey: string): Promise<RunRecord> {
      if (!idempotencyKey) throw new InferOpsError("INVALID_REQUEST", "An idempotency key is required.");
      // The run must be one of this project's before InferOps is asked to stop it.
      const current = await readRun(projectKey, runId);
      let body: unknown;
      try {
        body = await request("run.cancel", {
          method: "POST", path: `/project/runs/${runId}/cancel`, body: {}, idempotencyKey,
        });
      } catch (error) {
        if (error instanceof InferOpsError && error.code === "NOT_FOUND") throw runNotFound();
        throw error;
      }
      return parsed("run.cancel", body, raw => {
        const run = parseRun(record(raw, "response").run);
        if (run.id !== current.id) throw new Malformed("another run was returned");
        return { ...run, issueIdentifier: current.issueIdentifier };
      });
    },

    async listDocuments(): Promise<WikiDocumentRecord[]> {
      const body = await knowledge("wiki.document.list", { method: "GET", path: "/knowledge/documents" });
      return parsed("wiki.document.list", body, raw => list(raw, "documents").map(parseDocument));
    },

    readDocument,

    async listSections(documentId: string): Promise<WikiSectionRecord[]> {
      // The page first: InferOps answers sections of an unknown page with an empty list.
      const document = await readDocument(documentId);
      const body = await knowledge("wiki.section.list", {
        method: "GET", path: `/knowledge/sections?documentId=${document.id}`,
      });
      return parsed("wiki.section.list", body, raw => list(raw, "sections").map(value => {
        const section = parseSection(value);
        if (section.documentId !== document.id) throw new Malformed("a section of another document was returned");
        return section;
      }));
    },

    readSection,

    async updateSection(sectionId: string, body: string, idempotencyKey: string):
        Promise<WikiSectionRecord> {
      if (!idempotencyKey) throw new InferOpsError("INVALID_REQUEST", "An idempotency key is required.");
      // A section this workspace does not have is refused here: InferOps answers its PATCH with 500.
      await readSection(sectionId);
      const response = await knowledge("wiki.section.update", {
        method: "PATCH",
        path: `/knowledge/sections/${sectionId}`,
        // Only the body: the tag and the wikilink sidecar stay as they are.
        body: { body },
        idempotencyKey,
      });
      return parsed("wiki.section.update", response, raw => {
        const updated = parseSection(raw);
        if (updated.id !== sectionId.toLowerCase()) throw new Malformed("another section was returned");
        return updated;
      });
    },

    /** Nothing is held for a remote service. */
    async forget(): Promise<void> {},
  };
}
