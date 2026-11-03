// The InferLab sign-in proxy: only the authorize origin, only central-auth's browser legs,
// the edge header added upstream, Access's cookie dropped, and redirects and cookies kept on the
// authorize host.

import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTHORIZE_ORIGIN_HEADER, handleInferLabAuthProxy } from "../src/auth-proxy";
import { INFEROPS_EDGE_HEADER } from "../src/edge-header";
import { inferLabAuthorizeOrigin } from "../src/inferlab-login";

const SECRET = "edge_secret-0123456789abcdefABCDEF0123";
const AUTH = "https://auth.dev.inferlab.example";
const PROXY = "https://auth.dev-os.example";
const CALLBACK = "https://dev-os.example/gatekeeper/inferops/oauth?code=c&state=s";
const ENV = { INFERLAB_AUTH_ORIGIN: AUTH, INFERLAB_AUTHORIZE_ORIGIN: PROXY, INFEROPS_EDGE_SECRET: SECRET };

type Seen = { url: string; method?: string; headers: Headers; redirect: RequestInit["redirect"]; body?: string };

/** Stubs the global `fetch`, recording each upstream request and answering with `reply`. */
function upstream(reply: () => Response = () => new Response("page")) {
  const seen: Seen[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(input), method: init?.method, headers: new Headers(init?.headers), redirect: init?.redirect,
      body: init?.body ? new TextDecoder().decode(init.body as ArrayBuffer) : undefined,
    });
    return reply();
  });
  return seen;
}

afterEach(() => vi.unstubAllGlobals());

describe("authorize origin", () => {
  it("is the InferLab origin unless set, and off when set but malformed", () => {
    expect(inferLabAuthorizeOrigin({ INFERLAB_AUTH_ORIGIN: AUTH })).toBe(AUTH);
    expect(inferLabAuthorizeOrigin(ENV)).toBe(PROXY);
    expect(inferLabAuthorizeOrigin({ INFERLAB_AUTHORIZE_ORIGIN: PROXY })).toBeNull();
    for (const bad of [`${PROXY}/auth`, "http://auth.dev-os.example", "not a url"]) {
      expect(inferLabAuthorizeOrigin({ ...ENV, INFERLAB_AUTHORIZE_ORIGIN: bad }), bad).toBeNull();
    }
  });
});

