import { createHash, timingSafeEqual } from 'node:crypto';
import type { Server } from 'bun';
import type { OpenAiPluginState } from '@gadgets/workshop-shared/openai-plugin';
import type { AccountRecord, CredentialStore } from './credentialStore.ts';
import { recordId } from './credentialStore.ts';
import type { AuthorizationAttempt, AuthProvider } from './authProvider.ts';
import { PLAN_SCOPE, secret } from './authProvider.ts';
import { TokenManager } from './tokenManager.ts';
import { PlanUsageResponsesClient } from './responses.ts';
import { commandSchema, type PluginCommand } from './protocol.ts';
import { fail, PlanError, safeError } from './errors.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

type Flow = {
  owner: string; nonceHash: string; attempt: AuthorizationAttempt;
  server: Server<undefined>; timer: ReturnType<typeof setTimeout>; cancelled: boolean;
};
type Handoff = { flow: Flow; record?: AccountRecord; error?: PlanError; expiresAt: number };

/** Loopback service bridging authenticated Workshop operations to protected local credentials. */
export class OpenAiCompanion {
  readonly tokens: TokenManager;
  readonly responses: PlanUsageResponsesClient;
  #server?: Server<undefined>;
  #launches = new Map<string, Flow>();
  #flows = new Set<Flow>();
  #handoffs = new Map<string, Handoff>();
  #errors = new Map<string, Map<string | undefined, PlanError>>();
  #expiry = setInterval(() => { void this.#expireHandoffs(); }, 15_000);

  constructor(readonly store: CredentialStore, readonly provider: AuthProvider,
    private readonly options: { bridgeSecret: string; workshopOrigin: string; callbackPort?: number; fetch?: typeof fetch }) {
    const origin = new URL(options.workshopOrigin);
    if (origin.origin !== options.workshopOrigin || !['http:', 'https:'].includes(origin.protocol)) {
      fail('invalid_origin', 'Configure the exact Workshop origin.', 'configuration');
    }
    if (options.bridgeSecret.length < 32) fail('invalid_bridge_secret', 'The local bridge requires a generated secret.', 'configuration');
    this.tokens = new TokenManager(store, provider);
    this.responses = new PlanUsageResponsesClient(this.tokens,
      (owner, id, error) => this.#setError(owner, id, error), options.fetch);
    this.#expiry.unref();
  }

  start(port = 0): number {
    this.#server = Bun.serve({
      hostname: '127.0.0.1', port, maxRequestBodySize: 24 * 1024 * 1024,
      fetch: async (request, server) => {
        let accountId: string | undefined;
        try {
          const url = new URL(request.url);
          if (url.hostname !== '127.0.0.1') return new Response('Invalid host', { status: 403 });
          if (request.method === 'GET' && url.pathname.startsWith('/authorize/')) {
            const key = hash(url.pathname.slice('/authorize/'.length));
            const flow = this.#launches.get(key);
            this.#launches.delete(key);
            if (!flow || flow.cancelled) return new Response('Sign-in expired. Start again in InferOS.', { status: 410 });
            return new Response(null, { status: 302, headers: {
              Location: this.provider.authorize(flow.attempt), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
            } });
          }
          if (!this.#authorized(request)) return new Response('Unauthorized', { status: 401 });
          if (request.method === 'GET' && url.pathname === '/health') return Response.json({ ready: true });
          const owner = request.headers.get('x-inferos-user');
          if (!owner) return new Response('Unauthorized', { status: 401 });
          if (request.method === 'POST' && url.pathname === '/command') {
            const parsed = commandSchema.safeParse(await request.json());
            if (!parsed.success) return new Response('Invalid command', { status: 400 });
            accountId = 'accountId' in parsed.data ? parsed.data.accountId
              : parsed.data.operation === 'complete'
                ? this.#handoffs.get(hash(parsed.data.ticket))?.flow.attempt.account?.id : undefined;
            const result = await this.tokens.lock('owner:' + owner, () => this.#command(owner, parsed.data));
            return Response.json(result ?? null, { headers: { 'Cache-Control': 'no-store' } });
          }
          if (request.method === 'POST' && url.pathname === '/responses') {
            const id = request.headers.get('x-inferos-account');
            if (!id) return new Response('Account required', { status: 400 });
            accountId = id;
            server.timeout(request, 0);
            return await this.responses.stream(owner, id, await request.json(),
              request.headers.get('x-inferos-background') !== 'false', request.signal);
          }
          return new Response('Not found', { status: 404 });
        } catch (error) {
          const safe = safeError(error);
          const owner = request.headers.get('x-inferos-user');
          if (owner && this.#authorized(request)) this.#setError(owner, accountId, safe);
          return Response.json({ error: safe.detail }, { status: safe.detail.status >= 400 ? safe.detail.status : 502,
            headers: { 'Cache-Control': 'no-store' } });
        }
      },
    });
    return this.#server.port!;
  }

  #authorized(request: Request): boolean {
    // Browsers never call this bridge: denying Origin also rejects cross-site/preflight access.
    if (request.headers.has('origin')) return false;
    const expected = Buffer.from('Bearer ' + this.options.bridgeSecret);
    const actual = Buffer.from(request.headers.get('authorization') ?? '');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  #setError(owner: string, accountId: string | undefined, error?: PlanError): void {
    let errors = this.#errors.get(owner);
    if (error) {
      if (!errors) this.#errors.set(owner, errors = new Map());
      errors.set(accountId, error);
    } else {
      errors?.delete(accountId);
      if (!errors?.size) this.#errors.delete(owner);
    }
  }

  async #state(owner: string): Promise<OpenAiPluginState> {
    const accounts = await this.store.list(owner);
    const preferences = await this.store.preferences(owner);
    return { accounts: accounts.map(account => ({
      id: account.id, label: account.label, email: account.email, allowBackground: account.allowBackground,
      error: this.#errors.get(owner)?.get(account.id)?.detail,
      status: !account.tokens ? 'signed-out' : !account.tokens.scopes.includes(PLAN_SCOPE)
        ? 'plan-disabled' : account.paused ? 'usage-paused' : 'ready',
    })), activeAccountId: preferences.activeAccountId,
    error: this.#errors.get(owner)?.get(undefined)?.detail,
    needsWelcome: !preferences.welcomed && accounts.some(account => account.tokens?.scopes.includes(PLAN_SCOPE)),
    };
  }

