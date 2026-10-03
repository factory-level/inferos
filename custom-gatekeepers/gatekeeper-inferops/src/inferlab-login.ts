// Sign in with InferLab: the Workshop's gatekeeper sign-in flow (`connectAccount` with
// `scopes: "auth"`), backed by InferLab central-auth's authorization-code + PKCE server.
//
// - InferOS is the public client `inferos` (no secret). Its redirect URI is this gatekeeper's
//   `<BASE_URL>/oauth`, which InferLab registers exactly; `INFERLAB_AUTH_ORIGIN` names the auth
//   server. With no valid origin configured the vendor does not offer sign-in at all.
// - `InferLabLogin` is one short-lived Durable Object per attempt. It holds the Workshop's callback,
//   the single-use initiation and OAuth nonces, and the PKCE verifier, and deletes itself by alarm.
// - The code is exchanged server-side (`POST /auth/token`). Only an email InferLab marks
//   `emailVerified: true` is accepted, and only the email is kept: the
//   tokens are dropped, because board reads still use demo data and the InferOps API authority for
//   gatekeeper sessions is a separate, open contract.

import { DurableObject } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import { createPkce } from "@gadgets/gatekeeper-kit/oauth-client";
import {
  INITIATION_NONCE_LIFETIME_MS, OAUTH_NONCE_LIFETIME_MS, constantTimeEqual, generateNonce,
} from "@gadgets/gatekeeper-kit/connect-nonce";
import {
  INVALID_LINK_HTML, connectHandoffPageHtml, errorPageHtml, htmlResponse,
} from "@gadgets/gatekeeper-kit/connect-pages";
import { readTextCapped } from "@gadgets/gatekeeper-kit/response-body";
import { createLogger } from "@gadgets/observability/logger";
import {
  stripTrailingSlashes, type ConnectHandoff, type GatekeeperConnectCallback, type GatekeeperUser,
} from "@gadgets/workshop-shared/gatekeeper";

const logger = createLogger<{ vendorId: string }>({
  component: "gatekeeper.inferops.login", vendorId: "inferops",
});

/** InferLab's registered client id for InferOS. */
export const INFERLAB_CLIENT_ID = "inferos";

const DEFAULT_BASE_URL = "http://localhost:8787/gatekeeper/inferops";
const CALLBACK_PATH = "/oauth";
const TOKEN_EXCHANGE_TIMEOUT_MS = 30_000;
const MAX_TOKEN_RESPONSE_BYTES = 256 * 1024;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
// Both connect-flow ids are 32 random bytes in lowercase hex; the Durable Object id is 64 hex too.
const HEX_64 = /^[0-9a-f]{64}$/;

const NOT_CONFIGURED = "InferLab sign-in is not configured on this deployment.";
const FLOW_KEY = "flow";
const CALLBACK_KEY = "callback";

/** The deployment settings this flow reads. */
export type InferLabLoginEnv = { INFERLAB_AUTH_ORIGIN?: string; BASE_URL?: string };

/**
 * The configured InferLab auth origin, or null when sign-in is off. Anything but a bare HTTPS origin
 * (or plain HTTP on a loopback host, for local development) counts as off, so a malformed value fails
 * closed instead of sending users somewhere unexpected.
 */
export function inferLabAuthOrigin(env: InferLabLoginEnv): string | null {
  const raw = env.INFERLAB_AUTH_ORIGIN?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const secure = url.protocol === "https:" ||
    (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  if (!secure || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    return null;
  }
  return url.origin;
}

function baseUrl(env: InferLabLoginEnv): string {
  return stripTrailingSlashes(env.BASE_URL || DEFAULT_BASE_URL);
}

/** The redirect URI InferLab must have registered for the `inferos` client. */
export function inferLabRedirectUri(env: InferLabLoginEnv): string {
  return `${baseUrl(env)}${CALLBACK_PATH}`;
}

/** Where `connectAccount` sends the browser; `handleInferLabLogin` serves it. */
export function inferLabLoginUrl(env: InferLabLoginEnv, attemptId: string, nonce: string): string {
  return `${baseUrl(env)}/${attemptId}/${nonce}`;
}

type Flow =
  | { stage: "initiation"; nonce: string; expiresAt: number }
  | { stage: "oauth"; nonce: string; expiresAt: number; codeVerifier: string; redirectUri: string };

/** The identity InferLab vouched for, as the sign-in account carries it. */
export type InferLabIdentity = { email: string };

/** Mints the account handed to the Workshop's callback; it only has to report the email. */
export type InferLabAccountFactory = (identity: InferLabIdentity) => Fetcher<GatekeeperUser>;

/** Extracts the verified email from a `POST /auth/token` response body, or throws. */
export function identityFromTokenResponse(body: string): InferLabIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new SignInFailure("InferLab returned an unreadable sign-in response.");
  }
  const user = (parsed as { user?: unknown } | null)?.user as
    { email?: unknown; emailVerified?: unknown } | undefined;
  const email = typeof user?.email === "string" ? user.email.trim().toLowerCase() : "";
  // The Workshop keys accounts by email, so only an address InferLab vouches for may sign in.
  // InferLab also issues sessions whose email nobody proved (invitations, impersonation), so a
  // missing flag fails closed.
  if (!email.includes("@") || email.length > 320 || user?.emailVerified !== true) {
    throw new SignInFailure("Your InferLab account has no verified email address.");
  }
  return { email };
}

