import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withWorktreeEnv } from "../worktree-env.ts";
import {
  defaultDeps, EXIT_FAILED, EXIT_OK, EXIT_USAGE, main, runLifecycle, seedScreenTemplate,
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
    backendRecord: () => null,
    processIdentity: () => null,
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

test("status probes only the gatekeepers a --gatekeepers server recorded starting", async () => {
  const probed: string[] = [];
  const fetchImpl: typeof fetch = async input => {
    probed.push(new URL(String(input)).pathname);
    return new Response(null, { status: 200 });
  };
  const record = { ...ours(), gatekeepers: ["gatekeeper-inferops"] };
  const result = await runLifecycle(["status", "--json"],
    offlineDeps({ isPortListening: async () => true, devServerRecord: () => record, fetchImpl }));
  assert.equal(result.exitCode, EXIT_OK);
  assert.deepEqual(probed.toSorted(), ["/", "/api", "/gatekeeper/inferops"]);
});

test("status reports, rather than throws on, a recorded selection naming an unknown gatekeeper", async () => {
  const fetchImpl: typeof fetch = async () => new Response(null, { status: 200 });
  const record = { ...ours(), gatekeepers: ["gatekeeper-renamed-away"] };
  const result = await runLifecycle(["status", "--json"],
    offlineDeps({ isPortListening: async () => true, devServerRecord: () => record, fetchImpl }));
  assert.equal(result.exitCode, EXIT_FAILED);
  assert.match(String(result.report.selectionError), /Unknown gatekeeper gatekeeper-renamed-away/);
  assert.match(result.headline, /^degraded: The dev server's recorded gatekeeper selection is invalid/);
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

test("the CLI entry prints one JSON object with --json and exits with the command's code", async () => {
  // In process, against a fixture root: the spawned entry would read this checkout's own
  // `.env.worktree`, so in a `pnpm wt` worktree its ports would decide what the CLI reports.
  const root = tempRoot();
  try {
    const deps: LifecycleDeps = { ...defaultDeps, root, env: withWorktreeEnv(root, { VITE_BACKEND_HOST: "" }) };
    const run = async (argv: string[]) => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await main(argv, deps, { log: line => stdout.push(line), error: line => stderr.push(line) });
      return { exitCode, stdout, stderr };
    };
    const result = await run(["status", "--json", "--port", "1"]);
    assert.equal(result.exitCode, EXIT_FAILED);
    assert.equal(result.stdout.length, 1);
    const report = JSON.parse(result.stdout[0]!);
    assert.equal(report.listening, false);
    assert.equal(report.port, 1);
    const usage = await run(["--json"]);
    assert.equal(usage.exitCode, EXIT_USAGE);
    assert.match(usage.stderr.join("\n"), /Usage: pnpm local/);
    assert.equal(JSON.parse(usage.stdout.join("\n")).ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the CLI entry runs main and sets its exit code", () => {
  // Only a usage error goes through the real entry: it fails in argument parsing, so nothing it
  // prints depends on the environment or on this checkout's overlay.
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

// ---------------------------------------------------------------------------------------------
// The test InferOps backend (scripts/local/inferops.ts) through the lifecycle: `inferops <sub>`,
// `start --inferops`, mode-aware `seed`, `status`, `reset` and the shell output of `env`.

import { backendPaths, readBackendRecord, writeBackendRecord } from "./inferops.ts";

/** A root whose backend record says a backend of this checkout runs on `apiPort` (pid = this process, so it is alive). */
function withBackend(root: string, apiPort: number, { signIn = true, wiring }: { signIn?: boolean; wiring?: "sign-in" | "stopgap" } = {}): string {
  const checkout = join(root, ".inferops", "checkout-3dae0f50d5b4");
  mkdirSync(checkout, { recursive: true });
  if (signIn) {
    mkdirSync(join(checkout, "domain", "ts", "portal", "shared"), { recursive: true });
    writeFileSync(join(checkout, "domain", "ts", "portal", "shared", "reserved-tenants.ts"), "export const SSO_SIGN_IN_PERSONAS = [];\n");
  }
  writeBackendRecord(root, {
    pid: process.pid, port: apiPort, apiUrl: `http://localhost:${apiPort}`, inferosPort: apiPort - 10_000, database: `inferos_${apiPort - 10_000}`,
    checkout, revision: "3dae0f50d5b4fa467d734cbb2adf857f39942b31", dirty: false, managed: true, startedAt: "2026-11-01T00:00:00.000Z",
    log: backendPaths(root).log, ...(wiring ? { wiring } : {}),
  });
  return checkout;
}

/** Deps where only the backend's port answers (health 200, persona bearers) and the stack's port is free. */
function backendDeps(root: string, apiPort: number, overrides: Partial<LifecycleDeps> = {}) {
  const started: { env: NodeJS.ProcessEnv; passthrough: string[] }[] = [];
  const deps = offlineDeps({
    root,
    env: { PATH: "/bin", HOME: "/home/me" },
    backendRecord: readBackendRecord,
    processIdentity: () => `bun ${join(root, ".inferops", "checkout-3dae0f50d5b4")}/app/ts/shared-api/src/main.ts`,
    isPortListening: async port => port === apiPort,
    processAlive: () => true,
    fetchImpl: (async (input: string | URL | Request) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.pathname === "/health/ready") return new Response("{}", { status: 200 });
      if (url.pathname === "/auth/inferlab-login") return new Response(JSON.stringify({ token: "owner-token", user: { workspaces: [] } }), { status: 200 });
      if (url.pathname === "/workspaces") return new Response("[]", { status: 200 });
      return new Response("no", { status: 404 });
    }) as typeof fetch,
    startStack: async (_stack, passthrough, env) => { started.push({ env: env ?? {}, passthrough }); },
    ...overrides,
  });
  return { deps, started };
}

test("inferops is a two-word command whose flags apply to it alone", async () => {
  const usage = await runLifecycle(["inferops"], offlineDeps());
  assert.equal(usage.exitCode, EXIT_USAGE);
  assert.match(String(usage.report.error), /inferops needs one of: up, status, down, verify, env, logs/);
  assert.equal((await runLifecycle(["inferops", "bogus"], offlineDeps())).exitCode, EXIT_USAGE);
  for (const flag of ["--fresh", "--purge", "--dir", "--rev", "--allow-local-config", "--timeout"]) {
    const misplaced = await runLifecycle(["status", flag, ...(["--dir", "--rev", "--timeout"].includes(flag) ? ["x"] : [])], offlineDeps());
    assert.equal(misplaced.exitCode, EXIT_USAGE, flag);
  }
  assert.equal((await runLifecycle(["stop", "--stopgap"], offlineDeps())).exitCode, EXIT_USAGE);
  const root = tempRoot();
  try {
    const status = await runLifecycle(["inferops", "status", "--json", "--port", "8787"], offlineDeps({ root }));
    assert.equal(status.exitCode, EXIT_FAILED);
    assert.equal(status.report.command, "inferops status");
    assert.equal(status.report.backend, "not-running");
    assert.equal(status.report.apiUrl, "http://localhost:18787");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("start --inferops adopts the running backend and hands the stack the sign-in wiring, or the stopgap with --stopgap", async () => {
  const root = tempRoot();
  const { port, close } = await listen();
  await close();
  const apiPort = port + 10_000;
  withBackend(root, apiPort);
  try {
    const { deps, started } = backendDeps(root, apiPort);
    const signIn = await runLifecycle(["start", "--inferops", "--json", "--port", String(port), "--", "--no-ui-watchers"], deps);
    assert.equal(signIn.exitCode, EXIT_OK, JSON.stringify(signIn.report));
    assert.equal(started.length, 1);
    assert.deepEqual(started[0]!.passthrough, ["--no-ui-watchers"]);
    assert.equal(started[0]!.env.INFERLAB_AUTH_ORIGIN, `http://localhost:${apiPort}`);
    assert.equal(started[0]!.env.AUTH_GATEKEEPERS, "inferops");
    assert.equal(started[0]!.env.INFEROPS_ENABLED, "true");
    assert.equal(started[0]!.env.INFEROPS_BASE_URL, undefined);
    assert.equal(started[0]!.env.PATH, "/bin");
    assert.equal(readBackendRecord(root)?.wiring, "sign-in");
    assert.deepEqual(signIn.report.inferops, { apiUrl: `http://localhost:${apiPort}`, wiring: "sign-in", revision: "3dae0f50d5b4fa467d734cbb2adf857f39942b31" });
    const stopgap = await runLifecycle(["start", "--inferops", "--stopgap", "--json", "--port", String(port)], deps);
    assert.equal(stopgap.exitCode, EXIT_OK, JSON.stringify(stopgap.report));
    assert.equal(started[1]!.env.INFEROPS_API_TOKEN, "owner-token");
    assert.equal(started[1]!.env.INFEROPS_BASE_URL, `http://localhost:${apiPort}`);
    assert.equal(started[1]!.env.INFEROPS_WORKSPACE_SLUG, "operations");
    assert.equal(started[1]!.env.INFERLAB_AUTH_ORIGIN, undefined);
    assert.equal(readBackendRecord(root)?.wiring, "stopgap");
    assert.equal(JSON.stringify(stopgap.report).includes("owner-token"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("start --inferops refuses a shell already wired to InferOps, and sign-in against a revision without persona sign-in", async () => {
  const root = tempRoot();
  const { port, close } = await listen();
  await close();
  const apiPort = port + 10_000;
  try {
    withBackend(root, apiPort);
    const wired = backendDeps(root, apiPort, { env: { PATH: "/bin", INFEROPS_BASE_URL: "http://elsewhere:8080", INFEROPS_API_TOKEN: "t" } });
    const refused = await runLifecycle(["start", "--inferops", "--json", "--port", String(port)], wired.deps);
    assert.equal(refused.exitCode, EXIT_FAILED);
    assert.deepEqual(refused.report.wiring, ["INFEROPS_API_TOKEN", "INFEROPS_BASE_URL"]);
    assert.equal(wired.started.length, 0);
    rmSync(join(root, ".inferops"), { recursive: true, force: true });
    withBackend(root, apiPort, { signIn: false });
    const old = backendDeps(root, apiPort);
    const noSignIn = await runLifecycle(["start", "--inferops", "--json", "--port", String(port)], old.deps);
    assert.equal(noSignIn.exitCode, EXIT_FAILED);
    assert.match(String(noSignIn.report.error), /3cf153566|--stopgap/);
    assert.equal(old.started.length, 0);
    const stopgap = await runLifecycle(["start", "--inferops", "--stopgap", "--json", "--port", String(port)], old.deps);
    assert.equal(stopgap.exitCode, EXIT_OK, JSON.stringify(stopgap.report));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seed follows the wiring the stack was started with", async () => {
  const setupReport = { ok: true, url: "http://localhost:8787/", user: "dev" };
  const verifyReport = { ok: true, agentView: { inferops: "live", board: { project: "ENG", issues: 8, states: 5 }, approvalQueue: { pending: 0 } } };
  const run = async (root: string) => {
    const deps = offlineDeps({
      root, backendRecord: readBackendRecord, processIdentity: () => `bun ${join(root, ".inferops", "checkout-3dae0f50d5b4")}/app/ts/shared-api/src/main.ts`,
      isPortListening: async () => true, devServerRecord: () => ours(),
      runOperator: (script, args) => { deps.operatorCalls.push([script, ...args]); return { exitCode: 0, report: script === "dev-setup.ts" ? setupReport : verifyReport, stderr: "" }; },
    });
    const result = await runLifecycle(["seed", "--json"], deps);
    assert.equal(result.exitCode, EXIT_OK, JSON.stringify(result.report));
    return { result, calls: deps.operatorCalls };
  };
  const plain = tempRoot();
  const signIn = tempRoot();
  const stopgap = tempRoot();
  try {
    assert.ok((await run(plain)).calls[0]!.includes("--inferops"), "no backend: the mock InferOps account as before");
    withBackend(signIn, 18787, { wiring: "sign-in" });
    const s = await run(signIn);
    assert.ok(!s.calls[0]!.includes("--inferops"), "sign-in: no auto-provisioned account");
    assert.equal(s.result.report.inferops, "sign-in: no InferOps account is provisioned; sign in through the browser (Continue with InferOps)");
    withBackend(stopgap, 18787, { wiring: "stopgap" });
    const t = await run(stopgap);
    assert.ok(t.calls[0]!.includes("--inferops"));
    const verifyArgs = t.calls[1]!;
    assert.equal(verifyArgs[verifyArgs.indexOf("--board") + 1], "inferops://acme.operations/project/board/ENG");
  } finally {
    for (const root of [plain, signIn, stopgap]) rmSync(root, { recursive: true, force: true });
  }
});

test("status recognises the sign-in wiring and reports the backend row", async () => {
  assert.deepEqual(inferOpsConfiguration({ INFERLAB_AUTH_ORIGIN: "http://localhost:18787" }), { mode: "sign-in", host: "localhost:18787", missing: [] });
  assert.deepEqual(inferOpsConfiguration({ INFERLAB_AUTH_ORIGIN: "http://localhost:18787", INFEROPS_BASE_URL: "http://localhost:18787" }), { mode: "sign-in", host: "localhost:18787", missing: [] });
  const root = tempRoot();
  try {
    withBackend(root, 18787, { wiring: "sign-in" });
    const { deps } = backendDeps(root, 18787, { isPortListening: async () => true, devServerRecord: () => ours(), fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch });
    const result = await runLifecycle(["status", "--json"], deps);
    const inferops = result.report.inferops as Record<string, unknown>;
    assert.deepEqual(inferops.backend, { apiUrl: "http://localhost:18787", revision: "3dae0f50d5b4fa467d734cbb2adf857f39942b31", wiring: "sign-in", healthy: true });
    assert.equal(inferops.mode, "mock", "the shell itself carries no wiring; the record does");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the CLI prints env's export lines alone, so eval can take them", async () => {
  const root = tempRoot();
  try {
    withBackend(root, 18787);
    const { deps } = backendDeps(root, 18787);
    const stdout: string[] = [];
    const exitCode = await main(["inferops", "env", "--port", "8787"], deps, { log: line => stdout.push(line), error: () => {} });
    assert.equal(exitCode, EXIT_OK);
    assert.deepEqual(stdout, ["export INFERLAB_AUTH_ORIGIN='http://localhost:18787'\nexport AUTH_GATEKEEPERS='inferops'\nexport INFEROPS_ENABLED='true'"]);
    const json: string[] = [];
    await main(["inferops", "env", "--json", "--port", "8787"], deps, { log: line => json.push(line), error: () => {} });
    assert.equal(json.length, 1);
    assert.equal(JSON.parse(json[0]!).mode, "sign-in");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reset also clears a stopped backend's record and log, never a running one", async () => {
  const root = tempRoot();
  try {
    withBackend(root, 18787);
    mkdirSync(backendPaths(root).logsDir, { recursive: true });
    writeFileSync(backendPaths(root).log, "old\n");
    const running = await runLifecycle(["reset", "--yes", "--json"], offlineDeps({ root, backendRecord: readBackendRecord, processAlive: () => true, processIdentity: () => `bun ${join(root, ".inferops", "checkout-3dae0f50d5b4")}/app/ts/shared-api/src/main.ts` }));
    assert.equal(running.exitCode, EXIT_OK);
    assert.ok(existsSync(backendPaths(root).record), "a live backend keeps its record");
    const stopped = await runLifecycle(["reset", "--yes", "--json"], offlineDeps({ root, backendRecord: readBackendRecord, processAlive: () => false }));
    assert.equal(stopped.exitCode, EXIT_OK);
    assert.equal(existsSync(backendPaths(root).record), false);
    assert.equal(existsSync(backendPaths(root).log), false);
    assert.ok((stopped.report.removed as string[]).some(path => path.endsWith("backend.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a backend record on disk reaches status and seed only through deps.backendRecord", async () => {
  // A developer running `pnpm test` beside a live backend must not change what the offline suite sees.
  const root = tempRoot();
  try {
    withBackend(root, 18787, { wiring: "sign-in" });
    const blind = offlineDeps({ root, backendRecord: () => null, isPortListening: async () => true, devServerRecord: () => ours(),
      processIdentity: () => `bun ${join(root, ".inferops", "checkout-3dae0f50d5b4")}/app/ts/shared-api/src/main.ts`,
      fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch,
      runOperator: (script, args) => { blind.operatorCalls.push([script, ...args]); return { exitCode: 0, report: { ok: true }, stderr: "" }; } });
    const status = await runLifecycle(["status", "--json"], blind);
    assert.deepEqual(status.report.inferops, { mode: "mock", missing: [] });
    await runLifecycle(["seed", "--json"], blind);
    assert.ok(blind.operatorCalls[0]!.includes("--inferops"));
    const seeing = offlineDeps({ root, backendRecord: readBackendRecord, isPortListening: async () => true, devServerRecord: () => ours(),
      processIdentity: () => `bun ${join(root, ".inferops", "checkout-3dae0f50d5b4")}/app/ts/shared-api/src/main.ts`,
      fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch });
    const row = (await runLifecycle(["status", "--json"], seeing)).report.inferops as Record<string, unknown>;
    assert.equal((row.backend as Record<string, unknown>).wiring, "sign-in");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("the wiring is cleared by stop and by a plain start, and seed falls back to the shell's own wiring", async () => {
  const root = tempRoot();
  const { port, close } = await listen();
  try {
    recordDevServer(root, { port, mode: "run-local" });
    withBackend(root, port + 10_000, { wiring: "sign-in" });
    const identity = () => `bun ${join(root, ".inferops", "checkout-3dae0f50d5b4")}/app/ts/shared-api/src/main.ts`;
    const stopDeps = offlineDeps({ root, backendRecord: readBackendRecord, processIdentity: identity, isPortListening: async () => true,
      signal: () => {}, processAlive: () => false });
    const stopped = await runLifecycle(["stop", "--json", "--port", String(port)], stopDeps);
    assert.equal(stopped.exitCode, EXIT_OK, JSON.stringify(stopped.report));
    assert.equal(readBackendRecord(root)?.wiring, undefined, "stop forgets how the stack was wired");
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
  const root2 = tempRoot();
  const free = await listen();
  await free.close();
  try {
    withBackend(root2, free.port + 10_000, { wiring: "stopgap" });
    const plain = backendDeps(root2, free.port + 10_000);
    const started = await runLifecycle(["start", "--json", "--port", String(free.port)], plain.deps);
    assert.equal(started.exitCode, EXIT_OK, JSON.stringify(started.report));
    assert.equal(readBackendRecord(root2)?.wiring, undefined, "a plain start is a mock stack again");
  } finally {
    rmSync(root2, { recursive: true, force: true });
  }
  // No recorded wiring: the shell's own INFERLAB_AUTH_ORIGIN or stopgap variables decide what seed does.
  const run = async (env: NodeJS.ProcessEnv) => {
    const root3 = tempRoot();
    try {
      const deps = offlineDeps({ root: root3, env, isPortListening: async () => true, devServerRecord: () => ours(),
        runOperator: (script, args) => { deps.operatorCalls.push([script, ...args]); return { exitCode: 0, report: { ok: true }, stderr: "" }; } });
      await runLifecycle(["seed", "--json"], deps);
      return deps.operatorCalls;
    } finally {
      rmSync(root3, { recursive: true, force: true });
    }
  };
  const signIn = await run({ INFERLAB_AUTH_ORIGIN: "http://localhost:18787" });
  assert.ok(!signIn[0]!.includes("--inferops"));
  const stopgap = await run({ INFEROPS_BASE_URL: "http://localhost:18787", INFEROPS_API_TOKEN: "t", INFEROPS_WORKSPACE_ID: "w", INFEROPS_WORKSPACE_SLUG: "operations" });
  assert.ok(stopgap[0]!.includes("--inferops"));
  assert.equal(stopgap[1]![stopgap[1]!.indexOf("--board") + 1], "inferops://acme.operations/project/board/ENG");
});

test("start --stopgap without --inferops is a usage error", async () => {
  const result = await runLifecycle(["start", "--stopgap"], offlineDeps());
  assert.equal(result.exitCode, EXIT_USAGE);
  assert.match(String(result.report.error), /--stopgap/);
});
