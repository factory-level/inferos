#!/usr/bin/env node

// An opt-in smoke check of an already deployed instance -- a disposable preview from
// `scripts/preview/preview.ts deploy`, or any deployment's public origin. It is a recipe for a
// person or a CI job that has such a deployment; nothing runs it automatically.
//
//   node scripts/preview/smoke.ts <base-url> [--gatekeeper NAME]... [--connect-url URL]...
//                                 [--timeout MS]
//
// It only reads. Every request is a GET (or a WebSocket handshake that is closed at once), it never
// calls the Cloudflare API, Wrangler or the RPC API, and it never creates, changes or deletes a
// resource. What it asserts:
//
//   app-shell     the router serves the frontend at `/`, and its SPA fallback for a client route
//   api           a WebSocket handshake to `/api` reaches the Workshop: upgraded, or refused by an
//                 auth challenge (Cloudflare Access or the Workshop's own), never a 404 or a 5xx
//   gatekeeper:*  each bound gatekeeper's `/gatekeeper/<name>/` answers from the gatekeeper, not the
//                 app shell (which is what an unbound path falls through to) and not a 502-504
//   oauth:*       for each `--connect-url` (a connect flow URL the Workshop handed out, copied from
//                 the popup), the provider redirect's `redirect_uri` is on the base URL's origin,
//                 under that gatekeeper's routed path. Fetching it starts one sign-in attempt in
//                 the gatekeeper, which expires unused; nothing else is written.
//
// `--gatekeeper` defaults to every gatekeeper package this checkout would deploy. Behind Cloudflare
// Access, set an Access service token in CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET; without
// one, every path but `/api` is expected to be challenged, and those checks fail saying so.
//
// Output is one JSON report on stdout. Exit codes: 0 every check passed, 1 a check failed, 2 usage.
// A connect URL is a bearer capability, so the report names only its gatekeeper, never the URL.

import { randomBytes } from "node:crypto";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  gatekeeperShortName, isGatekeeperPackage, readDeployablePackages,
} from "../release/manifest-lib.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The most of a response body the smoke reads; the shell comparison needs no more. */
const BODY_LIMIT = 64 * 1024;

/** What the smoke was asked to check. */
export interface SmokeOptions {
  /** The deployment's public origin, e.g. `https://pr-12-router.example.workers.dev`. */
  baseUrl: URL;
  /** Gatekeeper route names (`/gatekeeper/<name>`) expected to be bound. */
  gatekeepers: string[];
  /** Connect flow URLs whose provider redirect origin is checked. */
  connectUrls: URL[];
  /** An Access service token, sent as `CF-Access-Client-Id`/`CF-Access-Client-Secret`. */
  accessToken?: { clientId: string; clientSecret: string };
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
}

/** One HTTP exchange, as far as the smoke reads it. */
export interface SmokeResponse {
  /** The status code; 101 for an accepted WebSocket handshake. */
  status: number;
  /** Response headers, lowercased. */
  headers: IncomingHttpHeaders;
  /** Up to {@link BODY_LIMIT} bytes of the body, as text ("" for a handshake). */
  body: string;
}

/** One check's outcome in the report. */
export interface SmokeCheck {
  /** `app-shell`, `api`, `gatekeeper:<name>` or `oauth:<name>`. */
  name: string;
  /** Whether it passed. A skipped check is `ok` and says why in `detail`. */
  ok: boolean;
  /** Set when the check had nothing to run against. */
  skipped?: boolean;
  /** The status code it decided on, when there was one. */
  status?: number;
  /** What was found, in a sentence. Never carries a credential or a connect URL. */
  detail: string;
}

/** The JSON report printed on stdout. */
export interface SmokeReport {
  /** Every check passed (skipped ones count as passed). */
  ok: boolean;
  /** The origin checked. */
  baseUrl: string;
  /** Whether an Access service token was sent (never its value). */
  accessServiceToken: boolean;
  /** The checks, in the order they ran. */
  checks: SmokeCheck[];
}

/** A usage error: exit 2. */
export class SmokeUsageError extends Error {}

