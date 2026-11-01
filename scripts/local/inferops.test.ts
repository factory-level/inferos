import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  apiEntrypoint, backendChildEnv, backendDatabase, backendPaths, backendPorts, existingWiring, forbiddenCredentials,
  initDbPath, migrationCommands, pinnedRevision, readBackendRecord, signInSupported, ssoLayer, wiringEnv, writeBackendRecord,
  type BackendRecord,
} from "./inferops.ts";

/** A throwaway InferOps checkout in either layout: the pinned (post-rename) tree or the old one. */
function fixtureCheckout(layout: "new" | "old", { signIn = layout === "new" }: { signIn?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), `inferops-${layout}-`));
  const api = layout === "new" ? "app/ts/shared-api" : "apps/_shared-api";
  const packages = layout === "new" ? ["domain/ts/*", api, "migration"] : ["domains/*", api, "migration"];
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "inferlab", workspaces: { packages } }));
  mkdirSync(join(root, api, "src"), { recursive: true });
  writeFileSync(join(root, api, "package.json"), JSON.stringify({ name: "@inferlab/shared-api" }));
  writeFileSync(join(root, api, "src", "main.ts"), "");
  const initDb = layout === "new" ? "docker/postgres/init-db.sql" : "db/init-db.sql";
  mkdirSync(join(root, initDb, ".."), { recursive: true });
  writeFileSync(join(root, initDb), "-- init");
  mkdirSync(join(root, "migration"), { recursive: true });
  writeFileSync(join(root, "migration", "package.json"), JSON.stringify({
    name: "@inferlab/migration",
    scripts: { migrate: "bun run src/cli/migrate.ts", seed: "bun run src/cli/seed.ts", "seed:reserved": "bun run src/cli/seed-reserved.ts" },
  }));
  if (signIn) {
    const shared = layout === "new" ? "domain/ts/portal/shared" : "domains/portal/shared";
    mkdirSync(join(root, shared), { recursive: true });
    writeFileSync(join(root, shared, "reserved-tenants.ts"), "export const SSO_SIGN_IN_PERSONAS = [];\n");
  }
  return root;
}

test("the backend's ports and database follow the InferOS stack port", () => {
  assert.deepEqual(backendPorts(8787), { inferosPort: 8787, inferosOrigin: "http://localhost:8787", apiPort: 18787, apiUrl: "http://localhost:18787" });
  assert.equal(backendPorts(8797).apiPort, 18797);
  assert.equal(backendDatabase(8787), "inferos_8787");
  assert.equal(backendDatabase(8810), "inferos_8810");
});

test("the child environment drops pnpm, turbo-global and credential names and pins the factory cascade", () => {
  const env = {
    PATH: "/bin", HOME: "/home/me", LANG: "C", npm_config_user_agent: "pnpm", PNPM_HOME: "/p", pnpm_config_x: "1", INIT_CWD: "/x", NODE_OPTIONS: "--x",
    NODE_ENV: "production", AUTH_MODE: "oauth", WORKTREE_OFFSET: "7", API_PORT: "1", DATABASE_URL: "postgres://other", NODE_CONFIG_DIR: "/c",
    NODE_CONFIG: "{}", NODE_CONFIG_ENV: "development", GCP_KMS_KEY: "k", GOOGLE_APPLICATION_CREDENTIALS: "/creds.json", UNDEFINED: undefined,
  };
  const child = backendChildEnv(env, { DATABASE_URL: "postgres://postgres:postgres@localhost:5432/inferos_8787?sslmode=disable" });
  assert.deepEqual(child, {
    PATH: "/bin", HOME: "/home/me", LANG: "C",
    NODE_CONFIG_ENV: "factory", SUPPRESS_NO_CONFIG_WARNING: "1",
    DATABASE_URL: "postgres://postgres:postgres@localhost:5432/inferos_8787?sslmode=disable",
  });
});

test("the SSO layer registers exactly the InferOS origin", () => {
  assert.equal(ssoLayer("http://localhost:8787"), JSON.stringify({ auth: { sso: { inferosOrigins: ["http://localhost:8787"] } } }));
});

