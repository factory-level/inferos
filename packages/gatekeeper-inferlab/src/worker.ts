// Sign in to InferOS with InferLab (FAC-214): the Workshop's "Continue with InferLab", backed by
// InferLab central-auth's authorization-code + PKCE server. Sign-in only.
//
// - The vendor declares `providesAuth` and `providesSubject`, so the Workshop keys the account on
//   the InferLab subject (issuer = INFERLAB_AUTH_ORIGIN, subject = the principal id), never on email.
// - It refuses any connect but `scopes: "auth"`, lists no resources, and its account exposes no
//   tool, resource or credential: signing in grants nothing. Business access is a separate
//   connection (FAC-235), not this package.
// - One `SignInAttempt` Durable Object per attempt holds the Workshop's callback, the single-use
//   initiation and OAuth nonces (the kit's connect-handshake), and the PKCE verifier, and deletes
//   itself once used or by alarm.
// - The code is exchanged server-side. The session InferLab opens is ended at once; only the subject,
//   the company and a vouched email are kept, and a session in another company than INFEROPS_COMPANY
//   is refused.
// - Without a valid INFERLAB_AUTH_ORIGIN and INFEROPS_COMPANY, every attempt fails with a message
//   naming the setting. There is no default issuer, demo company or other fallback.
//
// Ported from the archived fork's custom-gatekeepers/gatekeeper-inferops (24f5d885); see README.md
// for the ledger of what was taken and what was left behind.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import { advanceToOAuth, claimOAuth, putInitiation } from "@gadgets/gatekeeper-kit/connect-handshake";
import {
  INITIATION_NONCE_LIFETIME_MS, NONCE_BYTES, OAUTH_NONCE_LIFETIME_MS, generateNonce,
} from "@gadgets/gatekeeper-kit/connect-nonce";
import {
  INVALID_LINK_HTML, connectHandoffPageHtml, errorPageHtml, htmlResponse,
} from "@gadgets/gatekeeper-kit/connect-pages";
import { createPkce } from "@gadgets/gatekeeper-kit/oauth-client";
import { createLogger } from "@gadgets/observability/logger";
import type {
  AccountDescription, ConnectHandoff, Gatekeeper, GatekeeperConnectCallback, GatekeeperConnectOptions,
  GatekeeperSubject, GatekeeperUser, GatekeeperUserVerifier, GatekeeperVendor as GatekeeperVendorIface,
  ResourceConfiguratorFrame, SupportedResource, VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { type InferLabConfig, basePathOf, readConfig, redirectUriFor } from "./config";
import { INFERLAB_CLIENT_ID, OTHER_COMPANY, SignInFailure, endSession, exchangeCode } from "./token";

const logger = createLogger<{ vendorId: string }>({
  component: "gatekeeper.inferlab", vendorId: "inferlab",
});

const CALLBACK_KEY = "callback";
/** A plain mark, inline so the account needs no asset. */
const INFERLAB_LOGO_URL = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" ' +
  'fill="#4f46e5"/><text x="16" y="22" font-size="16" text-anchor="middle" fill="#fff" ' +
  'font-family="sans-serif">IL</text></svg>');
const HEX_64 = /^[0-9a-f]{64}$/;
/** What every refused action on the sign-in account says. */
const SIGN_IN_ONLY = "An InferLab sign-in grants no access to anything.";

/** What the OAuth stage keeps beside its nonce. */
type OAuthExtra = { codeVerifier: string; redirectUri: string };

/** The deployment's config, or a thrown error naming the setting that turns sign-in off. */
function configOrThrow(env: Cloudflare.Env): InferLabConfig {
  const config = readConfig(env);
  if ("off" in config) {
    logger.error("InferLab sign-in is not configured", { event: "inferlab.signin.not_configured" });
    throw new Error(config.off);
  }
  return config;
}

/**
 * One attempt: the Workshop's callback, the handshake nonces and the PKCE verifier. Deleted once
 * used or expired. A wrong nonce leaves the attempt alone, so only the browser holding the real one
 * can end it.
 */
@validateRpc()
export class SignInAttempt extends DurableObject<Cloudflare.Env> {
  /** Records the Workshop's callback and the initiation nonce the sign-in link carries. */
  @skipRpcValidation()
  async start(callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string): Promise<void> {
    const now = Date.now();
    this.ctx.storage.kv.put(CALLBACK_KEY, callback);
    putInitiation(this.ctx.storage.kv, initiationNonce, now);
    await this.ctx.storage.setAlarm(now + INITIATION_NONCE_LIFETIME_MS + OAUTH_NONCE_LIFETIME_MS);
  }

