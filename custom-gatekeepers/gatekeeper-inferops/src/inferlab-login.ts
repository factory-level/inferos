// Sign in and connect with InferLab: the Workshop's gatekeeper flows (`connectAccount` with
// `scopes: "auth"` or `"full"`, and `GatekeeperUser.reconnect`), backed by InferLab central-auth's
// authorization-code + PKCE server.
//
// - InferOS is the public client `inferos` (no secret). Its redirect URI is this gatekeeper's
//   `<BASE_URL>/oauth`, which InferLab registers exactly; `INFERLAB_AUTH_ORIGIN` names the auth
//   server. With no valid origin configured the vendor offers neither sign-in nor a connect flow.
// - `InferLabLogin` is one short-lived Durable Object per attempt. It holds the flow's purpose, the
//   Workshop's callback, the single-use initiation and OAuth nonces, and the PKCE verifier, and
//   deletes itself by alarm.
// - The code is exchanged server-side (`POST /auth/token`). What happens to the session depends on
//   the purpose:
//   - Sign-in keeps only the email, and only when InferLab marks it `emailVerified: true`; the
//     session is signed out again at once, so signing in leaves no InferLab session behind.
//   - A connect stores the session in the account's `InferOpsCredentials` object, so the person's
//     own authority backs every request the account makes (inferops-credentials.ts).
//   - A reconnect stages the session there until the Workshop commits it.
//   Before either stores a session, the slugs of the person's workspaces are read from InferOps
//   (`GET /workspaces`) and kept beside the memberships InferLab reported, since a resource URL
//   names its workspace by slug. A failure there ends the attempt and signs the session out.

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
import {
  accessTokenExpiry, logoutInferLabSession, type InferOpsConnection, type InferOpsCredentials,
  type InferOpsWorkspace,
} from "./inferops-credentials";
import { endpointFromEnv, listWorkspaceSlugs, type InferOpsEndpoint } from "./http-inferops";

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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NOT_CONFIGURED = "InferLab sign-in is not configured on this deployment.";
const FLOW_KEY = "flow";
const PURPOSE_KEY = "purpose";
const CALLBACK_KEY = "callback";

/** The deployment settings this flow reads. */
export type InferLabLoginEnv = {
  INFERLAB_AUTH_ORIGIN?: string; BASE_URL?: string; INFEROPS_BASE_URL?: string;
};

/**
 * What an attempt is for. A sign-in hands the Workshop a transient account carrying the verified
 * email; a connect mints a persistent account backed by the person's session; a reconnect replaces
 * an existing account's session.
 */
export type LoginPurpose =
  | { kind: "signin" }
  | { kind: "connect" }
  | { kind: "reconnect"; accountId: string };

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

/**
 * The API endpoint connected accounts call: `INFEROPS_BASE_URL`, or the InferLab origin itself when
 * only that is configured (locally one server serves both). Null while neither is set. This is the
 * only place a connected account's deployment comes from; a resource URL never names one.
 */
export function inferOpsApiEndpoint(env: InferLabLoginEnv): InferOpsEndpoint | null {
  const configured = endpointFromEnv(env);
  if (configured) return configured;
  const origin = inferLabAuthOrigin(env);
  return origin ? { baseUrl: origin, host: new URL(origin).host } : null;
}

/**
 * The connection with each membership's workspace slug, as InferOps lists it for the new token.
 * Only memberships InferLab reported are kept; a listed workspace outside them is ignored.
 */
