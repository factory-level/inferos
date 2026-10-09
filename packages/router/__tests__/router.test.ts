import { describe, expect, it } from 'vitest';
import { parse } from 'jsonc-parser';
import router, { type Env } from '../src/index';
// Imported as text so the config-integrity tests run inside workerd without filesystem access.
import wranglerConfigText from '../wrangler.jsonc?raw';

function stubFetcher(label: string): Fetcher {
  return {
    fetch: async () => new Response(label),
  } as unknown as Fetcher;
}

function makeEnv(extra: Record<string, unknown> = {}): Env {
  return {
    WORKSHOP_BACKEND: stubFetcher('backend'),
    ...extra,
  } as Env;
}

async function route(env: Env, path: string): Promise<string> {
  const req = new Request(`https://example.com${path}`);
  const res = await router.fetch!(req, env, {} as ExecutionContext);
  return res.text();
}

describe('router fetch', () => {
  it('routes /api and /blueprint-screenshot prefixes to the backend', async () => {
    const env = makeEnv({ ASSETS: stubFetcher('assets') });
    expect(await route(env, '/api')).toBe('backend');
    expect(await route(env, '/api/workshop')).toBe('backend');
    expect(await route(env, '/blueprint-screenshot')).toBe('backend');
    expect(await route(env, '/blueprint-screenshot/abc')).toBe('backend');
  });

  it('does not treat /api-lookalike paths as backend routes', async () => {
    const env = makeEnv({ ASSETS: stubFetcher('assets') });
    expect(await route(env, '/apiary')).toBe('assets');
    expect(await route(env, '/blueprint-screenshots')).toBe('assets');
  });

  it('routes /gatekeeper/<short> by scanning GATEKEEPER_* bindings', async () => {
    const env = makeEnv({
      ASSETS: stubFetcher('assets'),
      GATEKEEPER_GOOGLE: stubFetcher('google'),
      GATEKEEPER_HOMEASSISTANT: stubFetcher('homeassistant'),
    });
    expect(await route(env, '/gatekeeper/google')).toBe('google');
    expect(await route(env, '/gatekeeper/google/oauth')).toBe('google');
    expect(await route(env, '/gatekeeper/homeassistant/foo')).toBe('homeassistant');
  });

  it('maps underscores in binding names to dashes in the path', async () => {
    const env = makeEnv({
      ASSETS: stubFetcher('assets'),
      GATEKEEPER_MY_SERVICE: stubFetcher('my-service'),
    });
    expect(await route(env, '/gatekeeper/my-service')).toBe('my-service');
    expect(await route(env, '/gatekeeper/my-service/oauth')).toBe('my-service');
  });

  it('does not match gatekeeper prefixes on longer path segments', async () => {
    const env = makeEnv({
      ASSETS: stubFetcher('assets'),
      GATEKEEPER_GOOGLE: stubFetcher('google'),
    });
    expect(await route(env, '/gatekeeper/googles')).toBe('assets');
  });

  it('requires both the deployment switch and an explicit extension binding', async () => {
    const env = makeEnv({ ASSETS: stubFetcher('assets'), CONSUMER_HELLO_WORLD: stubFetcher('extension') });
    for (const flag of [undefined, 'false', 'TRUE']) {
      const response = await router.fetch!(new Request('https://example.com/extensions/hello-world'), { ...env, CUSTOM_CLOUDFLARE_CODE: flag }, {} as ExecutionContext);
      expect(response.status).toBe(404);
    }
    env.CUSTOM_CLOUDFLARE_CODE = 'true';
    expect(await route(env, '/extensions/hello-world')).toBe('extension');
    expect(await route(env, '/extensions/hello-world/nested')).toBe('extension');
    for (const path of ['/extensions', '/extensions/missing', '/extensions/hello_world', '/extensions/HELLO-WORLD', '/extensions/hello-worlds']) {
      expect((await router.fetch!(new Request(`https://example.com${path}`), env, {} as ExecutionContext)).status).toBe(404);
    }
    expect(await route(env, '/api')).toBe('backend');
    expect(await route(env, '/extensions-lookalike')).toBe('assets');
  });

  it('serves everything else from ASSETS when the binding is present', async () => {
    const env = makeEnv({ ASSETS: stubFetcher('assets') });
    expect(await route(env, '/')).toBe('assets');
    expect(await route(env, '/blueprints/123')).toBe('assets');
    expect(await route(env, '/gatekeeper/not-installed')).toBe('assets');
  });

  // Dev has no ASSETS binding: the backend serves the frontend from its own assets binding in
  // `run-local` mode, and in normal dev mode you open the Vite server on :3000 directly.
  it('falls through to the backend when ASSETS is absent', async () => {
    const env = makeEnv();
    expect(await route(env, '/')).toBe('backend');
    expect(await route(env, '/blueprints/123')).toBe('backend');
  });
});

const COOP = 'cross-origin-opener-policy';
const fetcher = (body: string, init?: ResponseInit) =>
  ({ fetch: async () => new Response(body, init) }) as unknown as Fetcher;
