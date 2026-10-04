// The preview smoke recipe against a local fake deployment: a plain Node HTTP server that answers
// like the router would (app shell with SPA fallback, `/api` upgrades or auth refusals, a bound
// gatekeeper, an unbound one falling through to the shell, a connect leg redirecting to a provider).
// Nothing here reaches Cloudflare.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyApiHandshake, classifyOAuthRedirect, deployedGatekeepers, parseSmokeArgs, runSmoke,
  SmokeUsageError, type SmokeOptions, type SmokeReport, type SmokeResponse,
} from "./smoke.ts";

const SHELL = "<!doctype html><div id=root></div>";
const SMOKE = fileURLToPath(new URL("./smoke.ts", import.meta.url));

/** How the fake deployment behaves; tests flip these between runs. */
const behaviour = {
  /** `/api` handshake: upgrade, the Workshop's Access refusal, or a 404 like a missing route. */
  api: "upgrade" as "upgrade" | "workshop-403" | "not-found" | "error",
  /** Require an Access service token on every path but `/api`, as an Access application would. */
  access: false,
  /** Where the connect leg sends `redirect_uri`: this origin, or a stale one. */
  redirectOrigin: "self" as "self" | "other",
};
const seen: { path: string; method: string; headers: IncomingMessage["headers"] }[] = [];

let server: Server;
let base: URL;

