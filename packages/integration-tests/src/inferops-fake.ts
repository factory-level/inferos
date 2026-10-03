// A fake InferLab central-auth and InferOps API behind the NetworkInterceptor, for suites that
// drive the real InferOps gatekeeper through the real Workshop.
//
// It answers what the gatekeeper calls and nothing more: InferLab's authorization-code + PKCE token
// exchange, refresh and logout; InferOps' `GET /workspaces`, project list, board, issue read, the
// three issue writes, and coding dispatch (repositories, runs, dispatch and cancel). Its rules are the ones the isolation suite leans on, taken from InferOps:
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
// - Dispatch and cancel need the person's `issue:delegate` (`grantDelegate`; nobody holds it by
//   default, as InferOps' write roles do not), else 403. A dispatch is refused 409 `RUN_ACTIVE` while
//   the issue has a queued or running run, 400 `VALIDATION` for a repository that is not enrolled
//   and enabled in the workspace, and 409 `STALE_REVISION`; it queues a run and advances the issue's
//   revision. Runs are workspace-wide, as in InferOps: their issue decides their project.
//
// - The InferMind Wiki (`/knowledge/*`) is served only in a workspace whose product is `infermind`
//   (`mind` and `notes` here); in any other InferOps answers 403, as its product gate does, and a
//   person without knowledge access (`setKnowledgeAccess`) gets 403 too. Its responses are bare,
//   a page or section of another workspace is `null`, sections carry an integer `version` bumped by
//   every write, and a section PATCH takes no expected version and does not replay an idempotency
//   key, all as in InferOps. A PATCH of a section this workspace lacks is InferOps' 500.
//
// The runner lane: `runnerKey(workspace)` mints a service-account key holding `run:execute` for one
// workspace, as `inferops runner codex` uses. With it, and only with it, a caller may list runs, read
// an issue, and claim (`start`), `heartbeat` and `finish` a run, fenced on the lease generation
// (`LEASE_LOST` once the run is no longer this lease's). A key reads and writes nothing else. `serve()`
// exposes the same fake on a loopback port, so a runner process outside the test can reach it.
//
// Failure switches: `failNextRequests` (503 for the next N InferOps calls), `failNextWrites` (503 for
// the next N writes, before anything is committed), and `loseNextWriteResponse` (commit the next
// write, store its response under its key, then drop the connection). `revokeSessions` ends a
// person's sessions at InferLab, so their access tokens get 401 and their refresh tokens too.
//
// Everything a request carried is recorded in `requests`, and every committed write in `commits`,
// so a test can say what reached InferOps, as whom, and what changed.

import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Handler } from "./network-interceptor.js";

/** InferLab's origin: `INFERLAB_AUTH_ORIGIN`. */
export const INFERLAB_ORIGIN = "https://inferlab.test";
/** The InferOps API: `INFEROPS_BASE_URL`. */
export const INFEROPS_ORIGIN = "https://inferops.test";
/** The tenant slug of every workspace here. */
export const TENANT = "acme";

/** The workspaces of tenant `acme`, by slug, each an InferOps or an InferMind one. */
export const WORKSPACES = {
  operations: { id: "9a000000-0000-4000-8000-000000000001", name: "Operations", product: "inferops" },
  knowledge: { id: "9a000000-0000-4000-8000-000000000002", name: "Knowledge", product: "inferops" },
  mind: { id: "9a000000-0000-4000-8000-000000000003", name: "Mind", product: "infermind" },
  notes: { id: "9a000000-0000-4000-8000-000000000004", name: "Notes", product: "infermind" },
} as const;
export type WorkspaceSlug = keyof typeof WORKSPACES;

/** A Wiki URL as InferOps writes it. */
export function wikiUrl(workspace: string, tenant = TENANT): string {
  return `inferops://${tenant}.${workspace}/knowledge/wiki`;
}

/** The body every seeded section starts with: it must never reach a log through InferOS. */
export function secretSectionBody(slug: string, tag: string): string {
  return `CONFIDENTIAL section ${slug}#${tag}: not for logs`;
}

