import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { FileCredentialStore, recordId, type AccountRecord } from './credentialStore.ts';
import { OssDynamicRegistrationProvider, RESOURCE, SCOPES, type AuthorizationAttempt, type AuthProvider } from './authProvider.ts';
import { TokenManager } from './tokenManager.ts';
import { PlanUsageResponsesClient } from './responses.ts';
import { preparePlanPayload, validatePlanRequest } from './payload.ts';
import { OpenAiCompanion } from './companion.ts';
import { PlanError, providerError, terminalRefreshCodes } from './errors.ts';
import { flowSchema, isOpenAiPluginEnabled, stateSchema } from './protocol.ts';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).toReversed()) await cleanup(); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'inferos-openai-test-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const store = new FileCredentialStore(directory);
  cleanups.push(await store.initialize());
  const account: AccountRecord = {
    id: recordId('oaiapp_test', 'subject'), client_id: 'oaiapp_test', subject: 'subject', ownerId: 'alice',
    issuer: 'https://auth.openai.com', ext_agent_host_id: await store.hostId(), label: 'Alice',
    allowBackground: false, paused: false,
    tokens: { access_token: 'access', refresh_token: 'refresh', id_token: 'retained-id', token_type: 'Bearer',
      scopes: SCOPES.split(' '), saved_at: new Date().toISOString(), expires_in: 3600 },
  };
  await store.put(account);
  let refreshes = 0;
  let revocations = 0;
  const provider: AuthProvider = {
    authorize: attempt => new OssDynamicRegistrationProvider().authorize(attempt),
    exchange: async () => ({ clientId: account.client_id, subject: account.subject, tokens: account.tokens! }),
    refresh: async () => { refreshes++; return { ...account.tokens!, access_token: 'rotated-access',
      refresh_token: 'rotated-refresh', saved_at: new Date().toISOString() }; },
    revoke: async () => { revocations++; },
  };
  return { store, account, provider, directory, refreshes: () => refreshes, revocations: () => revocations };
}

const attempt = (): AuthorizationAttempt => ({ clientId: 'dynamic_agent_client', state: 'state', nonce: 'nonce',
  verifier: 'a'.repeat(64), hostId: 'urn:uuid:00000000-0000-4000-8000-000000000000',
  redirectUri: 'http://127.0.0.1:1455/auth/callback', consent: false });
const callback = (extra = '') => new URL('http://127.0.0.1:1455/auth/callback?state=state&code=code&client_id=oaiapp_test' + extra);
const payload = () => ({ model: 'gpt-test', store: false, stream: true, input: [{ role: 'user', content: 'Hi' }] });
const sse = (...events: unknown[]) => new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''),
  { headers: { 'Content-Type': 'text/event-stream', 'x-request-id': 'req-test' } });
const catalog = () => Response.json({ models: [
  { slug: 'gpt-test', display_name: 'GPT Test', visibility: 'list' },
  { slug: 'hidden', display_name: 'Hidden', visibility: 'hidden' },
  { slug: 'second', display_name: 'Second', visibility: 'list' },
] });

function companionFixture(f: Awaited<ReturnType<typeof fixture>>, request?: typeof fetch) {
  const companion = new OpenAiCompanion(f.store, f.provider, {
    bridgeSecret: 's'.repeat(64), workshopOrigin: 'http://localhost:3000', callbackPort: 0, fetch: request,
  });
  const base = 'http://127.0.0.1:' + companion.start();
  cleanups.push(() => companion.stop());
  const command = (body: unknown, owner = 'alice') => fetch(base + '/command', { method: 'POST',
    headers: { authorization: 'Bearer ' + 's'.repeat(64), 'x-inferos-user': owner }, body: JSON.stringify(body) });
  const state = async (owner = 'alice') => stateSchema.parse(await (await command({ operation: 'state' }, owner)).json());
  const stage = async () => {
    const flow = flowSchema.parse(await (await command({ operation: 'start' })).json());
    const auth = new URL((await fetch(flow.url, { redirect: 'manual' })).headers.get('location')!);
    const redirect = new URL(auth.searchParams.get('redirect_uri')!);
    redirect.search = new URLSearchParams({ code: 'c', state: auth.searchParams.get('state')!, client_id: 'oaiapp_new' }).toString();
    const result = await fetch(redirect, { redirect: 'manual' });
    return { nonce: flow.nonce, ticket: new URL(result.headers.get('location')!).hash.slice(1) };
  };
  return { companion, command, state, stage };
}

