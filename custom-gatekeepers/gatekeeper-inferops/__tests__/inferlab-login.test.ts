// Sign in with InferLab: the vendor offers sign-in only when configured, the popup leg redirects to
// InferLab's /authorize with PKCE, and the callback leg exchanges the code once, server-side, and
// hands the Workshop an account carrying the verified email.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { pkceChallenge } from "@gadgets/gatekeeper-kit/oauth-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exchangeFromTokenResponse, handleInferLabLogin, inferLabAuthOrigin, startInferLabLogin,
  verifiedEmail,
} from "../src/inferlab-login.js";
import { signIns, type InferLabLogin, type SignInExports } from "./worker.js";

const LOGIN_ENV = {
  INFERLAB_AUTH_ORIGIN: "http://localhost:8080",
  BASE_URL: "http://localhost:8787/gatekeeper/inferops",
};
const REDIRECT_URI = "http://localhost:8787/gatekeeper/inferops/oauth";

afterEach(() => vi.unstubAllGlobals());

/** Runs `body` with the test worker's exports, from inside a throwaway sign-in object. */
async function withExports<R>(body: (exports: SignInExports) => Promise<R>): Promise<R> {
  const stub = env.INFERLAB_LOGIN.get(env.INFERLAB_LOGIN.newUniqueId());
  return runInDurableObject(stub, (_: InferLabLogin, state) =>
    body(state.exports as unknown as SignInExports));
}

/** Starts an attempt whose callback records under `label`; returns the popup URL. */
async function start(label: string): Promise<string> {
  return withExports(async exports => {
    const callback = exports.TestConnectCallback({ props: { label } });
    return (await startInferLabLogin(env.INFERLAB_LOGIN, LOGIN_ENV, { kind: "signin" }, callback as never)).url;
  });
}

function get(url: string): Promise<Response | null> {
  return handleInferLabLogin(new Request(url), LOGIN_ENV, env.INFERLAB_LOGIN);
}

/** Follows the popup URL to InferLab; returns the authorize request's parameters. */
async function authorize(label: string): Promise<URLSearchParams> {
  const response = await get(await start(label));
  expect(response?.status).toBe(302);
  const location = new URL(response!.headers.get("Location")!);
  expect(`${location.origin}${location.pathname}`).toBe("http://localhost:8080/authorize");
  return location.searchParams;
}

type TokenRequest = { clientId: string; code: string; codeVerifier: string; redirectUri: string };

/**
 * Stubs InferLab: the token endpoint answers with `reply`, recording each exchange it is asked for;
 * `/auth/logout` is recorded in `logouts` and always succeeds.
 */
function tokenEndpoint(reply: (request: TokenRequest) => Response) {
  const requests: Array<{ url: string; body: TokenRequest }> = [];
  const logouts: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith("/auth/logout")) {
      logouts.push((JSON.parse(String(init.body)) as { refreshToken: string }).refreshToken);
      return new Response(null, { status: 204 });
    }
    const body = JSON.parse(String(init.body)) as TokenRequest;
    requests.push({ url, body });
    return reply(body);
  });
  return Object.assign(requests, { logouts });
}

const user = (email: string, emailVerified: unknown = true) => ({
  id: "u1", email, emailVerified, name: "Ada", tenantId: "t1",
  workspaces: [{
    workspaceId: "90000000-0000-4000-8000-000000000001", workspaceName: "Ops", product: "inferops",
    role: "owner", deniedPermissions: [],
  }],
});

const signedIn = (email: string) => () => Response.json({
  token: "access", refreshToken: "refresh", user: user(email),
});