export type FakeDocument = { id: string; workspace: WorkspaceSlug; slug: string; title: string; parentId: string | null };
export type FakeSection = { id: string; documentId: string; tag: string; body: string; version: number };

/** The Wiki pages every fake starts with, by slug. `handbook` embeds the ENG board. */
export const DOCUMENTS = {
  handbook: { id: "6a000000-0000-4000-8000-000000000001", workspace: "mind", title: "Handbook" },
  runbook: { id: "6a000000-0000-4000-8000-000000000002", workspace: "mind", title: "Runbook" },
  "private-notes": { id: "6a000000-0000-4000-8000-000000000003", workspace: "notes", title: "Private notes" },
} as const satisfies Record<string, { id: string; workspace: WorkspaceSlug; title: string }>;

/** The ENG board reference `handbook#current-work` embeds as a paragraph of its own. */
export const HANDBOOK_EMBED = "inferops://acme.operations/project/board/ENG";

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

/** The repositories each workspace has enrolled for coding. `infra` is disabled. */
export const REPOS = {
  webApp: { id: "5e000000-0000-4000-8000-000000000001", slug: "web-app", workspace: "operations" as WorkspaceSlug, enabled: true },
  infra: { id: "5e000000-0000-4000-8000-000000000002", slug: "infra", workspace: "operations" as WorkspaceSlug, enabled: false },
  desk: { id: "5e000000-0000-4000-8000-000000000003", slug: "desk-tools", workspace: "knowledge" as WorkspaceSlug, enabled: true },
} as const;

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
  /** Whether the person holds InferOps' `issue:delegate`, which dispatch and cancel need. */
  canDelegate: boolean;
  /** The person's InferMind knowledge permission: `write` (the default), `read` or `none`. */
  knowledge: "write" | "read" | "none";
};

/** One Wiki section write InferOps committed. */
export type FakeSectionWrite = { sectionId: string; body: string; idempotencyKey: string | null; person: string };

