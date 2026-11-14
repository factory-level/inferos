// FAC-214's auth acceptance suite, gatekeeper half: InferLab sign-in end to end against a fake
// InferLab central-auth (faked at `fetch`, in mock mode: no network, no real provider). The kernel
// half (account keyed on the subject) is packages/workshop-backend/__tests__/subject-login.test.ts.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker.js";
import { NOT_CONFIGURED, readConfig } from "../src/config.js";

const ISSUER = "http://localhost:23380";
const BASE = "http://localhost:8787/gatekeeper/inferlab";
const REDIRECT_URI = `${BASE}/oauth`;
const COMPANY = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-0000000000f2";
const PRINCIPAL = "00000000-0000-4000-8000-000000000101";

type Seen = { path: string; body: Record<string, unknown> };
let seen: Seen[] = [];
/** What the fake answers `/auth/token` with; a test overrides it. */
let tokenAnswer: () => Response;

const tokenOk = (user: Record<string, unknown> = {}) => () => Response.json({
  token: "access-token-never-kept",
  refreshToken: "refresh-token-ended-at-once",
  user: { id: PRINCIPAL, email: "Ann@Acme.test", emailVerified: true, tenantId: COMPANY, ...user },
});

beforeEach(() => {
  seen = [];
  tokenAnswer = tokenOk();
  vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.origin !== ISSUER) throw new Error(`unexpected fetch to ${url.origin}`);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    seen.push({ path: url.pathname, body });
    if (url.pathname === "/auth/token") return tokenAnswer();
    if (url.pathname === "/auth/logout") return new Response(null, { status: 204 });
    throw new Error(`unexpected fetch to ${url.pathname}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type Env = Parameters<typeof worker.fetch>[1];
const ctx = { exports: { SignInAttempt: env.SIGN_IN_ATTEMPT } } as unknown as Parameters<typeof worker.fetch>[2];
const get = (url: string, e: Partial<Env> = {}) =>
  worker.fetch(new Request(url, { redirect: "manual" }), { ...env, ...e } as Env, ctx);
const hooks = () => env.TEST_HOOKS.getByName("hooks");

let counter = 0;
/** A started attempt, as connectAccount leaves it: its id, its initiation nonce, and a label. */
async function started() {
  const attemptId = env.SIGN_IN_ATTEMPT.newUniqueId().toString();
  const nonce = (++counter).toString(16).padStart(64, "a");
  const label = `attempt-${counter}`;
  await hooks().startAttempt(attemptId, nonce, label);
  return { attemptId, nonce, label };
}

/** Follows the sign-in link to InferLab's /authorize and answers its query. */
async function authorize(attemptId: string, nonce: string) {
  const response = await get(`${BASE}/${attemptId}/${nonce}`);
  expect(response.status).toBe(302);
  return new URL(response.headers.get("location")!);
}

/** The whole flow: link, authorize, callback with a code. */
async function signIn() {
  const attempt = await started();
  const auth = await authorize(attempt.attemptId, attempt.nonce);
  const state = auth.searchParams.get("state")!;
  const callback = await get(`${REDIRECT_URI}?code=the-code&state=${state}`);
  return { ...attempt, auth, state, callback, text: await callback.text() };
}

const sha256base64url = async (text: string) => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return btoa(String.fromCharCode(...digest)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

describe("the correct company signs in", () => {
  it("hands the Workshop the InferLab subject, keyed on issuer and principal, with the vouched email", async () => {
    const { label, callback, text } = await signIn();
    expect(callback.status).toBe(200);
    expect(text).toContain("t".repeat(64)); // the handoff page carries the Workshop's ticket
    expect(await hooks().received(label)).toMatchObject({
      subject: { issuer: ISSUER, subject: PRINCIPAL },
      email: "ann@acme.test",
    });
  });

  it("ends the InferLab session at once, so signing in keeps nothing", async () => {
    await signIn();
    expect(seen.map(s => s.path)).toEqual(["/auth/token", "/auth/logout"]);
    expect(seen[1]!.body).toEqual({ refreshToken: "refresh-token-ended-at-once" });
  });

  it("passes no email it wasn't vouched for: the account still signs in by subject", async () => {
    tokenAnswer = tokenOk({ emailVerified: false });
    const { label } = await signIn();
    expect(await hooks().received(label)).toMatchObject({
      subject: { issuer: ISSUER, subject: PRINCIPAL }, email: null,
    });
  });
});

describe("the wrong company is refused", () => {
  it("refuses a session in another company and ends it, without reaching the Workshop", async () => {
    tokenAnswer = tokenOk({ tenantId: OTHER });
    const { label, callback, text } = await signIn();
    expect(callback.status).toBe(502);
    expect(text).toContain("belongs to another company");
    expect(await hooks().received(label)).toBeNull();
    expect(seen.map(s => s.path)).toEqual(["/auth/token", "/auth/logout"]);
  });

  it("refuses when InferOps itself answers that the session is another company's", async () => {
    tokenAnswer = () => Response.json({ error: "company_not_this_deployment" }, { status: 403 });
    const { label, text } = await signIn();
    expect(text).toContain("belongs to another company");
    expect(await hooks().received(label)).toBeNull();
  });
});

describe("login exposes no business tools", () => {
  it("the sign-in account lists no resources and refuses every request for access", async () => {
    const { label } = await signIn();
    const got = await hooks().received(label);
    expect(got?.resources).toBe(0);
    expect(got?.refused).toEqual({
      getVerifier: "An InferLab sign-in grants no access to anything.",
      ensureResources: "An InferLab sign-in grants no access to anything.",
      getGatekeeperClassFor: "An InferLab sign-in grants no access to anything.",
      reconnect: "An InferLab sign-in grants no access to anything.",
    });
  });

  it("the vendor offers sign-in by subject, lists nothing, and refuses any connection but sign-in", async () => {
    const auth = await hooks().vendor("auth");
    expect(auth.description).toMatchObject({ providesAuth: true, providesSubject: true });
    expect(auth.resources).toBe(0);
    expect(auth.connect).toBe("allowed");
    expect((await hooks().vendor("full")).connect).toBe("InferLab connects only to sign you in.");
    expect((await hooks().vendor(undefined)).connect).toBe("InferLab connects only to sign you in.");
  });

  it("never keeps the access token InferLab issued", async () => {
    const { label } = await signIn();
    expect(JSON.stringify(await hooks().received(label))).not.toContain("access-token");
  });
});

describe("bad config fails closed and loud", () => {
  it.each([
    ["no issuer", { INFERLAB_AUTH_ORIGIN: "" }, NOT_CONFIGURED.issuer],
    ["an issuer with a path", { INFERLAB_AUTH_ORIGIN: `${ISSUER}/auth` }, NOT_CONFIGURED.issuer],
    ["plain http off loopback", { INFERLAB_AUTH_ORIGIN: "http://auth.example.test" }, NOT_CONFIGURED.issuer],
    ["an issuer with credentials", { INFERLAB_AUTH_ORIGIN: "https://u:p@auth.example.test" }, NOT_CONFIGURED.issuer],
    ["no company", { INFEROPS_COMPANY: "" }, NOT_CONFIGURED.company],
    ["a company that isn't a tenant id", { INFEROPS_COMPANY: "acme" }, NOT_CONFIGURED.company],
    ["the old 'internal' company setting", { INFEROPS_COMPANY: "internal" }, NOT_CONFIGURED.company],
  ])("with %s, sign-in can't start, the browser leg says why, and nothing reaches InferLab", async (_why, bad, message) => {
    expect(readConfig({ ...env, ...bad } as Env)).toEqual({ off: message });
    expect((await hooks().vendor("auth", bad)).connect).toBe(message);
    const page = await get(`${BASE}/${"a".repeat(64)}/${"b".repeat(64)}`, bad);
    expect(page.status).toBe(503);
    expect(await page.text()).toContain(message.replaceAll("'", "&#39;").split(":")[0]);
    expect(seen).toEqual([]);
  });

  it("a setting removed mid-flow fails the callback instead of signing in", async () => {
    const attempt = await started();
    const auth = await authorize(attempt.attemptId, attempt.nonce);
    const state = auth.searchParams.get("state")!;
    // The attempt reads its own env; the browser leg with a bad env answers 503 before touching it.
    const page = await get(`${REDIRECT_URI}?code=c&state=${state}`, { INFEROPS_COMPANY: "" });
    expect(page.status).toBe(503);
    expect(await hooks().received(attempt.label)).toBeNull();
  });
});

describe("PKCE, state and the exact callback", () => {
  it("sends an S256 challenge to /authorize and the matching verifier to the exchange, with one exact redirect URI", async () => {
    const { auth } = await signIn();
    expect(auth.origin).toBe(ISSUER);
    expect(auth.pathname).toBe("/authorize");
    expect(auth.searchParams.get("client_id")).toBe("inferos");
    expect(auth.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.searchParams.get("prompt")).toBe("select_account");
    const exchange = seen.find(s => s.path === "/auth/token")!.body;
    expect(exchange).toMatchObject({ clientId: "inferos", code: "the-code", redirectUri: REDIRECT_URI });
    expect(await sha256base64url(String(exchange.codeVerifier))).toBe(auth.searchParams.get("code_challenge"));
  });

  it("keeps the redirect URI it authorized under, even if BASE_URL changes mid-flow", async () => {
    const attempt = await started();
    const auth = await authorize(attempt.attemptId, attempt.nonce);
    const moved = "http://localhost:9999/gatekeeper/inferlab";
    await get(`${moved}/oauth?code=c&state=${auth.searchParams.get("state")}`, { BASE_URL: moved });
    expect(seen.find(s => s.path === "/auth/token")!.body.redirectUri).toBe(REDIRECT_URI);
  });

  it("refuses a callback whose state is wrong, and leaves the real attempt usable", async () => {
    const attempt = await started();
    const auth = await authorize(attempt.attemptId, attempt.nonce);
    const state = auth.searchParams.get("state")!;
    const [id] = state.split(".");
    for (const bad of [`${id}.${"0".repeat(64)}`, `${id}`, `${id}.x.y`, "nonsense", ""]) {
      const page = await get(`${REDIRECT_URI}?code=c&state=${bad}`);
      expect(page.status).toBe(400);
    }
    expect(seen).toEqual([]);
    expect((await get(`${REDIRECT_URI}?code=c&state=${state}`)).status).toBe(200);
  });

  it("refuses a replayed callback: the state is single use", async () => {
    const { state } = await signIn();
    const replay = await get(`${REDIRECT_URI}?code=the-code&state=${state}`);
    expect(replay.status).toBe(400);
    expect(seen.filter(s => s.path === "/auth/token")).toHaveLength(1);
  });

  it("refuses a replayed sign-in link: the initiation nonce is single use", async () => {
    const attempt = await started();
    await authorize(attempt.attemptId, attempt.nonce);
    expect((await get(`${BASE}/${attempt.attemptId}/${attempt.nonce}`)).status).toBe(400);
  });

  it("refuses a sign-in link with the wrong nonce", async () => {
    const attempt = await started();
    expect((await get(`${BASE}/${attempt.attemptId}/${"9".repeat(64)}`)).status).toBe(400);
    // ...and the right one still works.
    await authorize(attempt.attemptId, attempt.nonce);
  });

  it("ends the attempt when InferLab reports an error, so the state can't be used after", async () => {
    const attempt = await started();
    const state = (await authorize(attempt.attemptId, attempt.nonce)).searchParams.get("state")!;
    expect((await get(`${REDIRECT_URI}?error=access_denied&state=${state}`)).status).toBe(400);
    expect((await get(`${REDIRECT_URI}?code=c&state=${state}`)).status).toBe(400);
    expect(seen).toEqual([]);
  });

  it("answers only the two legs: any other path or method is not found", async () => {
    expect((await get(`${BASE}/oauth/extra`)).status).toBe(404);
    expect((await get(`${BASE}/elsewhere`)).status).toBe(404);
    const post = await worker.fetch(new Request(`${REDIRECT_URI}?code=c&state=x`, { method: "POST" }),
                                    env as Env, ctx);
    expect(post.status).toBe(404);
  });
});

describe("what InferLab answers is checked", () => {
  it.each([
    ["no subject", { id: undefined }],
    ["a subject with a space", { id: "a b" }],
    ["a non-ASCII subject", { id: "pé" }],
    ["no company", { tenantId: undefined }],
  ])("refuses a token response with %s", async (_why, user) => {
    tokenAnswer = tokenOk(user);
    const { label, text } = await signIn();
    expect(text).toContain("incomplete sign-in response");
    expect(await hooks().received(label)).toBeNull();
  });

  it("shows InferLab's refusal by status only, never its body", async () => {
    tokenAnswer = () => new Response("redirect_uri mismatch: secret detail", { status: 400 });
    const { text } = await signIn();
    expect(text).toContain("InferLab refused the sign-in (HTTP 400).");
    expect(text).not.toContain("secret detail");
  });
});