  /** Trades the initiation nonce for the state nonce and PKCE challenge; null when spent or expired. */
  async begin(initiationNonce: string, redirectUri: string)
      : Promise<{ oauthNonce: string; codeChallenge: string } | null> {
    const pkce = await createPkce();
    const oauthNonce = advanceToOAuth<OAuthExtra>(this.ctx.storage.kv, initiationNonce, Date.now(), {
      codeVerifier: pkce.codeVerifier, redirectUri,
    });
    return oauthNonce === null ? null : { oauthNonce, codeChallenge: pkce.codeChallenge };
  }

  /** Ends the attempt after InferLab reported an error; false when the state was already spent. */
  async abandon(oauthNonce: string): Promise<boolean> {
    if (claimOAuth(this.ctx.storage.kv, oauthNonce, Date.now()) === null) return false;
    await this.#forget();
    return true;
  }

  /**
   * Exchanges the code and hands the Workshop a sign-in account. Null when the state is unknown,
   * spent or expired; `{ error }` with a message safe to show when the sign-in fails.
   */
  async complete(code: string, oauthNonce: string)
      : Promise<{ handoff: ConnectHandoff } | { error: string } | null> {
    const flow = claimOAuth<OAuthExtra>(this.ctx.storage.kv, oauthNonce, Date.now());
    if (flow === null) return null;
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>(CALLBACK_KEY);
    try {
      if (!callback) return null;
      const config = readConfig(this.env);
      if ("off" in config) return { error: config.off };
      // The redirect URI is the one the authorize request named, so a change of BASE_URL mid-flow
      // can't make the exchange name another.
      const signedIn = await exchangeCode(config.issuer, code, flow.codeVerifier, flow.redirectUri);
      // Signing in keeps no InferLab session, whatever happens next.
      if (!await endSession(config.issuer, signedIn.refreshToken)) {
        logger.warn("InferLab logout failed", { event: "inferlab.signin.logout_failed" });
      }
      if (signedIn.tenantId !== config.tenantId) {
        logger.warn("InferLab session from another company refused", {
          event: "inferlab.signin.other_company",
        });
        throw new SignInFailure(OTHER_COMPANY);
      }
      const account = this.ctx.exports.InferLabAccount({
        props: { subject: signedIn.subject, ...(signedIn.email ? { email: signedIn.email } : {}) },
      }) as unknown as Fetcher<GatekeeperUser>;
      return { handoff: await callback.complete(account) };
    } catch (error) {
      if (error instanceof SignInFailure) return { error: error.message };
      logger.error("InferLab sign-in failed", { event: "inferlab.signin.failed", error });
      return { error: "InferLab sign-in failed. Close this window and try again." };
    } finally {
      await this.#forget();
    }
  }

  async alarm(): Promise<void> {
    await this.#forget();
  }

  async #forget(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

/** Who a sign-in named: the subject, and the email only when InferLab vouched for it. */
type AccountProps = { subject: GatekeeperSubject; email?: string };

/**
 * The account a sign-in hands the Workshop: it answers who the person is and nothing else. It lists
 * no resources and refuses every request for access, credentials or configuration.
 */
@validateRpc()
export class InferLabAccount extends WorkerEntrypoint<Cloudflare.Env, AccountProps> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    const name = this.ctx.props.email ?? this.ctx.props.subject.subject;
    return { displayName: name, uniqueName: name, avatar: { url: INFERLAB_LOGO_URL } };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  async getGatekeeperClassFor(_url: string)
      : Promise<{ class: DurableObjectClass<Gatekeeper<never>>; resource: SupportedResource }> {
    throw new Error(SIGN_IN_ONLY);
  }