test("the API entrypoint, init-db.sql and migration commands are found in both layouts", () => {
  for (const layout of ["new", "old"] as const) {
    const root = fixtureCheckout(layout);
    try {
      const api = layout === "new" ? "app/ts/shared-api" : "apps/_shared-api";
      assert.equal(apiEntrypoint(root), join(root, api, "src", "main.ts"), layout);
      assert.equal(initDbPath(root), join(root, layout === "new" ? "docker/postgres/init-db.sql" : "db/init-db.sql"), layout);
      assert.deepEqual(migrationCommands(root), {
        cwd: join(root, "migration"),
        migrate: ["bun", "run", "src/cli/migrate.ts"],
        seed: ["bun", "run", "src/cli/seed.ts"],
        seedReserved: ["bun", "run", "src/cli/seed-reserved.ts"],
      }, layout);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  const empty = mkdtempSync(join(tmpdir(), "not-inferops-"));
  try {
    assert.equal(apiEntrypoint(empty), null);
    assert.equal(initDbPath(empty), null);
    assert.equal(migrationCommands(empty), null);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("sign-in needs the reserved-persona catalog the checkout may predate", () => {
  const recent = fixtureCheckout("new");
  const old = fixtureCheckout("old", { signIn: false });
  try {
    assert.equal(signInSupported(recent), true);
    assert.equal(signInSupported(old), false);
  } finally {
    for (const root of [recent, old]) rmSync(root, { recursive: true, force: true });
  }
});

test("the pinned revision is the gatekeeper's provider revision", () => {
  const root = mkdtempSync(join(tmpdir(), "inferos-root-"));
  try {
    assert.equal(pinnedRevision(root), null);
    const dir = join(root, "custom-gatekeepers", "gatekeeper-inferops");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "connection.json"), JSON.stringify({ compatibility: { provider: { name: "inferops", revision: "3dae0f50d5b4fa467d734cbb2adf857f39942b31" } } }));
    assert.equal(pinnedRevision(root), "3dae0f50d5b4fa467d734cbb2adf857f39942b31");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  // This checkout's own pin is a full SHA.
  assert.match(pinnedRevision(join(import.meta.dirname, "..", "..")) ?? "", /^[0-9a-f]{40}$/);
});

test("the backend record round-trips, is private, and is null when absent or unreadable", () => {
  const root = mkdtempSync(join(tmpdir(), "inferos-root-"));
  try {
    const paths = backendPaths(root);
    assert.equal(paths.dir, join(root, ".inferops"));
    assert.equal(paths.record, join(root, ".inferops", "backend.json"));
    assert.equal(paths.log, join(root, ".inferops", "logs", "inferops.log"));
    assert.equal(readBackendRecord(root), null);
    const record: BackendRecord = {
      pid: 4242, port: 18787, apiUrl: "http://localhost:18787", inferosPort: 8787, database: "inferos_8787",
      checkout: "/tmp/x", revision: "3dae0f50d5b4fa467d734cbb2adf857f39942b31", dirty: false, managed: true,
      startedAt: "2026-11-01T00:00:00.000Z", log: paths.log,
    };
    writeBackendRecord(root, record);
    assert.deepEqual(readBackendRecord(root), record);
    assert.equal(statSync(paths.record).mode & 0o777, 0o600);
    assert.ok(!readFileSync(paths.record, "utf8").includes("TOKEN"));
    writeFileSync(paths.record, "{not json");
    assert.equal(readBackendRecord(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("credentials are refused by name only, model-provider keys included", () => {
  assert.deepEqual(forbiddenCredentials({ PATH: "/bin", AWS_ACCESS_KEY_ID: "", OPENAI_API_KEY: "sk", GOOGLE_APPLICATION_CREDENTIALS: "/c.json", INFEROPS_API_KEY: "iex" }),
    ["GOOGLE_APPLICATION_CREDENTIALS", "OPENAI_API_KEY"]);
  assert.deepEqual(forbiddenCredentials({ AWS_SECRET_ACCESS_KEY: "x", CLOUDFLARE_API_TOKEN: "y" }), ["AWS_SECRET_ACCESS_KEY", "CLOUDFLARE_API_TOKEN"]);
});

test("an existing gatekeeper wiring in the environment is reported by name", () => {
  assert.deepEqual(existingWiring({}), []);
  assert.deepEqual(existingWiring({ INFERLAB_AUTH_ORIGIN: "http://localhost:8080" }), ["INFERLAB_AUTH_ORIGIN"]);
  assert.deepEqual(existingWiring({ INFEROPS_BASE_URL: "http://x", INFEROPS_API_TOKEN: "t", INFEROPS_WORKSPACE_ID: "", }), ["INFEROPS_API_TOKEN", "INFEROPS_BASE_URL"]);
});

test("sign-in wiring names only the auth origin and the gatekeeper list; stopgap names the four connection variables", () => {
  assert.deepEqual(wiringEnv({ mode: "sign-in", apiUrl: "http://localhost:18787" }, {}),
    { INFERLAB_AUTH_ORIGIN: "http://localhost:18787", AUTH_GATEKEEPERS: "inferops", INFEROPS_ENABLED: "true" });
  assert.deepEqual(wiringEnv({ mode: "sign-in", apiUrl: "http://localhost:18787" }, { AUTH_GATEKEEPERS: "github,inferops" }).AUTH_GATEKEEPERS, "github,inferops");
  assert.deepEqual(wiringEnv({ mode: "sign-in", apiUrl: "http://localhost:18787" }, { AUTH_GATEKEEPERS: "github" }).AUTH_GATEKEEPERS, "github,inferops");
  const stopgap = wiringEnv({ mode: "stopgap", apiUrl: "http://localhost:18787", token: "bearer-value" }, {});
  assert.deepEqual(stopgap, {
    INFEROPS_BASE_URL: "http://localhost:18787", INFEROPS_API_TOKEN: "bearer-value",
    INFEROPS_WORKSPACE_ID: "00000000-0000-4000-8000-000000000011", INFEROPS_WORKSPACE_SLUG: "operations", INFEROPS_ENABLED: "true",
  });
  assert.equal("INFERLAB_AUTH_ORIGIN" in stopgap, false);
});

// ---------------------------------------------------------------------------------------------
// The commands, against fakes: no Postgres, no bun, no git, no network.

import { runInferopsBackend, type BackendDeps, type BackendOptions } from "./inferops.ts";
import type { LocalStack } from "./stack.ts";

const SHA = "3dae0f50d5b4fa467d734cbb2adf857f39942b31";

interface Harness {
  deps: BackendDeps;
  root: string;
  checkout: string;
  calls: { runIn: { argv: string[]; env: Record<string, string>; cwd: string }[]; runCli: string[][]; git: string[][]; launch: { argv: string[]; env: Record<string, string>; logPath: string; cwd: string }[]; signals: [number, string][] };
  state: { dbExists: boolean; readyAfter: number; healthCalls: number; alive: boolean; listening: boolean; shaKnown: boolean };
}

/** An InferOS root with the pin, and (unless `managed: false`) the managed checkout already present with node_modules. */
function harness({ managed = true, env = {} as NodeJS.ProcessEnv, layout = "new" as "new" | "old" } = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "inferos-root-"));
  const gk = join(root, "custom-gatekeepers", "gatekeeper-inferops");
  mkdirSync(gk, { recursive: true });
  writeFileSync(join(gk, "connection.json"), JSON.stringify({ compatibility: { provider: { revision: SHA } } }));
  const checkout = join(root, ".inferops", `checkout-${SHA.slice(0, 12)}`);
  const materialize = () => {
    const fixture = fixtureCheckout(layout);
    mkdirSync(join(root, ".inferops"), { recursive: true });
    rmSync(checkout, { recursive: true, force: true });
    // Move the fixture into place (rename across tmp is fine: same filesystem).
    renameSync(fixture, checkout);
  };
  if (managed) {
    materialize();
    mkdirSync(join(checkout, "node_modules"));
  }
  const calls: Harness["calls"] = { runIn: [], runCli: [], git: [], launch: [], signals: [] };
  const state: Harness["state"] = { dbExists: false, readyAfter: 2, healthCalls: 0, alive: true, listening: false, shaKnown: true };
  const ok = { exitCode: 0, stdout: "", stderr: "" };
  const deps: BackendDeps = {
    root,
    env: { PATH: "/bin", HOME: "/home/me", ...env },
    runIn: (argv, childEnv, cwd) => {
      calls.runIn.push({ argv, env: childEnv, cwd });
      if (argv[0] === "psql" && argv.includes("-tAc")) return { ...ok, stdout: state.dbExists ? "1\n" : "" };
      if (argv[0] === "psql" && argv.some(a => a.startsWith("CREATE DATABASE"))) state.dbExists = true;
      if (argv[0] === "psql" && argv.some(a => a.startsWith("DROP DATABASE"))) state.dbExists = false;
      return ok;
    },
    runCli: argv => {
      calls.runCli.push(argv);
      return ok;
    },
    git: args => {
      calls.git.push(args);
      if (args.includes("rev-parse") && args.includes("HEAD")) return { ...ok, stdout: `${SHA}\n` };
      if (args.includes("--git-common-dir")) return { ...ok, stdout: `${join(root, "..", "inferOS", ".git")}\n` };
      if (args.includes("cat-file")) return state.shaKnown ? ok : { ...ok, exitCode: 1 };
      if (args.includes("worktree") && args.includes("add")) {
        materialize();
        return ok;
      }
      return ok;
    },
    launch: (argv, childEnv, logPath, cwd) => {
      calls.launch.push({ argv, env: childEnv, logPath, cwd });
      state.alive = true; // a fresh process; `signal` SIGTERM flips it back
      mkdirSync(join(logPath, ".."), { recursive: true });
      writeFileSync(logPath, "shared-api on http://localhost:18787 (auth: stub)\n");
      return 4242;
    },
    signal: (pid, signal) => {
      calls.signals.push([pid, signal]);
      if (signal === "SIGTERM") state.alive = false;
    },
    processAlive: () => state.alive,
    sleep: async () => {},
    now: (() => { let t = 0; return () => (t += 1000); })(),
    isPortListening: async () => state.listening,
    fetchImpl: (async (input: string | URL | Request) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.pathname === "/health/ready") {
        state.healthCalls += 1;
        return new Response(JSON.stringify({ status: "ok" }), { status: state.healthCalls >= state.readyAfter ? 200 : 503 });
      }
      return new Response("no", { status: 404 });
    }) as typeof fetch,
  };
  return { deps, root, checkout, calls, state };
}

const stack8787: LocalStack = { root: "", backendHost: "localhost:8787", port: 8787, url: "http://localhost:8787", stateDir: "", recordPath: "" };
const options = (sub: BackendOptions["sub"], extra: Partial<BackendOptions> = {}): BackendOptions =>
  ({ sub, fresh: false, purge: false, stopgap: false, allowLocalConfig: false, timeoutSeconds: 180, lines: 50, ...extra });

const argvLines = (h: Harness) => h.calls.runIn.map(c => c.argv.join(" "));

test("up refuses a shell holding a credential before touching anything", async () => {
  const h = harness({ env: { OPENAI_API_KEY: "sk-x" } });
  try {
    const result = await runInferopsBackend(stack8787, options("up"), h.deps);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.report.credentials, ["OPENAI_API_KEY"]);
    assert.equal(h.calls.runIn.length + h.calls.launch.length + h.calls.git.length, 0);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("up prepares the database, starts the API from source and records it", async () => {
  const h = harness();
  try {
    const result = await runInferopsBackend(stack8787, options("up"), h.deps);
    assert.equal(result.exitCode, 0, JSON.stringify(result.report));
    assert.deepEqual(h.calls.runCli[0], ["pg_isready", "-h", "localhost", "-p", "5432", "-q"]);
    const lines = argvLines(h);
    assert.match(lines[0]!, /^psql .* -tAc SELECT 1 FROM pg_database WHERE datname = 'inferos_8787'$/);
    assert.match(lines[1]!, /DROP DATABASE IF EXISTS inferos_8787 WITH \(FORCE\)$/);
    assert.match(lines[2]!, /CREATE DATABASE inferos_8787$/);
    assert.match(lines[3]!, new RegExp(`^psql postgres://postgres:postgres@localhost:5432/inferos_8787\\?sslmode=disable -v ON_ERROR_STOP=1 -q -f ${h.checkout}/docker/postgres/init-db.sql$`));
    assert.deepEqual(lines.slice(4), ["bun run src/cli/migrate.ts", "bun run src/cli/seed.ts", "bun run src/cli/seed-reserved.ts"]);
    for (const call of h.calls.runIn.slice(4)) {
      assert.equal(call.cwd, join(h.checkout, "migration"));
      assert.equal(call.env.NODE_CONFIG_ENV, "factory");
      assert.equal(call.env.DATABASE_URL, "postgres://postgres:postgres@localhost:5432/inferos_8787?sslmode=disable");
    }
    assert.equal(h.calls.runIn.at(-1)!.env.SYNTHETICS_PROBE_KEY, "iex_synthetic_inferos_local_0000");
    assert.equal(h.calls.runIn.at(-2)!.env.SYNTHETICS_PROBE_KEY, undefined);
    assert.equal(h.calls.launch.length, 1);
    const launched = h.calls.launch[0]!;
    assert.deepEqual(launched.argv, ["bun", join(h.checkout, "app/ts/shared-api/src/main.ts")]);
    assert.equal(launched.cwd, h.checkout);
    assert.equal(launched.env.API_PORT, "18787");
    assert.equal(launched.env.NODE_CONFIG, ssoLayer("http://localhost:8787"));
    assert.equal(launched.env.VERSION, "inferos-local");
    assert.equal(launched.env.NODE_OPTIONS, undefined);
    assert.equal(launched.logPath, backendPaths(h.root).log);
    const record = readBackendRecord(h.root);
    assert.equal(record?.pid, 4242);
    assert.equal(record?.port, 18787);
    assert.equal(record?.revision, SHA);
    assert.equal(record?.managed, true);
    assert.equal(record?.database, "inferos_8787");
    assert.equal(result.report.apiUrl, "http://localhost:18787");
    assert.equal(result.report.reused, false);
    assert.equal(result.report.fresh, true);
    assert.equal(result.report.signIn, true);
    assert.ok(!JSON.stringify(result.report).includes("TOKEN"));
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("up reuses a database prepared at the same revision, and --fresh recreates it", async () => {
  const h = harness();
  try {
    await runInferopsBackend(stack8787, options("up"), h.deps);
    h.calls.runIn.length = 0;
    h.calls.launch.length = 0;
    h.state.alive = false; // the first API is gone; the record is stale
    const second = await runInferopsBackend(stack8787, options("up"), h.deps);
    assert.equal(second.exitCode, 0);
    assert.equal(second.report.fresh, false);
    assert.deepEqual(argvLines(h).slice(1), ["bun run src/cli/migrate.ts", "bun run src/cli/seed.ts", "bun run src/cli/seed-reserved.ts"]);
    h.calls.runIn.length = 0;
    h.state.alive = false;
    const third = await runInferopsBackend(stack8787, options("up", { fresh: true }), h.deps);
    assert.equal(third.report.fresh, true);
    assert.ok(argvLines(h).some(line => line.includes("DROP DATABASE")));
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("up adopts a backend that is already running and refuses a stranger on the port", async () => {
  const h = harness();
  try {
    await runInferopsBackend(stack8787, options("up"), h.deps);
    h.calls.launch.length = 0;
    h.calls.runIn.length = 0;
    h.state.listening = true;
    const again = await runInferopsBackend(stack8787, options("up"), h.deps);
    assert.equal(again.exitCode, 0);
    assert.equal(again.report.reused, true);
    assert.equal(h.calls.launch.length, 0);
    assert.equal(h.calls.runIn.length, 0);
    rmSync(backendPaths(h.root).record);
    const stranger = await runInferopsBackend(stack8787, options("up"), h.deps);
    assert.equal(stranger.exitCode, 1);
    assert.equal(stranger.report.backend, "port-in-use-by-other");
    assert.match(String(stranger.report.error), /18787/);
    assert.equal(h.calls.launch.length, 0);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("up that never becomes ready stops what it started and records nothing", async () => {
  const h = harness();
  h.state.readyAfter = Number.MAX_SAFE_INTEGER;
  try {
    const result = await runInferopsBackend(stack8787, options("up", { timeoutSeconds: 4 }), h.deps);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(h.calls.signals[0], [-4242, "SIGTERM"]);
    assert.equal(readBackendRecord(h.root), null);
    assert.match(String(result.report.error), /not ready|ready within/);
    assert.ok(Array.isArray(result.report.logTail));
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("up creates the managed worktree at the pin and installs it once", async () => {
  const h = harness({ managed: false, env: { INFEROPS_REPO: "/repos/inferops" } });
  try {
    const result = await runInferopsBackend(stack8787, options("up"), h.deps);
    assert.equal(result.exitCode, 0, JSON.stringify(result.report));
    assert.deepEqual(h.calls.git[0], ["-C", "/repos/inferops", "cat-file", "-e", `${SHA}^{commit}`]);
    assert.deepEqual(h.calls.git[1], ["-C", "/repos/inferops", "worktree", "add", "--detach", h.checkout, SHA]);
    assert.deepEqual(h.calls.runIn[0]!.argv, ["bun", "install", "--frozen-lockfile", "--ignore-scripts"]);
    assert.equal(h.calls.runIn[0]!.cwd, h.checkout);
    assert.equal(readBackendRecord(h.root)?.managed, true);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("up fetches a pin the sibling repository does not have yet", async () => {
  const h = harness({ managed: false, env: { INFEROPS_REPO: "/repos/inferops" } });
  h.state.shaKnown = false;
  try {
    const result = await runInferopsBackend(stack8787, options("up"), h.deps);
    assert.equal(result.exitCode, 0, JSON.stringify(result.report));
    assert.deepEqual(h.calls.git[1], ["-C", "/repos/inferops", "fetch", "origin", SHA]);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("up --dir uses a checkout as it is, and refuses one carrying a cloud credential unless allowed", async () => {
  const dir = fixtureCheckout("new");
  mkdirSync(join(dir, "config"));
  writeFileSync(join(dir, "config", "gcp-credentials.json"), "{}");
  const h = harness({ managed: false });
  try {
    const refused = await runInferopsBackend(stack8787, options("up", { dir }), h.deps);
    assert.equal(refused.exitCode, 1);
    assert.match(String(refused.report.error), /gcp-credentials\.json/);
    assert.equal(h.calls.launch.length, 0);
    const allowed = await runInferopsBackend(stack8787, options("up", { dir, allowLocalConfig: true }), h.deps);
    assert.equal(allowed.exitCode, 0, JSON.stringify(allowed.report));
    assert.ok(h.calls.git.some(args => args[0] === "-C" && args[1] === dir && args.includes("rev-parse")));
    assert.equal(readBackendRecord(h.root)?.managed, false);
    assert.equal(readBackendRecord(h.root)?.checkout, dir);
    assert.ok(!h.calls.runIn.some(c => c.argv[1] === "install"), "a --dir checkout is never installed by us");
  } finally {
    rmSync(h.root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("up on a checkout without the reserved-persona sign-in reports signIn false", async () => {
  const h = harness({ layout: "old" });
  try {
    const result = await runInferopsBackend(stack8787, options("up"), h.deps);
    assert.equal(result.exitCode, 0, JSON.stringify(result.report));
    assert.equal(result.report.signIn, false);
    assert.deepEqual(h.calls.launch[0]!.argv, ["bun", join(h.checkout, "apps/_shared-api/src/main.ts")]);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("status classifies the backend like the stack: running, not-running, port-in-use-by-other", async () => {
  const h = harness();
  try {
    const none = await runInferopsBackend(stack8787, options("status"), h.deps);
    assert.equal(none.exitCode, 1);
    assert.equal(none.report.backend, "not-running");
    await runInferopsBackend(stack8787, options("up"), h.deps);
    h.state.listening = true;
    const running = await runInferopsBackend(stack8787, options("status"), h.deps);
    assert.equal(running.exitCode, 0, JSON.stringify(running.report));
    assert.equal(running.report.backend, "running");
    assert.equal(running.report.revision, SHA);
    assert.equal(running.report.apiUrl, "http://localhost:18787");
    assert.equal(running.report.healthy, true);
    assert.match(running.headline, /running/);
    rmSync(backendPaths(h.root).record);
    const stranger = await runInferopsBackend(stack8787, options("status"), h.deps);
    assert.equal(stranger.exitCode, 1);
    assert.equal(stranger.report.backend, "port-in-use-by-other");
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("down stops the group it recorded, never a stranger, and --purge drops the database and worktree", async () => {
  const h = harness();
  try {
    const nothing = await runInferopsBackend(stack8787, options("down"), h.deps);
    assert.equal(nothing.exitCode, 0);
    assert.equal(nothing.report.stopped, false);
    await runInferopsBackend(stack8787, options("up"), h.deps);
    const stopped = await runInferopsBackend(stack8787, options("down"), h.deps);
    assert.equal(stopped.exitCode, 0, JSON.stringify(stopped.report));
    assert.deepEqual(h.calls.signals, [[-4242, "SIGTERM"]]);
    assert.equal(readBackendRecord(h.root), null);
    assert.ok(existsSync(h.checkout), "the managed checkout survives down");
    // A dead pid with a stranger on the port: nothing is signalled, the stale record goes, exit 1.
    h.state.alive = true;
    await runInferopsBackend(stack8787, options("up"), h.deps);
    h.state.alive = false;
    h.state.listening = true;
    h.calls.signals.length = 0;
    const stale = await runInferopsBackend(stack8787, options("down"), h.deps);
    assert.equal(stale.exitCode, 1);
    assert.equal(h.calls.signals.length, 0);
    assert.equal(readBackendRecord(h.root), null);
    // --purge
    h.state.listening = false;
    h.state.alive = true;
    await runInferopsBackend(stack8787, options("up"), h.deps);
    h.calls.runIn.length = 0;
    h.calls.git.length = 0;
    const purged = await runInferopsBackend(stack8787, options("down", { purge: true }), h.deps);
    assert.equal(purged.exitCode, 0, JSON.stringify(purged.report));
    assert.ok(argvLines(h).some(line => line.includes("DROP DATABASE IF EXISTS inferos_8787 WITH (FORCE)")));
    assert.ok(h.calls.git.some(args => args.includes("worktree") && args.includes("remove") && args.includes(h.checkout)));
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("logs tails the backend log", async () => {
  const h = harness();
  try {
    const empty = await runInferopsBackend(stack8787, options("logs"), h.deps);
    assert.equal(empty.exitCode, 0);
    assert.deepEqual(empty.report.lines, []);
    await runInferopsBackend(stack8787, options("up"), h.deps);
    const tail = await runInferopsBackend(stack8787, options("logs", { lines: 1 }), h.deps);
    assert.deepEqual(tail.report.lines, ["shared-api on http://localhost:18787 (auth: stub)"]);
    assert.equal(tail.report.file, backendPaths(h.root).log);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});


// ---------------------------------------------------------------------------------------------
// verify and env, against an in-process stand-in for the InferOps API.

import { createHash } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";

const ACME_OPS = "00000000-0000-4000-8000-000000000011";
const ACME_KNOWLEDGE = "00000000-0000-4000-8000-000000000012";
const GROK_OPS = "00000000-0000-4000-8000-000000000c11";

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    let data = "";
    request.on("data", chunk => { data += chunk; });
    request.on("end", () => resolve(data));
  });
}

/** Just enough of InferOps: health, persona bearers, workspaces, projects, boards and the stub SSO dance. */
async function fakeInferOps({ refusePersona = false } = {}): Promise<{ url: string; port: number; close: () => Promise<void>; seen: string[] }> {
  const seen: string[] = [];
  let challenge = "";
  const server = createHttpServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    seen.push(`${request.method} ${url.pathname}`);
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify(body));
    };
    const bearer = request.headers.authorization?.replace(/^Bearer /, "");
    if (url.pathname === "/health/ready") return json(200, { status: "ok" });
    if (url.pathname === "/auth/inferlab-login" && request.method === "POST") {
      const { personaId, transport } = JSON.parse(await readBody(request));
      if (transport !== "bearer") return json(400, { error: "transport" });
      if (personaId === "owner") return json(200, { token: "owner-token", refreshToken: "r", user: { workspaces: [{ workspaceId: ACME_OPS, product: "inferops", role: "owner" }, { workspaceId: ACME_KNOWLEDGE, product: "infermind", role: "owner" }] } });
      if (personaId === "grokbot-owner") return json(200, { token: "grok-token", refreshToken: "r", user: { workspaces: [{ workspaceId: GROK_OPS, product: "inferops", role: "owner" }] } });
      return json(401, { error: "unknown persona" });
    }
    if (url.pathname === "/workspaces") {
      if (bearer === "owner-token") return json(200, [{ id: ACME_OPS, product: "inferops", name: "Field Ops", slug: "operations" }, { id: ACME_KNOWLEDGE, product: "infermind", name: "Knowledge", slug: "knowledge" }]);
      if (bearer === "grok-token" || bearer === "sso-token") return json(200, [{ id: GROK_OPS, product: "inferops", name: "Grokbot Operations", slug: "operations" }]);
      return json(401, { error: "unauthorized" });
    }
    if (url.pathname === "/project/projects") {
      const workspace = request.headers["x-workspace-id"];
      if (bearer === "owner-token" && workspace === ACME_OPS) return json(200, { projects: [{ id: "p-eng", identifier: "ENG", name: "Robotics Platform" }] });
      if (bearer === "sso-token" && workspace === GROK_OPS) return json(200, { projects: [{ id: "p-grok", identifier: "GROK", name: "Grok Bot" }] });
      return json(403, { error: "forbidden" });
    }
    if (url.pathname === "/project/board") {
      const project = url.searchParams.get("projectId");
      if (project === "p-eng" && bearer === "owner-token") return json(200, { projectId: project, states: [{ id: "s1", issues: [{}, {}, {}] }, { id: "s2", issues: [{}] }] });
      if (project === "p-grok" && bearer === "sso-token") return json(200, { projectId: project, states: [{ id: "s1", issues: [{}] }, { id: "s2", issues: [] }, { id: "s3", issues: [] }] });
      return json(403, { error: "forbidden" });
    }
    if (url.pathname === "/authorize" && request.method === "GET") {
      const q = Object.fromEntries(url.searchParams);
      if (q.client_id !== "inferos" || q.redirect_uri !== "http://localhost:8787/gatekeeper/inferops/oauth" || (q.state ?? "").length < 8 || (q.code_challenge ?? "").length < 43 || q.code_challenge_method !== "S256") {
        response.writeHead(400); return response.end("invalid authorize request");
      }
      challenge = q.code_challenge!;
      response.writeHead(200, { "content-type": "text/html", "set-cookie": "iex_authz_csrf=csrf-value; Max-Age=600; Path=/authorize; HttpOnly; SameSite=Strict" });
      return response.end('<form><input name="csrf" value="csrf-value"></form>');
    }
    if (url.pathname === "/authorize/persona" && request.method === "POST") {
      const form = new URLSearchParams(await readBody(request));
      const origin = request.headers.origin;
      const cookie = request.headers.cookie ?? "";
      if (!cookie.includes("iex_authz_csrf=csrf-value") || form.get("csrf") !== "csrf-value" || origin !== `http://localhost:${port}`) { response.writeHead(403); return response.end("invalid sign-in request"); }
      if (refusePersona || form.get("persona") !== "grokbot-owner") { response.writeHead(401); return response.end("unknown persona"); }
      response.writeHead(302, { location: `${form.get("redirect_uri")}?code=CODE123&state=${form.get("state")}` });
      return response.end();
    }
    if (url.pathname === "/auth/token" && request.method === "POST") {
      const { clientId, code, codeVerifier, redirectUri } = JSON.parse(await readBody(request));
      const expected = createHash("sha256").update(codeVerifier).digest("base64url");
      if (clientId !== "inferos" || code !== "CODE123" || expected !== challenge || redirectUri !== "http://localhost:8787/gatekeeper/inferops/oauth") return json(400, { error: "invalid_grant" });
      return json(200, { token: "sso-token", refreshToken: "r", user: { emailVerified: true, workspaces: [{ workspaceId: GROK_OPS, product: "inferops", role: "owner" }] } });
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://localhost:${port}`, port, seen, close: () => new Promise(resolve => server.close(() => resolve())) };
}

/** A root whose backend record points at `api`, as a running backend of this checkout would. */
function recordedHarness(api: { url: string; port: number }): Harness {
  const h = harness();
  writeBackendRecord(h.root, {
    pid: 4242, port: api.port, apiUrl: api.url, inferosPort: 8787, database: "inferos_8787", checkout: h.checkout, revision: SHA, dirty: false, managed: true,
    startedAt: "2026-11-01T00:00:00.000Z", log: backendPaths(h.root).log,
  });
  h.state.listening = true;
  h.deps.fetchImpl = fetch;
  return h;
}

test("verify proves both wirings headless: the acme ENG board by bearer, the GROK board through the PKCE persona sign-in", async () => {
  const api = await fakeInferOps();
  const h = recordedHarness(api);
  try {
    const result = await runInferopsBackend({ ...stack8787, port: 8787 }, options("verify"), h.deps);
    assert.equal(result.exitCode, 0, JSON.stringify(result.report));
    const stopgap = result.report.stopgap as Record<string, unknown>;
    assert.equal(stopgap.ok, true);
    assert.equal(stopgap.persona, "owner");
    assert.equal(stopgap.workspace, "operations");
    assert.equal(stopgap.project, "ENG");
    assert.equal(stopgap.states, 2);
    assert.equal(stopgap.issues, 4);
    const signIn = result.report.signIn as Record<string, unknown>;
    assert.equal(signIn.ok, true, JSON.stringify(signIn));
    assert.equal(signIn.persona, "grokbot-owner");
    assert.equal(signIn.redirectUri, "http://localhost:8787/gatekeeper/inferops/oauth");
    assert.equal(signIn.project, "GROK");
    assert.equal(signIn.states, 3);
    assert.equal(signIn.issues, 1);
    assert.ok(api.seen.includes("GET /authorize") && api.seen.includes("POST /authorize/persona") && api.seen.includes("POST /auth/token"));
    assert.ok(!JSON.stringify(result.report).includes("token"), "no bearer in the report");
    assert.match(result.headline, /verified/);
  } finally {
    await api.close();
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("verify names the step that failed and needs a running backend", async () => {
  const h = harness();
  try {
    const none = await runInferopsBackend(stack8787, options("verify"), h.deps);
    assert.equal(none.exitCode, 1);
    assert.equal(none.report.step, "backend");
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
  const api = await fakeInferOps({ refusePersona: true });
  const refused = recordedHarness(api);
  try {
    const result = await runInferopsBackend(stack8787, options("verify"), refused.deps);
    assert.equal(result.exitCode, 1);
    assert.equal((result.report.stopgap as Record<string, unknown>).ok, true);
    assert.equal((result.report.signIn as Record<string, unknown>).ok, false);
    assert.equal(result.report.step, "sign-in");
    assert.match(String(result.report.error), /401/);
  } finally {
    await api.close();
    rmSync(refused.root, { recursive: true, force: true });
  }
});

test("env prints the sign-in wiring, or with --stopgap a minted owner bearer and the live-suite variables", async () => {
  const api = await fakeInferOps();
  const h = recordedHarness(api);
  try {
    const signIn = await runInferopsBackend(stack8787, options("env"), h.deps);
    assert.equal(signIn.exitCode, 0, JSON.stringify(signIn.report));
    assert.equal(signIn.report.shell, [`export INFERLAB_AUTH_ORIGIN='${api.url}'`, "export AUTH_GATEKEEPERS='inferops'", "export INFEROPS_ENABLED='true'"].join("\n"));
    assert.deepEqual(signIn.report.exports, ["INFERLAB_AUTH_ORIGIN", "AUTH_GATEKEEPERS", "INFEROPS_ENABLED"]);
    const stopgap = await runInferopsBackend(stack8787, options("env", { stopgap: true }), h.deps);
    assert.equal(stopgap.exitCode, 0, JSON.stringify(stopgap.report));
    const shell = String(stopgap.report.shell);
    assert.ok(shell.includes(`export INFEROPS_BASE_URL='${api.url}'`));
    assert.ok(shell.includes("export INFEROPS_API_TOKEN='owner-token'"));
    assert.ok(shell.includes(`export INFEROPS_WORKSPACE_ID='${ACME_OPS}'`));
    assert.ok(shell.includes("export INFEROPS_WORKSPACE_SLUG='operations'"));
    assert.ok(shell.includes("export INFEROPS_LIVE_TOKEN='owner-token'"));
    assert.ok(shell.includes("export INFEROPS_LIVE_TENANT='acme'") && shell.includes("export INFEROPS_LIVE_PROJECT='ENG'"));
    assert.ok(shell.includes(`export INFEROPS_LIVE_WIKI_WORKSPACE_ID='${ACME_KNOWLEDGE}'`) && shell.includes("export INFEROPS_LIVE_WIKI_WORKSPACE_SLUG='knowledge'"));
    assert.ok(!shell.includes("INFERLAB_AUTH_ORIGIN"));
    assert.ok(!stopgap.headline.includes("owner-token"));
    assert.ok(!JSON.stringify(stopgap.report.exports).includes("owner-token"));
  } finally {
    await api.close();
    rmSync(h.root, { recursive: true, force: true });
  }
});