  async #command(owner: string, command: PluginCommand): Promise<unknown> {
    switch (command.operation) {
      case 'state': return this.#state(owner);
      case 'start': return this.#startSignIn(owner, command.accountId, command.consent ?? false);
      case 'complete': return this.#complete(owner, command.ticket, command.nonce);
      case 'models': return this.responses.models(owner, command.accountId);
      case 'select': {
        await this.store.get(owner, command.accountId);
        const preferences = await this.store.preferences(owner);
        if (preferences.activeAccountId && preferences.activeAccountId !== command.accountId) this.tokens.cancel(preferences.activeAccountId);
        preferences.activeAccountId = command.accountId;
        await this.store.savePreferences(owner, preferences);
        this.responses.invalidate(command.accountId);
        return;
      }
      case 'sign-out': {
        await this.store.get(owner, command.accountId);
        for (const flow of this.#flows) {
          if (flow.owner === owner && flow.attempt.account?.id === command.accountId) this.#closeFlow(flow);
        }
        const result = await this.tokens.signOut(owner, command.accountId);
        this.responses.invalidate(command.accountId);
        if (!result.revoked) this.#setError(owner, command.accountId, new PlanError({ status: 503,
          code: 'revocation_unconfirmed', recovery: 'none',
          message: 'Signed out locally. Remote revocation was not confirmed; disconnect InferOS in ChatGPT Settings.',
        }));
        else this.#setError(owner, command.accountId);
        return result;
      }
      case 'background':
        await this.tokens.mutate(owner, command.accountId, account => { account.allowBackground = command.allowed; });
        if (!command.allowed) this.tokens.cancel(command.accountId);
        return;
      case 'retry':
        await this.tokens.mutate(owner, command.accountId, account => { account.paused = false; });
        this.#setError(owner, command.accountId);
        return;
      case 'welcome': {
        const preferences = await this.store.preferences(owner);
        preferences.welcomed = true;
        await this.store.savePreferences(owner, preferences);
        return;
      }
    }
  }

  async #startSignIn(owner: string, accountId: string | undefined, consent: boolean) {
    if (!this.#server) throw new Error('Companion is not running.');
    const account = accountId ? await this.store.get(owner, accountId) : undefined;
    const preferences = await this.store.preferences(owner);
    // Superseding a pending flow must not leave a late callback able to overwrite new credentials.
    for (const pending of this.#flows) if (pending.owner === owner) this.#closeFlow(pending);
    const nonce = secret();
    let flow: Flow;
    const fetchCallback = async (request: Request): Promise<Response> => {
      const callback = new URL(request.url);
      if (request.method !== 'GET' || callback.hostname !== '127.0.0.1' || callback.pathname !== '/auth/callback') {
        return new Response('Not found', { status: 404 });
      }
      if (flow.cancelled || callback.searchParams.get('state') !== flow.attempt.state) {
        return new Response('Invalid or expired sign-in state.', { status: 400 });
      }
      // Consume before asynchronous exchange so duplicate callbacks cannot reuse the code.
      const attempt = flow.attempt;
      flow.attempt = { ...attempt, state: secret() };
      let record: AccountRecord | undefined;
      let error: PlanError | undefined;
      try {
        const authorized = await this.provider.exchange(attempt, callback, clientId =>
          this.tokens.lock('owner:' + owner, async () => {
            if (flow.cancelled) fail('authorization_cancelled', 'Sign-in was cancelled.');
            const saved = await this.store.preferences(owner);
            saved.pendingClientId = clientId;
            await this.store.savePreferences(owner, saved);
          }));
        record = {
          id: recordId(authorized.clientId, authorized.subject), ownerId: owner,
          client_id: authorized.clientId, subject: authorized.subject, issuer: 'https://auth.openai.com',
          email: authorized.email, ext_agent_host_id: attempt.hostId,
          label: account?.label ?? (authorized.email ?? 'ChatGPT') + ' · ' + authorized.clientId.slice(-6),
          allowBackground: account?.allowBackground ?? false, paused: false, tokens: authorized.tokens,
        };
      } catch (caught) { error = safeError(caught); }
      if (flow.cancelled) {
        if (record) await this.provider.revoke(record).catch(() => {});
        return new Response('Sign-in cancelled.', { status: 410 });
      }
      const ticket = secret();
      this.#handoffs.set(hash(ticket), { flow, record, error, expiresAt: Date.now() + 120_000 });
      clearTimeout(flow.timer);
      // Delay stop until the redirect has been delivered; the handoff remains staged for two minutes.
      setTimeout(() => flow.server.stop(), 100).unref();
      return new Response(null, { status: 302, headers: {
        Location: this.options.workshopOrigin + '/connect/handoff#' + ticket,
        'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      } });
    };
    let server: Server<undefined>;
    try { server = Bun.serve({ hostname: '127.0.0.1', port: this.options.callbackPort ?? 1455, fetch: fetchCallback }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: fetchCallback });
    }
    flow = { owner, nonceHash: hash(nonce), server, cancelled: false,
      attempt: { state: secret(), nonce: secret(), verifier: secret(),
        redirectUri: 'http://127.0.0.1:' + server.port + '/auth/callback',
        hostId: await this.store.hostId(), clientId: account?.client_id ?? preferences.pendingClientId ?? 'dynamic_agent_client', account, consent },
      timer: setTimeout(() => this.#closeFlow(flow), 10 * 60_000),
    };
    flow.timer.unref();
    this.#flows.add(flow);
    const launch = secret();
    this.#launches.set(hash(launch), flow);
    this.#setError(owner, undefined);
    return { url: 'http://127.0.0.1:' + this.#server.port + '/authorize/' + launch, nonce };
  }

  async #complete(owner: string, ticket: string, nonce: string): Promise<void> {
    const pending = this.#handoffs.get(hash(ticket));
    this.#handoffs.delete(hash(ticket));
    if (!pending) fail('invalid_handoff', 'This connection link is invalid or expired.');
    const valid = /^[a-f0-9]{64}$/.test(nonce) && pending.flow.nonceHash === hash(nonce) &&
      pending.flow.owner === owner && !pending.flow.cancelled && pending.expiresAt > Date.now();
    this.#closeFlow(pending.flow);
    if (!valid) {
      if (pending.record) await this.provider.revoke(pending.record).catch(() => {});
      fail('invalid_handoff', 'This connection link is invalid or expired.');
    }
    if (pending.error) throw pending.error;
    const record = pending.record!;
    await this.tokens.lock(record.id, () => this.store.put(record));
    const preferences = await this.store.preferences(owner);
    if (preferences.activeAccountId) this.tokens.cancel(preferences.activeAccountId);
    preferences.activeAccountId = record.id;
    if (preferences.pendingClientId === record.client_id) delete preferences.pendingClientId;
    await this.store.savePreferences(owner, preferences);
    this.responses.invalidate(record.id);
    this.#setError(owner, record.id);
    this.#setError(owner, undefined);
  }

  #closeFlow(flow: Flow): void {
    flow.cancelled = true;
    clearTimeout(flow.timer);
    flow.server.stop();
    this.#flows.delete(flow);
    for (const [key, value] of this.#launches) if (value === flow) this.#launches.delete(key);
  }

  async #expireHandoffs(): Promise<void> {
    for (const [key, pending] of this.#handoffs) {
      if (pending.expiresAt > Date.now() && !pending.flow.cancelled) continue;
      this.#handoffs.delete(key);
      this.#closeFlow(pending.flow);
      if (pending.record) await this.provider.revoke(pending.record).catch(() => {});
    }
  }

  async stop(): Promise<void> {
    clearInterval(this.#expiry);
    for (const flow of this.#flows) this.#closeFlow(flow);
    await this.#expireHandoffs();
    await this.#server?.stop(true);
  }
}
