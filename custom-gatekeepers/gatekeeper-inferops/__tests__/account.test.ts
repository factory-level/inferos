// A connected InferOps account acts with the person's own InferLab session: the connect flow stores
// it, every InferOps request carries that person's token and one of their workspaces, the session
// is refreshed and rotated at InferLab, its death is reported once, revoking signs it out, and a
// board URL (`inferops://<tenant>.<workspace>/…`) resolves only to a workspace the person belongs
// to, by its slug; anything else is refused before any request.
//
// The Workshop holds an account as a stub rebuilt from its props, and a stub cannot leave the
// Durable Object that made it, so the tests learn each account's id by fixing `crypto.randomUUID`
// for the callback leg and drive the account through `TestHooks`, as the overseer would.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleInferLabLogin } from "../src/inferlab-login.js";
import type { HostBoardFence, HostBoardRead } from "@gadgets/gatekeeper-kit/host-board";
import {
  expired, reconnects, signIns, type AccountProps, type InferLabLogin, type SignInExports,
} from "./worker.js";

const LOGIN_ENV = {
  INFERLAB_AUTH_ORIGIN: "http://localhost:8080",
  BASE_URL: "http://localhost:8787/gatekeeper/inferops",
};
const REDIRECT_URI = "http://localhost:8787/gatekeeper/inferops/oauth";
const API_HOST = "localhost:8080";
const BOARD_URL = "inferops://acme.operations/project/board/DEMO";
const SALES_URL = "inferops://acme.sales/project/board/DEMO";

const OPS = "90000000-0000-4000-8000-000000000001";
const SALES = "90000000-0000-4000-8000-000000000002";
const OTHER = "90000000-0000-4000-8000-00000000ffff";
const MIND = "90000000-0000-4000-8000-000000000003";
const HANDBOOK = "60000000-0000-4000-8000-000000000001";
const DEMO = { id: "10000000-0000-4000-8000-000000000001", identifier: "DEMO", name: "Demo" };
const READY = "20000000-0000-4000-8000-000000000001";
const DEMO_1 = "30000000-0000-4000-8000-000000000001";

const TABLE = "70000000-0000-4000-8000-000000000001";
const TABLE_ROW = "71000000-0000-4000-8000-000000000001";
const TABLE_URL = `inferops://acme.operations/object/table/${TABLE}`;
/** The InferOps definition of the fake's one table: every column, the personal one included. */
const TABLE_TYPE = {
  id: TABLE, name: "assets", label: "Assets", version: 2, starter: null, relations: [],
  columns: [
    { key: "c1", name: "serial", label: "Serial", type: "text", required: true, indexed: true, personal: false },
    { key: "c2", name: "custodian", label: "Custodian", type: "text", required: false, indexed: false, personal: true },
  ],
};
const TABLE_RECORD = {
  id: TABLE_ROW, typeId: TABLE, typeVersion: 2, headSeq: "7", relations: [],
  values: { serial: "SN-1", custodian: "Ada Lovelace" },
};

/** The bound board as InferOps' `project.board_snapshot` answers it. */
const SNAPSHOT = {
  project: { identifier: "DEMO", name: "Demo" },
  columns: [{
    label: "Ready", group: "unstarted",
    issues: [{ identifier: "DEMO-1", title: "First", priority: "high", targetDate: null, blocked: false }],
  }],
};

const HOUR = 60 * 60 * 1000;