describe('registration recovery and lifecycle races', () => {
  test('keeps failures on their registration across account switches, retries and other owners', async () => {
    const f = await fixture();
    const other = { ...f.account, id: recordId('oaiapp_other', 'other'), client_id: 'oaiapp_other', subject: 'other', label: 'Other' };
    await f.store.put(other);
    await f.store.savePreferences('alice', { activeAccountId: f.account.id, welcomed: false });
    const c = companionFixture(f, (async url => String(url).endsWith('/models') ? catalog()
      : Response.json({ error: { code: 'subscription_sharing_usage_limit_exceeded' } }, { status: 429 })) as typeof fetch);
    await expect(c.companion.responses.stream('alice', other.id, payload(), false, new AbortController().signal)).rejects.toThrow('paused');
    let state = await c.state();
    expect(state.error).toBeUndefined();
    expect(state.accounts.find(account => account.id === f.account.id)?.error).toBeUndefined();
    expect(state.accounts.find(account => account.id === other.id)).toMatchObject({ status: 'usage-paused', error: { recovery: 'usage' } });
    await c.command({ operation: 'select', accountId: other.id });
    expect((await c.state()).accounts.find(account => account.id === other.id)?.error).toBeDefined();
    expect((await c.command({ operation: 'retry', accountId: other.id }, 'bob')).status).toBe(404);
    expect((await c.state('bob')).accounts).toEqual([]);
    await c.command({ operation: 'retry', accountId: f.account.id });
    expect((await c.state()).accounts.find(account => account.id === other.id)?.error).toBeDefined();
    await c.command({ operation: 'retry', accountId: other.id });
    state = await c.state();
    expect(state.accounts.find(account => account.id === other.id)).toMatchObject({ status: 'ready' });
    expect(state.accounts.find(account => account.id === other.id)?.error).toBeUndefined();
  });

  test.each(['superseded', 'expired'])('revokes a %s staged authorization without activating it', async outcome => {
    const f = await fixture();
    f.provider.exchange = async () => ({ clientId: 'oaiapp_new', subject: 'new', tokens: f.account.tokens! });
    const c = companionFixture(f);
    const flow = await c.stage();
    if (outcome === 'superseded') await c.command({ operation: 'start' });
    const now = Date.now();
    const clock = outcome === 'expired' ? spyOn(Date, 'now').mockReturnValue(now + 120_001) : undefined;
    try {
      expect((await c.command({ operation: 'complete', ...flow })).status).toBe(400);
      expect(await f.store.list('alice')).toHaveLength(1);
      expect(f.revocations()).toBe(1);
    } finally { clock?.mockRestore(); }
  });

  test('sign-out waits for rotating refresh and revokes the replacement session', async () => {
    const f = await fixture();
    const started = Promise.withResolvers<void>();
    const renewal = Promise.withResolvers<NonNullable<AccountRecord['tokens']>>();
    f.provider.refresh = async () => { started.resolve(); return renewal.promise; };
    const revoked: string[] = [];
    f.provider.revoke = async account => { revoked.push(account.tokens!.refresh_token!); };
    await f.store.put({ ...f.account, tokens: { ...f.account.tokens!, expires_in: 1, saved_at: new Date(0).toISOString() } });
    const manager = new TokenManager(f.store, f.provider);
    const access = manager.access('alice', f.account.id, false);
    await started.promise;
    const signOut = manager.signOut('alice', f.account.id);
    renewal.resolve({ ...f.account.tokens!, access_token: 'new-access', refresh_token: 'new-refresh' });
    await access;
    expect(await signOut).toEqual({ revoked: true });
    expect(revoked).toEqual(['new-refresh']);
    expect((await f.store.get('alice', f.account.id)).tokens).toBeUndefined();
  });

  test('switching accounts cancels an active Responses request without retrying it', async () => {
    const f = await fixture();
    const other = { ...f.account, id: recordId('oaiapp_other', 'other'), client_id: 'oaiapp_other', subject: 'other' };
    await f.store.put(other);
    await f.store.savePreferences('alice', { activeAccountId: f.account.id, welcomed: false });
    const started = Promise.withResolvers<void>();
    let requests = 0;
    const c = companionFixture(f, (async (url, init) => {
      if (String(url).endsWith('/models')) return catalog();
      requests++;
      started.resolve();
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }) as typeof fetch);
    const request = c.companion.responses.stream('alice', f.account.id, payload(), false, new AbortController().signal);
    const failed = request.catch(error => error);
    await started.promise;
    await c.command({ operation: 'select', accountId: other.id });
    expect(await failed).toBeInstanceOf(Error);
    expect(requests).toBe(1);
  });
});