describe("configuration", () => {
  it("offers sign-in only for a bare HTTPS origin, or HTTP on loopback", () => {
    expect(inferLabAuthOrigin({})).toBeNull();
    expect(inferLabAuthOrigin({ INFERLAB_AUTH_ORIGIN: " " })).toBeNull();
    expect(inferLabAuthOrigin({ INFERLAB_AUTH_ORIGIN: "https://auth.inferlab.io" }))
      .toBe("https://auth.inferlab.io");
    expect(inferLabAuthOrigin({ INFERLAB_AUTH_ORIGIN: "https://auth.inferlab.io/" }))
      .toBe("https://auth.inferlab.io");
    expect(inferLabAuthOrigin({ INFERLAB_AUTH_ORIGIN: "http://localhost:8080" }))
      .toBe("http://localhost:8080");
    for (const bad of [
      "http://auth.inferlab.io", "https://auth.inferlab.io/sso", "https://u:p@auth.inferlab.io",
      "https://auth.inferlab.io?x=1", "ftp://auth.inferlab.io", "not a url",
    ]) {
      expect(inferLabAuthOrigin({ INFERLAB_AUTH_ORIGIN: bad }), bad).toBeNull();
    }
  });

  it("describes the vendor as a sign-in provider whose accounts are connected, not provided", async () => {
    await withExports(async exports => {
      const vendor = exports.GatekeeperVendor({});
      expect(await vendor.describe()).toMatchObject({ providesAuth: true, autoProvisionsAccount: false });
      const callback = exports.TestConnectCallback({ props: { label: "full" } });
      const { url } = await vendor.connectAccount(callback as never, { scopes: "auth" });
      expect(url).toMatch(/^http:\/\/localhost:8787\/gatekeeper\/inferops\/[0-9a-f]{64}\/[0-9a-f]{64}$/);
    });
  });
});

describe("token response", () => {
  const envelope = (u: unknown) => JSON.stringify({ token: "a", refreshToken: "r", user: u });

  it("normalizes the email, keeps the session and the InferOps workspaces only", () => {
    const exchange = exchangeFromTokenResponse(envelope({
      ...user(" Ada@Example.com "),
      workspaces: [
        ...user("x").workspaces,
        { workspaceId: "90000000-0000-4000-8000-000000000002", workspaceName: "Mind", product: "infermind" },
      ],
    }));
    expect(exchange).toEqual({
      grant: { accessToken: "a", accessExpiresAt: 0, refreshToken: "r" },
      identity: {
        userId: "u1", email: "ada@example.com", tenantId: "t1",
        workspaces: [{ workspaceId: "90000000-0000-4000-8000-000000000001", workspaceName: "Ops" }],
      },
      emailVerified: true,
    });
    expect(verifiedEmail(exchange)).toBe("ada@example.com");
  });

  it("refuses an unreadable or incomplete response", () => {
    for (const body of [
      "{", "null", "{}", envelope({ ...user("x"), email: "" }), envelope({ ...user("x"), email: "no-at-sign" }),
      envelope({ ...user("x"), id: "" }), envelope({ ...user("x"), tenantId: undefined }),
      JSON.stringify({ token: "", refreshToken: "r", user: user("a@b.c") }),
      JSON.stringify({ token: "a", user: user("a@b.c") }),
      envelope({ ...user("x"), workspaces: [{ workspaceId: "not-a-uuid", product: "inferops" }] }),
    ]) {
      expect(() => exchangeFromTokenResponse(body), body).toThrow();
    }
  });

  it("vouches for the email only when InferLab marked it verified", () => {
    for (const flag of [false, null, "true", 1]) {
      expect(() => verifiedEmail(exchangeFromTokenResponse(envelope(user("a@b.c", flag)))), String(flag))
        .toThrow("no verified email");
    }
    const { emailVerified: _omitted, ...unmarked } = user("a@b.c");
    expect(() => verifiedEmail(exchangeFromTokenResponse(envelope(unmarked)))).toThrow("no verified email");
  });
});

