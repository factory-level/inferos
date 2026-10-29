import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ProcessResult } from "./coding.ts";
import { forbiddenCredentials, inferopsChildEnv, inferopsConnectEnv, inferopsSsoLayer, runFactory, stateFile, VERIFY_IMAGES, type FactoryDeps } from "./factory.ts";
import { runLifecycle, defaultDeps } from "./lifecycle.ts";
import type { DevServerRecord } from "./stack.ts";

/** A fake machine: which ports answer, which URLs return what, which processes live. */
function fakeDeps(root: string, opts: {
  env?: NodeJS.ProcessEnv;
  answers?: Record<string, number>;
  listening?: number[];
  record?: DevServerRecord | null;
  docker?: (argv: string[]) => ProcessResult;
  alive?: (pid: number) => boolean;
  runIn?: (argv: string[]) => ProcessResult;
} = {}) {
  const launches: { argv: string[]; env: Record<string, string>; cwd: string }[] = [];
  const signals: [number, NodeJS.Signals][] = [];
  const dockerCalls: string[][] = [];
  const runInCalls: { argv: string[]; env: Record<string, string>; cwd: string }[] = [];
  let clock = 0;
  const deps: FactoryDeps = {
    root,
    env: opts.env ?? { PATH: "/usr/bin" },
    isPortListening: async port => (opts.listening ?? []).includes(port),
    devServerRecord: () => opts.record ?? null,
    fetchImpl: (async (input: string | URL) => {
      const url = new URL(String(input));
      const key = `${url.port}${url.pathname}`;
      const status = opts.answers?.[key] ?? opts.answers?.[url.port];
      if (status === undefined) throw new Error("connection refused");
      return new Response(JSON.stringify({ path: url.pathname }), { status });
    }) as typeof fetch,
    runCli: argv => {
      dockerCalls.push(argv);
      return opts.docker?.(argv) ?? { exitCode: 0, stdout: "27.0.0\n", stderr: "" };
    },
    runIn: (argv, env, cwd) => {
      runInCalls.push({ argv, env, cwd });
      return opts.runIn?.(argv) ?? { exitCode: 0, stdout: "", stderr: "" };
    },
    launch: (argv, env, _log, cwd) => {
      launches.push({ argv, env, cwd });
      return 4242 + launches.length;
    },
    signal: (pid, signal) => { signals.push([pid, signal]); },
    processAlive: pid => opts.alive?.(pid) ?? false,
    sleep: async ms => { clock += ms; },
    now: () => clock,
  };
  return { deps, launches, signals, dockerCalls, runInCalls };
}

/** A checkout with a (fake) installed wrangler, which `infra` and `verify` check for. */
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "inferos-factory-"));
  mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(root, "node_modules", ".bin", "wrangler"), "");
  return root;
}

function inferopsCheckout(): string {
  const dir = mkdtempSync(join(tmpdir(), "inferops-"));
  mkdirSync(join(dir, "scripts"));
  writeFileSync(join(dir, "scripts", "dev.mjs"), "");
  mkdirSync(join(dir, "db"));
  writeFileSync(join(dir, "db", "init-db.sql"), "");
  return dir;
}

const IMAGE = `127.0.0.1:5600/services/inferlab@sha256:${"a".repeat(64)}`;

const ours: DevServerRecord = { pid: 777, port: 8787, mode: "run-local", startedAt: "2026-10-28T00:00:00.000Z" };