describe("handleInferLabAuthProxy", () => {
  it("leaves other origins, and deployments without a distinct authorize origin, alone", async () => {
    const seen = upstream();
    expect(await handleInferLabAuthProxy(new Request("https://dev-os.example/authorize"), ENV)).toBeNull();
    expect(await handleInferLabAuthProxy(new Request(`${AUTH}/authorize`), { INFERLAB_AUTH_ORIGIN: AUTH }))
      .toBeNull();
    expect(await handleInferLabAuthProxy(new Request(`${PROXY}/authorize`),
      { ...ENV, INFERLAB_AUTHORIZE_ORIGIN: "nope" })).toBeNull();
    expect(seen).toEqual([]);
  });

  it("refuses every path and method but the sign-in legs, without calling InferLab", async () => {
    const seen = upstream();
    for (const [method, path] of [
      ["GET", "/workspaces"], ["GET", "/auth/token"], ["POST", "/auth/token"], ["POST", "/authorize"],
      ["GET", "/authorize/persona"], ["GET", "/authorize/"], ["DELETE", "/logout"],
      ["GET", "/auth/oauth/sign-in/social"], ["POST", "/auth/oauth/callback/google"],
      ["GET", "/auth/oauth/callback/github"], ["POST", "/auth/oauth/sign-out"], ["GET", "/auth/oauth/get-session"],
      ["POST", "/auth/refresh"], ["POST", "/auth/logout"],
    ]) {
      const response = await handleInferLabAuthProxy(new Request(`${PROXY}${path}`, { method }), ENV);
      expect(response?.status, `${method} ${path}`).toBe(404);
    }
    expect(seen).toEqual([]);
  });

  it("forwards /authorize with its query and the edge header, never following a redirect", async () => {
    const seen = upstream();
    const response = await handleInferLabAuthProxy(new Request(`${PROXY}/authorize?client_id=inferos&state=x`, {
      headers: { accept: "text/html", "x-forwarded-for": "1.2.3.4", "cf-access-jwt-assertion": "jwt" },
    }), ENV);
    expect(await response?.text()).toBe("page");
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(`${AUTH}/authorize?client_id=inferos&state=x`);
    expect(seen[0].headers.get(INFEROPS_EDGE_HEADER)).toBe(SECRET);
    expect(seen[0].headers.get(AUTHORIZE_ORIGIN_HEADER)).toBe(PROXY);
    expect(seen[0].headers.get("accept")).toBe("text/html");
    expect(seen[0].headers.has("x-forwarded-for")).toBe(false);
    expect(seen[0].headers.has("cf-access-jwt-assertion")).toBe(false);
    expect(seen[0].redirect).toBe("manual");
  });

  it("drops Access's cookie, rewrites Origin and Referer to InferLab, and forwards the form body", async () => {
    const seen = upstream(() => new Response(null, { status: 302, headers: { location: CALLBACK } }));
    const response = await handleInferLabAuthProxy(new Request(`${PROXY}/authorize/persona`, {
      method: "POST",
      headers: {
        cookie: "CF_Authorization=access-jwt; iex_authz_csrf=abc", origin: PROXY,
        referer: `${PROXY}/authorize?client_id=inferos`, "content-type": "application/x-www-form-urlencoded",
      },
      body: "persona=grokbot-owner&csrf=abc",
    }), ENV);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].headers.get("cookie")).toBe("iex_authz_csrf=abc");
    expect(seen[0].headers.get("origin")).toBe(AUTH);
    expect(seen[0].headers.get("referer")).toBe(`${AUTH}/authorize?client_id=inferos`);
    expect(seen[0].body).toBe("persona=grokbot-owner&csrf=abc");
    // The callback is the deployment's own: passed through untouched.
    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toBe(CALLBACK);
  });

  it("forwards the Google sign-in start, naming this origin, and passes Google's URL back", async () => {
    const google = "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=x";
    const seen = upstream(() => {
      const headers = new Headers({ "content-type": "application/json" });
      headers.append("set-cookie", "__Secure-iex_ba.state=s; Path=/; Domain=inferlab.example; HttpOnly; Secure");
      return new Response(JSON.stringify({ url: google, redirect: true }), { headers });
    });
    const body = JSON.stringify({ provider: "google", callbackURL: "/authorize?client_id=inferos" });
    const response = await handleInferLabAuthProxy(new Request(`${PROXY}/auth/oauth/sign-in/social`, {
      method: "POST",
      headers: { origin: PROXY, "content-type": "application/json", "x-inferos-authorize-origin": "https://evil.example" },
      body,
    }), ENV);
    expect(seen[0].url).toBe(`${AUTH}/auth/oauth/sign-in/social`);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].body).toBe(body);
    expect(seen[0].headers.get("origin")).toBe(AUTH);
    // The browser cannot choose the origin InferLab is told about: the proxy always names itself.
    expect(seen[0].headers.get(AUTHORIZE_ORIGIN_HEADER)).toBe(PROXY);
    expect(await response?.json()).toEqual({ url: google, redirect: true });
    expect(response?.headers.getSetCookie()).toEqual(["__Secure-iex_ba.state=s; Path=/; HttpOnly; Secure"]);
  });

  it("forwards Google's callback with its query and keeps the return on the authorize host", async () => {
    const seen = upstream(() => new Response(null, {
      status: 302, headers: { location: `${PROXY}/authorize?client_id=inferos&state=s` },
    }));
    const response = await handleInferLabAuthProxy(
      new Request(`${PROXY}/auth/oauth/callback/google?code=g&state=st`, { headers: { cookie: "__Secure-iex_ba.state=s" } }),
      ENV);
    expect(seen[0].url).toBe(`${AUTH}/auth/oauth/callback/google?code=g&state=st`);
    expect(seen[0].headers.get("cookie")).toBe("__Secure-iex_ba.state=s");
    expect(seen[0].headers.get(AUTHORIZE_ORIGIN_HEADER)).toBe(PROXY);
    expect(response?.headers.get("location")).toBe(`${PROXY}/authorize?client_id=inferos&state=s`);
  });

  it("passes a foreign Origin unchanged, so central-auth still refuses it", async () => {
    const seen = upstream();
    await handleInferLabAuthProxy(new Request(`${PROXY}/authorize/persona`, {
      method: "POST", headers: { origin: "https://evil.example" }, body: "persona=x",
    }), ENV);
    expect(seen[0].headers.get("origin")).toBe("https://evil.example");
  });

  it("keeps a relative redirect from /logout on the authorize host", async () => {
    upstream(() => new Response(null, {
      status: 302, headers: { location: "/authorize?client_id=inferos&state=s" },
    }));
    const response = await handleInferLabAuthProxy(
      new Request(`${PROXY}/logout?return=${encodeURIComponent("/authorize?client_id=inferos&state=s")}`), ENV);
    expect(response?.headers.get("location")).toBe(`${PROXY}/authorize?client_id=inferos&state=s`);
  });

  it("keeps InferLab redirects and cookies on the authorize host", async () => {
    upstream(() => {
      const headers = new Headers({ location: `${AUTH}/authorize?client_id=inferos` });
      headers.append("set-cookie", "iex_sso=r; Path=/; Domain=inferlab.example; HttpOnly; Secure; SameSite=Lax");
      headers.append("set-cookie", "iex_authz_csrf=; Path=/authorize; Max-Age=0");
      return new Response(null, { status: 302, headers });
    });
    const response = await handleInferLabAuthProxy(new Request(`${PROXY}/logout?return=/`), ENV);
    expect(response?.headers.get("location")).toBe(`${PROXY}/authorize?client_id=inferos`);
    expect(response?.headers.getSetCookie()).toEqual([
      "iex_sso=r; Path=/; HttpOnly; Secure; SameSite=Lax",
      "iex_authz_csrf=; Path=/authorize; Max-Age=0",
    ]);
  });
});
