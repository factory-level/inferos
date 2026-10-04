import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  defaultDeps, EXIT_FAILED, EXIT_OK, EXIT_USAGE, runLifecycle, seedScreenTemplate,
  type LifecycleDeps, type OperatorResult,
} from "./lifecycle.ts";
import {
  configuredWorkers, inferOpsConfiguration, latestWranglerLog, localEnv, probeWorkers,
  readDevServerRecord, recordDevServer, resetLocalState, resolveLocalStack, stackOwnership,
  type DevServerRecord,
} from "./stack.ts";

const REPO = join(import.meta.dirname, "..", "..");

/** Deps that touch nothing: no port listens, no operator runs, no stack starts. */
function offlineDeps(overrides: Partial<LifecycleDeps> = {}): LifecycleDeps & { operatorCalls: string[][] } {
  const operatorCalls: string[][] = [];
  return {
    ...defaultDeps,
    env: {},
    isPortListening: async () => false,
    devServerRecord: () => null,
    fetchImpl: async () => { throw new Error("offline"); },
    runOperator: (script, args) => {
      operatorCalls.push([script, ...args]);
      return { exitCode: 1, report: null, stderr: "not run" };
    },
    startStack: async () => { throw new Error("startStack must not be reached"); },
    signal: () => { throw new Error("signal must not be reached"); },
    sleep: async () => {},
    wranglerLogDir: () => join(tmpdir(), "no-such-wrangler-logs"),
    operatorCalls,
    ...overrides,
  };
}

/** A live record of this checkout's dev server on `port`: what makes a listener ours. */
const ours = (port = 8787): DevServerRecord => ({ pid: process.pid, port, mode: "run-local", startedAt: "2026-10-03T00:00:00.000Z" });

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "inferos-local-"));
  return root;
}

async function listen(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { port: address.port, close: () => new Promise(resolve => server.close(() => resolve())) };
}

test("usage errors exit 2 and name the command set", async () => {
  for (const argv of [[], ["bogus"], ["status", "--port", "abc"], ["status", "--port", "70000"], ["logs", "--lines", "many"], ["status", "--nope"]]) {
    const result = await runLifecycle(argv, offlineDeps());
    assert.equal(result.exitCode, EXIT_USAGE, argv.join(" "));
    assert.equal(result.report.ok, false);
    assert.equal(typeof result.report.error, "string");
  }
  const usage = await runLifecycle(["bogus", "--json"], offlineDeps());
  assert.equal(usage.json, true);
  assert.match(String(usage.report.error), /status.*start.*stop.*seed.*verify.*reset.*logs/s);
});