async function withWorkspaceSlugs(env: InferLabLoginEnv, exchange: InferLabExchange)
    : Promise<InferOpsConnection> {
  const endpoint = inferOpsApiEndpoint(env);
  if (!endpoint) throw new SignInFailure(NOT_CONFIGURED);
  let slugs: Map<string, string>;
  try {
    const listed = await listWorkspaceSlugs(endpoint.baseUrl, exchange.grant.accessToken);
    slugs = new Map(listed.map(w => [w.workspaceId, w.slug]));
  } catch (error) {
    logger.warn("InferOps workspace list failed", { event: "inferlab.workspaces.failed", error });
    throw new SignInFailure(
      "InferOps could not list your workspaces. Close this window and try again.");
  }
  const workspaces = exchange.identity.workspaces.map(w => {
    const workspaceSlug = slugs.get(w.workspaceId);
    return workspaceSlug ? { ...w, workspaceSlug } : w;
  });
  return { grant: exchange.grant, identity: { ...exchange.identity, workspaces } };
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

/** What a `POST /auth/token` response yields: the session and whom it belongs to. */
export type InferLabExchange = InferOpsConnection & {
  /** Whether InferLab proved the person controls `identity.email`. */
  emailVerified: boolean;
};

/** Parses a `POST /auth/token` response body, or throws a `SignInFailure`. */
export function exchangeFromTokenResponse(body: string): InferLabExchange {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new SignInFailure("InferLab returned an unreadable sign-in response.");
  }
  const response = (parsed ?? {}) as { token?: unknown; refreshToken?: unknown; user?: unknown };
  const user = (response.user ?? {}) as {
    id?: unknown; email?: unknown; emailVerified?: unknown; tenantId?: unknown; workspaces?: unknown;
  };
  const email = typeof user.email === "string" ? user.email.trim().toLowerCase() : "";
  if (!email.includes("@") || email.length > 320) {
    throw new SignInFailure("Your InferLab account has no email address.");
  }
  if (typeof response.token !== "string" || !response.token ||
      typeof response.refreshToken !== "string" || !response.refreshToken ||
      typeof user.id !== "string" || !user.id || typeof user.tenantId !== "string" || !user.tenantId) {
    throw new SignInFailure("InferLab returned an incomplete sign-in response.");
  }
  const workspaces: InferOpsWorkspace[] = [];
  for (const entry of Array.isArray(user.workspaces) ? user.workspaces : []) {
    const w = (entry ?? {}) as { workspaceId?: unknown; workspaceName?: unknown; product?: unknown };
    // InferOps workspaces hold boards, InferMind ones the Wiki; any other product is not kept.
    if (w.product !== "inferops" && w.product !== "infermind") continue;
    if (typeof w.workspaceId !== "string" || !UUID.test(w.workspaceId)) {
      throw new SignInFailure("InferLab returned an incomplete sign-in response.");
    }
    workspaces.push({
      workspaceId: w.workspaceId.toLowerCase(),
      workspaceName: typeof w.workspaceName === "string" ? w.workspaceName : w.workspaceId,
      ...(w.product === "infermind" ? { product: "infermind" as const } : {}),
    });
  }
  return {
    grant: {
      accessToken: response.token, accessExpiresAt: accessTokenExpiry(response.token),
      refreshToken: response.refreshToken,
    },
    identity: { userId: user.id, email, tenantId: user.tenantId, workspaces },
    emailVerified: user.emailVerified === true,
  };
}

/**
 * The identity a sign-in may key the Workshop account on: only an email InferLab vouches for.
 * InferLab also issues sessions whose email nobody proved (invitations, impersonation), so a missing
 * flag fails closed.
 */
export function verifiedEmail(exchange: InferLabExchange): string {
  if (!exchange.emailVerified) {
    throw new SignInFailure("Your InferLab account has no verified email address.");
  }
  return exchange.identity.email;
}

/** The namespace the flow mints accounts' credential objects in. */
type CredentialsNamespace = DurableObjectNamespace<InferOpsCredentials>;

/**
 * One attempt: purpose, callback, nonces and PKCE verifier, deleted once used or expired. A wrong
 * nonce leaves the attempt alone, so only the browser holding the real one can end it.
 */