describe('protected registrations and token lifecycle', () => {
  test('VM import keeps its own host identity and refuses an active destination session', async () => {
    const laptop = await fixture();
    const vm = await fixture();
    const source = join(laptop.directory, 'accounts', laptop.account.id + '.json');
    await expect(vm.store.importRegistration(source)).rejects.toThrow('destination');
    const host = await vm.store.hostId();
    await vm.store.put({ ...vm.account, tokens: undefined });
    await vm.store.importRegistration(source);
    const imported = await vm.store.get('alice', laptop.account.id);
    expect(imported.ext_agent_host_id).toBe(host);
    expect(host).not.toBe(await laptop.store.hostId());
    expect(imported.allowBackground).toBe(false);
    expect(imported.tokens?.refresh_token).toBe('refresh');
  });
  test('persists host identity, private files, isolated ownership, and exclusive process lock', async () => {
    const f = await fixture();
    expect(await new FileCredentialStore(f.directory).hostId()).toBe(await f.store.hostId());
    expect((await stat(join(f.directory, 'accounts', f.account.id + '.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(f.directory)).mode & 0o777).toBe(0o700);
    await expect(new FileCredentialStore(f.directory).initialize()).rejects.toThrow('Another companion');
    expect(await f.store.list('bob')).toEqual([]);
    await expect(f.store.get('bob', f.account.id)).rejects.toThrow('not found');
    await expect(f.store.put({ ...f.account, ownerId: 'bob' })).rejects.toThrow('another Workshop');
    await expect(f.store.put({ ...f.account, client_id: 'dynamic_agent_client' })).rejects.toThrow('Invalid saved');
  });

  test('serializes concurrent refresh, atomically persists rotation and retains the ID hint', async () => {
    const f = await fixture();
    f.account.tokens!.saved_at = new Date(0).toISOString();
    await f.store.put(f.account);
    const tokens = new TokenManager(f.store, f.provider);
    expect(await Promise.all([tokens.access('alice', f.account.id, false), tokens.access('alice', f.account.id, false)]))
      .toEqual(['rotated-access', 'rotated-access']);
    expect(f.refreshes()).toBe(1);
    expect((await f.store.get('alice', f.account.id)).tokens?.refresh_token).toBe('rotated-refresh');
    expect((await f.store.get('alice', f.account.id)).tokens?.id_token).toBe('retained-id');
  });

  test('never refreshes before earliest_refresh_at and gates scope and background usage', async () => {
    const f = await fixture();
    f.account.tokens!.expires_in = 10;
    f.account.tokens!.earliest_refresh_at = new Date(Date.now() + 60_000).toISOString();
    await f.store.put(f.account);
    const tokens = new TokenManager(f.store, f.provider);
    expect(await tokens.access('alice', f.account.id, false)).toBe('access');
    expect(f.refreshes()).toBe(0);
    await expect(tokens.access('alice', f.account.id, true)).rejects.toThrow('background');
    await tokens.mutate('alice', f.account.id, record => { record.tokens!.scopes = ['openid']; });
    await expect(tokens.access('alice', f.account.id, false)).rejects.toThrow('Enable ChatGPT');
  });

  test.each([...terminalRefreshCodes])('clears tokens but retains registration after %s', async code => {
    const f = await fixture();
    f.account.tokens!.saved_at = new Date(0).toISOString();
    await f.store.put(f.account);
    f.provider.refresh = async () => { throw providerError(400, { error: code }); };
    await expect(new TokenManager(f.store, f.provider).access('alice', f.account.id, false)).rejects.toThrow('expired or was revoked');
    expect(await f.store.get('alice', f.account.id)).toMatchObject({ client_id: 'oaiapp_test', subject: 'subject' });
    expect((await f.store.get('alice', f.account.id)).tokens).toBeUndefined();
  });

  test('signout cancels active requests, retries revocation, and clears tokens even when unconfirmed', async () => {
    const f = await fixture();
    let attempts = 0;
    f.provider.revoke = async () => { attempts++; throw new Error('network'); };
    const tokens = new TokenManager(f.store, f.provider, Date.now, async () => {});
    const controller = new AbortController();
    tokens.track(f.account.id, controller);
    expect(await tokens.signOut('alice', f.account.id)).toEqual({ revoked: false });
    expect(attempts).toBe(3);
    expect(controller.signal.aborted).toBe(true);
    expect((await f.store.get('alice', f.account.id)).tokens).toBeUndefined();
    expect(await f.store.hostId()).toBe(f.account.ext_agent_host_id);
  });
});

describe('public-client OAuth', () => {
  test('retains an issued client before an expired code exchange fails', async () => {
    let issued: string | undefined;
    const provider = new OssDynamicRegistrationProvider(Object.assign(async () =>
      Response.json({ error: 'invalid_grant' }, { status: 400 }), { preconnect: () => {} }));
    await expect(provider.exchange(attempt(), callback(), async id => { issued = id; })).rejects.toThrow('expired or was revoked');
    expect(issued).toBe('oaiapp_test');
  });
  test('builds PKCE with fresh-registration hints and reauthorization uses issued client', async () => {
    const provider = new OssDynamicRegistrationProvider();
    const parameters = new URL(provider.authorize(attempt())).searchParams;
    expect(parameters.get('agent_name_hint')).toBe('InferOS');
    expect(parameters.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(parameters.get('scope')).toBe(SCOPES);
    expect(parameters.get('resource')).toBe(RESOURCE);
    expect(parameters.has('client_secret')).toBe(false);
    const f = await fixture();
    const returning = new URL(provider.authorize({ ...attempt(), clientId: f.account.client_id, account: f.account, consent: true })).searchParams;
    expect(returning.has('agent_name_hint')).toBe(false);
    expect(returning.get('id_token_hint')).toBe('retained-id');
    expect(returning.get('prompt')).toBe('consent');
  });

  test('validates state first, rejects incomplete or changed client, and never exchanges declined consent', async () => {
    let requests = 0;
    const provider = new OssDynamicRegistrationProvider(Object.assign(async (): Promise<Response> => {
      requests++; throw new Error('unexpected');
    }, { preconnect: () => {} }));
    await expect(provider.exchange(attempt(), new URL('http://127.0.0.1/auth/callback?state=wrong&error=access_denied'))).rejects.toThrow('Invalid sign-in state');
    await expect(provider.exchange(attempt(), new URL('http://127.0.0.1/auth/callback?state=state&error=access_denied'))).rejects.toThrow('not enabled');
    await expect(provider.exchange(attempt(), new URL('http://127.0.0.1/auth/callback?state=state&code=c'))).rejects.toThrow('registration');
    await expect(provider.exchange({ ...attempt(), clientId: 'oaiapp_different' }, callback())).rejects.toThrow('does not match');
    expect(requests).toBe(0);
  });

  test('verifies JWKS signature, issuer, audience, expiry, nonce and selected subject', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = { ...await exportJWK(publicKey), kid: 'test', alg: 'RS256' };
    let claims = { iss: 'https://auth.openai.com', aud: 'oaiapp_test', sub: 'subject', nonce: 'nonce', exp: Math.floor(Date.now() / 1000) + 3600 };
    let badSignature = false;
    const bodies: URLSearchParams[] = [];
    const provider = new OssDynamicRegistrationProvider((async (input, init) => {
      const url = String(input);
      if (url.includes('openid-configuration')) return Response.json({ issuer: 'https://auth.openai.com',
        jwks_uri: 'https://auth.openai.com/jwks', revocation_endpoint: 'https://auth.openai.com/revoke' });
      if (url.endsWith('/jwks')) return Response.json({ keys: [jwk] });
      bodies.push(new URLSearchParams(String(init?.body)));
      const id = await new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'test' }).sign(privateKey);
      return Response.json({ access_token: 'access', refresh_token: 'refresh', id_token: badSignature ? id.slice(0, -8) + 'AAAAAAAA' : id,
        token_type: 'Bearer', expires_in: 3600, scope: SCOPES });
    }) as typeof fetch);
    expect((await provider.exchange(attempt(), callback())).subject).toBe('subject');
    expect(bodies[0].get('redirect_uri')).toBe(attempt().redirectUri);
    expect(bodies[0].get('client_id')).toBe('oaiapp_test');
    expect(bodies[0].has('client_secret')).toBe(false);
    const valid = { ...claims };
    for (const invalid of [{ nonce: 'wrong' }, { iss: 'https://evil.example' }, { aud: 'other' }, { exp: 1 }]) {
      claims = { ...valid, ...invalid };
      await expect(provider.exchange(attempt(), callback())).rejects.toThrow('identity validation');
    }
    claims = valid; badSignature = true;
    await expect(provider.exchange(attempt(), callback())).rejects.toThrow('identity validation');
    badSignature = false;
    const f = await fixture();
    await expect(provider.exchange({ ...attempt(), clientId: 'oaiapp_test', account: { ...f.account, subject: 'other' } }, callback()))
      .rejects.toThrow('not the selected');
    await provider.refresh(f.account);
    expect(bodies.at(-1)?.get('grant_type')).toBe('refresh_token');
    expect(bodies.at(-1)?.has('scope')).toBe(false);
  });
});

describe('Responses constraints and failures', () => {
  test.each(['temperature', 'max_output_tokens', 'previous_response_id', 'background', 'metadata', 'conversation', 'top_p'])('rejects %s before sending', field => {
    expect(() => validatePlanRequest({ ...payload(), [field]: 1 })).toThrow('Unsupported');
  });
  test('rejects system/audio/hosted tools and preserves local function history and namespace', () => {
    expect(() => validatePlanRequest({ ...payload(), input: [{ role: 'system', content: 'x' }] })).toThrow('developer');
    expect(() => validatePlanRequest({ ...payload(), input: [{ role: 'user', content: [{ type: 'input_audio' }] }] })).toThrow('Audio');
    expect(() => preparePlanPayload({ ...payload(), tools: [{ type: 'file_search' }] })).toThrow('local');
    const result = preparePlanPayload({ ...payload(), tools: [{ type: 'function', name: 'execute' }],
      input: [{ type: 'function_call', name: 'execute', call_id: 'call', arguments: '{}' }, { type: 'function_call_output', call_id: 'call', output: 'ok' }] });
    expect(result.tools).toEqual([{ type: 'namespace', name: 'inferos', description: 'InferOS sandbox tools', tools: [{ type: 'function', name: 'execute' }] }]);
    expect(result.input).toEqual([{ type: 'function_call', name: 'execute', call_id: 'call', arguments: '{}', namespace: 'inferos' }, { type: 'function_call_output', call_id: 'call', output: 'ok' }]);
  });

  test('lists visible models in server order and accepts completion only', async () => {
    const f = await fixture();
    const calls: string[] = [];
    const client = new PlanUsageResponsesClient(new TokenManager(f.store, f.provider), () => {}, (async (url, init) => {
      calls.push(String(url));
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer access');
      return String(url).endsWith('/models') ? catalog() : sse({ type: 'response.output_text.delta', delta: 'Hi' }, { type: 'response.completed', response: { status: 'completed' } });
    }) as typeof fetch);
    expect(await client.models('alice', f.account.id)).toEqual([{ slug: 'gpt-test', displayName: 'GPT Test' }, { slug: 'second', displayName: 'Second' }]);
    expect(await (await client.stream('alice', f.account.id, payload(), false, new AbortController().signal)).text()).toContain('response.completed');
    expect(calls).toEqual([RESOURCE + '/models', RESOURCE + '/responses']);
  });

  test.each(['response.incomplete', 'dropped', 'response.failed'])('rejects %s and preserves recovery metadata', async outcome => {
    const f = await fixture();
    let failure: PlanError | undefined;
    const client = new PlanUsageResponsesClient(new TokenManager(f.store, f.provider), (_owner, _id, error) => { failure = error; }, (async url => {
      if (String(url).endsWith('/models')) return catalog();
      return outcome === 'dropped' ? sse({ type: 'response.output_text.delta', delta: 'unfinished' }) : sse({ type: outcome,
        response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'private diagnostic' } } });
    }) as typeof fetch);
    const output = await (await client.stream('alice', f.account.id, payload(), false, new AbortController().signal)).text();
    expect(output).not.toContain('response.completed');
    expect(output).not.toContain('private diagnostic');
    expect(output).toContain('"type":"error"');
    expect(failure?.detail.code).toBe(outcome === 'dropped' ? 'stream_interrupted' : outcome === 'response.incomplete' ? 'response_incomplete' : 'subscription_sharing_usage_limit_exceeded');
    if (outcome === 'response.failed') {
      expect(failure?.detail.requestId).toBe('req-test');
      expect((await f.store.get('alice', f.account.id)).paused).toBe(true);
      await expect(client.stream('alice', f.account.id, payload(), false, new AbortController().signal)).rejects.toThrow('paused');
    }
  });

  test.each([401, 403, 503])('handles HTTP %s admission with bounded retries and retains credentials', async status => {
    const f = await fixture(); let calls = 0;
    const client = new PlanUsageResponsesClient(new TokenManager(f.store, f.provider), () => {}, (async url => {
      if (String(url).endsWith('/models')) return catalog();
      calls++; return Response.json({ detail: 'raw secret-like detail' }, { status, headers: { 'x-request-id': 'admission' } });
    }) as typeof fetch, async () => {});
    try { await client.stream('alice', f.account.id, payload(), false, new AbortController().signal); throw new Error('expected failure'); }
    catch (error) {
      expect(error).toBeInstanceOf(PlanError);
      expect((error as PlanError).detail).toMatchObject({ status, requestId: 'admission' });
      expect((error as Error).message).not.toContain('raw');
    }
    expect(calls).toBe(status === 503 ? 3 : 1);
    expect((await f.store.get('alice', f.account.id)).tokens).toBeDefined();
  });
});