describe("sign-in flow", () => {
  it("redirects to /authorize as the inferos public client with an S256 challenge", async () => {
    const params = await authorize("redirect");

    expect(params.get("client_id")).toBe("inferos");
    expect(params.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get("state")).toMatch(/^[0-9a-f]{64}\.[0-9a-f]{64}$/);
  });

  it("exchanges the code once, hands the Workshop the verified email and ends the session", async () => {
    const params = await authorize("ok");
    const requests = tokenEndpoint(signedIn("ada@example.com"));
    const callbackUrl = `${REDIRECT_URI}?code=the-code&state=${params.get("state")}`;

    const response = await get(callbackUrl);

    expect(response?.status).toBe(200);
    expect(await response!.text()).toContain("ticket-ok");
    expect(signIns).toContainEqual({ label: "ok", email: "ada@example.com" });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("http://localhost:8080/auth/token");
    expect(requests[0].body).toMatchObject(
      { clientId: "inferos", code: "the-code", redirectUri: REDIRECT_URI });
    expect(await pkceChallenge(requests[0].body.codeVerifier)).toBe(params.get("code_challenge"));
    // Signing in grants nothing: the InferLab session it opened is signed out again.
    expect(requests.logouts).toEqual(["refresh"]);

    // The state is single-use: a replay neither exchanges again nor signs in again.
    expect((await get(callbackUrl))?.status).toBe(400);
    expect(requests).toHaveLength(1);
  });

  it("accepts the popup link only once", async () => {
    const url = await start("once");
    expect((await get(url))?.status).toBe(302);
    expect((await get(url))?.status).toBe(400);
  });

  it("rejects a forged or malformed state without calling InferLab", async () => {
    const params = await authorize("forged");
    const requests = tokenEndpoint(signedIn("mallory@example.com"));
    const [attempt] = params.get("state")!.split(".");

    for (const state of [`${attempt}.${"0".repeat(64)}`, attempt, "x.y", `${attempt}.${"0".repeat(64)}.z`]) {
      expect((await get(`${REDIRECT_URI}?code=c&state=${state}`))?.status, state).toBe(400);
      expect((await get(`${REDIRECT_URI}?error=access_denied&state=${state}`))?.status, state).toBe(400);
    }
    expect(requests).toHaveLength(0);
    expect(signIns.some(s => s.label === "forged")).toBe(false);

    // Guessing wrong did not end the real attempt.
    expect((await get(`${REDIRECT_URI}?code=c&state=${params.get("state")}`))?.status).toBe(200);
    expect(signIns).toContainEqual({ label: "forged", email: "mallory@example.com" });
  });

  it("ends the attempt when InferLab reports an error", async () => {
    const params = await authorize("denied");
    const requests = tokenEndpoint(signedIn("ada@example.com"));
    const state = params.get("state");

    const response = await get(`${REDIRECT_URI}?error=access_denied&state=${state}`);

    expect(response?.status).toBe(400);
    expect(await response!.text()).toContain("not completed");
    expect((await get(`${REDIRECT_URI}?code=c&state=${state}`))?.status).toBe(400);
    expect(requests).toHaveLength(0);
  });

  it("shows a safe error page when InferLab rejects the exchange", async () => {
    const params = await authorize("rejected");
    tokenEndpoint(() => Response.json({ error: "invalid_grant", detail: "secret" }, { status: 400 }));

    const response = await get(`${REDIRECT_URI}?code=c&state=${params.get("state")}`);

    expect(response?.status).toBe(502);
    const html = await response!.text();
    expect(html).toContain("HTTP 400");
    expect(html).not.toContain("secret");
    expect(signIns.some(s => s.label === "rejected")).toBe(false);
  });

  it("refuses an account InferLab has not verified", async () => {
    const params = await authorize("unverified");
    tokenEndpoint(() => Response.json({
      token: "access", refreshToken: "refresh", user: user("ada@example.com", false),
    }));

    const response = await get(`${REDIRECT_URI}?code=c&state=${params.get("state")}`);

    expect(response?.status).toBe(502);
    expect(await response!.text()).toContain("no verified email");
    expect(signIns.some(s => s.label === "unverified")).toBe(false);
  });

  it("leaves other paths to the RPC-only 404", async () => {
    expect(await get("http://localhost:8787/gatekeeper/inferops/elsewhere")).toBeNull();
    expect(await handleInferLabLogin(
      new Request(REDIRECT_URI, { method: "POST" }), LOGIN_ENV, env.INFERLAB_LOGIN)).toBeNull();
  });
});
