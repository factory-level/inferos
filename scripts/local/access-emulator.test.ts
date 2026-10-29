import assert from "node:assert/strict";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { isAccessRedirect } from "../preview/smoke.ts";
import {
  accessDecision, accessLoginUrl, createAccessEmulator, emulatorOptions, signAssertion, upstreamHeaders, verifyAssertion,
  type AccessEmulatorOptions,
} from "./access-emulator.ts";

const TOKEN = { clientId: "id-1234.access", clientSecret: "secret-value-5678" };
const options = (overrides: Partial<AccessEmulatorOptions> = {}): AccessEmulatorOptions => ({
  upstream: new URL("http://127.0.0.1:1"), team: "factory-local", token: TOKEN, aud: "aud-1",
  signingKey: Buffer.alloc(32, 7), now: () => 1_000, ...overrides,
});
const tokenHeaders = (secret = TOKEN.clientSecret) => ({ "cf-access-client-id": TOKEN.clientId, "cf-access-client-secret": secret });

test("no credential: a 302 to the team's Access login page that isAccessRedirect recognises", () => {
  const decision = accessDecision({ url: "/canvas?x=1", headers: { host: "127.0.0.1:8789" } }, options());
  assert.equal(decision.kind, "redirect");
  const location = (decision as { location: string }).location;
  assert.equal(location, accessLoginUrl("factory-local", "127.0.0.1:8789", "aud-1", "/canvas?x=1"));
  const url = new URL(location);
  assert.equal(url.origin + url.pathname, "https://factory-local.cloudflareaccess.com/cdn-cgi/access/login/127.0.0.1:8789");
  assert.equal(url.searchParams.get("redirect_url"), "/canvas?x=1");
  assert.ok(isAccessRedirect({ status: 302, headers: { location }, body: "" }));
});

test("the service token is proxied with an assertion; a wrong or half token is refused with 403", () => {
  const granted = accessDecision({ headers: tokenHeaders() }, options());
  assert.equal(granted.kind, "proxy");
  assert.ok(verifyAssertion((granted as { assertion: string }).assertion, options()));
  assert.equal(accessDecision({ headers: tokenHeaders("wrong") }, options()).kind, "forbidden");
  assert.equal(accessDecision({ headers: { "cf-access-client-id": TOKEN.clientId } }, options()).kind, "forbidden");
  assert.equal(accessDecision({ headers: { "cf-access-client-secret": TOKEN.clientSecret } }, options()).kind, "forbidden");
});

test("the CF_Authorization cookie it issued is a session; a forged, expired or foreign one is not", () => {
  const jwt = signAssertion(options());
  const claims = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;
  assert.deepEqual(claims.aud, ["aud-1"]);
  assert.equal(claims.common_name, TOKEN.clientId);
  assert.ok(!jwt.includes(TOKEN.clientSecret));
  const withCookie = (value: string) => accessDecision({ headers: { cookie: `a=b; CF_Authorization=${value}` } }, options());
  assert.deepEqual(withCookie(jwt), { kind: "proxy", assertion: jwt, issued: false });
  assert.equal(withCookie(`${jwt.slice(0, -2)}xx`).kind, "redirect");
  assert.equal(accessDecision({ headers: { cookie: `CF_Authorization=${jwt}` } }, options({ now: () => 1_000 + 25 * 3600 })).kind, "redirect");
  assert.equal(accessDecision({ headers: { cookie: `CF_Authorization=${jwt}` } }, options({ signingKey: Buffer.alloc(32, 8) })).kind, "redirect");
});

test("upstream never sees the token, and a client-sent assertion is replaced", () => {
  const headers = upstreamHeaders({ ...tokenHeaders(), "cf-access-jwt-assertion": "forged", host: "h" }, "issued");
  assert.deepEqual(headers, { host: "h", "cf-access-jwt-assertion": "issued" });
});

test("the CLI takes the token by name from the environment and refuses without it", () => {
  const env = { ACCESS_EMULATOR_CLIENT_ID: TOKEN.clientId, ACCESS_EMULATOR_CLIENT_SECRET: TOKEN.clientSecret };
  const parsed = emulatorOptions(["--port", "8789", "--upstream", "http://localhost:8797"], env, Buffer.alloc(32));
  assert.equal(parsed.port, 8789);
  assert.deepEqual(parsed.options.token, TOKEN);
  assert.throws(() => emulatorOptions(["--port", "8789", "--upstream", "http://localhost:8797"], {}, Buffer.alloc(32)), /ACCESS_EMULATOR_CLIENT_ID/);
  assert.throws(() => emulatorOptions(["--port", "8789", "--upstream", "https://x.test"], env, Buffer.alloc(32)), /http origin/);
});

const listen = (server: Server) => new Promise<number>(done => server.listen(0, "127.0.0.1", () => done((server.address() as AddressInfo).port)));

function get(port: number, headers: Record<string, string>, upgrade = false): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path: "/api", headers: upgrade ? { ...headers, connection: "Upgrade", upgrade: "websocket" } : headers });
    req.on("upgrade", (res, socket) => { socket.end(); done({ status: res.statusCode ?? 101, headers: res.headers, body: "" }); });
    req.on("response", res => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => done({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", fail);
    req.end();
  });
}

test("over HTTP and WebSocket: redirect, proxy with assertion and session cookie, 403", async () => {
  const seen: IncomingHttpHeaders[] = [];
  const upstream = createServer((req, res) => { seen.push(req.headers); res.end("shell"); });
  upstream.on("upgrade", (req, socket) => {
    seen.push(req.headers);
    socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
  });
  const upstreamPort = await listen(upstream);
  const emulator = createAccessEmulator(options({ upstream: new URL(`http://127.0.0.1:${upstreamPort}`) }));
  const port = await listen(emulator);
  try {
    const anonymous = await get(port, {});
    assert.equal(anonymous.status, 302);
    assert.ok(isAccessRedirect({ status: anonymous.status, headers: anonymous.headers, body: "" }));
    assert.equal(seen.length, 0, "nothing reaches InferOS without a credential");

    const granted = await get(port, tokenHeaders());
    assert.equal(granted.status, 200);
    assert.equal(granted.body, "shell");
    assert.equal(seen[0]!["cf-access-client-secret"], undefined);
    assert.ok(verifyAssertion(String(seen[0]!["cf-access-jwt-assertion"]), options()));
    const session = String(granted.headers["set-cookie"]).match(/CF_Authorization=([^;]+)/)?.[1];
    assert.ok(session && verifyAssertion(session, options()));

    assert.equal((await get(port, tokenHeaders("wrong"))).status, 403);
    assert.equal(seen.length, 1, "a refused request never reaches InferOS");

    assert.equal((await get(port, {}, true)).status, 302);
    assert.equal((await get(port, tokenHeaders("wrong"), true)).status, 403);
    assert.equal((await get(port, { cookie: `CF_Authorization=${session}` }, true)).status, 101);
    assert.equal(seen.length, 2);
    assert.equal(seen[1]!["cf-access-jwt-assertion"], session);
  } finally {
    emulator.close();
    upstream.close();
    emulator.closeAllConnections();
    upstream.closeAllConnections();
  }
});