describe('loopback and browser handoff', () => {
  test('authenticates bridge, rejects browser Origin, stages credentials, verifies nonce/owner and supports occupied callback port', async () => {
    const f = await fixture();
    // Use a new registration so activation can be distinguished from the fixture account.
    f.provider.exchange = async () => ({ clientId: 'oaiapp_new', subject: 'new-sub', tokens: f.account.tokens! });
    const occupied = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('occupied') });
    cleanups.push(async () => { await occupied.stop(true); });
    const companion = new OpenAiCompanion(f.store, f.provider, { bridgeSecret: 's'.repeat(64), workshopOrigin: 'http://localhost:3000', callbackPort: occupied.port });
    const base = 'http://127.0.0.1:' + companion.start();
    cleanups.push(() => companion.stop());
    const headers = { authorization: 'Bearer ' + 's'.repeat(64), 'x-inferos-user': 'alice', 'content-type': 'application/json' };
    const command = (body: unknown, owner = 'alice') => fetch(base + '/command', { method: 'POST', headers: { ...headers, 'x-inferos-user': owner }, body: JSON.stringify(body) });
    expect((await fetch(base + '/health')).status).toBe(401);
    expect((await fetch(base + '/health', { headers: { ...headers, origin: 'http://localhost:3000' } })).status).toBe(401);
    const flow = await (await command({ operation: 'start' })).json() as { url: string; nonce: string };
    const launch = await fetch(flow.url, { redirect: 'manual' });
    const auth = new URL(launch.headers.get('location')!);
    const redirect = new URL(auth.searchParams.get('redirect_uri')!);
    expect(Number(redirect.port)).not.toBe(occupied.port);
    redirect.search = new URLSearchParams({ code: 'code', state: 'wrong', client_id: 'oaiapp_new' }).toString();
    expect((await fetch(redirect)).status).toBe(400);
    redirect.searchParams.set('state', auth.searchParams.get('state')!);
    const landed = await fetch(redirect, { redirect: 'manual' });
    const handoff = new URL(landed.headers.get('location')!);
    expect(handoff.origin).toBe('http://localhost:3000');
    expect((await f.store.list('alice')).length).toBe(1);
    const ticket = handoff.hash.slice(1);
    expect((await command({ operation: 'complete', ticket, nonce: flow.nonce })).status).toBe(200);
    expect((await f.store.list('alice')).length).toBe(2);
    expect((await command({ operation: 'complete', ticket, nonce: flow.nonce })).status).toBe(400);
    const stateText = await (await command({ operation: 'state' })).text();
    expect(stateText).not.toContain('refresh_token');
    expect(stateText).not.toContain('retained-id');
    expect((await command({ operation: 'sign-out', accountId: f.account.id }, 'bob')).status).toBe(404);
    expect((await command({ operation: 'sign-out', accountId: f.account.id })).status).toBe(200);
    expect(f.revocations()).toBe(1);
    expect(await readFile(join(f.directory, 'accounts', f.account.id + '.json'), 'utf8')).not.toContain('access_token');
  });

  test.each(['wrong-owner', 'wrong-nonce'])('refuses %s without activating a grant', async attack => {
    const f = await fixture();
    f.provider.exchange = async () => ({ clientId: 'oaiapp_new', subject: 'new-sub', tokens: f.account.tokens! });
    const companion = new OpenAiCompanion(f.store, f.provider, { bridgeSecret: 's'.repeat(64), workshopOrigin: 'http://localhost:3000', callbackPort: 0 });
    const base = 'http://127.0.0.1:' + companion.start(); cleanups.push(() => companion.stop());
    const command = (body: unknown, owner = 'alice') => fetch(base + '/command', { method: 'POST', headers: {
      authorization: 'Bearer ' + 's'.repeat(64), 'x-inferos-user': owner }, body: JSON.stringify(body) });
    const flow = await (await command({ operation: 'start' })).json() as { url: string; nonce: string };
    const auth = new URL((await fetch(flow.url, { redirect: 'manual' })).headers.get('location')!);
    const redirect = new URL(auth.searchParams.get('redirect_uri')!);
    redirect.search = new URLSearchParams({ code: 'c', state: auth.searchParams.get('state')!, client_id: 'oaiapp_new' }).toString();
    const ticket = new URL((await fetch(redirect, { redirect: 'manual' })).headers.get('location')!).hash.slice(1);
    expect((await command({ operation: 'complete', ticket, nonce: attack === 'wrong-nonce' ? 'bad' : flow.nonce }, attack === 'wrong-owner' ? 'bob' : 'alice')).status).toBe(400);
    expect((await f.store.list('alice')).length).toBe(1);
    expect(f.revocations()).toBe(1);
  });

  test('feature flag fails closed even with a forged remote bridge configuration', () => {
    expect(isOpenAiPluginEnabled({})).toBe(false);
    const env = { ENABLE_OPENAI_ASSISTANT_PLUGIN: 'true', OPENAI_ASSISTANT_PLUGIN_SECRET: 'secret', OPENAI_ASSISTANT_PLUGIN_URL: 'http://127.0.0.1:1234' };
    expect(isOpenAiPluginEnabled(env)).toBe(true);
    for (const url of ['https://example.com', 'http://localhost:1234', 'http://127.0.0.1:1234/evil', 'http://user@127.0.0.1']) {
      expect(isOpenAiPluginEnabled({ ...env, OPENAI_ASSISTANT_PLUGIN_URL: url })).toBe(false);
    }
  });
});