const html = (body: string, headers: Record<string, string> = {}) =>
  fetcher(body, { headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
const get = (env: Env, path: string) =>
  router.fetch!(new Request(`https://example.com${path}`), env, {} as ExecutionContext);

describe('opener policy on Worker-served documents', () => {

  it('sets same-origin on gatekeeper, extension and backend HTML, keeping status and body', async () => {
    const env = makeEnv({
      ASSETS: stubFetcher('assets'),
      CUSTOM_CLOUDFLARE_CODE: 'true',
      WORKSHOP_BACKEND: html('<p>backend</p>'),
      // A gatekeeper's connect handoff page, and one that chose a weaker policy for itself.
      GATEKEEPER_GOOGLE: html('<p>handoff</p>'),
      GATEKEEPER_LAX: html('<p>lax</p>', { 'cross-origin-opener-policy': 'unsafe-none' }),
      CONSUMER_HELLO_WORLD: fetcher('<p>gone</p>', { status: 410, headers: { 'content-type': 'TEXT/HTML' } }),
    });
    for (const [path, body, status] of [
      ['/gatekeeper/google/oauth', '<p>handoff</p>', 200],
      ['/gatekeeper/lax/connect', '<p>lax</p>', 200],
      ['/extensions/hello-world/page', '<p>gone</p>', 410],
      ['/blueprint-screenshot/abc', '<p>backend</p>', 200],
    ] as const) {
      const response = await get(env, path);
      expect(response.headers.get(COOP), path).toBe('same-origin');
      expect(response.status, path).toBe(status);
      expect(await response.text(), path).toBe(body);
    }
  });

  it("sets it on the router's own 404 pages", async () => {
    const env = makeEnv({ ASSETS: stubFetcher('assets') });
    for (const path of ['/extensions', '/extensions/missing']) {
      const response = await get(env, path);
      expect(response.status, path).toBe(404);
      expect(response.headers.get(COOP), path).toBe('same-origin');
    }
  });

  it('leaves non-document responses and asset responses as they are', async () => {
    const env = makeEnv({
      ASSETS: stubFetcher('assets'),
      WORKSHOP_BACKEND: fetcher('{}', { headers: { 'content-type': 'application/json' } }),
      GATEKEEPER_GOOGLE: fetcher('', { status: 302, headers: { location: 'https://accounts.example/' } }),
    });
    expect((await get(env, '/api')).headers.get(COOP)).toBeNull();
    const redirect = await get(env, '/gatekeeper/google/connect');
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get(COOP)).toBeNull();
    // Static assets take the policy from the frontend's `_headers`, which ASSETS applies.
    expect((await get(env, '/')).headers.get(COOP)).toBeNull();
  });

  it('sets it on documents the backend serves in dev, where there is no ASSETS binding', async () => {
    const response = await get(makeEnv({ WORKSHOP_BACKEND: html('<p>dev</p>') }), '/w/1');
    expect(response.headers.get(COOP)).toBe('same-origin');
  });
});

describe('router email', () => {
  it('forwards to GATEKEEPER_EMAIL when bound', async () => {
    const received: unknown[] = [];
    const env = makeEnv({
      GATEKEEPER_EMAIL: { email: async (m: unknown) => { received.push(m); } },
    });
    const message = {} as ForwardableEmailMessage;
    await router.email!(message, env, {} as ExecutionContext);
    expect(received).toEqual([message]);
  });

  it('rejects mail when no email gatekeeper is installed', async () => {
    const rejections: string[] = [];
    const env = makeEnv();
    const message = {
      setReject: (reason: string) => { rejections.push(reason); },
    } as unknown as ForwardableEmailMessage;
    await router.email!(message, env, {} as ExecutionContext);
    expect(rejections).toHaveLength(1);
  });
});

// The deploy service renders customer instances from this config (via the release manifest), so
// the asset-routing contract must hold: worker-first prefixes cover every dynamic route, or asset
// 404 handling would swallow API and gatekeeper traffic.
describe('wrangler.jsonc contract', () => {
  const config = parse(wranglerConfigText);

  it('runs the worker first for API, screenshot, and gatekeeper prefixes', () => {
    const first: string[] = config.assets.run_worker_first;
    expect(first).toContain('/api');
    expect(first).toContain('/api/*');
    expect(first).toContain('/blueprint-screenshot');
    expect(first).toContain('/blueprint-screenshot/*');
    expect(first).toContain('/gatekeeper/*');
    expect(first).toContain('/extensions');
    expect(first).toContain('/extensions/*');
  });

  it('serves the frontend as a single-page application', () => {
    expect(config.assets.not_found_handling).toBe('single-page-application');
    expect(config.assets.directory).toBe('../workshop-frontend/dist');
    expect(config.assets.binding).toBe('ASSETS');
  });

  it('binds the workshop backend', () => {
    expect(config.services).toContainEqual({
      binding: 'WORKSHOP_BACKEND',
      service: 'workshop-backend',
    });
  });
});