/** Parse the command line and environment into options. Throws {@link SmokeUsageError}. */
export function parseSmokeArgs(
  argv: string[], env: NodeJS.ProcessEnv, defaultGatekeepers: () => string[],
): SmokeOptions {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        gatekeeper: { type: "string", multiple: true },
        "connect-url": { type: "string", multiple: true },
        timeout: { type: "string" },
      },
    });
  } catch (error) {
    throw new SmokeUsageError(error instanceof Error ? error.message : String(error));
  }
  const [base, ...extra] = parsed.positionals;
  if (!base || extra.length > 0) throw new SmokeUsageError("Expected exactly one base URL.");
  const baseUrl = parseHttpUrl(base, "base URL");
  if (baseUrl.pathname !== "/" || baseUrl.search || baseUrl.hash || baseUrl.username || baseUrl.password) {
    throw new SmokeUsageError("The base URL must be a bare origin, such as https://example.workers.dev.");
  }

  const timeoutMs = parsed.values.timeout === undefined ? 15_000 : Number(parsed.values.timeout);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new SmokeUsageError("--timeout must be a positive whole number of milliseconds.");
  }

  const gatekeepers = parsed.values.gatekeeper ?? defaultGatekeepers();
  for (const name of gatekeepers) {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) {
      throw new SmokeUsageError(`Not a gatekeeper route name: ${name}`);
    }
  }

  const connectUrls = (parsed.values["connect-url"] ?? []).map(url => {
    const parsedUrl = parseHttpUrl(url, "--connect-url");
    if (parsedUrl.origin !== baseUrl.origin || !connectGatekeeper(parsedUrl)) {
      throw new SmokeUsageError("--connect-url must be a /gatekeeper/<name>/... URL on the base URL's origin.");
    }
    return parsedUrl;
  });

  const clientId = env.CF_ACCESS_CLIENT_ID;
  const clientSecret = env.CF_ACCESS_CLIENT_SECRET;
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new SmokeUsageError("Set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET, or neither.");
  }
  return {
    baseUrl, gatekeepers, connectUrls, timeoutMs,
    ...(clientId && clientSecret ? { accessToken: { clientId, clientSecret } } : {}),
  };
}