function handle(req: IncomingMessage, res: ServerResponse): void {
  seen.push({ path: req.url ?? "", method: req.method ?? "", headers: req.headers });
  const path = new URL(req.url ?? "/", base).pathname;
  if (behaviour.access && req.headers["cf-access-client-id"] !== "id") {
    res.writeHead(302, { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" }).end();
    return;
  }
  if (path === "/api") {
    if (behaviour.api === "workshop-403") res.writeHead(403).end("Invalid CF access JWT.");
    else if (behaviour.api === "error") res.writeHead(500).end("boom");
    else res.writeHead(404).end("Not Found");
    return;
  }
  if (path === "/gatekeeper/inferops/start/attempt-nonce") {
    const origin = behaviour.redirectOrigin === "self" ? base.origin : "http://localhost:8787";
    const authorize = new URL("https://provider.test/authorize");
    authorize.searchParams.set("redirect_uri", `${origin}/gatekeeper/inferops/oauth`);
    res.writeHead(302, { location: authorize.href }).end();
    return;
  }
  if (path.startsWith("/gatekeeper/inferops/")) {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not Found");
    return;
  }
  if (path.startsWith("/gatekeeper/broken/")) {
    res.writeHead(503).end("upstream unavailable");
    return;
  }
  // Everything else, unbound gatekeeper paths included, is the SPA fallback.
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(SHELL);
}

before(async () => {
  server = createServer(handle);
  server.on("upgrade", (req, socket) => {
    seen.push({ path: req.url ?? "", method: req.method ?? "", headers: req.headers });
    if (behaviour.api === "upgrade") {
      socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
      return;
    }
    // Answer the handshake with a plain response, as the Workshop or an edge refusal does.
    const status = behaviour.api === "workshop-403" ? "403 Forbidden"
      : behaviour.api === "error" ? "500 Internal Server Error" : "404 Not Found";
    const body = behaviour.api === "workshop-403" ? "Invalid CF access JWT." : "nope";
    socket.end(`HTTP/1.1 ${status}\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  base = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
});

after(() => new Promise<void>(done => server.close(() => done())));

const options = (overrides: Partial<SmokeOptions> = {}): SmokeOptions => ({
  baseUrl: base, gatekeepers: ["inferops"], connectUrls: [], timeoutMs: 5_000, ...overrides,
});
const checkNamed = (report: SmokeReport, name: string) => {
  const found = report.checks.find(c => c.name === name);
  assert.ok(found, `no ${name} check in ${JSON.stringify(report.checks)}`);
  return found;
};

const response = (status: number, body = "", headers: SmokeResponse["headers"] = {}): SmokeResponse =>
  ({ status, body, headers });
const none = () => ["inferops"];
const refuses = (argv: string[], env: NodeJS.ProcessEnv = {}) =>
  assert.throws(() => parseSmokeArgs(argv, env, none), SmokeUsageError);

describe("runSmoke against a fake deployment", () => {
  it("passes a healthy deployment and only ever sends GETs", async () => {
    behaviour.api = "upgrade";
    seen.length = 0;
    const connectUrl = new URL("/gatekeeper/inferops/start/attempt-nonce", base);
    const report = await runSmoke(options({ connectUrls: [connectUrl] }));
    assert.equal(report.ok, true, JSON.stringify(report, null, 2));
    assert.deepEqual(report.checks.map(c => c.name),
      ["app-shell", "api", "gatekeeper:inferops", "oauth:inferops"]);
    assert.equal(checkNamed(report, "api").status, 101);
    assert.ok(seen.every(r => r.method === "GET"));
    // The handshake named the deployment's own origin, which the Workshop requires under Access.
    assert.equal(seen.find(r => r.path === "/api")?.headers.origin, base.origin);
    // The bearer connect URL never appears in the report.
    assert.ok(!JSON.stringify(report).includes("attempt-nonce"));
  });

  it("accepts the Workshop's auth refusal on /api, and fails a 404 or a 5xx there", async () => {
    behaviour.api = "workshop-403";
    assert.equal(checkNamed(await runSmoke(options()), "api").ok, true);
    behaviour.api = "not-found";
    const missing = await runSmoke(options());
    assert.equal(missing.ok, false);
    assert.equal(checkNamed(missing, "api").status, 404);
    behaviour.api = "error";
    assert.equal(checkNamed(await runSmoke(options()), "api").ok, false);
    behaviour.api = "upgrade";
  });

  it("fails a gatekeeper path that falls through to the app shell or has nothing behind it", async () => {
    const report = await runSmoke(options({ gatekeepers: ["inferops", "unbound", "broken"] }));
    assert.equal(report.ok, false);
    assert.equal(checkNamed(report, "gatekeeper:inferops").ok, true);
    assert.match(checkNamed(report, "gatekeeper:unbound").detail, /app shell/);
    assert.equal(checkNamed(report, "gatekeeper:broken").status, 503);
  });

  it("fails an OAuth redirect_uri on another origin", async () => {
    behaviour.redirectOrigin = "other";
    try {
      const report = await runSmoke(options({
        connectUrls: [new URL("/gatekeeper/inferops/start/attempt-nonce", base)],
      }));
      assert.equal(checkNamed(report, "oauth:inferops").ok, false);
      assert.match(checkNamed(report, "oauth:inferops").detail, /localhost:8787/);
    } finally {
      behaviour.redirectOrigin = "self";
    }
  });

  it("behind Access: challenged paths fail without a service token and pass with one", async () => {
    behaviour.access = true;
    try {
      const without = await runSmoke(options());
      assert.equal(without.ok, false);
      assert.match(checkNamed(without, "app-shell").detail, /CF_ACCESS_CLIENT_ID/);
      const withToken = await runSmoke(options({ accessToken: { clientId: "id", clientSecret: "secret" } }));
      assert.equal(withToken.ok, true, JSON.stringify(withToken, null, 2));
      assert.equal(withToken.accessServiceToken, true);
      assert.ok(!JSON.stringify(withToken).includes("secret"));
    } finally {
      behaviour.access = false;
    }
  });

  it("reports an unreachable deployment as failed checks, not a crash", async () => {
    const closed = createServer();
    await new Promise<void>(done => closed.listen(0, "127.0.0.1", done));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>(done => closed.close(() => done()));
    const report = await runSmoke(options({ baseUrl: new URL(`http://127.0.0.1:${port}`) }));
    assert.equal(report.ok, false);
    assert.ok(report.checks.filter(c => !c.skipped).every(c => !c.ok && /Request failed/.test(c.detail)));
  });
});

describe("classifiers", () => {
  it("treats an Access login redirect on /api as an auth challenge", () => {
    const check = classifyApiHandshake(response(302, "", {
      location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/x",
    }));
    assert.equal(check.ok, true);
    assert.match(check.detail, /Workshop itself was not reached/);
    assert.equal(classifyApiHandshake(response(302, "", { location: "https://elsewhere.test/" })).ok, false);
  });

  it("requires redirect_uri under the gatekeeper's own route on the base origin", () => {
    const at = (uri: string) => response(302, "", {
      location: `https://provider.test/authorize?redirect_uri=${encodeURIComponent(uri)}`,
    });
    const baseUrl = new URL("https://pr-1-router.example.workers.dev");
    assert.equal(classifyOAuthRedirect("google", baseUrl, at(`${baseUrl.origin}/gatekeeper/google/oauth`)).ok, true);
    assert.equal(classifyOAuthRedirect("google", baseUrl, at(`${baseUrl.origin}/gatekeeper/github/oauth`)).ok, false);
    assert.equal(classifyOAuthRedirect("google", baseUrl, response(302, "", { location: "https://provider.test/" })).ok, false);
    assert.equal(classifyOAuthRedirect("google", baseUrl, response(200, SHELL)).ok, false);
  });
});

describe("parseSmokeArgs", () => {
  it("parses a base URL, repeated flags and an Access token pair", () => {
    const parsed = parseSmokeArgs([
      "https://pr-1-router.example.workers.dev", "--gatekeeper", "google", "--gatekeeper", "inferops",
      "--connect-url", "https://pr-1-router.example.workers.dev/gatekeeper/google/a/b", "--timeout", "2000",
    ], { CF_ACCESS_CLIENT_ID: "id", CF_ACCESS_CLIENT_SECRET: "secret" }, none);
    assert.deepEqual(parsed.gatekeepers, ["google", "inferops"]);
    assert.equal(parsed.connectUrls.length, 1);
    assert.equal(parsed.timeoutMs, 2000);
    assert.deepEqual(parsed.accessToken, { clientId: "id", clientSecret: "secret" });
    assert.deepEqual(parseSmokeArgs(["https://x.example"], {}, none).gatekeepers, ["inferops"]);
  });

  it("refuses bad input as a usage error", () => {
    refuses([]);
    refuses(["https://x.example", "https://y.example"]);
    refuses(["ftp://x.example"]);
    refuses(["https://x.example/path"]);
    refuses(["https://x.example", "--timeout", "0"]);
    refuses(["https://x.example", "--gatekeeper", "Bad_Name"]);
    refuses(["https://x.example", "--connect-url", "https://other.example/gatekeeper/google/a"]);
    refuses(["https://x.example", "--connect-url", "https://x.example/api"]);
    refuses(["https://x.example"], { CF_ACCESS_CLIENT_ID: "only-id" });
    refuses(["https://x.example", "--unknown"]);
  });

  it("defaults to every gatekeeper package this checkout deploys", () => {
    const names = deployedGatekeepers();
    assert.ok(names.includes("inferops"));
    assert.ok(names.every(name => /^[a-z][a-z0-9-]*$/.test(name)));
  });
});

describe("the command", () => {
  it("exits 2 with a JSON report on a usage error", () => {
    const usage = spawnSync(process.execPath, [SMOKE], { encoding: "utf8" });
    assert.equal(usage.status, 2);
    assert.equal(JSON.parse(usage.stdout).ok, false);
  });

  it("exits 1 and prints the report when a check fails", async () => {
    behaviour.api = "not-found";
    try {
      const run = await new Promise<{ status: number | null; stdout: string }>(done => {
        const child = spawn(process.execPath, [SMOKE, base.origin, "--gatekeeper", "inferops"]);
        let stdout = "";
        child.stdout.on("data", (chunk: Buffer) => { stdout += chunk; });
        child.on("close", status => done({ status, stdout }));
      });
      assert.equal(run.status, 1);
      const report = JSON.parse(run.stdout) as SmokeReport;
      assert.equal(report.ok, false);
      assert.equal(checkNamed(report, "api").ok, false);
    } finally {
      behaviour.api = "upgrade";
    }
  });
});
