// The code exchange with InferLab central-auth (`POST /auth/token`) and the logout that follows it.
// Ported from the archived fork's `custom-gatekeepers/gatekeeper-inferops/src/inferlab-login.ts`
// (24f5d885), sign-in only: no workspace list, no stored session, no InferOps API call.

import { readTextCapped } from "@gadgets/gatekeeper-kit/response-body";
import type { GatekeeperSubject } from "@gadgets/workshop-shared/gatekeeper";

/** InferLab's registered client id for InferOS: a public client, no secret. */
export const INFERLAB_CLIENT_ID = "inferos";

const EXCHANGE_TIMEOUT_MS = 30_000;
const LOGOUT_TIMEOUT_MS = 10_000;
const MAX_TOKEN_RESPONSE_BYTES = 256 * 1024;
/** OpenID Connect's rule for `sub`, which the InferLab contract adopts. */
const SUBJECT = /^[\x21-\x7e]{1,255}$/;

/** What a sign-in keeps from the exchange: whom it names, and nothing that grants access. */
export type SignedIn = {
  subject: GatekeeperSubject;
  tenantId: string;
  /** Present only when InferLab vouches for it (`emailVerified: true`). Display data. */
  email?: string;
  /** Only to end the session at once; never stored. */
  refreshToken: string;
};

/** A failure whose message is safe to show the person signing in. */
export class SignInFailure extends Error {}

/** InferOps' answer for a session in another company than this deployment's. */
const COMPANY_NOT_THIS_DEPLOYMENT = "company_not_this_deployment";

/** Shown when a session belongs to another company. Names neither company. */
export const OTHER_COMPANY =
  "This InferOS belongs to another company. In InferLab, choose the company this InferOS is for, " +
  "then sign in again.";

/** Parses a `POST /auth/token` body into what a sign-in keeps, or throws a `SignInFailure`. */
export function signedInFrom(issuer: string, body: string): SignedIn {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new SignInFailure("InferLab returned an unreadable sign-in response.");
  }
  const response = (parsed ?? {}) as { refreshToken?: unknown; user?: unknown };
  const user = (response.user ?? {}) as {
    id?: unknown; email?: unknown; emailVerified?: unknown; tenantId?: unknown;
  };
  if (typeof response.refreshToken !== "string" || !response.refreshToken ||
      typeof user.id !== "string" || !SUBJECT.test(user.id) ||
      typeof user.tenantId !== "string" || !user.tenantId) {
    throw new SignInFailure("InferLab returned an incomplete sign-in response.");
  }
  const email = typeof user.email === "string" ? user.email.trim().toLowerCase() : "";
  return {
    subject: { issuer, subject: user.id },
    tenantId: user.tenantId.toLowerCase(),
    ...(user.emailVerified === true && email.includes("@") && email.length <= 320 ? { email } : {}),
    refreshToken: response.refreshToken,
  };
}

/** Exchanges an authorization code at InferLab, never following a redirect. */
export async function exchangeCode(issuer: string, code: string, codeVerifier: string,
                                   redirectUri: string): Promise<SignedIn> {
  const response = await fetch(`${issuer}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ clientId: INFERLAB_CLIENT_ID, code, codeVerifier, redirectUri }),
    // A redirect would carry the code elsewhere.
    redirect: "manual",
    signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
  });
  const body = await readTextCapped(response, MAX_TOKEN_RESPONSE_BYTES);
  if (!response.ok) {
    if (response.status === 403 && errorCode(body) === COMPANY_NOT_THIS_DEPLOYMENT) {
      throw new SignInFailure(OTHER_COMPANY);
    }
    // The body may echo request details; never show it.
    throw new SignInFailure(`InferLab refused the sign-in (HTTP ${response.status}).`);
  }
  return signedInFrom(issuer, body);
}

/**
 * Ends the InferLab session a sign-in opened, since signing in grants nothing to keep. Best effort:
 * the caller already has what it needs, and a failure only leaves the session to expire.
 */
export async function endSession(issuer: string, refreshToken: string): Promise<boolean> {
  try {
    const response = await fetch(`${issuer}/auth/logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
      redirect: "manual",
      signal: AbortSignal.timeout(LOGOUT_TIMEOUT_MS),
    });
    return response.ok || response.status === 401;
  } catch {
    return false;
  }
}

/** The `error` field of a failed token response, compared and never shown. */
function errorCode(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    const error = parsed && typeof parsed === "object" ? (parsed as { error?: unknown }).error : undefined;
    return typeof error === "string" ? error : null;
  } catch {
    return null;
  }
}