test("status reports a stopped stack with a stable JSON shape and exit 1", async () => {
  // A temp root: no dev-server record, and only the two Workers every checkout has.
  const root = tempRoot();
  try {
    const result = await runLifecycle(["status", "--json", "--port", "18999"], offlineDeps({ root }));
    assert.equal(result.exitCode, EXIT_FAILED);
    assert.equal(result.json, true);
    const report = result.report;
    assert.equal(report.ok, false);
    assert.equal(report.command, "status");
    assert.equal(report.url, "http://localhost:18999");
    assert.equal(report.port, 18999);
    assert.equal(report.listening, false);
    assert.equal(report.devServer, null);
    assert.deepEqual(report.inferops, { mode: "mock", missing: [] });
    assert.deepEqual(report.state, { directory: join(root, ".wrangler", "state"), present: false });
    assert.equal(typeof report.logs, "string");
    const workers = report.workers as { name: string; role: string; path: string; state: string }[];
    assert.deepEqual(workers.map(w => [w.name, w.role, w.path, w.state]),
      [["router", "router", "/", "down"], ["workshop-backend", "backend", "/api", "down"]]);
    assert.match(result.headline, /^down:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  // This checkout's discovery adds every gatekeeper package, the fork's own included.
  const names = configuredWorkers(REPO).map(w => w.name);
  assert.ok(names.includes("gatekeeper-inferops"));
  assert.equal(configuredWorkers(REPO).find(w => w.name === "gatekeeper-inferops")?.path, "/gatekeeper/inferops");
});

test("status is ok only when every configured Worker answers through the router", async () => {
  // An RPC-only gatekeeper answers 500 from its own code: that is a running Worker, not a gap.
  const answers = new Map<string, number>([["/", 200], ["/api", 400], ["/gatekeeper/inferops", 404], ["/gatekeeper/scheduler", 500]]);
  const fetchImpl: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    const status = answers.get(path) ?? 503;
    return new Response(null, { status });
  };
  const deps = offlineDeps({ isPortListening: async () => true, devServerRecord: () => ours(), fetchImpl });
  const degraded = await runLifecycle(["status", "--json"], deps);
  assert.equal(degraded.exitCode, EXIT_FAILED);
  assert.match(degraded.headline, /^degraded:/);
  const states = degraded.report.workers as { name: string; state: string; status?: number }[];
  assert.equal(states.find(w => w.name === "router")?.state, "up");
  assert.equal(states.find(w => w.name === "workshop-backend")?.state, "up");
  assert.equal(states.find(w => w.name === "workshop-backend")?.status, 400);
  assert.equal(states.find(w => w.name === "gatekeeper-scheduler")?.state, "up");
  assert.ok(states.some(w => w.state === "error" && w.status === 503));

  for (const worker of configuredWorkers(REPO)) answers.set(worker.path, 200);
  const up = await runLifecycle(["status", "--json"], deps);
  assert.equal(up.exitCode, EXIT_OK);
  assert.equal(up.report.ok, true);
  assert.match(up.headline, /^up: \d+ workers answering .* \(InferOps mock\)$/);
});

test("status reports a listener this checkout did not start as port-in-use-by-other and never probes it", async () => {
  const root = tempRoot();
  const { port, close } = await listen();
  let probed = false;
  const fetchImpl: typeof fetch = async () => { probed = true; return new Response(null, { status: 200 }); };
  try {
    // Real port, real record file: nothing recorded, then a record for another port, then ours.
    for (const record of [null, () => recordDevServer(root, { port: port + 1, mode: "run-local" })]) {
      record?.();
      const result = await runLifecycle(["status", "--json", "--port", String(port)], offlineDeps({ root, fetchImpl, isPortListening: defaultDeps.isPortListening, devServerRecord: readDevServerRecord }));
      assert.equal(result.exitCode, EXIT_FAILED);
      assert.equal(result.report.ok, false);
      assert.equal(result.report.listening, true);
      assert.equal(result.report.stack, "port-in-use-by-other");
      assert.match(String(result.report.error), new RegExp(`Port ${port} is in use by a process this checkout did not start`));
      assert.match(result.headline, /^port-in-use-by-other:/);
      assert.ok((result.report.workers as { state: string }[]).every(worker => worker.state === "down"));
    }
    assert.equal(probed, false);
    recordDevServer(root, { port, mode: "run-local" });
    const mine = await runLifecycle(["status", "--json", "--port", String(port)], offlineDeps({ root, fetchImpl, isPortListening: defaultDeps.isPortListening, devServerRecord: readDevServerRecord }));
    assert.equal(mine.report.stack, "running");
    assert.equal((mine.report.devServer as { port: number }).port, port);
    assert.equal(probed, true);
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(stackOwnership(false, ours(), 8787), "not-running");
  assert.equal(stackOwnership(true, null, 8787), "port-in-use-by-other");
  assert.equal(stackOwnership(true, ours(9000), 8787), "port-in-use-by-other");
  assert.equal(stackOwnership(true, ours(), 8787), "running");
});

test("seed and verify refuse a listener that is not this checkout's stack", async () => {
  const deps = offlineDeps({ isPortListening: async () => true });
  for (const command of ["seed", "verify"]) {
    const result = await runLifecycle([command, "--json"], deps);
    assert.equal(result.exitCode, EXIT_FAILED);
    assert.equal(result.report.stack, "port-in-use-by-other");
    assert.match(String(result.report.error), /Port 8787 is in use by a process this checkout did not start/);
  }
  assert.deepEqual(deps.operatorCalls, []);
});

test("probing reports a Worker as down when the origin does not answer", async () => {
  const probes = await probeWorkers("http://127.0.0.1:1", configuredWorkers(REPO).slice(0, 2),
    async () => { throw new TypeError("fetch failed"); });
  assert.deepEqual(probes.map(p => p.state), ["down", "down"]);
});

test("start refuses an occupied port without touching its listener", async () => {
  const { port, close } = await listen();
  let started = false;
  const deps = offlineDeps({ startStack: async () => { started = true; } });
  try {
    const result = await runLifecycle(["start", "--json", "--port", String(port)], deps);
    assert.equal(result.exitCode, EXIT_FAILED);
    assert.equal(result.report.ok, false);
    assert.match(String(result.report.error), new RegExp(`Port ${port} is busy`));
    assert.equal(started, false);
  } finally {
    await close();
  }
  const free = await runLifecycle(["start", "--json", "--port", String(port), "--", "--use-workers-ai-binding"], deps);
  assert.equal(free.exitCode, EXIT_OK);
  assert.equal(started, true);
});

test("start names this checkout's own dev server when its record owns the port", async () => {
  const root = tempRoot();
  const { port, close } = await listen();
  try {
    recordDevServer(root, { port, mode: "run-local" });
    const result = await runLifecycle(["start", "--json", "--port", String(port)], offlineDeps({ root }));
    assert.equal(result.exitCode, EXIT_FAILED);
    assert.match(String(result.report.error), new RegExp(`dev server \\(pid ${process.pid}\\) already runs`));
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("seed and verify fail fast when nothing listens", async () => {
  const deps = offlineDeps();
  for (const command of ["seed", "verify"]) {
    const result = await runLifecycle([command, "--json"], deps);
    assert.equal(result.exitCode, EXIT_FAILED);
    assert.equal(result.report.command, command);
    assert.match(String(result.report.error), /Nothing listens on localhost:8787/);
  }
  assert.deepEqual(deps.operatorCalls, []);
});

test("repeated seed runs the same idempotent operator steps and keeps the session out of the report", async () => {
  const setupReport = { ok: true, url: "http://localhost:8787/", user: "dev", accountCreated: false,
    model: "scripted-inferops", inferops: "already connected", browserLogin: 'localStorage.setItem("authToken", "SECRET-TOKEN")' };
  const verifyReport = { ok: true, connectionCreated: false,
    agentView: { inferops: { connected: true }, board: { project: "DEMO", issues: 9, states: 10 }, approvalQueue: { reachable: true, pending: 1 } } };
  const runOperator = (script: string): OperatorResult =>
    ({ exitCode: 0, report: script === "dev-setup.ts" ? { ...setupReport } : { ...verifyReport }, stderr: "" });
  const deps = offlineDeps({ isPortListening: async () => true, devServerRecord: () => ours(), runOperator: (script, args, env) => {
    deps.operatorCalls.push([script, ...args]);
    return runOperator(script);
  } });
  const first = await runLifecycle(["seed", "--json", "--screen", "operations"], deps);
  const second = await runLifecycle(["seed", "--json", "--screen", "operations"], deps);
  for (const result of [first, second]) {
    assert.equal(result.exitCode, EXIT_OK);
    assert.equal(result.report.ok, true);
    assert.equal(result.report.screen, "operations");
    assert.equal(JSON.stringify(result.report).includes("SECRET-TOKEN"), false);
    assert.equal((result.report.setup as { accountCreated: boolean }).accountCreated, false);
    assert.match(result.headline, /^seeded .*board DEMO \(9 issues in 10 states\), 1 pending approval/);
  }
  assert.deepEqual(deps.operatorCalls[0], ["dev-setup.ts", "--url", "http://localhost:8787", "--mock-model", "--inferops", "--screen", "operations"]);
  assert.deepEqual(deps.operatorCalls[1], ["dev-verify.ts", "--url", "http://localhost:8787", "--ensure-board", "--approval-scenario"]);
  assert.deepEqual(deps.operatorCalls.slice(2), deps.operatorCalls.slice(0, 2));

  const quiet = await runLifecycle(["seed", "--json", "--no-approval", "--user", "ops", "--password", "pw"], deps);
  assert.equal(quiet.exitCode, EXIT_OK);
  assert.deepEqual(deps.operatorCalls.at(-1), ["dev-verify.ts", "--url", "http://localhost:8787", "--user", "ops", "--password", "pw", "--ensure-board"]);
  assert.match(String(quiet.report.screen), /^skipped:/);
});

test("seed reports which operator step failed", async () => {
  const deps = offlineDeps({ isPortListening: async () => true, devServerRecord: () => ours(), runOperator: script => script === "dev-setup.ts"
    ? { exitCode: 0, report: { ok: true }, stderr: "" }
    : { exitCode: 1, report: { ok: false, step: "board", error: "The InferOps account cannot open the board" }, stderr: "" } });
  const result = await runLifecycle(["seed", "--json"], deps);
  assert.equal(result.exitCode, EXIT_FAILED);
  assert.equal((result.report.verify as { step: string }).step, "board");
  assert.match(result.headline, /^seed failed at verify: The InferOps account cannot open/);

  const broken = await runLifecycle(["seed", "--json"], offlineDeps({ isPortListening: async () => true, devServerRecord: () => ours(),
    runOperator: () => ({ exitCode: 1, report: null, stderr: "Saved canvases are off" }) }));
  assert.equal(broken.exitCode, EXIT_FAILED);
  assert.deepEqual(broken.report, { ok: false, command: "seed", url: "http://localhost:8787", step: "setup", error: "Saved canvases are off" });
});

test("verify passes the operator's report through with its exit code", async () => {
  const ready = { ok: true, agentView: { board: { project: "DEMO", issues: 2, states: 3 }, approvalQueue: { pending: 0 } } };
  const calls: string[][] = [];
  const deps = offlineDeps({ isPortListening: async () => true, devServerRecord: () => ours(), runOperator: (script, args) => {
    calls.push([script, ...args]);
    return { exitCode: 0, report: ready, stderr: "" };
  } });
  const result = await runLifecycle(["verify", "--json", "--board", "inferops://ops.example/project/board/OPS"], deps);
  assert.equal(result.exitCode, EXIT_OK);
  assert.equal(result.report.command, "verify");
  assert.deepEqual(result.report.agentView, ready.agentView);
  assert.deepEqual(calls, [["dev-verify.ts", "--url", "http://localhost:8787", "--board", "inferops://ops.example/project/board/OPS"]]);

  const notReady = await runLifecycle(["verify", "--json"], offlineDeps({ isPortListening: async () => true, devServerRecord: () => ours(),
    runOperator: () => ({ exitCode: 1, report: { ok: false, step: "signIn", error: "No local account" }, stderr: "" }) }));
  assert.equal(notReady.exitCode, EXIT_FAILED);
  assert.equal(notReady.headline, "not ready (signIn): No local account");

  const crashed = await runLifecycle(["verify", "--json"], offlineDeps({ isPortListening: async () => true, devServerRecord: () => ours(),
    runOperator: () => ({ exitCode: 1, report: null, stderr: "boom" }) }));
  assert.equal(crashed.exitCode, EXIT_FAILED);
  assert.deepEqual(crashed.report, { ok: false, step: "connect", error: "boom", command: "verify" });
});

test("reset needs --yes, clears only this checkout's state, and refuses while the stack runs", async () => {
  const root = tempRoot();
  const stack = resolveLocalStack(root, [], {});
  try {
    assert.equal(stack.stateDir, join(root, ".wrangler", "state"));
    mkdirSync(join(stack.stateDir, "v3", "do"), { recursive: true });
    writeFileSync(join(stack.stateDir, "v3", "do", "object.sqlite"), "data");
    mkdirSync(join(root, ".wrangler", "tmp"), { recursive: true });
    writeFileSync(join(root, ".wrangler", "tmp", "bundle.js"), "keep");

    const refused = await runLifecycle(["reset", "--json"], offlineDeps({ root }));
    assert.equal(refused.exitCode, EXIT_FAILED);
    assert.match(String(refused.report.error), /without --yes/);
    assert.ok(existsSync(join(stack.stateDir, "v3", "do", "object.sqlite")));

    const forget = recordDevServer(root, { port: 8787, mode: "run-local" });
    const running = await runLifecycle(["reset", "--json", "--yes"], offlineDeps({ root }));
    assert.equal(running.exitCode, EXIT_FAILED);
    assert.match(String(running.report.error), /stack is running/);
    assert.ok(existsSync(stack.stateDir));
    forget();
    assert.equal(existsSync(stack.recordPath), false);

    const reset = await runLifecycle(["reset", "--json", "--yes"], offlineDeps({ root }));
    assert.equal(reset.exitCode, EXIT_OK);
    assert.deepEqual(reset.report, { ok: true, command: "reset", stateDir: stack.stateDir, removed: [stack.stateDir, join(root, ".wrangler", "local")] });
    assert.equal(existsSync(stack.stateDir), false);
    assert.ok(existsSync(join(root, ".wrangler", "tmp", "bundle.js")));

    const again = await runLifecycle(["reset", "--json", "--yes"], offlineDeps({ root }));
    assert.equal(again.exitCode, EXIT_OK);
    assert.deepEqual(again.report.removed, []);
    assert.throws(() => resetLocalState(stack, { confirm: false }), /--yes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a dev server record only counts while its process lives, and only its owner removes it", () => {
  const root = tempRoot();
  try {
    const recordPath = resolveLocalStack(root, [], {}).recordPath;
    const forget = recordDevServer(root, { port: 9000, mode: "dev-server" });
    const record = readDevServerRecord(recordPath);
    assert.equal(record?.pid, process.pid);
    assert.equal(record?.port, 9000);
    assert.equal(record?.mode, "dev-server");
    // A newer server replaced the record: this run's cleanup must leave it alone.
    writeFileSync(recordPath, JSON.stringify({ pid: 2 ** 22 - 1, port: 9000, mode: "dev-server", startedAt: "x" }));
    forget();
    assert.ok(existsSync(recordPath));
    // ...and a record whose process is gone is no record.
    assert.equal(readDevServerRecord(recordPath), null);
    writeFileSync(recordPath, "not json");
    assert.equal(readDevServerRecord(recordPath), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stop signals the recorded server and waits for it, or reports there is nothing of ours", async () => {
  const root = tempRoot();
  try {
    const nothing = await runLifecycle(["stop", "--json"], offlineDeps({ root }));
    assert.equal(nothing.exitCode, EXIT_OK);
    assert.equal(nothing.report.stopped, false);

    const foreign = await runLifecycle(["stop", "--json"], offlineDeps({ root, isPortListening: async () => true }));
    assert.equal(foreign.exitCode, EXIT_FAILED);
    assert.match(String(foreign.report.error), /recorded no dev server/);

    recordDevServer(root, { port: 8787, mode: "run-local" });
    const signals: [number, string][] = [];
    let alive = true;
    const stopped = await runLifecycle(["stop", "--json"], offlineDeps({ root,
      signal: (pid, signal) => { signals.push([pid, signal]); alive = false; },
      processAlive: () => alive }));
    assert.equal(stopped.exitCode, EXIT_OK);
    assert.deepEqual(signals, [[process.pid, "SIGTERM"]]);
    assert.deepEqual(stopped.report, { ok: true, command: "stop", stopped: true, pid: process.pid });

    let clock = 0;
    const wedged = await runLifecycle(["stop", "--json"], offlineDeps({ root,
      signal: () => {}, processAlive: () => true, now: () => (clock += 20_000) }));
    assert.equal(wedged.exitCode, EXIT_FAILED);
    assert.match(String(wedged.report.error), /did not exit within 30s/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("InferOps configuration is reported by presence only, never by value", () => {
  assert.deepEqual(inferOpsConfiguration({}), { mode: "mock", missing: [] });
  const partial = inferOpsConfiguration({ INFEROPS_BASE_URL: "https://ops.example.com/api" });
  assert.deepEqual(partial, { mode: "live", host: "ops.example.com", missing: ["INFEROPS_API_TOKEN", "INFEROPS_WORKSPACE_ID", "INFEROPS_WORKSPACE_SLUG"] });
  const live = inferOpsConfiguration({ INFEROPS_BASE_URL: "http://localhost:8080", INFEROPS_API_TOKEN: "tok-secret", INFEROPS_WORKSPACE_ID: "ws-1", INFEROPS_WORKSPACE_SLUG: "operations" });
  assert.deepEqual(live, { mode: "live", host: "localhost:8080", missing: [] });
  assert.equal(JSON.stringify(live).includes("tok-secret"), false);
  assert.equal(inferOpsConfiguration({ INFEROPS_BASE_URL: "nonsense" }).host, undefined);
});

test("status reads the dev server's .dev.vars and .env with shell precedence", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, ".dev.vars"), "INFEROPS_BASE_URL=https://vars.example\nINFEROPS_API_TOKEN=\"dev-vars-secret-token\"\n");
    writeFileSync(join(root, ".env"), "INFEROPS_BASE_URL=https://env.example\nINFEROPS_WORKSPACE_ID=w\nINFEROPS_WORKSPACE_SLUG=operations\n");
    const merged = localEnv(root, {});
    assert.equal(merged.INFEROPS_BASE_URL, "https://vars.example");
    assert.equal(merged.INFEROPS_WORKSPACE_ID, "w");
    assert.equal(localEnv(root, { INFEROPS_BASE_URL: "https://shell.example" }).INFEROPS_BASE_URL, "https://shell.example");
    const result = await runLifecycle(["status", "--json"], offlineDeps({ root }));
    assert.deepEqual(result.report.inferops, { mode: "live", host: "vars.example", missing: [] });
    assert.equal(JSON.stringify(result.report).includes("dev-vars-secret-token"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("logs locates the newest Wrangler log and tails it", async () => {
  const dir = tempRoot();
  try {
    const none = await runLifecycle(["logs", "--json"], offlineDeps({ wranglerLogDir: () => dir }));
    assert.equal(none.exitCode, EXIT_OK);
    assert.deepEqual([none.report.file, none.report.lines], [null, []]);
    writeFileSync(join(dir, "wrangler-2026-10-01_10-00-00_000.log"), "old\n");
    writeFileSync(join(dir, "wrangler-2026-10-02_10-00-00_000.log"), "a\nb\nc\nd\n");
    writeFileSync(join(dir, "unrelated.txt"), "zzz\n");
    assert.deepEqual(latestWranglerLog(dir, 2), { file: join(dir, "wrangler-2026-10-02_10-00-00_000.log"), lines: ["c", "d"] });
    const tail = await runLifecycle(["logs", "--json", "--lines", "3"], offlineDeps({ wranglerLogDir: () => dir }));
    assert.deepEqual(tail.report.lines, ["b", "c", "d"]);
    assert.equal(tail.report.directory, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the seed screen template comes from an explicit id or the first configured screen", () => {
  assert.equal(seedScreenTemplate(REPO, "operations"), "operations");
  const root = tempRoot();
  try {
    assert.equal(seedScreenTemplate(root), null);
    writeFileSync(join(root, "inferos.canvas.json"), JSON.stringify({ schemaVersion: 1,
      widgets: { kinds: ["inferops.project-board"], blueprints: [] }, customGatekeepers: "all",
      screens: [{ id: "ops", title: "Ops", sections: [{ id: "main", title: "Ops", columns: 1,
        widgets: [{ id: "board", kind: "inferops.project-board", version: 1, size: "full",
          targetRef: "inferops://demo.local/project/board/DEMO", params: { workflow: "software", showCompleted: true } }] }] }] }));
    assert.equal(seedScreenTemplate(root), "ops");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the CLI entry prints one JSON object with --json and exits with the command's code", () => {
  const result = spawnSync(process.execPath, [join(REPO, "scripts", "local", "lifecycle.ts"), "status", "--json", "--port", "1"],
    { cwd: REPO, encoding: "utf8", env: { ...process.env, VITE_BACKEND_HOST: "" } });
  assert.equal(result.status, EXIT_FAILED);
  const report = JSON.parse(result.stdout);
  assert.equal(report.listening, false);
  assert.equal(report.port, 1);
  const usage = spawnSync(process.execPath, [join(REPO, "scripts", "local", "lifecycle.ts"), "--json"], { cwd: REPO, encoding: "utf8" });
  assert.equal(usage.status, EXIT_USAGE);
  assert.match(usage.stderr, /Usage: pnpm local/);
  assert.equal(JSON.parse(usage.stdout).ok, false);
});

test("a wedged record file is ignored by status", () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, ".wrangler", "local"), { recursive: true });
    writeFileSync(join(root, ".wrangler", "local", "dev-server.json"), "{}");
    assert.equal(readDevServerRecord(join(root, ".wrangler", "local", "dev-server.json")), null);
    assert.equal(readFileSync(join(root, ".wrangler", "local", "dev-server.json"), "utf8"), "{}");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
