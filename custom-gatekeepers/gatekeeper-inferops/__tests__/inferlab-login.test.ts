// Sign in with InferLab: the vendor offers sign-in only when configured, the popup leg redirects to
// InferLab's /authorize with PKCE, and the callback leg exchanges the code once, server-side, and
// hands the Workshop an account carrying the verified email.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { pkceChallenge } from "@gadgets/gatekeeper-kit/oauth-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleInferLabLogin, identityFromTokenResponse, inferLabAuthOrigin, startInferLabLogin,
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
    return (await startInferLabLogin(env.INFERLAB_LOGIN, LOGIN_ENV, callback as never)).url;
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

/**
 * The message an RPC call failed with, or "" when it succeeded. Awaited here rather than through
 * `expect(...).rejects`, which leaves the RPC promise's own rejection unhandled.
 */
async function failure(call: PromiseLike<unknown>): Promise<string> {
  try {
    await call;
    return "";
  } catch (error) {
    return String(error);
  }
}

type TokenRequest = { clientId: string; code: string; codeVerifier: string; redirectUri: string };

/** Stubs InferLab's token endpoint, recording each exchange it is asked for. */
function tokenEndpoint(reply: (request: TokenRequest) => Response) {
  const requests: Array<{ url: string; body: TokenRequest }> = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body)) as TokenRequest;
    requests.push({ url: String(input), body });
    return reply(body);
  });
  return requests;
}

const signedIn = (email: string) => () => Response.json({
  token: "access", refreshToken: "refresh",
  user: { id: "u1", email, emailVerified: true, name: "Ada", tenantId: "t1" },
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

  it("describes the vendor as a sign-in provider and keeps board access flow-free", async () => {
    await withExports(async exports => {
      const vendor = exports.GatekeeperVendor({});
      expect(await vendor.describe()).toMatchObject({ providesAuth: true, autoProvisionsAccount: true });
      const callback = exports.TestConnectCallback({ props: { label: "full" } });
      expect(await failure(vendor.connectAccount(callback as never, { scopes: "full" })))
        .toContain("no connect flow");
      const { url } = await vendor.connectAccount(callback as never, { scopes: "auth" });
      expect(url).toMatch(/^http:\/\/localhost:8787\/gatekeeper\/inferops\/[0-9a-f]{64}\/[0-9a-f]{64}$/);
    });
  });
});

describe("token response", () => {
  it("normalizes a verified email and refuses an unverified, unmarked or missing one", () => {
    expect(identityFromTokenResponse(
      JSON.stringify({ user: { email: " Ada@Example.com ", emailVerified: true } })))
      .toEqual({ email: "ada@example.com" });
    for (const body of [
      "{", "null", "{}", JSON.stringify({ user: { email: "", emailVerified: true } }),
      JSON.stringify({ user: { email: "no-at-sign", emailVerified: true } }),
      JSON.stringify({ user: { email: "a@b.c", emailVerified: false } }),
      JSON.stringify({ user: { email: "a@b.c" } }),
      JSON.stringify({ user: { email: "a@b.c", emailVerified: "true" } }),
    ]) {
      expect(() => identityFromTokenResponse(body), body).toThrow();
    }
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

  it("exchanges the code once and hands the Workshop the verified email", async () => {
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
    tokenEndpoint(() => Response.json({ user: { email: "ada@example.com", emailVerified: false } }));

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
