#!/usr/bin/env node
// A local stand-in for Cloudflare Access in front of the factory's `dev` sandbox, the way floci-gcp
// stands in for GCP: it lets the `stage-probe` sandbox exercise a remote stage's Access mode on this
// machine (`pnpm local factory up dev --access-emulator`, then `FACTORY_STAGE_ACCESS=emulated`).
//
//   ACCESS_EMULATOR_CLIENT_ID=... ACCESS_EMULATOR_CLIENT_SECRET=... \
//     node scripts/local/access-emulator.ts --port 8789 --upstream http://localhost:8797 [--team factory-local]
//
// It listens on 127.0.0.1 only and decides each request (HTTP and WebSocket upgrade alike) the way
// an Access application with a Service Auth policy does:
//   - `CF-Access-Client-Id` + `CF-Access-Client-Secret` matching its service token: proxied to the
//     upstream with a `Cf-Access-Jwt-Assertion` header, and the response sets a `CF_Authorization`
//     cookie holding the same assertion;
//   - a valid `CF_Authorization` cookie (one it issued): proxied the same way;
//   - a service-token header that does not match: 403;
//   - anything else: 302 to `https://<team>.cloudflareaccess.com/cdn-cgi/access/login/<host>?...`,
//     which `isAccessRedirect` (scripts/preview/smoke.ts) recognises.
// The service token is generated per run by `factory up` and reaches this process by name only.
//
// What it does NOT prove: Cloudflare's signing (the assertion is HS256 with a per-process key, not
// Access's RS256 keys at `/cdn-cgi/access/certs`), identity providers, policy evaluation beyond one
// service token, Access's edge timeouts, TLS, or that the deployed application is configured at all.
// ponytail: one service token, no identity login; upgrade path is a token list and an IdP stub.

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

/** How the emulator is configured. */
export interface AccessEmulatorOptions {
  /** The InferOS origin requests are proxied to. */
  upstream: URL;
  /** The Zero Trust team name: logins redirect to `<team>.cloudflareaccess.com`. */
  team: string;
  /** The one service token the Service Auth policy allows. */
  token: { clientId: string; clientSecret: string };
  /** The application audience (AUD tag) put in the assertion and the login URL. */
  aud: string;
  /** The HMAC key the assertions are signed with. */
  signingKey: Buffer;
  /** Seconds since the epoch; injected for tests. */
  now?: () => number;
}

/** What Access does with one request. */
export type AccessDecision =
  | { kind: "redirect"; location: string }
  | { kind: "forbidden"; reason: string }
  | { kind: "proxy"; assertion: string; issued: boolean };

/** How long an issued assertion (and its cookie) stays valid, as Access's default session. */
const SESSION_SECONDS = 24 * 60 * 60;

const b64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The login URL Access redirects an unauthenticated browser to, in Cloudflare's shape. */
export function accessLoginUrl(team: string, host: string, aud: string, path: string): string {
  const url = new URL(`https://${team}.cloudflareaccess.com/cdn-cgi/access/login/${host}`);
  url.searchParams.set("kid", aud);
  url.searchParams.set("redirect_url", path);
  return url.toString();
}