@validateRpc()
export class InferLabLogin extends DurableObject<Cloudflare.Env> {
  /** Records what the attempt is for, the Workshop's callback and the initiation nonce the URL carries. */
  @skipRpcValidation()
  async start(purpose: LoginPurpose, initiationNonce: string,
              callback?: Fetcher<GatekeeperConnectCallback>): Promise<void> {
    const now = Date.now();
    this.ctx.storage.kv.put(PURPOSE_KEY, purpose);
    if (callback) this.ctx.storage.kv.put(CALLBACK_KEY, callback);
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
   * Exchanges the authorization code and finishes the attempt for its purpose. Returns null when the
   * state is unknown, used or expired, and `{ error }` with a message safe to show the user when the
   * flow fails.
   */
  async complete(code: string, oauthNonce: string)
      : Promise<{ handoff: ConnectHandoff } | { error: string } | null> {
    const flow = this.#claim("oauth", oauthNonce);
    if (flow?.stage !== "oauth") return null;
    const purpose = this.ctx.storage.kv.get<LoginPurpose>(PURPOSE_KEY);
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>(CALLBACK_KEY);
    try {
      if (!purpose) return null;
      const origin = inferLabAuthOrigin(this.env);
      if (!origin) return { error: NOT_CONFIGURED };
      const exchange = await exchangeCode(origin, code, flow.codeVerifier, flow.redirectUri);
      return { handoff: await this.#finish(origin, purpose, exchange, callback) };
    } catch (error) {
      if (error instanceof SignInFailure) return { error: error.message };
      logger.error("InferLab flow failed", { event: "inferlab.login.failed", error });
      return { error: "InferLab sign-in failed. Close this window and try again." };
    } finally {
      await this.#forget();
    }
  }

  async #finish(origin: string, purpose: LoginPurpose, exchange: InferLabExchange,
                callback: Fetcher<GatekeeperConnectCallback> | undefined): Promise<ConnectHandoff> {
    const credentials = this.ctx.exports.InferOpsCredentials as unknown as CredentialsNamespace;
    switch (purpose.kind) {
      case "signin": {
        if (!callback) throw new Error("This sign-in attempt has no callback.");
        // Only the email is kept: the session itself is ended, since signing in grants nothing.
        const email = verifiedEmail(exchange);
        await logoutInferLabSession(origin, exchange.grant.refreshToken);
        return callback.complete(this.#account({ accountId: crypto.randomUUID(), email }));
      }
      case "connect": {
        if (!callback) throw new Error("This connect attempt has no callback.");
        const connection = await this.#withSlugs(origin, exchange);
        const accountId = crypto.randomUUID();
        const store = credentials.get(credentials.idFromName(accountId));
        await store.install(connection, callback);
        try {
          return await callback.complete(this.#account({
            accountId, connected: true,
            email: exchange.emailVerified ? exchange.identity.email : undefined,
          }));
        } catch (error) {
          // Reachable from no Workshop account, so the session is ended and the store wiped.
          await store.revoke();
          throw error;
        }
      }
      case "reconnect": {
        const connection = await this.#withSlugs(origin, exchange);
        const store = credentials.get(credentials.idFromName(purpose.accountId));
        return store.completeReconnect(connection);
      }
    }
  }

  /** `withWorkspaceSlugs`, signing the new session out when it fails, since nothing will hold it. */
  async #withSlugs(origin: string, exchange: InferLabExchange): Promise<InferOpsConnection> {
    try {
      return await withWorkspaceSlugs(this.env, exchange);
    } catch (error) {
      await logoutInferLabSession(origin, exchange.grant.refreshToken);
      throw error;
    }
  }

  #account(props: { accountId: string; email?: string; connected?: boolean }): Fetcher<GatekeeperUser> {
    return this.ctx.exports.InferOpsAccount({ props }) as unknown as Fetcher<GatekeeperUser>;
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

/** A failure whose message is safe to show the user. */
class SignInFailure extends Error {}

async function exchangeCode(origin: string, code: string, codeVerifier: string,
                            redirectUri: string): Promise<InferLabExchange> {
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
  return exchangeFromTokenResponse(body);
}

type LoginNamespace = DurableObjectNamespace<InferLabLogin>;

/**
 * Starts an attempt: a fresh Durable Object holding its purpose and callback, and the URL the
 * Workshop opens in the popup. A reconnect has no callback of its own; the account's stored one
 * reports its completion.
 */
export async function startInferLabLogin(namespace: LoginNamespace, env: InferLabLoginEnv,
                                         purpose: LoginPurpose,
                                         callback?: Fetcher<GatekeeperConnectCallback>)
    : Promise<{ url: string }> {
  if (!inferLabAuthOrigin(env)) throw new Error(NOT_CONFIGURED);
  const id = namespace.newUniqueId();
  const nonce = generateNonce();
  await namespace.get(id).start(purpose, nonce, callback);
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