/** An unsigned JWT whose only claim is `exp`; nothing here verifies signatures. */
function jwt(expiresAt: number): string {
  const part = (value: unknown) => btoa(JSON.stringify(value)).replace(/=+$/, "")
    .replace(/\+/g, "-").replace(/\//g, "_");
  return `${part({ alg: "HS256" })}.${part({ exp: Math.floor(expiresAt / 1000) })}.sig`;
}

type ApiCall = { path: string; token: string | null; workspaceId: string | null };

/**
 * One fake behind `fetch`: InferLab central-auth (token exchange, refresh, logout) and the InferOps
 * API (projects and board), sharing the sessions the former issues.
 */
class FakeInferLab {
  /** Live sessions by refresh token. */
  sessions = new Map<string, { access: string }>();
  /** Live access tokens. */
  access = new Set<string>();
  /** Workspaces InferOps lets this person into; the token's user is a member of these. */
  memberships = new Set<string>([OPS]);
  /** Workspaces whose product is InferMind: the only ones InferOps serves `/knowledge/*` in. */
  infermind = new Set<string>([MIND]);
  /** Whether the person lacks `knowledge:read`. */
  knowledgeDenied = false;
  /** The handbook page's body and version, and the page body writes InferOps took. */
  page = { body: "The handbook.", version: 3 };
  pageWrites: Array<{ body: string; idempotencyKey: string | null }> = [];
  /** Workspaces InferLab reports at sign-in. */
  workspaces: Array<{ workspaceId: string; workspaceName: string; product: string }> = [
    { workspaceId: OPS, workspaceName: "Ops", product: "inferops" },
  ];
  /** Every workspace of the tenant and its slug, as `GET /workspaces` lists them. */
  slugs = new Map<string, string>([
    [OPS, "operations"], [SALES, "sales"], [OTHER, "knowledge"], [MIND, "mind"],
  ]);
  /** Whether `GET /workspaces` fails. */
  workspaceListDown = false;
  workspaceLists = 0;
  emailVerified = true;
  accessTtlMs = HOUR;
  logouts: string[] = [];
  refreshes: string[] = [];
  exchanges = 0;
  apiCalls: ApiCall[] = [];
  /** While set, `object.embed` answers wait for it, after reading their answer: a request in flight. */
  embedGate: Promise<void> | null = null;
  /** Embed requests that have reached the gate. */
  embedsHeld = 0;
  /** What `GET /project/board-snapshot` answers instead of the bound board, when set. */
  snapshotAnswer: (() => Response) | null = null;
  /** While set, board snapshot answers wait for it, after reading their answer: a request in flight. */
  snapshotGate: Promise<void> | null = null;
  /** Snapshot requests that have reached the gate. */
  snapshotsHeld = 0;
  #serial = 0;

  /** The access token of the session `refreshToken` names. */
  accessOf(refreshToken: string): string {
    return this.sessions.get(refreshToken)!.access;
  }

  #issue(): { token: string; refreshToken: string } {
    const n = ++this.#serial;
    const token = `${jwt(Date.now() + this.accessTtlMs)}.${n}`;
    const refreshToken = `refresh-${n}`;
    this.access.add(token);
    this.sessions.set(refreshToken, { access: token });
    return { token, refreshToken };
  }

  /** Ends a session: its refresh token stops rotating and its access token stops working. */
  endSession(refreshToken: string): void {
    const session = this.sessions.get(refreshToken);
    this.sessions.delete(refreshToken);
    if (session) this.access.delete(session.access);
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (url.pathname === "/auth/token") {
      this.exchanges++;
      return Response.json({
        ...this.#issue(),
        user: {
          id: "u1", email: "ada@example.com", emailVerified: this.emailVerified, name: "Ada",
          tenantId: "t1",
          workspaces: this.workspaces.map(w => ({ ...w, role: "member", deniedPermissions: [] })),
        },
      });
    }
    if (url.pathname === "/auth/refresh") {
      this.refreshes.push(body.refreshToken!);
      if (!this.sessions.has(body.refreshToken!)) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      this.endSession(body.refreshToken!);
      return Response.json(this.#issue());
    }
    if (url.pathname === "/auth/logout") {
      this.logouts.push(body.refreshToken!);
      this.endSession(body.refreshToken!);
      return new Response(null, { status: 204 });
    }
    const headers = new Headers(init.headers);
    const token = headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
    const workspaceId = headers.get("x-workspace-id");
    if (url.pathname === "/workspaces") {
      // The principal lane: a valid token, no workspace header.
      this.workspaceLists++;
      if (this.workspaceListDown) return new Response("down", { status: 502 });
      if (!token || !this.access.has(token) || workspaceId) {
        return Response.json({ error: { code: "UNAUTHORIZED", message: "bad token" } }, { status: 401 });
      }
      return Response.json([...this.slugs].map(([id, slug]) => ({
        id, tenant_id: "t1", product: "inferops", name: slug, slug,
      })));
    }
    this.apiCalls.push({ path: url.pathname + url.search, token, workspaceId });
    if (!token || !this.access.has(token)) {
      return Response.json({ error: { code: "UNAUTHORIZED", message: "bad token" } }, { status: 401 });
    }
    if (url.pathname === "/project/board-snapshot") {
      // InferOps' principal lane: the reference names its own tenant and workspace, which must be
      // the reader's; any miss is one generic NOT_FOUND.
      const answer = this.snapshotAnswer?.() ?? (url.searchParams.get("ref") === BOARD_URL &&
        this.memberships.has(OPS) && url.searchParams.size === 1
        ? Response.json({ scope: { workspaceId: OPS, projectId: DEMO.id }, snapshot: SNAPSHOT })
        : Response.json({ error: { code: "NOT_FOUND", message: "Resource not found" } }, { status: 404 }));
      if (this.snapshotGate) {
        this.snapshotsHeld++;
        await this.snapshotGate;
      }
      return answer;
    }
    if (!workspaceId || !this.memberships.has(workspaceId)) {
      return Response.json({ error: { code: "FORBIDDEN", message: "not a member" } }, { status: 403 });
    }
    if (url.pathname.startsWith("/knowledge/")) {
      // InferOps' product gate, then the permission check: both answer 403 FORBIDDEN.
      if (!this.infermind.has(workspaceId)) {
        return Response.json({ error: { code: "FORBIDDEN", message: "Wrong product for this route" } }, { status: 403 });
      }
      if (this.knowledgeDenied) {
        return Response.json({ error: { code: "FORBIDDEN", message: "Missing permission: knowledge:read" } }, { status: 403 });
      }
      const handbook = {
        id: HANDBOOK, workspaceId, slug: "handbook", title: "Handbook", summary: null, pathway: null,
        parentId: null, siblingOrder: 0,
      };
      if (url.pathname === "/knowledge/documents") return Response.json([handbook]);
      if (url.pathname === `/knowledge/documents/${HANDBOOK}`) {
        return Response.json({ ...handbook, ...this.page, masterRole: null });
      }
      if (url.pathname === `/knowledge/wiki/pages/${HANDBOOK}` && init.method === "PATCH") {
        if (Number(body.expectedVersion) !== this.page.version) {
          return Response.json({ error: { code: "STALE_VERSION", message: "stale" } }, { status: 409 });
        }
        this.pageWrites.push({ body: body.body!, idempotencyKey: headers.get("x-idempotency-key") });
        this.page = { body: body.body!, version: this.page.version + 1 };
        return Response.json({ document: { id: HANDBOOK, version: this.page.version } });
      }
    }
    if (url.pathname === "/object/embed") {
      // InferOps' principal-lane read: the reference names its own tenant and workspace, and both
      // must be the reader's (the person is in tenant `acme`); anything else is one NOT_FOUND.
      const ref = new URL((url.searchParams.get("ref") ?? "").replace(/^inferops:/, "https:"));
      const [tenant, workspace] = ref.hostname.split(".");
      const held = [...this.slugs].find(([id, slug]) => slug === workspace && this.memberships.has(id));
      const [, widget, id] = ref.pathname.split("/").filter(Boolean);
      if (tenant !== "acme" || !held) {
        return Response.json({ success: false, error: { code: "NOT_FOUND", message: "no such widget target" } }, { status: 404 });
      }
      if (widget === "table-view" && id === TABLE) {
        const answer = Response.json({ widget: "table-view", type: TABLE_TYPE, records: [TABLE_RECORD] });
        if (this.embedGate) {
          this.embedsHeld++;
          await this.embedGate;
        }
        return answer;
      }
      if (widget === "record-card" && id === TABLE_ROW) {
        return Response.json({ widget: "record-card", type: TABLE_TYPE, record: TABLE_RECORD });
      }
      return Response.json({ success: false, error: { code: "NOT_FOUND", message: "no such widget target" } }, { status: 404 });
    }
    if (url.pathname === "/object/types") return Response.json({ types: [TABLE_TYPE] });
    if (url.pathname === "/project/projects") return Response.json({ projects: [DEMO] });
    if (url.pathname === "/project/board") {
      return Response.json({
        projectId: DEMO.id, projects: [DEMO],
        columns: [{
          state: { id: READY, name: "Ready", group: "unstarted", position: 1, workflow: "software" },
          issues: [{
            id: DEMO_1, identifier: "DEMO-1", title: "First", priority: "high", stateId: READY,
            targetDate: null, workflow: "software", revision: "1041", assigneeId: null,
            blockedReason: null,
          }],
        }],
      });
    }
    if (url.pathname === `/project/issues/${DEMO_1}` && (init.method ?? "GET") === "GET") {
      return Response.json({
        issue: {
          id: DEMO_1, identifier: "DEMO-1", title: "First", priority: "high", stateId: READY,
          targetDate: null, workflow: "software", revision: "1041", assigneeId: null,
          blockedReason: null, projectId: DEMO.id,
        },
      });
    }
    return Response.json({ error: { code: "NOT_FOUND", message: "no route" } }, { status: 404 });
  };
}

let inferlab: FakeInferLab;
let accounts = 0;
beforeEach(() => {
  inferlab = new FakeInferLab();
  vi.stubGlobal("fetch", inferlab.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Runs `body` with the test worker's exports, from inside a throwaway sign-in object. */
async function withExports<R>(body: (exports: SignInExports) => Promise<R>): Promise<R> {
  const stub = env.INFERLAB_LOGIN.get(env.INFERLAB_LOGIN.newUniqueId());
  return runInDurableObject(stub, (_: InferLabLogin, state) =>
    body(state.exports as unknown as SignInExports));
}

function get(url: string): Promise<Response | null> {
  return handleInferLabLogin(new Request(url), LOGIN_ENV, env.INFERLAB_LOGIN);
}

/** Drives a popup URL through InferLab's authorize redirect and the callback leg. */
async function finish(url: string): Promise<Response> {
  const redirect = await get(url);
  expect(redirect?.status).toBe(302);
  const state = new URL(redirect!.headers.get("Location")!).searchParams.get("state");
  const response = await get(`${REDIRECT_URI}?code=the-code&state=${state}`);
  expect(response).not.toBeNull();
  return response!;
}

/** Connects a fresh account under `label` and returns the props the Workshop would hold for it. */
async function connect(label: string): Promise<AccountProps> {
  const url = await withExports(async exports => {
    const vendor = exports.GatekeeperVendor({});
    const callback = exports.TestConnectCallback({ props: { label } });
    return (await vendor.connectAccount(callback as never, { scopes: "full" })).url;
  });
  const accountId = `00000000-0000-4000-8000-${String(++accounts).padStart(12, "0")}`;
  // The connect leg mints exactly one id: the account's.
  const minted = vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(accountId as `${string}-${string}-${string}-${string}-${string}`);
  const response = await finish(url);
  minted.mockRestore();
  expect(response.status, await response.text()).toBe(200);
  const email = signIns.find(s => s.label === label)?.email ?? undefined;
  return { accountId, connected: true, email };
}

const hooks = () => env.TEST_HOOKS.get(env.TEST_HOOKS.idFromName("accounts"));

/** A board session over the binding `account` mints for `url`, named `name`. */
async function bindBoard(account: AccountProps, name: string, url = BOARD_URL) {
  expect(await hooks().bindAccount(name, account, url)).toBeNull();
  return hooks().startBoundSession(name);
}

const lastApiCall = () => inferlab.apiCalls[inferlab.apiCalls.length - 1]!;

/** The message an awaited call failed with, or "" when it succeeded. */
async function failure(call: PromiseLike<unknown>): Promise<string> {
  try {
    await call;
    return "";
  } catch (error) {
    return String(error);
  }
}

describe("connecting", () => {
  it("is a real connect flow once an InferLab origin is configured", async () => {
    await withExports(async exports => {
      expect(await exports.GatekeeperVendor({}).describe())
        .toMatchObject({ providesAuth: true, autoProvisionsAccount: false });
    });
  });

  it("keeps the person's session and backs the account with it", async () => {
    const account = await connect("keep");

    expect(inferlab.exchanges).toBe(1);
    // Unlike a sign-in, a connect keeps the session: nothing is signed out.
    expect(inferlab.logouts).toEqual([]);
    expect(signIns).toContainEqual({ label: "keep", email: "ada@example.com" });
    expect(await hooks().describeAccount(account)).toMatchObject({
      displayName: `InferOps (${API_HOST})`, uniqueName: "ada@example.com",
    });
  });

  it("does not vouch for an email InferLab has not verified, but still connects", async () => {
    inferlab.emailVerified = false;
    const account = await connect("unverified");
    expect(account.email).toBeUndefined();
    expect(await hooks().authenticatedEmail(account)).toBeNull();
    expect(await hooks().describeAccount(account)).toMatchObject({ uniqueName: "ada@example.com" });
  });
});

describe("requests as the person", () => {
  it("carries the person's token and their workspace on every InferOps request", async () => {
    const account = await connect("headers");
    const token = inferlab.accessOf("refresh-1");

    const session = await bindBoard(account, "headers");
    const board = await session.readBoard();

    expect(board.project.identifier).toBe("DEMO");
    expect(inferlab.apiCalls.length).toBeGreaterThan(0);
    for (const call of inferlab.apiCalls) {
      expect(call.token).toBe(token);
      expect(call.workspaceId).toBe(OPS);
    }
    expect(inferlab.refreshes).toEqual([]);
  });

  it("refreshes an access token about to expire, rotating the session once", async () => {
    inferlab.accessTtlMs = 30_000;
    const account = await connect("refresh");
    const first = inferlab.accessOf("refresh-1");
    inferlab.accessTtlMs = HOUR;

    const session = await bindBoard(account, "refresh");
    await session.readBoard();

    expect(inferlab.refreshes).toEqual(["refresh-1"]);
    for (const call of inferlab.apiCalls) expect(call.token).not.toBe(first);
    expect(inferlab.sessions.has("refresh-2")).toBe(true);
  });

  it("heals a token InferOps rejects by refreshing, and retries once", async () => {
    const account = await connect("rejected");
    const session = await bindBoard(account, "rejected");
    // The access token stops working while the session itself stays refreshable.
    inferlab.access.delete(inferlab.accessOf("refresh-1"));

    const board = await session.readBoard();

    expect(board.project.identifier).toBe("DEMO");
    expect(inferlab.refreshes).toEqual(["refresh-1"]);
    expect(lastApiCall().token).toBe(inferlab.accessOf("refresh-2"));
    expect(expired).not.toContain("rejected");
  });

  it("reports a dead session once and refuses the account until it is reconnected", async () => {
    const account = await connect("dead");
    const session = await bindBoard(account, "dead");
    inferlab.endSession("refresh-1");

    expect(await failure(session.readBoard())).toContain("UNAUTHORIZED");
    expect(await failure(session.readBoard())).toContain("UNAUTHORIZED");

    expect(inferlab.refreshes).toEqual(["refresh-1"]);
    expect(expired.filter(label => label === "dead")).toEqual(["dead"]);
  });
});

describe("writes as the person", () => {
  it("does not apply a create or update proposed before the person's session ended", async () => {
    const account = await connect("ended-write");
    const session = await bindBoard(account, "ended-write");
    await session.createIssue({ title: "Proposed while signed in" });
    await session.openIssue(DEMO_1).update({ title: "Renamed" }, "1041");
    const proposed = (await hooks().log()).actions.slice(-2);
    expect(proposed.map(a => a.title))
      .toEqual(["Create issue: Proposed while signed in", "Update DEMO-1: title"]);
    inferlab.endSession("refresh-1");
    const writesBefore = inferlab.apiCalls.length;

    for (const action of proposed) {
      expect(await hooks().applyBound("ended-write", action.id))
        .toContain("does not permit it for this connection");
    }
    // Nothing reached InferOps' write endpoints with the dead token.
    expect(inferlab.apiCalls.slice(writesBefore).every(c => !c.path.startsWith("/project/issues")))
      .toBe(true);
  });
});

describe("revoking", () => {
  it("signs the session out at InferLab and forgets it", async () => {
    const account = await connect("revoke");
    const session = await bindBoard(account, "revoke");
    await session.readBoard();

    await hooks().revokeAccount(account);

    expect(inferlab.logouts).toEqual(["refresh-1"]);
    expect(await failure(session.readBoard())).toContain("not connected");
    // A disconnect is the person's own action, not an expiry.
    expect(expired).not.toContain("revoke");
  });
});

describe("reconnecting", () => {
  it("stages the new session until the Workshop commits it, then signs the old one out", async () => {
    const account = await connect("reconnect");
    const session = await bindBoard(account, "reconnect");
    const first = inferlab.accessOf("refresh-1");

    const response = await finish(await hooks().reconnectAccount(account));
    const html = await response.text();
    expect(response.status, html).toBe(200);
    expect(html).toContain("reticket-reconnect");
    const stageId = reconnects.find(r => r.label === "reconnect")!.stageId;

    // Staged, not live: reads still use the first session.
    await session.readBoard();
    expect(lastApiCall().token).toBe(first);

    expect(await hooks().commitReconnect(account, stageId)).toBeNull();
    await session.readBoard();
    expect(lastApiCall().token).toBe(inferlab.accessOf("refresh-2"));
    expect(inferlab.logouts).toEqual(["refresh-1"]);
    expect(await hooks().commitReconnect(account, stageId)).toContain("awaiting confirmation");
  });
});

describe("workspaces named by board URLs", () => {
  it("stores each membership's slug at connect time and offers them by slug", async () => {
    const account = await connect("slugs");
    expect(inferlab.workspaceLists).toBe(1);
    expect(await hooks().listWorkspaces(account))
      .toEqual([{ value: "operations", title: "Ops", subtitle: "operations" }]);
    // A connected person names organization and workspace; only demo data has a default.
    expect(await hooks().defaultHost(account)).toBeNull();
  });

  it("resolves the URL's workspace slug to the person's own workspace and its credentials", async () => {
    const account = await connect("resolve");
    const session = await bindBoard(account, "resolve");
    await session.readBoard();
    expect(inferlab.apiCalls.length).toBeGreaterThan(0);
    for (const call of inferlab.apiCalls) {
      expect(call.workspaceId).toBe(OPS);
      expect(call.token).toBe(inferlab.accessOf("refresh-1"));
    }    expect(await hooks().mockOf(account, BOARD_URL)).toBe(false);
  });

  it("binds each of several workspaces by its own slug", async () => {
    inferlab.workspaces.push({ workspaceId: SALES, workspaceName: "Sales", product: "inferops" });
    inferlab.memberships.add(SALES);
    const account = await connect("several");

    expect(await hooks().listProjects(account, "acme.sales")).toEqual(["DEMO"]);
    expect(lastApiCall().workspaceId).toBe(SALES);
    const sales = await bindBoard(account, "several-sales", SALES_URL);
    const ops = await bindBoard(account, "several-ops", BOARD_URL);

    await sales.readBoard();
    expect(lastApiCall().workspaceId).toBe(SALES);
    await ops.readBoard();
    expect(lastApiCall().workspaceId).toBe(OPS);
  });

  it("refuses a workspace the person does not hold exactly like a missing project, before any request", async () => {
    const account = await connect("outside");
    // `knowledge` is a workspace of the tenant the person is not a member of; `nowhere` does not exist.
    const outside = await hooks().bindAccount("outside-1", account,
      "inferops://acme.knowledge/project/board/DEMO");
    const missing = await hooks().bindAccount("outside-2", account,
      "inferops://acme.nowhere/project/board/DEMO");
    const unknownProject = await hooks().bindAccount("outside-3", account,
      "inferops://acme.operations/project/board/NOPE");
    expect(outside).toBe("No InferOps project DEMO is available on acme.knowledge.");
    expect(missing).toBe("No InferOps project DEMO is available on acme.nowhere.");
    expect(unknownProject).toBe("No InferOps project NOPE is available on acme.operations.");
    expect(await hooks().listProjects(account, "acme.knowledge")).toEqual([]);
    // Only the unknown project's lookup reached InferOps, in the person's own workspace.
    for (const call of inferlab.apiCalls) expect(call.workspaceId).toBe(OPS);
  });

  it("takes no authority from the tenant label: a tampered tenant still means the person's own workspace", async () => {
    const account = await connect("tenant");
    // The identity carries a tenant id, never its slug, so the label is not compared (as in
    // InferOps); the workspace still resolves only among the person's own memberships.
    const session = await bindBoard(account, "tenant", "inferops://globex.operations/project/board/DEMO");
    await session.readBoard();
    for (const call of inferlab.apiCalls) expect(call.workspaceId).toBe(OPS);
    expect(await hooks().bindAccount("tenant-2", account, "inferops://globex.knowledge/project/board/DEMO"))
      .toBe("No InferOps project DEMO is available on globex.knowledge.");
  });

  it.each([
    "inferops://localhost:8080/project/board/DEMO",
    "inferops://operations/project/board/DEMO",
    "inferops://acme.operations.extra/project/board/DEMO",
    "inferops://ACME.operations/project/board/DEMO",
  ])("rejects the malformed authority of %s without a request", async url => {
    const account = await connect(`malformed-${url}`);
    expect(await hooks().bindAccount("malformed", account, url)).toContain("Not an InferOps project board URL");
    expect(inferlab.apiCalls).toEqual([]);
  });

  it("keeps demo.local the built-in demo data, never InferOps", async () => {
    const account = await connect("demo");
    const session = await bindBoard(account, "demo", "inferops://demo.local/project/board/DEMO");
    const board = await session.readBoard();
    expect(board.project.identifier).toBe("DEMO");
    expect(inferlab.apiCalls).toEqual([]);
    // Reported as mock data, so the Workshop refuses it in a space that is not test-only.
    expect(await hooks().mockOf(account, "inferops://demo.local/project/board/DEMO")).toBe(true);
  });

  it("fails the connect and signs the session out when InferOps cannot list the workspaces", async () => {
    inferlab.workspaceListDown = true;
    const url = await withExports(async exports => {
      const vendor = exports.GatekeeperVendor({});
      const callback = exports.TestConnectCallback({ props: { label: "list-down" } });
      return (await vendor.connectAccount(callback as never, { scopes: "full" })).url;
    });
    const response = await finish(url);
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("could not list your workspaces");
    expect(inferlab.logouts).toEqual(["refresh-1"]);
    expect(signIns.find(s => s.label === "list-down")).toBeUndefined();
  });

  it("is denied by InferOps for a workspace the token cannot enter, without expiring the account", async () => {
    // InferLab listed Sales at sign-in, but InferOps no longer admits this person there.
    inferlab.workspaces.push({ workspaceId: SALES, workspaceName: "Sales", product: "inferops" });
    const account = await connect("denied");

    expect(await hooks().bindAccount("denied", account, SALES_URL)).toContain("FORBIDDEN");
    expect(lastApiCall().workspaceId).toBe(SALES);
    expect(inferlab.refreshes).toEqual([]);
    expect(expired).not.toContain("denied");

    // In a workspace the person belongs to, the same account works.
    await bindBoard(account, "denied");
  });

  it("admits a collaborator only when their own account reaches the project in the binding's workspace", async () => {
    inferlab.workspaces.push({ workspaceId: SALES, workspaceName: "Sales", product: "inferops" });
    inferlab.memberships.add(SALES);
    const owner = await connect("owner");
    await bindBoard(owner, "shared", SALES_URL);

    // A collaborator who belongs to Sales too.
    const member = await connect("member");
    expect(await hooks().addObserverFrom("shared", member)).toBeNull();

    // A collaborator whose InferLab account never listed Sales: refused before any request.
    inferlab.workspaces = inferlab.workspaces.filter(w => w.workspaceId !== SALES);
    const outsider = await connect("outsider");
    const calls = inferlab.apiCalls.length;
    expect(await hooks().addObserverFrom("shared", outsider)).toContain("cannot open");
    expect(inferlab.apiCalls.length).toBe(calls);
  });
});

describe("the InferMind Wiki of a connected person", () => {
  const WIKI = "inferops://acme.mind/knowledge/wiki";

  /** A person who belongs to the InferOps workspace `operations` and the InferMind workspace `mind`. */
  async function mindPerson(label: string) {
    inferlab.workspaces.push({ workspaceId: MIND, workspaceName: "Mind", product: "infermind" });
    inferlab.memberships.add(MIND);
    return connect(label);
  }

  it("binds the person's InferMind workspace by slug and reads it with their own token there", async () => {
    const account = await mindPerson("mind");
    expect((await hooks().listWikiWorkspaces(account)).map(w => w.value)).toEqual(["mind"]);
    expect((await hooks().listWorkspaces(account)).map(w => w.value)).toEqual(["operations"]);

    expect(await hooks().bindAccount("mind-wiki", account, WIKI)).toBeNull();
    const pages = await hooks().startBoundWikiSession("mind-wiki").listDocuments();
    expect(pages.map(p => p.slug)).toEqual(["handbook"]);
    expect(lastApiCall()).toMatchObject({ path: "/knowledge/documents", workspaceId: MIND });
    expect(lastApiCall().token).toBe(inferlab.accessOf("refresh-1"));
  });

  it("refuses an InferOps workspace as having no Wiki, before any request", async () => {
    const account = await mindPerson("nomind");
    const before = inferlab.apiCalls.length;
    expect(await hooks().bindAccount("ops-wiki", account, "inferops://acme.operations/knowledge/wiki"))
      .toBe("FORBIDDEN: acme.operations is an InferOps workspace without InferMind, so it has no Wiki.");
    // And an InferMind workspace is no board workspace.
    expect(await hooks().bindAccount("mind-board", account, "inferops://acme.mind/project/board/DEMO"))
      .toBe("No InferOps project DEMO is available on acme.mind.");
    expect(inferlab.apiCalls.length).toBe(before);
  });

  it("refuses a workspace the person does not hold like a missing Wiki, and takes nothing from the tenant label", async () => {
    const account = await mindPerson("elsewhere");
    const before = inferlab.apiCalls.length;
    expect(await hooks().bindAccount("w1", account, "inferops://acme.knowledge/knowledge/wiki"))
      .toBe("No InferMind Wiki is available on acme.knowledge.");
    expect(await hooks().bindAccount("w2", account, "inferops://acme.nowhere/knowledge/wiki"))
      .toBe("No InferMind Wiki is available on acme.nowhere.");
    expect(inferlab.apiCalls.length).toBe(before);

    // A tampered tenant label still means the person's own `mind` workspace.
    expect(await hooks().bindAccount("w3", account, "inferops://globex.mind/knowledge/wiki")).toBeNull();
    await hooks().startBoundWikiSession("w3").listDocuments();
    expect(lastApiCall().workspaceId).toBe(MIND);
  });

  it("reports InferOps' refusal (product or knowledge permission) as FORBIDDEN, without expiring the account", async () => {
    const account = await mindPerson("denied");
    expect(await hooks().bindAccount("denied-wiki", account, WIKI)).toBeNull();

    inferlab.knowledgeDenied = true;
    const message = await failure(hooks().startBoundWikiSession("denied-wiki").listDocuments());
    expect(message).toContain("FORBIDDEN: InferOps refused the Wiki for this connection");
    expect(message).not.toContain("Missing permission");
    expect(await hooks().bindAccount("denied-again", account, WIKI)).toContain("FORBIDDEN");
    expect(expired).not.toContain("denied");

    // The workspace stops being an InferMind one in InferOps after the connect.
    inferlab.knowledgeDenied = false;
    inferlab.infermind.delete(MIND);
    expect(await failure(hooks().startBoundWikiSession("denied-wiki").listDocuments()))
      .toContain("FORBIDDEN: InferOps refused the Wiki");
  });

  it("sends nothing for a page edit once the session is dead, and applies the same edit after a reconnect", async () => {
    const account = await mindPerson("dead-wiki");
    expect(await hooks().bindAccount("dead-wiki", account, WIKI)).toBeNull();
    await hooks().startBoundWikiSession("dead-wiki").updateDocumentBody(HANDBOOK, "Rewritten.", 3);
    const [action] = (await hooks().log()).actions.slice(-1);
    expect(action!.title).toContain("Handbook");

    // The session dies; the account learns it, so its credentials now fail before any request.
    inferlab.endSession("refresh-1");
    expect(await failure(hooks().startBoundWikiSession("dead-wiki").listDocuments())).toContain("UNAUTHORIZED");
    const callsBefore = inferlab.apiCalls.length;

    // Known not applied, not "possibly applied": nothing was sent, so it is not reconcile-only.
    const refused = await hooks().applyBound("dead-wiki", action!.id);
    expect(refused).toContain("was not applied");
    expect(refused).not.toContain("may or may not");
    expect(inferlab.apiCalls.slice(callsBefore)).toEqual([]);
    expect(inferlab.pageWrites).toEqual([]);

    const stageId = await (async () => {
      const response = await finish(await hooks().reconnectAccount(account));
      expect(response.status, await response.text()).toBe(200);
      return reconnects.find(r => r.label === "dead-wiki")!.stageId;
    })();
    expect(await hooks().commitReconnect(account, stageId)).toBeNull();

    expect(await hooks().applyBound("dead-wiki", action!.id)).toBeNull();
    expect(inferlab.pageWrites).toEqual([{ body: "Rewritten.", idempotencyKey: expect.stringMatching(/:\d+$/) }]);
    expect(inferlab.page.version).toBe(4);
  });

  it("admits a Wiki observer only when their own account reads the binding's Wiki", async () => {
    const owner = await mindPerson("wikiowner");
    expect(await hooks().bindAccount("shared-wiki", owner, WIKI)).toBeNull();
    const member = await connect("wikimember");
    expect(await hooks().addWikiObserverFrom("shared-wiki", member)).toBeNull();

    inferlab.memberships.delete(MIND);
    const outsider = await connect("wikioutsider");
    expect(await hooks().addWikiObserverFrom("shared-wiki", outsider))
      .toContain("cannot read the InferMind Wiki of acme.mind");
  });
});

describe("custom tables as the person", () => {
  const tables = env as unknown as { INFEROPS_TABLES_ENABLED?: string };
  beforeEach(() => { tables.INFEROPS_TABLES_ENABLED = "true"; });
  afterEach(() => { delete tables.INFEROPS_TABLES_ENABLED; });

  it("reads with the person's own token, through object.embed for the whole tenant.workspace, GET only", async () => {
    const account = await connect("table");
    expect(await hooks().bindAccount("table", account, TABLE_URL)).toBeNull();
    const { table, records } = await hooks().startBoundTableSession("table").listRecords();
    expect(table.columns.map(c => c.name)).toEqual(["serial"]);
    expect(records).toEqual([{ id: TABLE_ROW, tableVersion: 2, values: { serial: "SN-1" }, links: [] }]);
    expect(JSON.stringify({ table, records })).not.toContain("Ada");
    const embeds = inferlab.apiCalls.filter(c => c.path.startsWith("/object/embed"));
    expect(embeds.length).toBeGreaterThanOrEqual(2);
    for (const call of embeds) {
      expect(new URLSearchParams(call.path.split("?")[1]).get("ref"))
        .toMatch(new RegExp(`^inferops://acme\\.operations/object/table-view/${TABLE}\\?limit=`));
      expect(call.workspaceId).toBe(OPS);
      expect(call.token).toBe(inferlab.accessOf("refresh-1"));
    }
    expect(await hooks().listPickerTables(account, "acme.operations")).toEqual([
      expect.objectContaining({ value: TABLE, title: "Assets" }),
    ]);
  });

  it("refuses a colliding tenant label: InferOps checks the whole tenant.workspace on every read", async () => {
    const account = await connect("table-collide");
    // `operations` is the person's workspace slug, but `globex` is not their tenant. Unlike a board,
    // the label reaches InferOps in the reference, which refuses it, so the binding is refused.
    expect(await hooks().bindAccount("collide", account, `inferops://globex.operations/object/table/${TABLE}`))
      .toBe("No such InferOps custom table is available to you on globex.operations.");
    const probe = inferlab.apiCalls.find(c => c.path.startsWith("/object/embed"))!;
    expect(new URLSearchParams(probe.path.split("?")[1]).get("ref")).toContain("inferops://globex.operations/");
  });

  it("refuses a workspace the person does not hold, before any request, as it refuses a missing table", async () => {
    const account = await connect("table-outside");
    const outside = await hooks().bindAccount("t-outside", account, `inferops://acme.knowledge/object/table/${TABLE}`);
    const missing = await hooks().bindAccount("t-missing", account,
      "inferops://acme.operations/object/table/70000000-0000-4000-8000-0000000000ff");
    expect(outside).toBe("No such InferOps custom table is available to you on acme.knowledge.");
    expect(missing).toBe("No such InferOps custom table is available to you on acme.operations.");
    expect(inferlab.apiCalls.every(c => c.workspaceId === OPS)).toBe(true);
  });

  it("refuses reads once the session has ended, and once the account is revoked", async () => {
    const ended = await connect("table-ended");
    expect(await hooks().bindAccount("t-ended", ended, TABLE_URL)).toBeNull();
    inferlab.endSession("refresh-1");
    expect(await failure(hooks().startBoundTableSession("t-ended").listRecords())).toContain("UNAUTHORIZED");

    const revoked = await connect("table-revoked");
    expect(await hooks().bindAccount("t-revoked", revoked, TABLE_URL)).toBeNull();
    const session = hooks().startBoundTableSession("t-revoked");
    await session.describeTable();
    await hooks().revokeAccount(revoked);
    expect(await failure(session.listRecords())).toContain("not connected");
  });

  it("reads with the reconnected session once the Workshop commits it", async () => {
    const account = await connect("table-reconnect");
    expect(await hooks().bindAccount("t-reconnect", account, TABLE_URL)).toBeNull();
    const session = hooks().startBoundTableSession("t-reconnect");
    await session.listRecords();
    const first = inferlab.accessOf("refresh-1");
    expect((await finish(await hooks().reconnectAccount(account))).status).toBe(200);
    const stageId = reconnects.find(r => r.label === "table-reconnect")!.stageId;
    // Staged, not live: reads still use the first session.
    await session.listRecords();
    expect(lastApiCall().token).toBe(first);
    expect(await hooks().commitReconnect(account, stageId)).toBeNull();
    await session.listRecords();
    expect(lastApiCall().token).toBe(inferlab.accessOf("refresh-2"));
    expect(inferlab.logouts).toEqual(["refresh-1"]);
  });

  /** Starts a table read whose InferOps answer is held until `release()`; the read's outcome. */
  async function heldRead(name: string) {
    let release!: () => void;
    inferlab.embedGate = new Promise<void>(resolve => { release = resolve; });
    const before = inferlab.embedsHeld;
    const outcome = failure(hooks().startBoundTableSession(name).listRecords());
    await vi.waitFor(() => expect(inferlab.embedsHeld).toBe(before + 1));
    return {
      settle: async () => {
        inferlab.embedGate = null;
        release();
        return outcome;
      },
    };
  }

  const tableObservations = async () =>
    (await hooks().log()).observations.filter(title => title === "List InferOps custom table rows").length;

  it("discards an answer that arrives after a reconnect committed while it was in flight", async () => {
    const account = await connect("table-fence-reconnect");
    expect(await hooks().bindAccount("t-fence-reconnect", account, TABLE_URL)).toBeNull();
    const observed = await tableObservations();
    const read = await heldRead("t-fence-reconnect");

    expect((await finish(await hooks().reconnectAccount(account))).status).toBe(200);
    const stageId = reconnects.find(r => r.label === "table-fence-reconnect")!.stageId;
    expect(await hooks().commitReconnect(account, stageId)).toBeNull();

    // InferOps answered the old session's request successfully; the answer is still discarded.
    expect(await read.settle()).toBe("InferOpsError: UNAVAILABLE: This InferOps connection changed. Try again.");
    expect(await tableObservations()).toBe(observed);
    // The next read runs under the new session.
    expect((await hooks().startBoundTableSession("t-fence-reconnect").listRecords()).records).toHaveLength(1);
    expect(lastApiCall().token).toBe(inferlab.accessOf("refresh-2"));
  });

  it("discards an answer that arrives after the account was revoked while it was in flight", async () => {
    const account = await connect("table-fence-revoke");
    expect(await hooks().bindAccount("t-fence-revoke", account, TABLE_URL)).toBeNull();
    const observed = await tableObservations();
    const read = await heldRead("t-fence-revoke");

    await hooks().revokeAccount(account);

    const outcome = await read.settle();
    expect(outcome).toMatch(/^InferOpsError: (UNAVAILABLE|UNAUTHORIZED): /);
    expect(outcome).not.toContain("SN-1");
    expect(await tableObservations()).toBe(observed);
    expect(await failure(hooks().startBoundTableSession("t-fence-revoke").listRecords())).not.toBe("");
  });

  it("never admits a collaborator, even one who holds the workspace", async () => {
    const owner = await connect("table-owner");
    expect(await hooks().bindAccount("t-shared", owner, TABLE_URL)).toBeNull();
    const member = await connect("table-member");
    expect(await hooks().addTableObserverFrom("t-shared", member)).toContain("cannot be shared");
  });
});

describe("host boards, the kernel-only read of a board binding's fixed target", () => {
  const vars = env as unknown as { INFEROPS_HOST_BOARDS?: string; INFEROPS_ENABLED?: string };
  beforeEach(() => { vars.INFEROPS_HOST_BOARDS = "true"; });
  afterEach(() => {
    delete vars.INFEROPS_HOST_BOARDS;
    delete vars.INFEROPS_ENABLED;
  });

  // The hooks' RPC typing loses the union, so the answers are typed back here.
  type BindingProps = { accountId: string; host: string; projectKey: string; connected?: boolean; workspaceId?: string };
  const boardOf = async (name: string) => await hooks().boundHostBoard(name) as unknown as HostBoardRead;
  const fenceOf = async (name: string) => await hooks().boundHostFence(name) as unknown as HostBoardFence | null;
  const boardFor = async (props: BindingProps) => await hooks().hostBoard(props) as unknown as HostBoardRead;
  const fenceFor = async (props: BindingProps) => await hooks().hostFence(props) as unknown as HostBoardFence | null;
  const okRead = (read: HostBoardRead) => {
    if (read.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(read)}`);
    return read;
  };

  const snapshotCalls = () => inferlab.apiCalls.filter(c => c.path.startsWith("/project/board-snapshot"));

  /** Connects `label`, binds the board and returns the account and the API calls the binding made. */
  async function bound(label: string) {
    const account = await connect(label);
    expect(await hooks().bindAccount(label, account, BOARD_URL)).toBeNull();
    return { account, before: inferlab.apiCalls.length };
  }

  /** Only board snapshot reads were sent since `before`: never project.board, the project list or anything else. */
  function expectOnlySnapshotsSince(before: number) {
    for (const call of inferlab.apiCalls.slice(before)) expect(call.path).toMatch(/^\/project\/board-snapshot\?ref=/);
  }

  it("reads the binding's own board on the principal lane, with its scope and the fence of the attempt", async () => {
    const { before } = await bound("hb-ok");
    const observed = (await hooks().log()).observations.length;

    const read = await boardOf("hb-ok");

    expect(read).toEqual({
      status: "ok",
      scope: { workspaceId: OPS, projectId: DEMO.id },
      snapshot: SNAPSHOT,
      fence: await fenceOf("hb-ok"),
    });
    expect(okRead(read).fence.identity).not.toBe("");
    expect(snapshotCalls()).toHaveLength(1);
    const [call] = snapshotCalls();
    expect(new URLSearchParams(call!.path.split("?")[1]).get("ref")).toBe(BOARD_URL);
    expect(call!.workspaceId).toBeNull();
    expect(call!.token).toBe(inferlab.accessOf("refresh-1"));
    expectOnlySnapshotsSince(before);
    // The kernel owns the audit: the gatekeeper records no observation.
    expect((await hooks().log()).observations).toHaveLength(observed);
  });

  it("is unreachable while INFEROPS_HOST_BOARDS is off, or while InferOps is off whatever it says", async () => {
    const { before } = await bound("hb-off");
    delete vars.INFEROPS_HOST_BOARDS;
    expect(await boardOf("hb-off")).toEqual({ status: "unavailable", reason: "disabled" });
    expect(await fenceOf("hb-off")).toBeNull();
    vars.INFEROPS_HOST_BOARDS = "yes";
    expect(await boardOf("hb-off")).toEqual({ status: "unavailable", reason: "disabled" });
    vars.INFEROPS_HOST_BOARDS = "true";
    vars.INFEROPS_ENABLED = "false";
    expect(await boardOf("hb-off")).toEqual({ status: "unavailable", reason: "disabled" });
    expect(await fenceOf("hb-off")).toBeNull();
    expect(inferlab.apiCalls.length).toBe(before);
    // Back on, the same binding reads again: the switch deletes nothing.
    delete vars.INFEROPS_ENABLED;
    expect((await boardOf("hb-off")).status).toBe("ok");
  });

  it("takes its target from the props alone and refuses a key outside InferOps' bound before any request", async () => {
    const account = await connect("hb-key");
    const before = inferlab.apiCalls.length;
    const props = { accountId: account.accountId, connected: true, host: "acme.operations", workspaceId: OPS };
    for (const projectKey of ["DEMOKEY0001", "demo", "Demo", "1DEMO", ""]) {
      expect(await boardFor({ ...props, projectKey }), projectKey)
        .toEqual({ status: "unavailable", reason: "invalid-target" });
    }
    expect(await boardFor({ ...props, host: "acme", projectKey: "DEMO" }))
      .toEqual({ status: "unavailable", reason: "invalid-target" });
    expect(inferlab.apiCalls.length).toBe(before);
    // The ten-character bound itself is a target: the reference is built from exactly these props.
    expect(await boardFor({ ...props, projectKey: "DEMOKEY001" }))
      .toEqual({ status: "unavailable", reason: "not-found" });
    expect(new URLSearchParams(lastApiCall().path.split("?")[1]).get("ref"))
      .toBe("inferops://acme.operations/project/board/DEMOKEY001");
  });

  it("never reads for a demo, unconnected or unresolved binding, and never falls back to anything", async () => {
    const account = await connect("hb-demo");
    const before = { api: inferlab.apiCalls.length, refreshes: inferlab.refreshes.length };
    expect(await boardFor({ accountId: account.accountId, connected: true, host: "demo.local", projectKey: "DEMO" }))
      .toEqual({ status: "not-connected" });
    expect(await boardFor({ accountId: crypto.randomUUID(), host: "demo.local", projectKey: "DEMO" }))
      .toEqual({ status: "not-connected" });
    expect(await boardFor({ accountId: crypto.randomUUID(), host: "acme.operations", projectKey: "DEMO" }))
      .toEqual({ status: "not-connected" });
    expect(await boardFor({ accountId: account.accountId, connected: true, host: "acme.operations", projectKey: "DEMO" }))
      .toEqual({ status: "not-connected" });
    expect(await fenceFor({ accountId: account.accountId, connected: true, host: "demo.local", projectKey: "DEMO" }))
      .toBeNull();
    expect(inferlab.apiCalls.length).toBe(before.api);
    expect(inferlab.refreshes.length).toBe(before.refreshes);
  });

  it("reduces every refusal and malformed answer to a status, with nothing InferOps said", async () => {
    const { before } = await bound("hb-refusals");
    const said = "server detail that must not leak";
    const cases: Array<[() => Response, unknown]> = [
      [() => Response.json({ error: { code: "NOT_FOUND", message: said } }, { status: 404 }), { status: "unavailable", reason: "not-found" }],
      [() => Response.json({ error: { code: "SNAPSHOT_TOO_LARGE", message: said, details: { bound: "issues", limit: 500 } } }, { status: 422 }),
        { status: "unavailable", reason: "too-large" }],
      [() => Response.json({ error: { code: "FORBIDDEN", message: said } }, { status: 403 }), { status: "unavailable", reason: "forbidden" }],
      [() => Response.json({ error: { code: "VALIDATION", message: said } }, { status: 400 }), { status: "unavailable", reason: "invalid-target" }],
      [() => new Response(said, { status: 502 }), { status: "unavailable", reason: "provider" }],
      [() => Response.json({ scope: { workspaceId: OPS, projectId: DEMO.id }, snapshot: SNAPSHOT, said }), { status: "unavailable", reason: "provider" }],
      [() => Response.json({ error: { code: "NOT_FOUND", message: said } }), { status: "unavailable", reason: "provider" }],
      // Another workspace's or project's board is never shown as this binding's.
      [() => Response.json({ scope: { workspaceId: SALES, projectId: DEMO.id }, snapshot: SNAPSHOT }), { status: "unavailable", reason: "provider" }],
      [() => Response.json({ scope: { workspaceId: OPS, projectId: DEMO.id }, snapshot: { ...SNAPSHOT, project: { identifier: "OTHER", name: "Other" } } }),
        { status: "unavailable", reason: "provider" }],
    ];
    for (const [answer, expected] of cases) {
      inferlab.snapshotAnswer = answer;
      const read = await boardOf("hb-refusals");
      expect(read).toEqual(expected);
      expect(JSON.stringify(read)).not.toContain(said);
    }
    expect(snapshotCalls()).toHaveLength(cases.length);
    expectOnlySnapshotsSince(before);
  });

  it("is not-connected once the session has ended, or the account is revoked", async () => {
    const { account, before } = await bound("hb-dead");
    inferlab.endSession("refresh-1");
    expect(await boardOf("hb-dead")).toEqual({ status: "not-connected" });
    expect(await fenceOf("hb-dead")).toBeNull();
    expectOnlySnapshotsSince(before);

    const revoked = await bound("hb-revoked");
    await hooks().revokeAccount(revoked.account);
    const sent = inferlab.apiCalls.length;
    expect(await boardOf("hb-revoked")).toEqual({ status: "not-connected" });
    expect(inferlab.apiCalls.length).toBe(sent);
    expect(account.accountId).not.toBe(revoked.account.accountId);
  });

  it("heals a token InferOps rejects and fences on the retry's own read", async () => {
    const { before } = await bound("hb-retry");
    const first = await fenceOf("hb-retry");
    inferlab.access.delete(inferlab.accessOf("refresh-1"));

    const read = await boardOf("hb-retry");

    const { fence } = okRead(read);
    // The refresh superseded the credential the first attempt used: the fence is the retry's.
    expect(fence.identity).not.toBe(first!.identity);
    expect(fence.generation).toBe(first!.generation);
    expect(await fenceOf("hb-retry")).toEqual(fence);
    const tokens = snapshotCalls().map(c => c.token);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toBe(tokens[1]);
    expect(tokens[1]).toBe(inferlab.accessOf("refresh-2"));
    expect(inferlab.refreshes).toEqual(["refresh-1"]);
    expectOnlySnapshotsSince(before);
  });

  /** Starts a host-board read whose InferOps answer is held until `settle()`. */
  async function heldRead(name: string) {
    let release!: () => void;
    inferlab.snapshotGate = new Promise<void>(resolve => { release = resolve; });
    const held = inferlab.snapshotsHeld;
    const outcome = boardOf(name);
    await vi.waitFor(() => expect(inferlab.snapshotsHeld).toBe(held + 1));
    return {
      settle: async () => {
        inferlab.snapshotGate = null;
        release();
        return outcome;
      },
    };
  }

  it("discards an answer held in flight across a reconnect as stale, then reads as the new session", async () => {
    const { account, before } = await bound("hb-reconnect");
    const read = await heldRead("hb-reconnect");
    expect((await finish(await hooks().reconnectAccount(account))).status).toBe(200);
    const stageId = reconnects.find(r => r.label === "hb-reconnect")!.stageId;
    expect(await hooks().commitReconnect(account, stageId)).toBeNull();

    // InferOps answered the old session's request successfully; the answer is still discarded.
    expect(await read.settle()).toEqual({ status: "stale" });
    const next = await boardOf("hb-reconnect");
    expect(lastApiCall().token).toBe(inferlab.accessOf("refresh-2"));
    expect(okRead(next).fence).toEqual(await fenceOf("hb-reconnect"));
    expectOnlySnapshotsSince(before);
  });

  it("discards an answer held in flight across a revoke as stale, then reads as not-connected", async () => {
    const { account, before } = await bound("hb-revoke");
    const read = await heldRead("hb-revoke");
    await hooks().revokeAccount(account);

    const outcome = await read.settle();
    expect(outcome).toEqual({ status: "stale" });
    expect(JSON.stringify(outcome)).not.toContain("DEMO-1");
    expect(await boardOf("hb-revoke")).toEqual({ status: "not-connected" });
    expectOnlySnapshotsSince(before);
  });

  describe("normalization boundaries", () => {
    const SENTINEL = "PRIVATE_CUSTOMER_SENTINEL";
    const config = env as unknown as { INFEROPS_BASE_URL?: string; INFERLAB_AUTH_ORIGIN?: string };
    const origin = config.INFERLAB_AUTH_ORIGIN;
    let logged: string[];
    beforeEach(() => {
      logged = [];
      for (const level of ["debug", "info", "log", "warn", "error"] as const) {
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
          logged.push(args.map(a => a instanceof Error ? `${a.message} ${a.stack}` : JSON.stringify(a)).join(" "));
        });
      }
    });
    afterEach(() => {
      delete config.INFEROPS_BASE_URL;
      config.INFERLAB_AUTH_ORIGIN = origin;
    });

    it("logs nothing InferOps said for a 401 whose adjudication RPC fails, and answers provider", async () => {
      const { account, before } = await bound("hb-report-fails");
      inferlab.snapshotAnswer = () => Response.json(
        { error: { code: SENTINEL, message: SENTINEL, details: { [SENTINEL]: SENTINEL } } }, { status: 401 });
      await env.INFEROPS_CREDENTIALS.get(env.INFEROPS_CREDENTIALS.idFromName(account.accountId)).failNextReport();

      const read = await boardOf("hb-report-fails");

      expect(read).toEqual({ status: "unavailable", reason: "provider" });
      expect(logged.join("\n")).toContain("credentials.rejection.report.failed");
      expect(JSON.stringify(read)).not.toContain(SENTINEL);
      expect(logged.join("\n")).not.toContain(SENTINEL);
      // Not adjudicated, so not retried and not expired.
      expect(snapshotCalls()).toHaveLength(1);
      expect(expired).not.toContain("hb-report-fails");
      expectOnlySnapshotsSince(before);
    });

    it("answers a malformed INFEROPS_BASE_URL as provider, and null for the fence, without a request", async () => {
      const { before } = await bound("hb-bad-base");
      config.INFEROPS_BASE_URL = `${SENTINEL} is not a url`;
      const read = await boardOf("hb-bad-base");
      expect(read).toEqual({ status: "unavailable", reason: "provider" });
      expect(await fenceOf("hb-bad-base")).toBeNull();
      expect(inferlab.apiCalls.length).toBe(before);
      expect(JSON.stringify(read) + logged.join("\n")).not.toContain(SENTINEL);
      expect(logged.join("\n")).not.toContain("INFEROPS_BASE_URL");
    });

    it("answers an invalid InferLab origin, with no base URL, as provider, and null for the fence, without a request", async () => {
      const { before } = await bound("hb-bad-origin");
      for (const bad of [`ftp://${SENTINEL.toLowerCase()}.example`, `https://${SENTINEL.toLowerCase()}.example/path`, SENTINEL]) {
        config.INFERLAB_AUTH_ORIGIN = bad;
        const read = await boardOf("hb-bad-origin");
        expect(read, bad).toEqual({ status: "unavailable", reason: "provider" });
        expect(await fenceOf("hb-bad-origin")).toBeNull();
        expect(JSON.stringify(read) + logged.join("\n")).not.toContain(SENTINEL.toLowerCase());
        expect(logged.join("\n")).not.toContain(SENTINEL);
      }
      expect(inferlab.apiCalls.length).toBe(before);
    });
  });

  it("is absent from the board session and from the agent types", async () => {
    await bound("hb-session");
    const session = hooks().startBoundSession("hb-session") as unknown as {
      readHostBoardSnapshot(): Promise<unknown>; connectionIdentity(): Promise<unknown>;
      readBoard(): Promise<Record<string, unknown>>;
    };
    expect(await failure(session.readHostBoardSnapshot())).not.toBe("");
    expect(await failure(session.connectionIdentity())).not.toBe("");
    const board = await session.readBoard();
    expect(Object.keys(board)).not.toContain("scope");
    expect(Object.keys(board)).not.toContain("fence");
    // The agent's documentation is `types.d.ts` verbatim (through the `types.txt` symlink).
    const agentTypes = (await import("../src/types.d.ts?raw" as string) as { default: string }).default;
    expect(agentTypes).toContain("interface InferOpsProjectSession");
    for (const name of ["readHostBoardSnapshot", "connectionIdentity", "HostBoard", "board-snapshot", "board_snapshot"]) {
      expect(agentTypes).not.toContain(name);
    }
  });
});
