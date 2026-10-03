// A fake InferLab central-auth and InferOps API behind the NetworkInterceptor, for suites that
// drive the real InferOps gatekeeper through the real Workshop.
//
// It answers what the gatekeeper calls and nothing more: InferLab's authorization-code + PKCE token
// exchange, refresh and logout; InferOps' `GET /workspaces`, project list, board, issue read, and the
// three issue writes. Its rules are the ones the isolation suite leans on, taken from InferOps:
//
// - A token belongs to one person. Every InferOps request is authorized by that token *and* the
//   person's current membership of the `x-workspace-id` workspace (401 for a dead token, 403 for a
//   workspace the person is not in). Projects and issues are scoped to the header's workspace, so
//   an issue of another workspace is a 404, as in InferOps.
// - InferLab reports the person's memberships at sign-in. Memberships can change afterwards
//   (`setWorkspaces`), so the identity a gatekeeper stored can go stale, as it would for real.
// - Revisions are decimal strings; a write naming another revision is a 409 `STALE_REVISION`.
// - Writes carry `x-idempotency-key`. The first response under a key is stored and replayed for
//   every later request with that key, without writing again.
//
// Failure switches: `failNextRequests` (503 for the next N InferOps calls), `failNextWrites` (503 for
// the next N writes, before anything is committed), and `loseNextWriteResponse` (commit the next
// write, store its response under its key, then drop the connection). `revokeSessions` ends a
// person's sessions at InferLab, so their access tokens get 401 and their refresh tokens too.
//
// Everything a request carried is recorded in `requests`, and every committed write in `commits`,
// so a test can say what reached InferOps, as whom, and what changed.

import { createHash, randomUUID } from "node:crypto";
import type { Handler } from "./network-interceptor.js";

/** InferLab's origin: `INFERLAB_AUTH_ORIGIN`. */
export const INFERLAB_ORIGIN = "https://inferlab.test";
/** The InferOps API: `INFEROPS_BASE_URL`. */
export const INFEROPS_ORIGIN = "https://inferops.test";
/** The tenant slug of every workspace here. */
export const TENANT = "acme";

/** The InferOps workspaces of tenant `acme`, by slug. */
export const WORKSPACES = {
  operations: { id: "9a000000-0000-4000-8000-000000000001", name: "Operations" },
  knowledge: { id: "9a000000-0000-4000-8000-000000000002", name: "Knowledge" },
} as const;
export type WorkspaceSlug = keyof typeof WORKSPACES;

type StateDef = { id: string; name: string; group: string; position: number };
type ProjectDef = {
  id: string; identifier: string; name: string; workspace: WorkspaceSlug; states: StateDef[];
};

function states(prefix: string): StateDef[] {
  return [
    { id: `${prefix}-0000-4000-8000-000000000001`, name: "Todo", group: "unstarted", position: 1 },
    { id: `${prefix}-0000-4000-8000-000000000002`, name: "In Progress", group: "started", position: 2 },
    { id: `${prefix}-0000-4000-8000-000000000003`, name: "Done", group: "completed", position: 3 },
  ];
}

/**
 * ENG and WEB live in `operations`, OPS in `knowledge`. WEB is there so a board bound to ENG has a
 * sibling project in the same workspace, whose issues InferOps itself would hand out.
 */
export const PROJECTS: Record<"ENG" | "WEB" | "OPS", ProjectDef> = {
  ENG: {
    id: "1e000000-0000-4000-8000-000000000001", identifier: "ENG", name: "Engineering",
    workspace: "operations", states: states("2e000000"),
  },
  WEB: {
    id: "1e000000-0000-4000-8000-000000000003", identifier: "WEB", name: "Website",
    workspace: "operations", states: states("2d000000"),
  },
  OPS: {
    id: "1e000000-0000-4000-8000-000000000002", identifier: "OPS", name: "Operations desk",
    workspace: "knowledge", states: states("2f000000"),
  },
};

const ISSUE_PREFIX: Record<keyof typeof PROJECTS, string> = { ENG: "3e", WEB: "3d", OPS: "3f" };