/**
 * One sign-in attempt: callback, nonces and PKCE verifier, deleted once used or expired. A wrong
 * nonce leaves the attempt alone, so only the browser holding the real one can end it.
 */
@validateRpc()
export class InferLabLogin extends DurableObject<Cloudflare.Env> {
  /** Records the Workshop's callback and the initiation nonce the login URL carries. */
  @skipRpcValidation()
  async start(callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string): Promise<void> {
    const now = Date.now();
    this.ctx.storage.kv.put(CALLBACK_KEY, callback);
    this.ctx.storage.kv.put<Flow>(FLOW_KEY, {
      stage: "initiation", nonce: initiationNonce, expiresAt: now + INITIATION_NONCE_LIFETIME_MS,
    });
    await this.ctx.storage.setAlarm(
      now + INITIATION_NONCE_LIFETIME_MS + OAUTH_NONCE_LIFETIME_MS);
  }

  /**
   * Trades the initiation nonce for the authorization request's state nonce and PKCE challenge.
   * Returns null when the link is unknown, used or expired.
   */
  async begin(initiationNonce: string, redirectUri: string)
      : Promise<{ oauthNonce: string; codeChallenge: string } | null> {
    const flow = this.#claim("initiation", initiationNonce);
    if (!flow) return null;
    const pkce = await createPkce();
    const oauthNonce = generateNonce();
    this.ctx.storage.kv.put<Flow>(FLOW_KEY, {
      stage: "oauth", nonce: oauthNonce, expiresAt: Date.now() + OAUTH_NONCE_LIFETIME_MS,
      codeVerifier: pkce.codeVerifier, redirectUri,
    });
    return { oauthNonce, codeChallenge: pkce.codeChallenge };
  }

  /** Burns the attempt after InferLab reported an error; false when it was already gone. */
  async abandon(oauthNonce: string): Promise<boolean> {
    if (!this.#claim("oauth", oauthNonce)) return false;
    await this.#forget();
    return true;
  }

  /**
   * Exchanges the authorization code, then hands the Workshop an account carrying the verified
   * email. Returns null when the state is unknown, used or expired, and `{ error }` with a message
   * safe to show the user when the sign-in fails.
   */
  async complete(code: string, oauthNonce: string)
      : Promise<{ handoff: ConnectHandoff } | { error: string } | null> {
    const flow = this.#claim("oauth", oauthNonce);
    if (flow?.stage !== "oauth") return null;
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>(CALLBACK_KEY);
    try {
      if (!callback) return null;
      const origin = inferLabAuthOrigin(this.env);
      if (!origin) return { error: NOT_CONFIGURED };
      const identity = await exchangeCode(origin, code, flow.codeVerifier, flow.redirectUri);
      const account = this.ctx.exports.InferOpsAccount({
        props: { accountId: crypto.randomUUID(), email: identity.email },
      }) as unknown as Fetcher<GatekeeperUser>;
      return { handoff: await callback.complete(account) };
    } catch (error) {
      if (error instanceof SignInFailure) return { error: error.message };
      logger.error("InferLab sign-in failed", { event: "inferlab.login.failed", error });
      return { error: "InferLab sign-in failed. Close this window and try again." };
    } finally {
      await this.#forget();
    }
  }

  async alarm(): Promise<void> {
    await this.#forget();
  }

  #claim(stage: Flow["stage"], nonce: string): Flow | null {
    const flow = this.ctx.storage.kv.get<Flow>(FLOW_KEY);
    if (!flow || flow.stage !== stage || !(Date.now() < flow.expiresAt) ||
        !constantTimeEqual(flow.nonce, nonce)) {
      return null;
    }
    // Single use: a replayed link or state finds nothing.
    this.ctx.storage.kv.delete(FLOW_KEY);
    return flow;
  }

