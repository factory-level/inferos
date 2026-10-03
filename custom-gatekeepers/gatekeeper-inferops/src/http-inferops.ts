// LIVE InferOps data source: `InferOpsClient` over the InferOps HTTP API (the contract in
// docs/design/inferops-gatekeeper.md). The only module that talks HTTP.
//
// - Every response is parsed field by field; nothing is cast. A response that does not match is a
//   provider failure (`UNAVAILABLE`), never partial data.
// - InferOps authorizes an issue read or transition against the workspace, not a project, so this
//   client checks the issue's `projectId` against the bound project itself, and answers an issue of
//   another project exactly as an unknown one.
// - The board response also lists every workspace project and each card's lease and run, and the
//   issue response the description and comments; the parsers copy only the `Issue` fields.
// - `listWorkspaceSlugs` reads the workspace slugs a connect stores beside the person's memberships
//   (`GET /workspaces`), since a resource URL names a workspace by slug.
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
  InferOpsError, type InferOpsClient, type InferOpsErrorCode, type ProjectSnapshot,
  type ProjectSummary,
} from "./inferops-client";
import { isSlug } from "./resources";
import type { Issue, Project, Revision, State, StateGroup, Workflow } from "./types";

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

// One message for "no such issue" and "issue of another project", so a caller cannot probe.
function issueNotFound(): InferOpsError {
  return new InferOpsError("NOT_FOUND", "No such issue in this project.");
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

const FAILURE_DETAIL: Record<InferOpsErrorCode, string> = {
  NOT_FOUND: "InferOps has no such item.",
  STALE_REVISION: "The issue changed in InferOps. Read it again.",
  WORKFLOW_MISMATCH: "The target state belongs to another workflow than the issue.",
  INVALID_STATE: "The target state is not part of this project.",
  IDEMPOTENCY_CONFLICT: "This idempotency key was already used for a different change.",
  INVALID_REQUEST: "InferOps rejected the request as malformed.",
  CONFLICT: "InferOps refused the change in the issue's current condition.",
  UNAUTHORIZED: "InferOps rejected this connection's credential. Reconnect InferOps.",
  FORBIDDEN: "This connection is not permitted to do that in InferOps.",
  UNAVAILABLE: "InferOps could not be reached or returned an unusable response.",
};

/** The gatekeeper code for a failed response, from its status and InferOps error code. */
function failureCode(status: number, code: string | null): InferOpsErrorCode {
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) {
    return code === "STALE_REVISION" || code === "WORKFLOW_MISMATCH" ? code : "CONFLICT";
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

type Send = { method: "GET" | "POST"; path: string; body?: unknown; idempotencyKey?: string };

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
      throw new InferOpsError(code, FAILURE_DETAIL[code]);
    }
    if (body === undefined) throw unavailable(response.status);
    return body;
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

    /** Nothing is held for a remote service. */
    async forget(): Promise<void> {},
  };
}