/** The issues every fake starts with. */
export const SEEDED_ISSUES = ["ENG-1", "ENG-2", "WEB-1", "OPS-1"] as const;

/** A board URL as InferOps writes it. */
export function boardUrl(workspace: string, projectKey: string, tenant = TENANT): string {
  return `inferops://${tenant}.${workspace}/project/board/${projectKey}`;
}

/** The description every seeded issue carries: it must never leave InferOps through InferOS. */
export function secretDescription(identifier: string): string {
  return `CONFIDENTIAL description of ${identifier}: not for logs`;
}

export type FakeIssue = {
  id: string; identifier: string; projectId: string; title: string; description: string | null;
  priority: string; stateId: string; revision: string;
};

/** One person known to InferLab. */
export type FakePerson = {
  readonly userId: string;
  readonly email: string;
  workspaces: Set<WorkspaceSlug>;
};

/** One request that reached the InferOps API, as it arrived. */
export type FakeRequest = {
  method: string;
  path: string;
  /** The bearer token, verbatim (null without one). */
  token: string | null;
  /** Whose token it was, when it is one InferLab issued and still honors. */
  person: string | null;
  workspaceId: string | null;
  idempotencyKey: string | null;
};

/** One write InferOps committed. */
export type FakeCommit = {
  operation: "create" | "update" | "transition";
  issueId: string;
  idempotencyKey: string;
  person: string;
};

type Session = { person: FakePerson; access: string; refresh: string; live: boolean };
type PendingCode = { person: FakePerson; challenge: string; redirectUri: string };
type Stored = { status: number; body: unknown };

const json = (body: unknown, status = 200) => Response.json(body, { status });
const failure = (status: number, code: string, message: string) =>
  json({ error: { code, message } }, status);

/** Base64url SHA-256, PKCE's S256. */
function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** A refused write, as InferOps answers one. */
const err = (status: number, code: string): Stored =>
  ({ status, body: { error: { code, message: code.toLowerCase() } } });

/** Unguessable hex, so no two runs share a token. */
const randomHex = () => randomUUID().replaceAll("-", "");

export class InferOpsFake {
  readonly requests: FakeRequest[] = [];
  readonly commits: FakeCommit[] = [];
  /** Requests answered from the idempotency store rather than written again. */
  readonly replays: FakeRequest[] = [];
  /** Refresh tokens InferLab was asked to sign out. */
  readonly logouts: string[] = [];

  /** Answer the next N InferOps API calls with a 503, before doing anything. */
  failNextRequests = 0;
  /** Answer the next N InferOps writes with a 503, before committing anything. */
  failNextWrites = 0;
  /** Commit the next write and store its response, then drop the connection instead of answering. */
  loseNextWriteResponse = false;

  readonly #people = new Map<string, FakePerson>();
  readonly #sessions: Session[] = [];
  readonly #codes = new Map<string, PendingCode>();
  readonly #issues = new Map<string, FakeIssue>();
  readonly #idempotency = new Map<string, Stored>();
  #serial = 0;

  constructor() {
    this.#seed("ENG", 1, "Ship the scoped gatekeeper", "high");
    this.#seed("ENG", 2, "Write the isolation suite", "medium");
    this.#seed("WEB", 1, "Refresh the landing page", "low");
    this.#seed("OPS", 1, "Rotate the on-call roster", "low");
  }

