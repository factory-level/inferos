import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { z } from 'zod';
import type { AccountRecord, TokenSet } from './credentialStore.ts';
import { fail, providerError } from './errors.ts';

/** Required direct-route permission; identity alone never enables inference. */
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
/** OpenAI resource audience for the public Responses API. */
export const RESOURCE = 'https://api.openai.com/v1';
/** Identity and plan permissions requested by the OSS public client. */
export const SCOPES = 'openid profile email offline_access resource.invoke ' + PLAN_SCOPE;
const ISSUER = 'https://auth.openai.com';
const AUTHORIZE = ISSUER + '/api/accounts/authorize';
const TOKEN = ISSUER + '/api/accounts/oauth/token';

/** Fresh proof material for exactly one authorization attempt. */
export type AuthorizationAttempt = {
  state: string; nonce: string; verifier: string; redirectUri: string; hostId: string;
  clientId: string; account?: AccountRecord; consent: boolean;
};

/** Verified identity and returned credentials; not yet activated in Workshop. */
export type AuthorizedAccount = {
  clientId: string; subject: string; email?: string; tokens: TokenSet;
};

/** Registration-specific boundary, replaced by a partner adapter only after onboarding. */
export interface AuthProvider {
  authorize(attempt: AuthorizationAttempt): string;
  exchange(attempt: AuthorizationAttempt, callback: URL, registered?: (clientId: string) => Promise<void>): Promise<AuthorizedAccount>;
  refresh(account: AccountRecord): Promise<TokenSet>;
  revoke(account: AccountRecord): Promise<void>;
}

/** Cryptographically random, URL-safe 256-bit secret used for state and handoff capabilities. */
export const secret = (): string => randomBytes(32).toString('hex');

const responseSchema = z.object({
  access_token: z.string().min(1), refresh_token: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(), token_type: z.string(), expires_in: z.number().positive(),
  scope: z.string().optional(), earliest_refresh_at: z.union([z.string(), z.number()]).optional(),
});

/** Public-client implementation of OpenAI's documented OSS dynamic registration. */
export class OssDynamicRegistrationProvider implements AuthProvider {
  #discovery?: Promise<{ jwks_uri: string; revocation_endpoint: string }>;
  #jwks?: ReturnType<typeof createRemoteJWKSet>;
  constructor(private readonly request: typeof fetch = fetch, private readonly now: () => number = Date.now) {}

  authorize(attempt: AuthorizationAttempt): string {
    const url = new URL(AUTHORIZE);
    const parameters: Record<string, string> = {
      client_id: attempt.clientId, ext_agent_host_id: attempt.hostId,
      response_type: 'code', redirect_uri: attempt.redirectUri, scope: SCOPES, resource: RESOURCE,
      state: attempt.state, nonce: attempt.nonce, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url'),
    };
    if (attempt.clientId === 'dynamic_agent_client') parameters.agent_name_hint = 'InferOS';
    if (attempt.account?.tokens?.id_token) parameters.id_token_hint = attempt.account.tokens.id_token;
    if (attempt.account?.email) parameters.login_hint = attempt.account.email;
    if (attempt.consent) parameters.prompt = 'consent';
    url.search = new URLSearchParams(parameters).toString();
    return url.href;
  }