/** An HS256 JWT shaped like Access's service-token assertion (`common_name` is the client id). */
export function signAssertion(options: AccessEmulatorOptions): string {
  const now = options.now?.() ?? Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT", kid: "factory-access-emulator" }));
  const body = b64url(JSON.stringify({
    aud: [options.aud], iss: `https://${options.team}.cloudflareaccess.com`, type: "app",
    common_name: options.token.clientId, sub: "", iat: now, nbf: now, exp: now + SESSION_SECONDS,
  }));
  const signature = createHmac("sha256", options.signingKey).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${signature}`;
}

/** Whether `jwt` is an unexpired assertion this emulator issued for its audience. */
export function verifyAssertion(jwt: string, options: AccessEmulatorOptions): boolean {
  const [head, body, signature] = jwt.split(".");
  if (!head || !body || !signature) return false;
  const expected = createHmac("sha256", options.signingKey).update(`${head}.${body}`).digest("base64url");
  if (!sameSecret(signature, expected)) return false;
  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { aud?: string[]; exp?: number };
    const now = options.now?.() ?? Math.floor(Date.now() / 1000);
    return Array.isArray(claims.aud) && claims.aud.includes(options.aud) && typeof claims.exp === "number" && claims.exp > now;
  } catch {
    return false;
  }
}

function cookie(headers: IncomingHttpHeaders, name: string): string | undefined {
  for (const part of (header(headers, "cookie") ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

/** Decide one request from its headers and path, as Access would. */
export function accessDecision(request: { url?: string; headers: IncomingHttpHeaders }, options: AccessEmulatorOptions): AccessDecision {
  const clientId = header(request.headers, "cf-access-client-id");
  const clientSecret = header(request.headers, "cf-access-client-secret");
  if (clientId !== undefined || clientSecret !== undefined) {
    const ok = clientId !== undefined && clientSecret !== undefined &&
      sameSecret(clientId, options.token.clientId) && sameSecret(clientSecret, options.token.clientSecret);
    return ok ? { kind: "proxy", assertion: signAssertion(options), issued: true }
      : { kind: "forbidden", reason: "the service token does not match the application's Service Auth policy" };
  }
  const session = cookie(request.headers, "CF_Authorization");
  if (session && verifyAssertion(session, options)) return { kind: "proxy", assertion: session, issued: false };
  const host = header(request.headers, "host") ?? "localhost";
  return { kind: "redirect", location: accessLoginUrl(options.team, host, options.aud, request.url ?? "/") };
}

/** The headers forwarded upstream: the token stripped, any client-sent assertion replaced by ours. */
export function upstreamHeaders(headers: IncomingHttpHeaders, assertion: string): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (["cf-access-client-id", "cf-access-client-secret", "cf-access-jwt-assertion"].includes(name)) continue;
    out[name] = value;
  }
  out["cf-access-jwt-assertion"] = assertion;
  return out;
}

const sessionCookie = (assertion: string) =>
  `CF_Authorization=${assertion}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}`;

function refusalHead(decision: Exclude<AccessDecision, { kind: "proxy" }>): string {
  return decision.kind === "redirect"
    ? `HTTP/1.1 302 Found\r\nLocation: ${decision.location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`
    : "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: 9\r\nConnection: close\r\n\r\nForbidden";
}

/** Proxy a WebSocket upgrade raw: Access passes WebSockets through once a request is authorised. */
function proxyUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, options: AccessEmulatorOptions, assertion: string): void {
  const upstream = connect(Number(options.upstream.port || 80), options.upstream.hostname, () => {
    const headers = upstreamHeaders(request.headers, assertion);
    const lines = [`${request.method} ${request.url} HTTP/1.1`];
    for (const [name, value] of Object.entries(headers)) {
      for (const one of Array.isArray(value) ? value : [value]) if (one !== undefined) lines.push(`${name}: ${one}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const close = () => { upstream.destroy(); socket.destroy(); };
  upstream.on("error", close);
  socket.on("error", close);
}

/** Create the emulator's server (not yet listening). */
export function createAccessEmulator(options: AccessEmulatorOptions): Server {
  const server = createServer((request, response) => {
    const decision = accessDecision(request, options);
    if (decision.kind === "redirect") {
      response.writeHead(302, { location: decision.location, "content-length": "0" }).end();
      return;
    }
    if (decision.kind === "forbidden") {
      response.writeHead(403, { "content-type": "text/plain" }).end("Forbidden");
      return;
    }
    const proxied = httpRequest(options.upstream, {
      method: request.method, path: request.url, headers: upstreamHeaders(request.headers, decision.assertion),
    }, upstream => {
      const headers = { ...upstream.headers };
      if (decision.issued) {
        const existing = headers["set-cookie"] ?? [];
        headers["set-cookie"] = [...existing, sessionCookie(decision.assertion)];
      }
      response.writeHead(upstream.statusCode ?? 502, headers);
      upstream.pipe(response);
    });
    proxied.on("error", error => {
      if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
      response.end(`Bad gateway: ${error.message}`);
    });
    request.pipe(proxied);
  });
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const decision = accessDecision(request, options);
    if (decision.kind !== "proxy") {
      socket.end(refusalHead(decision));
      return;
    }
    proxyUpgrade(request, socket, head, options, decision.assertion);
  });
  return server;
}

/** Read the CLI's options; the service token comes from the environment by name. */
export function emulatorOptions(argv: string[], env: NodeJS.ProcessEnv, signingKey: Buffer): { port: number; options: AccessEmulatorOptions } {
  const { values } = parseArgs({ args: argv, options: { port: { type: "string" }, upstream: { type: "string" }, team: { type: "string", default: "factory-local" } } });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be a TCP port");
  if (!values.upstream) throw new Error("--upstream names the InferOS origin to proxy to");
  const upstream = new URL(values.upstream);
  if (upstream.protocol !== "http:") throw new Error("--upstream must be an http origin");
  const clientId = env.ACCESS_EMULATOR_CLIENT_ID;
  const clientSecret = env.ACCESS_EMULATOR_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("ACCESS_EMULATOR_CLIENT_ID and ACCESS_EMULATOR_CLIENT_SECRET must name the service token");
  if (!/^[a-z0-9-]+$/.test(values.team)) throw new Error("--team must be a Zero Trust team name");
  return { port, options: { upstream, team: values.team, token: { clientId, clientSecret }, aud: `factory-local-${port}`, signingKey } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { randomBytes } = await import("node:crypto");
  const { port, options } = emulatorOptions(process.argv.slice(2), process.env, randomBytes(32));
  const server = createAccessEmulator(options);
  server.listen(port, "127.0.0.1", () => {
    console.log(`access emulator on http://127.0.0.1:${port} -> ${options.upstream.origin} (team ${options.team}; service token by name)`);
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => process.exit(0));
}