test("usage errors exit 2", async () => {
  const root = tempRoot();
  try {
    for (const argv of [[], ["bogus"], ["up"], ["up", "prod"], ["doctor", "dev", "extra"], ["up", "dev", "--timeout", "soon"]]) {
      const result = await runFactory(argv, fakeDeps(root).deps);
      assert.equal(result.exitCode, 2, argv.join(" "));
      assert.match(String(result.report.error), /dev, infra, verify, stage-probe/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("credentials are detected by name: provider keys via runner.ts, cloud keys, smoke keys outside stage-probe", () => {
  const env = { OPENAI_API_KEY: "sk-x", AWS_SECRET_ACCESS_KEY: "y", CLOUDFLARE_API_TOKEN: "z", CF_ACCESS_CLIENT_SECRET: "s", PATH: "/bin", INFEROPS_API_KEY: "ok", EMPTY_API_KEY: "" };
  assert.deepEqual(forbiddenCredentials(env, "dev"), ["AWS_SECRET_ACCESS_KEY", "CF_ACCESS_CLIENT_SECRET", "CLOUDFLARE_API_TOKEN", "OPENAI_API_KEY"]);
  assert.deepEqual(forbiddenCredentials(env, "stage-probe"), ["AWS_SECRET_ACCESS_KEY", "CLOUDFLARE_API_TOKEN", "OPENAI_API_KEY"]);
});

test("doctor FAILS on a credential and never prints its value", async () => {
  const root = tempRoot();
  try {
    const { deps } = fakeDeps(root, { env: { PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant-secret-value" }, listening: [8787], record: ours, answers: { 8787: 200, 8080: 200 } });
    const result = await runFactory(["doctor", "dev", "--json"], deps);
    assert.equal(result.exitCode, 1);
    const text = JSON.stringify(result.report) + result.headline;
    assert.ok(!text.includes("sk-ant-secret-value"));
    const checks = result.report.checks as { name: string; status: string; detail: string }[];
    assert.equal(checks.find(c => c.name === "credentials")?.status, "FAIL");
    assert.match(checks.find(c => c.name === "credentials")!.detail, /ANTHROPIC_API_KEY/);
    assert.match(result.headline, /FAIL\s+credentials/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("up refuses with a credential present, before launching anything", async () => {
  const root = tempRoot();
  try {
    const fake = fakeDeps(root, { env: { PATH: "/bin", GOOGLE_APPLICATION_CREDENTIALS: "/k.json" } });
    const result = await runFactory(["up", "dev"], fake.deps);
    assert.equal(result.exitCode, 1);
    assert.equal(fake.launches.length, 0);
    assert.equal(existsSync(stateFile(root)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor dev is READY when both services answer, with health JSON per service", async () => {
  const root = tempRoot();
  try {
    const { deps } = fakeDeps(root, { listening: [8787], record: ours, answers: { 8787: 200, "8080/health/ready": 200 } });
    const result = await runFactory(["doctor", "dev", "--json"], deps);
    assert.equal(result.exitCode, 0, result.headline);
    const checks = result.report.checks as { name: string; status: string; health?: { status?: number; workers?: unknown[] } }[];
    assert.deepEqual(checks.map(c => [c.name, c.status]), [["credentials", "READY"], ["service:inferos", "READY"], ["service:inferops", "READY"]]);
    assert.ok(Array.isArray(checks[1]!.health?.workers));
    assert.equal(checks[2]!.health?.status, 200);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an InferOps that does not answer is an honest FAIL naming the missing checkout", async () => {
  const root = tempRoot();
  try {
    const { deps } = fakeDeps(root, { listening: [8787], record: ours, answers: { 8787: 200 } });
    const result = await runFactory(["doctor", "dev"], deps);
    assert.equal(result.exitCode, 1);
    assert.match(result.headline, /FAIL\s+service:inferops: http:\/\/127\.0\.0\.1:8080\/health\/ready did not answer; no InferOps checkout configured/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a foreign listener on the InferOS port is never adopted or probed as the stack", async () => {
  const root = tempRoot();
  try {
    const fake = fakeDeps(root, { listening: [8787], record: null, answers: { 8787: 200, "8080/health/ready": 200 } });
    const result = await runFactory(["up", "dev", "--timeout", "0"], fake.deps);
    assert.equal(result.exitCode, 1);
    assert.equal(fake.launches.length, 0);
    assert.match(result.headline, /port 8787 is in use by a process this checkout did not start/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("up dev launches run-local here and bun in the InferOps checkout, each with its own toolchain", async () => {
  const root = tempRoot();
  const inferops = inferopsCheckout();
  try {
    const fake = fakeDeps(root, {
      env: { PATH: "/bin", npm_config_user_agent: "pnpm/11", PNPM_HOME: "/p", HOME: "/h" },
      answers: {}, alive: () => true,
    });
    // Each service answers once the factory launched it.
    const launchedBy = (tool: string) => fake.launches.some(l => l.argv[0] === tool || l.argv[0] === process.execPath && tool === "node");
    fake.deps.isPortListening = async () => launchedBy("node");
    fake.deps.devServerRecord = () => launchedBy("node") ? ours : null;
    fake.deps.fetchImpl = (async (input: string | URL) => {
      const port = new URL(String(input)).port;
      if (port === "8787" && launchedBy("node") || port === "8080" && launchedBy("bun")) return new Response("{}", { status: 200 });
      throw new Error("connection refused");
    }) as typeof fetch;
    const result = await runFactory(["up", "dev", "--inferops-dir", inferops], fake.deps);
    assert.equal(result.exitCode, 0, result.headline);
    assert.equal(fake.launches.length, 2);
    const [inferos, ops] = fake.launches;
    assert.match(inferos!.argv.join(" "), /scripts\/run-local\.ts --port 8787$/);
    assert.equal(inferos!.cwd, root);
    assert.deepEqual(ops!.argv, ["bun", "run", "dev", "up", "--docker", "--seed"]);
    assert.equal(ops!.cwd, inferops);
    assert.equal(ops!.env.npm_config_user_agent, undefined);
    assert.equal(ops!.env.PNPM_HOME, undefined);
    assert.equal(ops!.env.HOME, "/h");
    assert.ok(existsSync(stateFile(root)));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(inferops, { recursive: true, force: true });
  }
});

test("up stops waiting when a launched service dies, and reports its log", async () => {
  const root = tempRoot();
  const inferops = inferopsCheckout();
  try {
    const fake = fakeDeps(root, { listening: [8787], record: ours, answers: { 8787: 200 }, alive: () => false });
    const result = await runFactory(["up", "dev", "--inferops-dir", inferops], fake.deps);
    assert.equal(result.exitCode, 1);
    assert.match(result.headline, /inferops: pid \d+ exited; see .*inferops\.log/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(inferops, { recursive: true, force: true });
  }
});

test("infra reuses a floci already answering, and down leaves it running", async () => {
  const root = tempRoot();
  try {
    const fake = fakeDeps(root, { listening: [8787], record: ours, answers: { 8787: 200, "8080/health/ready": 200, "4588/health": 200 } });
    const result = await runFactory(["up", "infra"], fake.deps);
    assert.equal(result.exitCode, 0, result.headline);
    assert.ok(!fake.dockerCalls.some(argv => argv[1] === "run"));
    const stopped = await runFactory(["down"], fake.deps);
    assert.deepEqual(stopped.report.stopped, []);
    assert.deepEqual((stopped.report.leftRunning as string[]).toSorted(), ["floci", "inferops", "inferos"]);
    assert.equal(fake.signals.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("infra starts floci on loopback when none answers, and down removes only that container", async () => {
  const root = tempRoot();
  try {
    let flociUp = false;
    const fake = fakeDeps(root, {
      env: { PATH: "/bin", FACTORY_FLOCI_PORT: "14588" }, listening: [8787], record: ours, answers: { 8787: 200, "8080/health/ready": 200 },
      docker: argv => { if (argv[1] === "run") flociUp = true; return { exitCode: 0, stdout: "", stderr: "" }; },
    });
    const fetchImpl = fake.deps.fetchImpl;
    fake.deps.fetchImpl = (async (input: string | URL, init?: RequestInit) =>
      flociUp && String(input).includes(":14588/") ? new Response("{}", { status: 200 }) : fetchImpl(input, init)) as typeof fetch;
    const result = await runFactory(["up", "infra"], fake.deps);
    assert.equal(result.exitCode, 0, result.headline);
    const run = fake.dockerCalls.find(argv => argv[1] === "run")!;
    assert.ok(run.includes("127.0.0.1:14588:4588"));
    assert.ok(!run.join(" ").includes("docker.sock"));
    const stopped = await runFactory(["down", "--json"], fake.deps);
    assert.deepEqual(stopped.report.stopped, ["floci"]);
    assert.ok(fake.dockerCalls.some(argv => argv.join(" ") === "docker rm -f inferos-factory-floci"));
    assert.equal(existsSync(stateFile(root)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("down signals the process group the factory launched and waits for it", async () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, ".factory"));
    writeFileSync(stateFile(root), JSON.stringify({ sandbox: "dev", startedAt: "x", services: { inferos: { pid: 900, startedByFactory: true } } }));
    let alive = true;
    const fake = fakeDeps(root, { alive: () => alive });
    fake.deps.signal = (pid, signal) => { fake.signals.push([pid, signal]); alive = false; };
    const result = await runFactory(["down"], fake.deps);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(fake.signals, [[-900, "SIGTERM"]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("down never signals a recorded process that already exited", async () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, ".factory"));
    writeFileSync(stateFile(root), JSON.stringify({ sandbox: "dev", startedAt: "x", services: { inferops: { pid: 901, startedByFactory: true } } }));
    const fake = fakeDeps(root, { alive: () => false });
    const result = await runFactory(["down"], fake.deps);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(fake.signals, []);
    assert.deepEqual(result.report.alreadyExited, ["inferops"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verify checks every tool image; a missing one is FAIL with the pull command", async () => {
  const root = tempRoot();
  try {
    const { deps } = fakeDeps(root, {
      listening: [8787], record: ours, answers: { 8787: 200, "8080/health/ready": 200 },
      docker: argv => ({ exitCode: argv.includes("aquasec/trivy:latest") ? 1 : 0, stdout: "", stderr: "" }),
    });
    const result = await runFactory(["doctor", "verify"], deps);
    assert.equal(result.exitCode, 1);
    const checks = result.report.checks as { name: string; status: string; detail: string }[];
    for (const image of VERIFY_IMAGES) assert.ok(checks.some(c => c.name === `tool:${image}`), image);
    assert.equal(checks.find(c => c.name === "tool:aquasec/trivy:latest")?.detail, "docker pull aquasec/trivy:latest");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stage-probe runs nothing and checks the smoke credentials by name only", async () => {
  const root = tempRoot();
  try {
    const missing = await runFactory(["doctor", "stage-probe"], fakeDeps(root, { env: { PATH: "/bin", CF_ACCESS_CLIENT_ID: "id-value-123" } }).deps);
    assert.equal(missing.exitCode, 1);
    assert.match(missing.headline, /FAIL\s+smoke-credentials: missing \(names only\): CF_ACCESS_CLIENT_SECRET, GROKBOT_PERSONA_USER, GROKBOT_PERSONA_PASSWORD/);
    const env = { PATH: "/bin", CF_ACCESS_CLIENT_ID: "id-value-123", CF_ACCESS_CLIENT_SECRET: "secret-value-456", GROKBOT_PERSONA_USER: "u", GROKBOT_PERSONA_PASSWORD: "pw-value-789" };
    const fake = fakeDeps(root, { env });
    const ready = await runFactory(["up", "stage-probe", "--json"], fake.deps);
    assert.equal(ready.exitCode, 0, ready.headline);
    assert.equal(fake.launches.length, 0);
    assert.equal(fake.dockerCalls.length, 0);
    const text = JSON.stringify(ready.report) + ready.headline;
    for (const value of Object.values(env).filter(v => v.includes("value"))) assert.ok(!text.includes(value));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pnpm local routes factory through lifecycle.ts with --json", async () => {
  const root = tempRoot();
  try {
    const result = await runLifecycle(["factory", "status", "--json"], { ...defaultDeps, root, env: {} });
    assert.equal(result.json, true);
    assert.equal(result.exitCode, 1);
    assert.match(String(result.report.error), /no sandbox is up/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the InferOps child loses pnpm's script environment", () => {
  assert.deepEqual(inferopsChildEnv({ PATH: "/b", npm_lifecycle_event: "local", INIT_CWD: "/x", NODE_OPTIONS: "--x", HOME: "/h" }), { PATH: "/b", HOME: "/h" });
});

test("image mode: migrate + seed in the InferOps checkout on its own database, then the image on loopback without KMS", async () => {
  const root = tempRoot();
  const inferops = inferopsCheckout();
  try {
    let apiUp = false;
    const fake = fakeDeps(root, {
      env: { PATH: "/bin", HOME: "/h", FACTORY_INFEROPS_OFFSET: "7", npm_config_user_agent: "pnpm/11" }, listening: [8787], record: ours, answers: { 8787: 200 },
      docker: argv => {
        if (argv[1] === "run") apiUp = true;
        return { exitCode: 0, stdout: argv[1] === "inspect" ? "true\n" : "", stderr: "" };
      },
    });
    const fetchImpl = fake.deps.fetchImpl;
    fake.deps.fetchImpl = (async (input: string | URL, init?: RequestInit) =>
      apiUp && String(input).includes(":8780/health/ready") ? new Response(JSON.stringify({ status: "ok", checks: [{ name: "postgres", status: "ok" }] }), { status: 200 }) : fetchImpl(input, init)) as typeof fetch;
    const result = await runFactory(["up", "dev", "--inferops-dir", inferops, "--inferops-image", IMAGE], fake.deps);
    assert.equal(result.exitCode, 0, result.headline);
    assert.equal(fake.launches.length, 0, "no bun run dev up and no run-local (adopted)");
    assert.deepEqual(fake.runInCalls.map(c => c.argv.slice(0, 4).join(" ")), [
      "psql postgres://postgres:postgres@localhost:5432/postgres -v ON_ERROR_STOP=1",
      "psql postgres://postgres:postgres@localhost:5432/postgres -v ON_ERROR_STOP=1",
      "psql postgres://postgres:postgres@localhost:5432/inferos_factory?sslmode=disable -v ON_ERROR_STOP=1",
      "bunx turbo run migrate", "bunx turbo run seed", "bunx turbo run seed:reserved",
    ]);
    assert.match(fake.runInCalls[0]!.argv.at(-1)!, /^DROP DATABASE IF EXISTS inferos_factory WITH \(FORCE\)$/);
    for (const call of fake.runInCalls) {
      assert.equal(call.cwd, inferops);
      assert.equal(call.env.DATABASE_URL, "postgres://postgres:postgres@localhost:5432/inferos_factory?sslmode=disable");
      assert.equal(call.env.npm_config_user_agent, undefined);
    }
    const run = fake.dockerCalls.find(argv => argv[1] === "run")!;
    assert.equal(run.at(-1), IMAGE);
    assert.ok(run.includes("127.0.0.1:8780:8080"));
    assert.ok(run.includes("NODE_CONFIG_ENV=factory"));
    assert.ok(run.includes("DATABASE_URL=postgres://postgres:postgres@host.docker.internal:5432/inferos_factory?sslmode=disable"));
    assert.ok(!run.includes("-v") && !run.join(" ").includes("docker.sock") && !run.join(" ").includes("GOOGLE_APPLICATION_CREDENTIALS"));
    const stopped = await runFactory(["down", "--json"], fake.deps);
    assert.deepEqual(stopped.report.stopped, ["inferops"]);
    assert.deepEqual(stopped.report.leftRunning, ["inferos"]);
    assert.ok(fake.dockerCalls.some(argv => argv.join(" ") === "docker rm -f inferos-factory-inferops"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(inferops, { recursive: true, force: true });
  }
});

test("image mode needs the InferOps checkout for migrations, and a failed migrate never runs the image", async () => {
  const root = tempRoot();
  const inferops = inferopsCheckout();
  try {
    const bare = fakeDeps(root, { env: { PATH: "/bin", FACTORY_INFEROPS_IMAGE: IMAGE }, listening: [8787], record: ours, answers: { 8787: 200 } });
    const noDir = await runFactory(["up", "dev", "--timeout", "0"], bare.deps);
    assert.equal(noDir.exitCode, 1);
    assert.match(noDir.headline, /image mode needs --inferops-dir/);
    assert.equal(bare.runInCalls.length, 0);
    rmSync(stateFile(root), { force: true });
    const failing = fakeDeps(root, {
      env: { PATH: "/bin" }, listening: [8787], record: ours, answers: { 8787: 200 },
      runIn: argv => ({ exitCode: argv.includes("migrate") ? 3 : 0, stdout: "", stderr: "boom" }),
    });
    const result = await runFactory(["up", "dev", "--inferops-dir", inferops, "--inferops-image", IMAGE, "--timeout", "0"], failing.deps);
    assert.equal(result.exitCode, 1);
    assert.match(result.headline, /inferops: migrate exited 3/);
    assert.ok(!failing.dockerCalls.some(argv => argv[1] === "run"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(inferops, { recursive: true, force: true });
  }
});

test("an image reference that is not one is a usage error", async () => {
  const root = tempRoot();
  try {
    for (const bad of ["--privileged", "img; rm -rf /", "a b"]) {
      const result = await runFactory(["doctor", "dev", `--inferops-image=${bad}`], fakeDeps(root).deps);
      assert.equal(result.exitCode, 2, bad);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/health/ready answering 200 with a non-ready body is a FAIL", async () => {
  const root = tempRoot();
  try {
    const fake = fakeDeps(root, { listening: [8787], record: ours, answers: { 8787: 200 } });
    const fetchImpl = fake.deps.fetchImpl;
    fake.deps.fetchImpl = (async (input: string | URL, init?: RequestInit) =>
      String(input).includes(":8080/health/ready") ? new Response(JSON.stringify({ status: "degraded" }), { status: 200 }) : fetchImpl(input, init)) as typeof fetch;
    const result = await runFactory(["doctor", "dev"], fake.deps);
    assert.equal(result.exitCode, 1);
    assert.match(result.headline, /FAIL\s+service:inferops: .*answered 200 but not ready/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--inferops-connect starts run-local against the sandbox's InferOps with InferLab sign-in and no token", async () => {
  const root = tempRoot();
  const inferops = inferopsCheckout();
  try {
    const fake = fakeDeps(root, {
      env: { PATH: "/bin", FACTORY_INFEROPS_OFFSET: "9", AUTH_GATEKEEPERS: "cloudflare" },
      alive: () => true,
    });
    const launched = () => fake.launches.length > 0;
    fake.deps.isPortListening = async () => launched();
    fake.deps.devServerRecord = () => launched() ? ours : null;
    fake.deps.fetchImpl = (async (input: string | URL) => {
      const port = new URL(String(input)).port;
      if (port === "8787" && launched() || port === "8980") return new Response("{}", { status: 200 });
      throw new Error("connection refused");
    }) as typeof fetch;
    const result = await runFactory(["up", "dev", "--inferops-dir", inferops, "--inferops-connect", "--json"], fake.deps);
    assert.equal(result.exitCode, 0, result.headline);
    const [inferos] = fake.launches;
    assert.equal(inferos!.env.INFERLAB_AUTH_ORIGIN, "http://127.0.0.1:8980");
    assert.equal(inferos!.env.INFEROPS_BASE_URL, "http://127.0.0.1:8980");
    assert.equal(inferos!.env.AUTH_GATEKEEPERS, "cloudflare,inferops");
    assert.equal(inferos!.env.INFEROPS_API_TOKEN, undefined);
    const services = result.report.services as Record<string, { inferops?: string; inferopsUrl?: string }>;
    assert.equal(services.inferos?.inferops, "connected");
    assert.equal(services.inferos?.inferopsUrl, "http://127.0.0.1:8980");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(inferops, { recursive: true, force: true });
  }
});

test("without --inferops-connect run-local keeps the mock and gets no InferLab origin", async () => {
  const root = tempRoot();
  try {
    const fake = fakeDeps(root, { env: { PATH: "/bin" }, alive: () => false });
    await runFactory(["up", "dev"], fake.deps);
    const [inferos] = fake.launches;
    assert.equal(inferos!.env.INFERLAB_AUTH_ORIGIN, undefined);
    assert.equal(inferos!.env.INFEROPS_BASE_URL, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--inferops-connect refuses a non-loopback InferOps, other commands, and cannot rewire an adopted InferOS", async () => {
  const root = tempRoot();
  try {
    const remote = await runFactory(["up", "dev", "--inferops-connect"], fakeDeps(root, { env: { PATH: "/bin", FACTORY_INFEROPS_URL: "https://api.dev.inferlab.io" } }).deps);
    assert.equal(remote.exitCode, 2);
    assert.match(String(remote.report.error), /loopback/);
    const doctor = await runFactory(["doctor", "dev", "--inferops-connect"], fakeDeps(root).deps);
    assert.equal(doctor.exitCode, 2);
    const fake = fakeDeps(root, { env: { PATH: "/bin" }, listening: [8787], record: ours, answers: { 8787: 200, 8080: 200 } });
    const adopted = await runFactory(["up", "dev", "--inferops-connect", "--json"], fake.deps);
    assert.equal(fake.launches.length, 0);
    assert.match(JSON.stringify(adopted.report.problems), /cannot rewire/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inferopsConnectEnv keeps an existing inferops vendor once", () => {
  assert.deepEqual(inferopsConnectEnv("http://localhost:8080/", { AUTH_GATEKEEPERS: "inferops" }),
    { INFERLAB_AUTH_ORIGIN: "http://localhost:8080", INFEROPS_BASE_URL: "http://localhost:8080", AUTH_GATEKEEPERS: "inferops" });
});

test("image mode with --inferops-connect registers this InferOS's origin with InferOps' central auth", async () => {
  const root = tempRoot();
  const inferops = inferopsCheckout();
  try {
    const fake = fakeDeps(root, { env: { PATH: "/bin", VITE_BACKEND_HOST: "localhost:8797" }, alive: () => false });
    await runFactory(["up", "dev", "--inferops-dir", inferops, "--inferops-image", IMAGE, "--inferops-connect", "--timeout", "0"], fake.deps);
    const run = fake.dockerCalls.find(argv => argv[0] === "docker" && argv[1] === "run")!;
    assert.ok(run.includes(`NODE_CONFIG=${inferopsSsoLayer("http://localhost:8797")}`), run.join(" "));
    assert.deepEqual(JSON.parse(inferopsSsoLayer("http://localhost:8797/x")), { auth: { sso: { inferosOrigins: ["http://localhost:8797"] } } });
    assert.ok(!run.some(arg => /docker\.sock/.test(arg)));
    const plain = fakeDeps(root, { env: { PATH: "/bin" }, alive: () => false });
    rmSync(stateFile(root), { force: true });
    await runFactory(["up", "dev", "--inferops-dir", inferops, "--inferops-image", IMAGE, "--timeout", "0"], plain.deps);
    assert.ok(!plain.dockerCalls.find(argv => argv[1] === "run")!.some(arg => arg.startsWith("NODE_CONFIG=")));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(inferops, { recursive: true, force: true });
  }
});

test("a second up keeps the InferOps container an earlier up started, so down still removes it", async () => {
  const root = tempRoot();
  const inferops = inferopsCheckout();
  try {
    let started = false;
    const fake = fakeDeps(root, {
      env: { PATH: "/bin" }, alive: () => true, listening: [8787], record: ours,
      docker: argv => { if (argv[1] === "run") started = true; return { exitCode: 0, stdout: "true\n", stderr: "" }; },
    });
    fake.deps.fetchImpl = (async (input: string | URL) => {
      const port = new URL(String(input)).port;
      if (port === "8787" || port === "8080" && started) return new Response("{}", { status: 200 });
      throw new Error("connection refused");
    }) as typeof fetch;
    await runFactory(["up", "dev", "--inferops-dir", inferops, "--inferops-image", IMAGE], fake.deps);
    const again = await runFactory(["up", "dev", "--inferops-dir", inferops, "--inferops-image", IMAGE, "--json"], fake.deps);
    assert.equal(fake.dockerCalls.filter(argv => argv[1] === "run").length, 1);
    const services = again.report.services as Record<string, { container?: string; startedByFactory: boolean }>;
    assert.equal(services.inferops?.container, "inferos-factory-inferops");
    assert.equal(services.inferops?.startedByFactory, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(inferops, { recursive: true, force: true });
  }
});
