// A connected InferOps account acts with the person's own InferLab session: the connect flow stores
// it, every InferOps request carries that person's token and one of their workspaces, the session
// is refreshed and rotated at InferLab, its death is reported once, revoking signs it out, and a
// workspace the person does not belong to is refused before any request.
//
// The Workshop holds an account as a stub rebuilt from its props, and a stub cannot leave the
// Durable Object that made it, so the tests learn each account's id by fixing `crypto.randomUUID`
// for the callback leg and drive the account through `TestHooks`, as the overseer would.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleInferLabLogin } from "../src/inferlab-login.js";
import {
  expired, reconnects, signIns, type AccountProps, type InferLabLogin, type SignInExports,
} from "./worker.js";

const LOGIN_ENV = {
  INFERLAB_AUTH_ORIGIN: "http://localhost:8080",
  BASE_URL: "http://localhost:8787/gatekeeper/inferops",
};
const REDIRECT_URI = "http://localhost:8787/gatekeeper/inferops/oauth";
const HOST = "localhost:8080";
const BOARD_URL = `inferops://${HOST}/project/board/DEMO`;

const OPS = "90000000-0000-4000-8000-000000000001";
const SALES = "90000000-0000-4000-8000-000000000002";
const OTHER = "90000000-0000-4000-8000-00000000ffff";
const DEMO = { id: "10000000-0000-4000-8000-000000000001", identifier: "DEMO", name: "Demo" };
const READY = "20000000-0000-4000-8000-000000000001";
const DEMO_1 = "30000000-0000-4000-8000-000000000001";

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
  /** Workspaces InferLab reports at sign-in. */
  workspaces: Array<{ workspaceId: string; workspaceName: string; product: string }> = [
    { workspaceId: OPS, workspaceName: "Ops", product: "inferops" },
  ];
  emailVerified = true;
  accessTtlMs = HOUR;
  logouts: string[] = [];
  refreshes: string[] = [];
  exchanges = 0;
  apiCalls: ApiCall[] = [];
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
    this.apiCalls.push({ path: url.pathname + url.search, token, workspaceId });
    if (!token || !this.access.has(token)) {
      return Response.json({ error: { code: "UNAUTHORIZED", message: "bad token" } }, { status: 401 });
    }
    if (!workspaceId || !this.memberships.has(workspaceId)) {
      return Response.json({ error: { code: "FORBIDDEN", message: "not a member" } }, { status: 403 });
    }
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

/** A board session over the binding `account` mints for `BOARD_URL`, named `name`. */
async function bindBoard(account: AccountProps, name: string) {
  expect(await hooks().bindAccount(name, account, BOARD_URL)).toBeNull();
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
      displayName: `InferOps (${HOST})`, uniqueName: "ada@example.com",
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

describe("workspaces", () => {
  it("binds in the person's only workspace without asking", async () => {
    const account = await connect("single");
    expect(await hooks().listWorkspaces(account)).toEqual([{ value: OPS, title: "Ops", subtitle: OPS }]);
    await bindBoard(account, "single");
    expect(lastApiCall().workspaceId).toBe(OPS);
  });

  it("requires a choice among several, refuses one the person is not a member of, and binds in the chosen one", async () => {
    inferlab.workspaces.push({ workspaceId: SALES, workspaceName: "Sales", product: "inferops" });
    inferlab.memberships.add(SALES);
    const account = await connect("several");

    expect(await hooks().bindAccount("several", account, BOARD_URL)).toContain("choose one");
    expect(await hooks().listProjects(account)).toContain("choose one");
    expect(await hooks().selectWorkspace(account, OTHER)).toContain("not a member");
    expect(inferlab.apiCalls).toEqual([]);

    expect(await hooks().selectWorkspace(account, SALES)).toBeNull();
    expect(await hooks().listProjects(account)).toEqual(["DEMO"]);
    const session = await bindBoard(account, "several");
    await session.readBoard();
    for (const call of inferlab.apiCalls) expect(call.workspaceId).toBe(SALES);
  });

  it("is denied by InferOps for a workspace the token cannot enter, without expiring the account", async () => {
    // InferLab listed Sales at sign-in, but InferOps no longer admits this person there.
    inferlab.workspaces.push({ workspaceId: SALES, workspaceName: "Sales", product: "inferops" });
    const account = await connect("denied");
    expect(await hooks().selectWorkspace(account, SALES)).toBeNull();

    expect(await hooks().bindAccount("denied", account, BOARD_URL)).toContain("FORBIDDEN");
    expect(lastApiCall().workspaceId).toBe(SALES);
    expect(inferlab.refreshes).toEqual([]);
    expect(expired).not.toContain("denied");

    // Back in a workspace the person belongs to, the same account works.
    expect(await hooks().selectWorkspace(account, OPS)).toBeNull();
    await bindBoard(account, "denied");
  });

  it("admits a collaborator only when their own account reaches the project in the binding's workspace", async () => {
    inferlab.workspaces.push({ workspaceId: SALES, workspaceName: "Sales", product: "inferops" });
    inferlab.memberships.add(SALES);
    const owner = await connect("owner");
    expect(await hooks().selectWorkspace(owner, SALES)).toBeNull();
    await bindBoard(owner, "shared");

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