function parseHttpUrl(value: string, what: string): URL {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new SmokeUsageError(`The ${what} is not a URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new SmokeUsageError(`The ${what} must be http or https.`);
  }
  return url;
}

/** The gatekeeper a connect URL belongs to, from its `/gatekeeper/<name>/` path. */
export function connectGatekeeper(url: URL): string | null {
  return /^\/gatekeeper\/([a-z][a-z0-9-]*)\/./.exec(url.pathname)?.[1] ?? null;
}

/** Whether a response is a Cloudflare Access login redirect. */
export function isAccessRedirect(response: SmokeResponse): boolean {
  const location = header(response, "location");
  if (response.status < 300 || response.status >= 400 || !location) return false;
  try {
    return new URL(location).hostname.endsWith(".cloudflareaccess.com");
  } catch {
    return false;
  }
}

/** The Workshop's own refusals of an `/api` request it received (`server.ts`). */
const WORKSHOP_API_REFUSALS = [
  "Invalid CF access JWT.",
  "Cross-origin API access not allowed.",
  "Access JWT didn't specify email address.",
];

/** Decide the `/api` handshake check from its response. */
export function classifyApiHandshake(response: SmokeResponse): SmokeCheck {
  const base = { name: "api", status: response.status };
  if (response.status === 101) {
    return { ...base, ok: true, detail: "The WebSocket upgrade reached the Workshop." };
  }
  if (response.status === 403 && WORKSHOP_API_REFUSALS.some(message => response.body.includes(message))) {
    return { ...base, ok: true, detail: `The Workshop answered with its auth challenge: ${response.body.trim()}` };
  }
  if (isAccessRedirect(response) || response.status === 401 || response.status === 403) {
    return {
      ...base, ok: true,
      detail: "An auth challenge in front of the Workshop answered (Cloudflare Access); the Workshop itself was not reached.",
    };
  }
  return { ...base, ok: false, detail: `Expected an upgrade or an auth challenge, got ${response.status}.` };
}

/** Decide the app shell check from the root and a client route's responses. */
export function classifyAppShell(root: SmokeResponse, clientRoute: SmokeResponse): SmokeCheck {
  const base = { name: "app-shell", status: root.status };
  const challenge = accessChallenge(root);
  if (challenge) return { ...base, ok: false, detail: challenge };
  if (root.status !== 200 || !header(root, "content-type")?.includes("text/html")) {
    return { ...base, ok: false, detail: `Expected the HTML app shell at /, got ${root.status}.` };
  }
  if (clientRoute.status !== 200 || clientRoute.body !== root.body) {
    return {
      ...base, ok: false,
      detail: `A client route did not fall back to the app shell (got ${clientRoute.status}).`,
    };
  }
  return { ...base, ok: true, detail: "The router serves the app shell and its SPA fallback." };
}

/** Decide one gatekeeper's check from its route's response and the app shell's body. */
export function classifyGatekeeper(name: string, response: SmokeResponse, shellBody: string | null)
    : SmokeCheck {
  const base = { name: `gatekeeper:${name}`, status: response.status };
  const challenge = accessChallenge(response);
  if (challenge) return { ...base, ok: false, detail: challenge };
  if (response.status >= 502 && response.status <= 504) {
    return { ...base, ok: false, detail: `The route answered ${response.status}: nothing behind it.` };
  }
  if (shellBody !== null && response.status === 200 && response.body === shellBody) {
    return { ...base, ok: false, detail: "The route fell through to the app shell: no gatekeeper is bound." };
  }
  return { ...base, ok: true, detail: `The gatekeeper answered ${response.status}.` };
}

/** Decide one connect URL's OAuth redirect check from its first response. */
export function classifyOAuthRedirect(gatekeeper: string, baseUrl: URL, response: SmokeResponse)
    : SmokeCheck {
  const base = { name: `oauth:${gatekeeper}`, status: response.status };
  const challenge = accessChallenge(response);
  if (challenge) return { ...base, ok: false, detail: challenge };
  const location = header(response, "location");
  if (response.status < 300 || response.status >= 400 || !location) {
    return { ...base, ok: false, detail: `Expected a redirect to the provider, got ${response.status}.` };
  }
  let redirectUri;
  try {
    redirectUri = new URL(new URL(location).searchParams.get("redirect_uri") ?? "");
  } catch {
    return { ...base, ok: false, detail: "The provider redirect carried no valid redirect_uri." };
  }
  const expected = `${baseUrl.origin}/gatekeeper/${gatekeeper}/`;
  if (redirectUri.origin !== baseUrl.origin || !redirectUri.href.startsWith(expected)) {
    return {
      ...base, ok: false,
      detail: `redirect_uri ${redirectUri.origin}${redirectUri.pathname} is not under ${expected}.`,
    };
  }
  return { ...base, ok: true, detail: `redirect_uri ${redirectUri.origin}${redirectUri.pathname} matches the base URL.` };
}

function accessChallenge(response: SmokeResponse): string | null {
  if (!isAccessRedirect(response) && response.status !== 401 && response.status !== 403) return null;
  return `Challenged (${response.status}) before reaching the router; set an Access service token in ` +
    "CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET.";
}

function header(response: SmokeResponse, name: string): string | undefined {
  const value = response.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * One GET, never following redirects. With `websocket`, a handshake instead: a 101 is reported
 * and the socket closed at once, so no session starts.
 */
export function smokeRequest(url: URL, options: {
  headers?: Record<string, string>; websocket?: boolean; timeoutMs: number;
}): Promise<SmokeResponse> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.websocket) {
    Object.assign(headers, {
      Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": randomBytes(16).toString("base64"), Origin: url.origin,
    });
  }
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((done, fail) => {
    const req = send(url, { method: "GET", headers, timeout: options.timeoutMs });
    req.on("timeout", () => req.destroy(new Error(`Timed out after ${options.timeoutMs}ms`)));
    req.on("error", fail);
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      done({ status: res.statusCode ?? 101, headers: res.headers, body: "" });
    });
    req.on("response", res => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        if (size < BODY_LIMIT) chunks.push(chunk.subarray(0, BODY_LIMIT - size));
        size += chunk.length;
      });
      res.on("end", () => done({
        status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8"),
      }));
      res.on("error", fail);
    });
    req.end();
  });
}

/** Run every check against the deployment and build the report. */
export async function runSmoke(options: SmokeOptions): Promise<SmokeReport> {
  const headers: Record<string, string> = options.accessToken
    ? {
      "CF-Access-Client-Id": options.accessToken.clientId,
      "CF-Access-Client-Secret": options.accessToken.clientSecret,
    }
    : {};
  const at = (path: string) => new URL(path, options.baseUrl);
  const send = (url: URL, websocket = false) =>
    smokeRequest(url, { headers, websocket, timeoutMs: options.timeoutMs });
  const checks: SmokeCheck[] = [];
  /** Run one check; a request that fails outright fails the check rather than the run. */
  const check = async (name: string, run: () => Promise<SmokeCheck>) => {
    try {
      checks.push(await run());
    } catch (error) {
      checks.push({ name, ok: false, detail: `Request failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  };

  let shellBody: string | null = null;
  await check("app-shell", async () => {
    const root = await send(at("/"));
    const result = classifyAppShell(root, await send(at("/__inferos-smoke/client-route")));
    if (result.ok) shellBody = root.body;
    return result;
  });
  await check("api", async () => classifyApiHandshake(await send(at("/api"), true)));
  for (const name of options.gatekeepers) {
    await check(`gatekeeper:${name}`, async () =>
      classifyGatekeeper(name, await send(at(`/gatekeeper/${name}/`)), shellBody));
  }
  if (options.connectUrls.length === 0) {
    checks.push({
      name: "oauth", ok: true, skipped: true,
      detail: "No --connect-url given, so no provider redirect origin was checked.",
    });
  }
  for (const url of options.connectUrls) {
    const name = connectGatekeeper(url)!;
    await check(`oauth:${name}`, async () => classifyOAuthRedirect(name, options.baseUrl, await send(url)));
  }

  return {
    ok: checks.every(c => c.ok),
    baseUrl: options.baseUrl.origin,
    accessServiceToken: options.accessToken !== undefined,
    checks,
  };
}

/** Every gatekeeper this checkout deploys, by route name. */
export function deployedGatekeepers(root = ROOT): string[] {
  return readDeployablePackages(root)
    .filter(pkg => isGatekeeperPackage(pkg.name))
    .map(pkg => gatekeeperShortName(pkg.name));
}

async function main(): Promise<number> {
  let options;
  try {
    options = parseSmokeArgs(process.argv.slice(2), process.env, () => deployedGatekeepers());
  } catch (error) {
    if (!(error instanceof SmokeUsageError)) throw error;
    process.stdout.write(`${JSON.stringify({ ok: false, usage: error.message })}\n`);
    return 2;
  }
  const report = await runSmoke(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