  #seed(key: keyof typeof PROJECTS, n: number, title: string, priority: string): void {
    const project = PROJECTS[key];
    const identifier = `${key}-${n}`;
    const id = `${ISSUE_PREFIX[key]}000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    this.#issues.set(id, {
      id, identifier, projectId: project.id, title, description: secretDescription(identifier),
      priority, stateId: project.states[0]!.id, revision: String(1040 + n),
    });
  }

  /** The interceptor handler: InferLab and InferOps requests, and nothing else. */
  readonly handler: Handler = async (url, method, headers, request) => {
    if (url.origin === INFERLAB_ORIGIN) return this.#inferlab(url, method, request);
    if (url.origin === INFEROPS_ORIGIN) return this.#inferops(url, method, headers, request);
    return null;
  };

  // -------------------------------------------------------------------------
  // Test controls

  /** A person InferLab knows, a member of `workspaces`. Labels must be unique per suite. */
  addPerson(label: string, workspaces: WorkspaceSlug[]): FakePerson {
    if (this.#people.has(label)) throw new Error(`Person ${label} already exists`);
    const person: FakePerson = {
      userId: `user-${label}`, email: `${label}@acme.test`, workspaces: new Set(workspaces),
    };
    this.#people.set(label, person);
    return person;
  }

  /** Change a person's memberships, in InferLab and InferOps alike, from now on. */
  setWorkspaces(person: FakePerson, workspaces: WorkspaceSlug[]): void {
    person.workspaces = new Set(workspaces);
  }

  /**
   * The person signs in at InferLab's `/authorize`: returns the redirect back to the gatekeeper with
   * a fresh code, bound to the request's PKCE challenge and redirect URI.
   */
  authorize(authorizeUrl: string, person: FakePerson): string {
    const url = new URL(authorizeUrl);
    if (url.origin !== INFERLAB_ORIGIN || url.pathname !== "/authorize") {
      throw new Error(`Not an InferLab authorize URL: ${authorizeUrl}`);
    }
    const params = url.searchParams;
    if (params.get("client_id") !== "inferos" || params.get("code_challenge_method") !== "S256") {
      throw new Error("Unexpected authorize parameters");
    }
    const code = `code-${randomHex()}`;
    this.#codes.set(code, {
      person, challenge: params.get("code_challenge")!, redirectUri: params.get("redirect_uri")!,
    });
    const back = new URL(params.get("redirect_uri")!);
    back.searchParams.set("code", code);
    back.searchParams.set("state", params.get("state")!);
    return back.toString();
  }

  /** End every session of `person` at InferLab: their tokens stop working, refresh included. */
  revokeSessions(person: FakePerson): void {
    for (const session of this.#sessions) if (session.person === person) session.live = false;
  }

  /** Every access and refresh token InferLab ever issued, live or not. */
  issuedTokens(): string[] {
    return this.#sessions.flatMap(s => [s.access, s.refresh]);
  }

  /** The access tokens issued to `person`, live or not. */
  accessTokensOf(person: FakePerson): string[] {
    return this.#sessions.filter(s => s.person === person).map(s => s.access);
  }

  /** Every issue description InferOps holds. */
  descriptions(): string[] {
    return [...this.#issues.values()].flatMap(i => i.description ? [i.description] : []);
  }

  /** The stored issue `identifier`. */
  issue(identifier: string): FakeIssue {
    const found = [...this.#issues.values()].find(i => i.identifier === identifier);
    if (!found) throw new Error(`No issue ${identifier}`);
    return found;
  }

  /** The issues of project `key`. */
  issuesOf(key: keyof typeof PROJECTS): FakeIssue[] {
    return [...this.#issues.values()].filter(i => i.projectId === PROJECTS[key].id);
  }

  /** Someone else edits the issue in InferOps: its revision moves on. */
  touch(identifier: string): void {
    const issue = this.issue(identifier);
    issue.revision = String(Number(issue.revision) + 1);
  }

  /** The InferOps writes (anything but a GET) that reached the API. */
  writeRequests(): FakeRequest[] {
    return this.requests.filter(r => r.method !== "GET");
  }

  // -------------------------------------------------------------------------
  // InferLab

  #issue(person: FakePerson): Session {
    const n = ++this.#serial;
    const session: Session = {
      person,
      access: `ilab-access-${n}-${randomHex()}`,
      refresh: `ilab-refresh-${n}-${randomHex()}`,
      live: true,
    };
    this.#sessions.push(session);
    return session;
  }

  async #inferlab(url: URL, method: string, request: Request): Promise<Response | null> {
    if (method !== "POST") return null;
    const body = await request.json() as Record<string, unknown>;
    switch (url.pathname) {
      case "/auth/token": {
        const pending = this.#codes.get(String(body.code));
        this.#codes.delete(String(body.code));
        if (!pending || body.clientId !== "inferos" || body.redirectUri !== pending.redirectUri ||
            typeof body.codeVerifier !== "string" || s256(body.codeVerifier) !== pending.challenge) {
          return failure(400, "INVALID_GRANT", "invalid grant");
        }
        const { person } = pending;
        const session = this.#issue(person);
        return json({
          token: session.access,
          refreshToken: session.refresh,
          user: {
            id: person.userId, email: person.email, emailVerified: true, name: person.email,
            tenantId: "tenant-acme",
            workspaces: [...person.workspaces].map(slug => ({
              workspaceId: WORKSPACES[slug].id, workspaceName: WORKSPACES[slug].name,
              product: "inferops", role: "member", deniedPermissions: [],
            })),
          },
        });
      }
      case "/auth/refresh": {
        const session = this.#sessions.find(s => s.refresh === body.refreshToken && s.live);
        if (!session) return failure(401, "UNAUTHORIZED", "session ended");
        session.live = false;
        const next = this.#issue(session.person);
        return json({ token: next.access, refreshToken: next.refresh });
      }
      case "/auth/logout": {
        this.logouts.push(String(body.refreshToken));
        const session = this.#sessions.find(s => s.refresh === body.refreshToken);
        if (session) session.live = false;
        return new Response(null, { status: 204 });
      }
      default:
        return null;
    }
  }

  // -------------------------------------------------------------------------
  // InferOps

  #wireIssue(issue: FakeIssue) {
    return {
      id: issue.id, identifier: issue.identifier, title: issue.title, priority: issue.priority,
      stateId: issue.stateId, targetDate: null, workflow: "software", revision: issue.revision,
      assigneeId: null, blockedReason: null, projectId: issue.projectId,
      // InferOps sends these too; the gatekeeper must drop them.
      description: issue.description, lease: null, comments: [],
    };
  }

  async #inferops(url: URL, method: string, headers: Headers, request: Request): Promise<Response> {
    const token = headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
    const session = token ? this.#sessions.find(s => s.access === token && s.live) : undefined;
    const workspaceId = headers.get("x-workspace-id");
    const record: FakeRequest = {
      method, path: url.pathname + url.search, token,
      person: session ? [...this.#people].find(([, p]) => p === session.person)![0] : null,
      workspaceId, idempotencyKey: headers.get("x-idempotency-key"),
    };
    this.requests.push(record);

    if (this.failNextRequests > 0) {
      this.failNextRequests--;
      return failure(503, "UNAVAILABLE", "upstream down");
    }
    if (!session) return failure(401, "UNAUTHORIZED", "invalid token");
    const person = session.person;

    if (url.pathname === "/workspaces" && method === "GET") {
      // The principal lane: every workspace of the tenant, with its slug.
      return json(Object.entries(WORKSPACES).map(([slug, w]) => ({
        id: w.id, tenant_id: "tenant-acme", product: "inferops", name: w.name, slug,
      })));
    }

    const slug = (Object.keys(WORKSPACES) as WorkspaceSlug[])
      .find(s => WORKSPACES[s].id === workspaceId);
    if (!slug || !person.workspaces.has(slug)) {
      return failure(403, "FORBIDDEN", "not a member of this workspace");
    }
    const projects = Object.values(PROJECTS).filter(p => p.workspace === slug);
    const issueIn = (id: string) => {
      const issue = this.#issues.get(id);
      return issue && projects.some(p => p.id === issue.projectId) ? issue : undefined;
    };

    if (method === "GET") {
      if (url.pathname === "/project/projects") {
        return json({ projects: projects.map(({ id, identifier, name }) => ({ id, identifier, name })) });
      }
      if (url.pathname === "/project/board") {
        const project = projects.find(p => p.id === url.searchParams.get("projectId"));
        if (!project) return failure(404, "NOT_FOUND", "no such project");
        const issues = [...this.#issues.values()].filter(i => i.projectId === project.id);
        return json({
          projectId: project.id,
          projects: projects.map(({ id, identifier, name }) => ({ id, identifier, name })),
          columns: project.states.map(state => ({
            state: { ...state, workflow: "software" },
            issues: issues.filter(i => i.stateId === state.id).map(i => this.#wireIssue(i)),
          })),
        });
      }
      const match = /^\/project\/issues\/([^/]+)$/.exec(url.pathname);
      const issue = match ? issueIn(match[1]!) : undefined;
      if (!issue) return failure(404, "NOT_FOUND", "no such issue");
      return json({ issue: this.#wireIssue(issue) });
    }

    // Writes.
    const key = record.idempotencyKey;
    if (!key) return failure(400, "INVALID_REQUEST", "missing idempotency key");
    const operation = method === "POST" && url.pathname === "/project/issues" ? "create"
      : method === "PATCH" ? "update"
      : url.pathname.endsWith("/transition") ? "transition" : null;
    if (!operation) return failure(404, "NOT_FOUND", "no route");
    const stored = this.#idempotency.get(`${operation}:${key}`);
    if (stored) {
      this.replays.push(record);
      return json(stored.body, stored.status);
    }
    if (this.failNextWrites > 0) {
      this.failNextWrites--;
      return failure(503, "UNAVAILABLE", "upstream down");
    }
    const body = await request.json() as Record<string, unknown>;
    const result = this.#write(operation, url, body, projects, issueIn);
    if (result.status >= 300) return json(result.body, result.status);
    this.#idempotency.set(`${operation}:${key}`, result);
    this.commits.push({
      operation, issueId: (result.body as { issue: { id: string } }).issue.id, idempotencyKey: key,
      person: record.person!,
    });
    if (this.loseNextWriteResponse) {
      this.loseNextWriteResponse = false;
      throw new Error("The connection was reset after InferOps committed the write.");
    }
    return json(result.body, result.status);
  }

  #write(operation: FakeCommit["operation"], url: URL, body: Record<string, unknown>,
         projects: ProjectDef[], issueIn: (id: string) => FakeIssue | undefined): Stored {
    if (operation === "create") {
      const project = projects.find(p => p.id === body.projectId);
      if (!project) return err(404, "NOT_FOUND");
      if (!project.states.some(s => s.id === body.stateId)) return err(404, "NOT_FOUND");
      const n = this.issuesOfProject(project.id).length + 1;
      const prefix = ISSUE_PREFIX[project.identifier as keyof typeof PROJECTS];
      const issue: FakeIssue = {
        id: `${prefix}000000-0000-4000-8000-${String(100 + n).padStart(12, "0")}`,
        identifier: `${project.identifier}-${n}`, projectId: project.id, title: String(body.title),
        description: typeof body.description === "string" ? body.description : null,
        priority: typeof body.priority === "string" ? body.priority : "none",
        stateId: String(body.stateId), revision: "1",
      };
      this.#issues.set(issue.id, issue);
      return { status: 201, body: { issue: this.#wireIssue(issue) } };
    }
    const id = /^\/project\/issues\/([^/]+)/.exec(url.pathname)?.[1] ?? "";
    const issue = issueIn(id);
    if (!issue) return err(404, "NOT_FOUND");
    if (body.expectedRevision !== issue.revision) return err(409, "STALE_REVISION");
    if (operation === "transition") {
      const project = projects.find(p => p.id === issue.projectId)!;
      if (!project.states.some(s => s.id === body.toStateId)) return err(404, "NOT_FOUND");
      issue.stateId = String(body.toStateId);
    } else {
      if (typeof body.title === "string") issue.title = body.title;
      if (typeof body.priority === "string") issue.priority = body.priority;
      if (body.description !== undefined) {
        issue.description = typeof body.description === "string" ? body.description : null;
      }
    }
    issue.revision = String(Number(issue.revision) + 1);
    return { status: 200, body: { issue: this.#wireIssue(issue) } };
  }

  issuesOfProject(projectId: string): FakeIssue[] {
    return [...this.#issues.values()].filter(i => i.projectId === projectId);
  }
}