  async startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error(SIGN_IN_ONLY);
  }

  /** Nothing is held, so there is nothing to revoke. */
  async revoke(): Promise<void> {}

  async reconnect(): Promise<{ url: string }> {
    throw new Error(SIGN_IN_ONLY);
  }

  async commitReconnect(_stageId: string): Promise<void> {
    throw new Error(SIGN_IN_ONLY);
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return this.ctx.props.email ?? null;
  }

  async getAuthenticatedSubject(): Promise<GatekeeperSubject | null> {
    return this.ctx.props.subject;
  }

  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    throw new Error(SIGN_IN_ONLY);
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    throw new Error(SIGN_IN_ONLY);
  }
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "InferLab",
      url: "https://inferlab.dev",
      logo: { url: INFERLAB_LOGO_URL },
      color: "#eef2ff",
      tagline: "Sign in with your InferLab account",
      description: "Sign in to this InferOS with the InferLab account of the company it belongs to. " +
        "Signing in grants nothing by itself.",
      providesAuth: true,
      providesSubject: true,
    };
  }

  /** Starts a sign-in. Any other kind of connection is refused: this gatekeeper only signs people in. */
  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>,
                       options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    if (options?.scopes !== "auth") throw new Error("InferLab connects only to sign you in.");
    const config = configOrThrow(this.env);
    const id = this.ctx.exports.SignInAttempt.newUniqueId();
    const nonce = generateNonce();
    await this.ctx.exports.SignInAttempt.get(id).start(callback, nonce);
    return { url: `${config.baseUrl}/${id.toString()}/${nonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  /** No resources, so no session types for gadget code. */
  async getTypeScriptTypes(): Promise<string> {
    return "";
  }
}

function attemptFor(ctx: ExecutionContext, attemptId: string): DurableObjectStub<SignInAttempt> | null {
  if (!HEX_64.test(attemptId)) return null;
  try {
    return ctx.exports.SignInAttempt.get(ctx.exports.SignInAttempt.idFromString(attemptId));
  } catch {
    return null;
  }
}

const invalidLink = () => htmlResponse(INVALID_LINK_HTML, 400);

export default {
  /**
   * The two browser legs under BASE_URL: `/<attempt>/<nonce>` sends the browser to InferLab's
   * `/authorize`, and `/oauth` is the exact redirect URI InferLab registered.
   */
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
    const config = readConfig(env);
    if ("off" in config) {
      return htmlResponse(errorPageHtml("InferLab sign-in is not configured", config.off), 503);
    }
    const url = new URL(request.url);
    const prefix = basePathOf(config);
    if (request.method !== "GET" || !url.pathname.startsWith(`${prefix}/`)) {
      return new Response("Not Found", { status: 404 });
    }
    const segments = url.pathname.slice(prefix.length + 1).split("/");

    if (segments.length === 2 && HEX_64.test(segments[1]!) && segments[1]!.length === NONCE_BYTES * 2) {
      const stub = attemptFor(ctx, segments[0]!);
      if (!stub) return invalidLink();
      const redirectUri = redirectUriFor(config);
      const begun = await stub.begin(segments[1]!, redirectUri);
      if (!begun) return invalidLink();
      const authorize = new URL("/authorize", config.issuer);
      authorize.searchParams.set("client_id", INFERLAB_CLIENT_ID);
      authorize.searchParams.set("redirect_uri", redirectUri);
      authorize.searchParams.set("response_type", "code");
      authorize.searchParams.set("state", `${segments[0]}.${begun.oauthNonce}`);
      authorize.searchParams.set("code_challenge", begun.codeChallenge);
      authorize.searchParams.set("code_challenge_method", "S256");
      // The account chooser: InferLab shows its sign-in page even while the browser holds a
      // central-auth session, so a person can choose which account (and company) to use.
      authorize.searchParams.set("prompt", "select_account");
      return Response.redirect(authorize.toString(), 302);
    }

    if (segments.length === 1 && segments[0] === "oauth") {
      const [attemptId, oauthNonce, extra] = (url.searchParams.get("state") ?? "").split(".");
      const stub = extra === undefined && oauthNonce && HEX_64.test(oauthNonce)
        ? attemptFor(ctx, attemptId ?? "") : null;
      if (!stub) return invalidLink();
      if (url.searchParams.has("error")) {
        if (!await stub.abandon(oauthNonce!)) return invalidLink();
        return htmlResponse(errorPageHtml("Sign-in was not completed",
          "InferLab did not complete the sign-in. Close this window and try again."), 400);
      }
      const code = url.searchParams.get("code");
      if (!code) return invalidLink();
      const result = await stub.complete(code, oauthNonce!);
      if (!result) return invalidLink();
      if ("error" in result) return htmlResponse(errorPageHtml("Sign-in failed", result.error), 502);
      return htmlResponse(connectHandoffPageHtml(result.handoff));
    }

    return new Response("Not Found", { status: 404 });
  },
};