  async #forget(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

/** A sign-in failure whose message is safe to show the user. */
class SignInFailure extends Error {}

async function exchangeCode(origin: string, code: string, codeVerifier: string,
                            redirectUri: string): Promise<InferLabIdentity> {
  const response = await fetch(`${origin}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ clientId: INFERLAB_CLIENT_ID, code, codeVerifier, redirectUri }),
    signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
  });
  const body = await readTextCapped(response, MAX_TOKEN_RESPONSE_BYTES);
  if (!response.ok) {
    // The body may echo request details; never surface it.
    throw new SignInFailure(`InferLab rejected the sign-in (HTTP ${response.status}).`);
  }
  return identityFromTokenResponse(body);
}

type LoginNamespace = DurableObjectNamespace<InferLabLogin>;

/**
 * Starts an attempt for `connectAccount`: a fresh Durable Object holding the callback, and the URL
 * the Workshop opens in the sign-in popup.
 */
export async function startInferLabLogin(namespace: LoginNamespace, env: InferLabLoginEnv,
                                         callback: Fetcher<GatekeeperConnectCallback>)
    : Promise<{ url: string }> {
  if (!inferLabAuthOrigin(env)) throw new Error(NOT_CONFIGURED);
  const id = namespace.newUniqueId();
  const nonce = generateNonce();
  await namespace.get(id).start(callback, nonce);
  return { url: inferLabLoginUrl(env, id.toString(), nonce) };
}

function basePath(env: InferLabLoginEnv): string {
  const path = new URL(baseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

function attemptStub(namespace: LoginNamespace, attemptId: string) {
  if (!HEX_64.test(attemptId)) return null;
  try {
    return namespace.get(namespace.idFromString(attemptId));
  } catch {
    return null;
  }
}

const invalidLink = () => htmlResponse(INVALID_LINK_HTML, 400);

/**
 * Serves the two browser legs of the flow under BASE_URL: `/<attempt>/<nonce>` redirects to InferLab's
 * `/authorize`, and `/oauth` is the registered redirect URI. Returns null for any other path.
 */
export async function handleInferLabLogin(request: Request, env: InferLabLoginEnv,
                                          namespace: LoginNamespace): Promise<Response | null> {
  const url = new URL(request.url);
  const prefix = basePath(env);
  if (request.method !== "GET" || !url.pathname.startsWith(`${prefix}/`)) return null;
  const segments = url.pathname.slice(prefix.length + 1).split("/");

  if (segments.length === 2 && HEX_64.test(segments[1])) {
    const origin = inferLabAuthOrigin(env);
    if (!origin) {
      return htmlResponse(errorPageHtml("InferLab sign-in is not configured",
        "Ask the administrator of this deployment to set INFERLAB_AUTH_ORIGIN."), 503);
    }
    const stub = attemptStub(namespace, segments[0]);
    if (!stub) return invalidLink();
    const redirectUri = inferLabRedirectUri(env);
    const begun = await stub.begin(segments[1], redirectUri);
    if (!begun) return invalidLink();

    const authorize = new URL("/authorize", origin);
    authorize.searchParams.set("client_id", INFERLAB_CLIENT_ID);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("state", `${segments[0]}.${begun.oauthNonce}`);
    authorize.searchParams.set("code_challenge", begun.codeChallenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    return Response.redirect(authorize.toString(), 302);
  }

  if (segments.length === 1 && `/${segments[0]}` === CALLBACK_PATH) {
    const [attemptId, oauthNonce, extra] = (url.searchParams.get("state") ?? "").split(".");
    const stub = extra === undefined && oauthNonce && HEX_64.test(oauthNonce)
      ? attemptStub(namespace, attemptId) : null;
    if (!stub) return invalidLink();

    if (url.searchParams.has("error")) {
      if (!await stub.abandon(oauthNonce)) return invalidLink();
      return htmlResponse(errorPageHtml("Sign-in was not completed",
        "InferLab did not complete the sign-in. Close this window and try again."), 400);
    }
    const code = url.searchParams.get("code");
    if (!code) return invalidLink();

    const result = await stub.complete(code, oauthNonce);
    if (!result) return invalidLink();
    if ("error" in result) return htmlResponse(errorPageHtml("Sign-in failed", result.error), 502);
    return htmlResponse(connectHandoffPageHtml(result.handoff));
  }

  return null;
}