  async #metadata() {
    if (!this.#discovery) {
      this.#discovery = (async () => {
        const response = await this.request(ISSUER + '/.well-known/openid-configuration', {
          signal: AbortSignal.timeout(15_000), redirect: 'error',
        });
        if (!response.ok) throw providerError(response.status, await response.json().catch(() => null));
        const data = z.object({ issuer: z.literal(ISSUER), jwks_uri: z.string().url(), revocation_endpoint: z.string().url() }).parse(await response.json());
        for (const value of [data.jwks_uri, data.revocation_endpoint]) {
          const endpoint = new URL(value);
          if (endpoint.origin !== ISSUER || endpoint.username || endpoint.password || endpoint.hash) {
            fail('invalid_discovery', 'OpenAI discovery returned an unexpected endpoint.', 'configuration');
          }
        }
        return data;
      })().catch(error => { this.#discovery = undefined; throw error; });
    }
    return this.#discovery;
  }

  async #identity(idToken: string, clientId: string, nonce?: string) {
    if (!this.#jwks) this.#jwks = createRemoteJWKSet(new URL((await this.#metadata()).jwks_uri), { [customFetch]: this.request });
    try {
      const { payload } = await jwtVerify(idToken, this.#jwks, {
        issuer: ISSUER, audience: clientId, algorithms: ['RS256', 'ES256'],
        requiredClaims: ['iss', 'aud', 'exp', 'sub'], currentDate: new Date(this.now()),
      });
      if (nonce !== undefined && payload.nonce !== nonce) throw new Error('nonce');
      if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('subject');
      return { subject: payload.sub, ...(typeof payload.email === 'string' && { email: payload.email }) };
    } catch { fail('invalid_identity', 'OpenAI identity validation failed. Start sign-in again.', 'sign-in'); }
  }

  async #token(parameters: Record<string, string>, previousScopes?: string[]): Promise<TokenSet> {
    const response = await this.request(TOKEN, {
      method: 'POST', body: new URLSearchParams(parameters),
      signal: AbortSignal.timeout(20_000), redirect: 'error',
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw providerError(response.status, body, response.headers.get('x-request-id') ?? undefined);
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success || parsed.data.token_type.toLowerCase() !== 'bearer') {
      fail('invalid_token_response', 'OpenAI returned an invalid token response.', 'configuration');
    }
    const { scope, token_type: _type, ...tokens } = parsed.data;
    return { ...tokens, token_type: 'Bearer', saved_at: new Date(this.now()).toISOString(),
      scopes: scope === undefined ? previousScopes ?? [] : scope.split(/\s+/).filter(Boolean) };
  }

  async exchange(attempt: AuthorizationAttempt, callback: URL, registered?: (clientId: string) => Promise<void>): Promise<AuthorizedAccount> {
    if (callback.searchParams.get('state') !== attempt.state) fail('invalid_state', 'Invalid sign-in state.');
    const error = callback.searchParams.get('error');
    if (error) {
      if (error === 'access_denied') fail('access_denied', 'ChatGPT plan usage was not enabled. You can try again or configure an API key.', 'consent');
      fail('authorization_failed', 'ChatGPT sign-in was not completed.', 'sign-in');
    }
    const returned = callback.searchParams.get('client_id');
    const isNew = attempt.clientId === 'dynamic_agent_client';
    if (isNew && (!returned || !/^oaiapp_[A-Za-z0-9_-]+$/.test(returned))) fail('missing_client_id', 'OpenAI did not complete client registration.', 'sign-in');
    if (!isNew && returned && returned !== attempt.clientId) fail('client_mismatch', 'The returned client does not match the selected registration.');
    const clientId = isNew ? returned! : attempt.clientId;
    const code = callback.searchParams.get('code');
    if (!code) fail('missing_code', 'OpenAI did not return an authorization code.', 'sign-in');
    // Keep an issued registration even if this one-use code expires before exchange succeeds.
    if (isNew) await registered?.(clientId);
    const tokens = await this.#token({ grant_type: 'authorization_code', client_id: clientId,
      code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource: RESOURCE });
    if (!tokens.id_token) fail('missing_id_token', 'OpenAI did not return an identity token.', 'sign-in');
    const identity = await this.#identity(tokens.id_token, clientId, attempt.nonce);
    if (attempt.account && identity.subject !== attempt.account.subject) fail('identity_mismatch', 'This is not the selected ChatGPT account.');
    return { clientId, ...identity, tokens };
  }

  async refresh(account: AccountRecord): Promise<TokenSet> {
    const old = account.tokens;
    if (!old?.refresh_token) fail('sign_in_required', 'Sign in with ChatGPT again to renew access.', 'sign-in', 401);
    const tokens = await this.#token({ grant_type: 'refresh_token', client_id: account.client_id,
      refresh_token: old.refresh_token, resource: RESOURCE }, old.scopes);
    if (!tokens.refresh_token) fail('missing_refresh_token', 'OpenAI did not return a replacement refresh token.', 'sign-in');
    if (tokens.id_token) {
      const identity = await this.#identity(tokens.id_token, account.client_id);
      if (identity.subject !== account.subject) fail('identity_mismatch', 'The renewed ChatGPT session changed identity.', 'sign-in');
    }
    return { ...tokens, id_token: tokens.id_token ?? old.id_token };
  }

  async revoke(account: AccountRecord): Promise<void> {
    if (!account.tokens?.refresh_token) return;
    const response = await this.request((await this.#metadata()).revocation_endpoint, {
      method: 'POST', body: new URLSearchParams({ token: account.tokens.refresh_token,
        token_type_hint: 'refresh_token', client_id: account.client_id }),
      signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
    if (response.status !== 200) throw providerError(response.status, await response.json().catch(() => null));
  }
}
