import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