/** One coding run, as InferOps stores it. */
export type FakeRun = {
  id: string; issueId: string; repoId: string; status: string; baseRef: string | null;
  requestedBy: string;
  /** The issue lease generation: bumped by each `start`, quoted by every heartbeat and finish. */
  leaseGeneration: string;
  externalRunId: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

/** One request that reached the InferOps API, as it arrived. */
export type FakeRequest = {
  method: string;
  path: string;
  /** The bearer token, verbatim (null without one). */
  token: string | null;
  /** Whose token it was, when it is one InferLab issued and still honors; `runner:<workspace>` for a runner key. */
  person: string | null;
  workspaceId: string | null;
  idempotencyKey: string | null;
};

/** One write InferOps committed. */
export type FakeCommit = {
  operation: "create" | "update" | "transition" | "dispatch" | "cancel";
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
  /** Every Wiki section write committed, in order. */
  readonly sectionWrites: FakeSectionWrite[] = [];

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
  readonly #runs = new Map<string, FakeRun>();
  readonly #documents = new Map<string, FakeDocument>();
  readonly #sections = new Map<string, FakeSection>();
  /** Service-account keys holding `run:execute`, by key, with the one workspace each may act in. */
  readonly #runnerKeys = new Map<string, WorkspaceSlug>();
  #serial = 0;

  constructor() {
    this.#seed("ENG", 1, "Ship the scoped gatekeeper", "high");
    this.#seed("ENG", 2, "Write the isolation suite", "medium");
    this.#seed("WEB", 1, "Refresh the landing page", "low");
    this.#seed("OPS", 1, "Rotate the on-call roster", "low");
    for (const [slug, doc] of Object.entries(DOCUMENTS)) {
      this.#documents.set(doc.id, { id: doc.id, workspace: doc.workspace, slug, title: doc.title, parentId: null });
    }
    this.#seedSection("handbook", 1, "purpose", secretSectionBody("handbook", "purpose"));
    this.#seedSection("handbook", 2, "current-work",
      `${secretSectionBody("handbook", "current-work")}\n\n[ENG board](${HANDBOOK_EMBED})`);
    this.#seedSection("runbook", 3, "steps", secretSectionBody("runbook", "steps"));
    this.#seedSection("private-notes", 4, "secret", secretSectionBody("private-notes", "secret"));
  }

  #seedSection(slug: keyof typeof DOCUMENTS, n: number, tag: string, body: string): void {
    const id = `6b000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    this.#sections.set(id, { id, documentId: DOCUMENTS[slug].id, tag, body, version: 7 });
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
      canDelegate: false, knowledge: "write",
    };
    this.#people.set(label, person);
    return person;
  }

  /** Give the person InferOps' `issue:delegate`, so they may dispatch and cancel runs. */
  grantDelegate(person: FakePerson): void {
    person.canDelegate = true;
  }

  /** Set the person's InferMind knowledge permission. */
  setKnowledgeAccess(person: FakePerson, access: FakePerson["knowledge"]): void {
    person.knowledge = access;
  }

  /** The stored section `tag` of page `slug`. */
  section(slug: keyof typeof DOCUMENTS, tag: string): FakeSection {
    const found = [...this.#sections.values()].find(s => s.documentId === DOCUMENTS[slug].id && s.tag === tag);
    if (!found) throw new Error(`No section ${slug}#${tag}`);
    return found;
  }

  /** Someone else edits the section in InferMind: its body changes and its version moves on. */
  editSection(slug: keyof typeof DOCUMENTS, tag: string, body: string): void {
    const section = this.section(slug, tag);
    section.body = body;
    section.version += 1;
  }

  /** The body of every seeded section. */
  seededSectionBodies(): string[] {
    return [
      secretSectionBody("handbook", "purpose"), secretSectionBody("handbook", "current-work"),
      secretSectionBody("runbook", "steps"), secretSectionBody("private-notes", "secret"),
    ];
  }

  /** The runs of `identifier`'s issue, oldest first. */
  runsOf(identifier: string): FakeRun[] {
    const issue = this.issue(identifier);
    return [...this.#runs.values()].filter(r => r.issueId === issue.id);
  }

  /** The runner moves a run on, as `inferops runner` would report it. */
  setRunStatus(runId: string, status: string): void {
    const run = this.#runs.get(runId);
    if (!run) throw new Error(`No run ${runId}`);
    run.status = status;
  }

  /** A service-account key holding `run:execute` in `workspace`, as a runner's `INFEROPS_API_KEY`. */
  runnerKey(workspace: WorkspaceSlug): string {
    const key = `iops_sk_${randomHex()}`;
    this.#runnerKeys.set(key, workspace);
    return key;
  }

  /** The stored run `runId`. */
  run(runId: string): FakeRun {
    const run = this.#runs.get(runId);
    if (!run) throw new Error(`No run ${runId}`);
    return run;
  }

  /**
   * Serve this fake's InferOps API on a loopback port, for a process outside the test (a runner).
   * Requests are answered exactly as the interceptor's are, and recorded the same way.
   */
  async serve(): Promise<{ url: string; close: () => Promise<void> }> {
    const server = createServer((incoming, outgoing) => {
      const chunks: Buffer[] = [];
      incoming.on("data", chunk => chunks.push(chunk));
      incoming.on("end", () => {
        const url = new URL(incoming.url ?? "/", INFEROPS_ORIGIN);
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (typeof value === "string") headers.set(name, value);
        }
        const method = incoming.method ?? "GET";
        const body = chunks.length ? Buffer.concat(chunks) : undefined;
        const request = new Request(url, { method, headers, body: method === "GET" ? undefined : body });
        this.#inferops(url, method, headers, request).then(async response => {
          outgoing.writeHead(response.status, { "content-type": "application/json" });
          outgoing.end(Buffer.from(await response.arrayBuffer()));
        }, (error: unknown) => {
          outgoing.writeHead(500);
          outgoing.end(String(error));
        });
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("The fake did not get a port");
    return {
      url: `http://127.0.0.1:${address.port}`,
      close: () => new Promise(resolve => server.close(() => resolve())),
    };
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
              product: WORKSPACES[slug].product, role: "member", deniedPermissions: [],
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

  #wireRun(run: FakeRun) {
    return { ...run, action: "code", queuedAt: "2026-10-03T00:00:00.000Z" };
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
    const runnerWorkspace = token ? this.#runnerKeys.get(token) : undefined;
    if (runnerWorkspace) {
      record.person = `runner:${runnerWorkspace}`;
      return this.#runner(url, method, workspaceId, runnerWorkspace, request);
    }
    if (!session) return failure(401, "UNAUTHORIZED", "invalid token");
    const person = session.person;

    if (url.pathname === "/workspaces" && method === "GET") {
      // The principal lane: every workspace of the tenant, with its slug.
      return json(Object.entries(WORKSPACES).map(([slug, w]) => ({
        id: w.id, tenant_id: "tenant-acme", product: w.product, name: w.name, slug,
      })));
    }

    const slug = (Object.keys(WORKSPACES) as WorkspaceSlug[])
      .find(s => WORKSPACES[s].id === workspaceId);
    if (!slug || !person.workspaces.has(slug)) {
      return failure(403, "FORBIDDEN", "not a member of this workspace");
    }
    if (url.pathname.startsWith("/knowledge/")) return this.#knowledge(url, method, request, record, slug, person);
    const projects = Object.values(PROJECTS).filter(p => p.workspace === slug);
    const issueIn = (id: string) => {
      const issue = this.#issues.get(id);
      return issue && projects.some(p => p.id === issue.projectId) ? issue : undefined;
    };

    const runIn = (id: string) => {
      const run = this.#runs.get(id);
      return run && issueIn(run.issueId) ? run : undefined;
    };

    if (method === "GET") {
      if (url.pathname === "/project/repos") {
        return json({ repos: Object.values(REPOS).filter(r => r.workspace === slug).map(r => ({
          id: r.id, slug: r.slug, gitUrl: `git@forge.test:acme/${r.slug}.git`, defaultBaseRef: "main",
          enabled: r.enabled,
        })) });
      }
      if (url.pathname === "/project/runs") {
        const issueId = url.searchParams.get("issueId");
        const limit = Number(url.searchParams.get("limit") ?? 50);
        const runs = [...this.#runs.values()].toReversed()
          .filter(r => issueIn(r.issueId) && (!issueId || r.issueId === issueId)).slice(0, limit);
        return json({ runs: runs.map(r => this.#wireRun(r)) });
      }
      const runMatch = /^\/project\/runs\/([^/]+)$/.exec(url.pathname);
      if (runMatch) {
        const run = runIn(runMatch[1]!);
        return run ? json({ run: this.#wireRun(run) }) : failure(404, "NOT_FOUND", "no such run");
      }
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
    const operation: FakeCommit["operation"] | null =
      method === "POST" && url.pathname === "/project/issues" ? "create"
      : method === "PATCH" ? "update"
      : url.pathname.endsWith("/transition") ? "transition"
      : url.pathname.endsWith("/dispatch") ? "dispatch"
      : /^\/project\/runs\/[^/]+\/cancel$/.test(url.pathname) ? "cancel" : null;
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
    const result = operation === "dispatch" || operation === "cancel"
      ? this.#runWrite(operation, url, body, person, issueIn, runIn)
      : this.#write(operation, url, body, projects, issueIn);
    if (result.status >= 300) return json(result.body, result.status);
    this.#idempotency.set(`${operation}:${key}`, result);
    const written = result.body as { issue?: { id: string }; run?: { issueId: string } };
    this.commits.push({
      operation, issueId: written.issue?.id ?? written.run!.issueId, idempotencyKey: key,
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

  #runWrite(operation: "dispatch" | "cancel", url: URL, body: Record<string, unknown>,
             person: FakePerson, issueIn: (id: string) => FakeIssue | undefined,
             runIn: (id: string) => FakeRun | undefined): Stored {
    if (!person.canDelegate) return err(403, "FORBIDDEN");
    if (operation === "cancel") {
      const run = runIn(/^\/project\/runs\/([^/]+)/.exec(url.pathname)?.[1] ?? "");
      if (!run) return err(404, "NOT_FOUND");
      if (run.status !== "queued" && run.status !== "running") return err(409, "CONFLICT");
      run.status = run.status === "queued" ? "cancelled" : "unknown";
      return { status: 200, body: { run: this.#wireRun(run) } };
    }
    const issue = issueIn(/^\/project\/issues\/([^/]+)/.exec(url.pathname)?.[1] ?? "");
    if (!issue) return err(404, "NOT_FOUND");
    if (body.action !== "code") return err(400, "VALIDATION");
    if ([...this.#runs.values()].some(r => r.issueId === issue.id &&
        (r.status === "queued" || r.status === "running"))) {
      return err(409, "RUN_ACTIVE");
    }
    const repo = Object.values(REPOS).find(r => r.id === body.repoId);
    const project = Object.values(PROJECTS).find(p => p.id === issue.projectId)!;
    if (!repo || !repo.enabled || repo.workspace !== project.workspace) return err(400, "VALIDATION");
    if (body.expectedRevision !== issue.revision) return err(409, "STALE_REVISION");
    const run: FakeRun = {
      id: randomUUID(), issueId: issue.id, repoId: repo.id, status: "queued",
      baseRef: typeof body.baseRef === "string" ? body.baseRef : null, requestedBy: person.userId,
      leaseGeneration: "1", externalRunId: null, result: null, error: null, startedAt: null, finishedAt: null,
    };
    this.#runs.set(run.id, run);
    issue.revision = String(Number(issue.revision) + 1);
    return { status: 201, body: { run: this.#wireRun(run) } };
  }

  /** InferOps' knowledge routes, for one request already authorized into workspace `slug`. */
  async #knowledge(url: URL, method: string, request: Request, record: FakeRequest,
                   slug: WorkspaceSlug, person: FakePerson): Promise<Response> {
    // The product gate, then the route's permission: both InferOps' 403 FORBIDDEN.
    if (WORKSPACES[slug].product !== "infermind") return failure(403, "FORBIDDEN", "Wrong product for this route");
    const write = method !== "GET";
    if (person.knowledge === "none" || (write && person.knowledge !== "write")) {
      return failure(403, "FORBIDDEN", `Missing permission: knowledge:${write ? "write" : "read"}`);
    }
    const documentIn = (id: string) => {
      const doc = this.#documents.get(id);
      return doc?.workspace === slug ? doc : undefined;
    };
    const sectionIn = (id: string) => {
      const section = this.#sections.get(id);
      return section && documentIn(section.documentId) ? section : undefined;
    };
    const wireDocument = (doc: FakeDocument) => ({
      id: doc.id, workspaceId: WORKSPACES[slug].id, slug: doc.slug, title: doc.title,
      summary: null, pathway: null, parentId: doc.parentId, siblingOrder: 0,
    });
    if (method === "GET") {
      if (url.pathname === "/knowledge/documents") {
        return json([...this.#documents.values()].filter(d => d.workspace === slug).map(wireDocument));
      }
      const documentMatch = /^\/knowledge\/documents\/([^/]+)$/.exec(url.pathname);
      if (documentMatch) {
        const doc = documentIn(documentMatch[1]!);
        return json(doc ? { ...wireDocument(doc), body: "" } : null);
      }
      if (url.pathname === "/knowledge/sections") {
        const documentId = url.searchParams.get("documentId") ?? "";
        return json(documentIn(documentId)
          ? [...this.#sections.values()].filter(s => s.documentId === documentId) : []);
      }
      const sectionMatch = /^\/knowledge\/sections\/([^/]+)$/.exec(url.pathname);
      if (sectionMatch) return json(sectionIn(sectionMatch[1]!) ?? null);
      return failure(404, "NOT_FOUND", "no route");
    }
    const patchMatch = /^\/knowledge\/sections\/([^/]+)$/.exec(url.pathname);
    if (method !== "PATCH" || !patchMatch) return failure(404, "NOT_FOUND", "no route");
    if (this.failNextWrites > 0) {
      this.failNextWrites--;
      return failure(503, "UNAVAILABLE", "upstream down");
    }
    const section = sectionIn(patchMatch[1]!);
    // InferOps' updateSection throws a plain "not found", which its error middleware answers 500.
    if (!section) return failure(500, "INTERNAL_ERROR", "An unexpected error occurred");
    const body = await request.json() as { body?: unknown };
    if (typeof body.body === "string") {
      section.body = body.body;
      section.version += 1;
    }
    this.sectionWrites.push({
      sectionId: section.id, body: section.body, idempotencyKey: record.idempotencyKey, person: record.person!,
    });
    if (this.loseNextWriteResponse) {
      this.loseNextWriteResponse = false;
      throw new Error("The connection was reset after InferOps committed the write.");
    }
    return json(section);
  }

  /**
   * The runner lane: a `run:execute` key lists runs, reads an issue, and claims, heartbeats and
   * finishes a run of its own workspace. Anything else is 403, as a key without a person's grants.
   */
  async #runner(url: URL, method: string, workspaceId: string | null, workspace: WorkspaceSlug,
                request: Request): Promise<Response> {
    if (workspaceId !== WORKSPACES[workspace].id) return failure(403, "FORBIDDEN", "not this key's workspace");
    const projects = Object.values(PROJECTS).filter(p => p.workspace === workspace);
    const issueIn = (id: string) => {
      const issue = this.#issues.get(id);
      return issue && projects.some(p => p.id === issue.projectId) ? issue : undefined;
    };
    if (method === "GET" && url.pathname === "/project/runs") {
      const status = url.searchParams.get("status");
      const runs = [...this.#runs.values()]
        .filter(r => issueIn(r.issueId) && (!status || r.status === status));
      return json({ runs: runs.map(r => this.#wireRun(r)) });
    }
    const issueMatch = /^\/project\/issues\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && issueMatch) {
      const issue = issueIn(issueMatch[1]!);
      return issue ? json({ issue: this.#wireIssue(issue) }) : failure(404, "NOT_FOUND", "no such issue");
    }
    const match = /^\/project\/runs\/([^/]+)\/(start|heartbeat|finish)$/.exec(url.pathname);
    if (method !== "POST" || !match) return failure(403, "FORBIDDEN", "run:execute does not grant this");
    const run = this.#runs.get(match[1]!);
    if (!run || !issueIn(run.issueId)) return failure(404, "NOT_FOUND", "no such run");
    const body = await request.json() as Record<string, unknown>;
    const now = new Date().toISOString();
    if (match[2] === "start") {
      if (run.status !== "queued") return failure(409, "CONFLICT", "run is not queued");
      run.status = "running";
      run.leaseGeneration = String(Number(run.leaseGeneration) + 1);
      run.startedAt = now;
      if (typeof body.externalRunId === "string") run.externalRunId = body.externalRunId;
      return json({ run: this.#wireRun(run) });
    }
    if (run.status !== "running" || body.leaseGeneration !== run.leaseGeneration) {
      return failure(409, "LEASE_LOST", "the lease is no longer yours");
    }
    if (match[2] === "heartbeat") {
      if (typeof body.externalRunId === "string") run.externalRunId ??= body.externalRunId;
      return json({ run: this.#wireRun(run) });
    }
    const status = String(body.status);
    if (!["succeeded", "failed", "cancelled", "unknown"].includes(status)) {
      return failure(400, "VALIDATION", "not a finish status");
    }
    if (status === "succeeded" && (typeof body.result !== "object" || body.result === null)) {
      return failure(400, "VALIDATION", "A succeeded run must report its result");
    }
    run.status = status;
    run.result = typeof body.result === "object" && body.result !== null ? body.result as Record<string, unknown> : null;
    run.error = typeof body.error === "string" ? body.error : null;
    run.finishedAt = now;
    return json({ run: this.#wireRun(run) });
  }

  issuesOfProject(projectId: string): FakeIssue[] {
    return [...this.#issues.values()].filter(i => i.projectId === projectId);
  }
}
