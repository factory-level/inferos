// The test InferOps backend an InferOS checkout develops against: a headless InferOps API (no web
// clients, no worker) run from source at the gatekeeper's pinned provider revision, with its own
// seeded database on the shared local Postgres, started, inspected and stopped by `pnpm local
// inferops <command>`. `pnpm local start --inferops` wires this checkout's stack to it.
//
// Nothing here needs a bootstrapped InferOps checkout or a cloud credential: the API boots on
// `NODE_CONFIG_ENV=factory`, an environment with no secret layer, so InferOps runs its stub auth
// on `config/default.js` (inferops `lib/ts/backend/config/secret-layer.ts`). The managed checkout is
// a detached git worktree of the sibling inferops repository at the pinned SHA; nothing in it is
// edited and its `config/local.json` (which does not exist there) is never read.

import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import type { CodingDeps, ProcessResult } from "./coding.ts";
import { providerVariables } from "./runner.ts";
import { localEnv, type LocalStack } from "./stack.ts";

/** The API listens at the InferOS stack port plus this: 8787 → 18787, a `pnpm wt` 88xx → 188xx. */
export const API_PORT_SHIFT = 10_000;

/** The acme workspace the stopgap connection names (inferops `seeds/`, dev persona matrix). */
export const STOPGAP_WORKSPACE = { id: "00000000-0000-4000-8000-000000000011", slug: "operations", persona: "owner" } as const;

/** Where the backend's ports fall for an InferOS stack on `inferosPort`. */
export function backendPorts(inferosPort: number): { inferosPort: number; inferosOrigin: string; apiPort: number; apiUrl: string } {
  const apiPort = inferosPort + API_PORT_SHIFT;
  return { inferosPort, inferosOrigin: `http://localhost:${inferosPort}`, apiPort, apiUrl: `http://localhost:${apiPort}` };
}

/** One database per InferOS stack, beside inferops' own `inferlab_<offset>` databases. */
export function backendDatabase(inferosPort: number): string {
  return `inferos_${inferosPort}`;
}

/**
 * Names the InferOps child must not inherit: what pnpm injects into a script's environment, and
 * every name inferops' turbo `globalEnv` and `custom-environment-variables.json` would read into
 * the cascade (a developer's `AUTH_MODE`, `NODE_CONFIG_ENV` or `DATABASE_URL` would rewrite the
 * backend), plus the ADC pointer so nothing reaches for a cloud credential.
 */
const DROPPED_ENV = /^(?:npm_|PNPM_|pnpm_)/;
export const DROPPED_NAMES: readonly string[] = [
  "INIT_CWD", "NODE_OPTIONS", "NODE_ENV", "AUTH_MODE", "WORKTREE_OFFSET", "API_PORT", "DATABASE_URL", "DB_SCHEMA", "PGBOSS_SCHEMA",
  "LOG_LEVEL", "CONFIG_AUDIT", "NODE_CONFIG_DIR", "NODE_CONFIG", "NODE_CONFIG_ENV", "GCP_KMS_KEY", "GOOGLE_APPLICATION_CREDENTIALS",
];

/** Every environment-variable name the checkout's `config/custom-environment-variables.json` maps into its cascade. */
function mappedNames(checkout: string | undefined): Set<string> {
  const names = new Set<string>();
  if (!checkout) return names;
  const walk = (node: unknown): void => {
    if (typeof node === "string") names.add(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === "object") Object.values(node).forEach(walk);
  };
  walk(readJson(join(checkout, "config", "custom-environment-variables.json")));
  return names;
}

/**
 * The environment every InferOps step runs with: the shell minus {@link DROPPED_NAMES} and every
 * name the checkout's own cascade would read (`custom-environment-variables.json`), pinned to
 * `factory`, plus `extra`.
 */
export function backendChildEnv(env: NodeJS.ProcessEnv, extra: Record<string, string> = {}, checkout?: string): Record<string, string> {
  const mapped = mappedNames(checkout);
  const child: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || DROPPED_ENV.test(name) || DROPPED_NAMES.includes(name) || mapped.has(name)) continue;
    child[name] = value;
  }
  return { ...child, NODE_CONFIG_ENV: "factory", SUPPRESS_NO_CONFIG_WARNING: "1", ...extra };
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * node-config's `NODE_CONFIG` layer registering the InferOS origin as the `inferos` SSO client's
 * redirect origin, in both loopback spellings: InferOps matches the origin exactly, and the
 * gatekeeper builds its `redirect_uri` from whichever host `VITE_BACKEND_HOST` names.
 */
export function ssoLayer(inferosOrigin: string): string {
  const port = new URL(inferosOrigin).port || "80";
  return JSON.stringify({ auth: { sso: { inferosOrigins: [`http://localhost:${port}`, `http://127.0.0.1:${port}`] } } });
}

/** The workspace package directories an InferOps checkout declares (`dir/*` globs and explicit paths). */
function workspaceDirs(checkout: string): string[] {
  const manifest = readJson(join(checkout, "package.json"));
  const workspaces = manifest?.workspaces;
  const patterns: unknown = Array.isArray(workspaces) ? workspaces : (workspaces as { packages?: unknown } | undefined)?.packages;
  if (!Array.isArray(patterns)) return [];
  const dirs: string[] = [];
  for (const pattern of patterns) {
    if (typeof pattern !== "string") continue;
    if (pattern.endsWith("/*")) {
      const parent = join(checkout, pattern.slice(0, -2));
      if (!existsSync(parent)) continue;
      for (const entry of readdirSync(parent, { withFileTypes: true })) if (entry.isDirectory()) dirs.push(join(parent, entry.name));
    } else {
      dirs.push(join(checkout, pattern));
    }
  }
  return dirs;
}

/** `<package dir>/src/main.ts` of `@inferlab/shared-api`, wherever the layout puts it; null when the checkout is not InferOps. */
export function apiEntrypoint(checkout: string): string | null {
  for (const dir of workspaceDirs(checkout)) {
    if (readJson(join(dir, "package.json"))?.name !== "@inferlab/shared-api") continue;
    const entry = join(dir, "src", "main.ts");
    return existsSync(entry) ? entry : null;
  }
  return null;
}

/** The database bootstrap script, at its current or its pre-rename path. */
export function initDbPath(checkout: string): string | null {
  for (const candidate of ["docker/postgres/init-db.sql", "db/init-db.sql"]) {
    const path = join(checkout, candidate);
    if (existsSync(path)) return path;
  }
  return null;
}

/** The migrate and seed commands as the migration package's own scripts name them, run directly (no turbo). */
export function migrationCommands(checkout: string): { cwd: string; migrate: string[]; seed: string[]; seedReserved: string[] } | null {
  const cwd = join(checkout, "migration");
  const scripts = readJson(join(cwd, "package.json"))?.scripts as Record<string, string> | undefined;
  const argv = (name: string) => scripts?.[name]?.trim().split(/\s+/);
  const migrate = argv("migrate");
  const seed = argv("seed");
  const seedReserved = argv("seed:reserved");
  if (!migrate || !seed || !seedReserved) return null;
  return { cwd, migrate, seed, seedReserved };
}

/** Whether the checkout has the stub-mode reserved-persona sign-in (inferops #2445) that per-person mode needs. */
export function signInSupported(checkout: string): boolean {
  return ["domain/ts/portal/shared/reserved-tenants.ts", "domains/portal/shared/reserved-tenants.ts"].some(candidate => {
    const path = join(checkout, candidate);
    return existsSync(path) && readFileSync(path, "utf8").includes("SSO_SIGN_IN_PERSONAS");
  });
}

/** The InferOps revision this checkout's gatekeeper is pinned to (`connection.json` `compatibility.provider.revision`). */
export function pinnedRevision(root: string): string | null {
  const connection = readJson(join(root, "custom-gatekeepers", "gatekeeper-inferops", "connection.json"));
  const revision = (connection?.compatibility as { provider?: { revision?: unknown } } | undefined)?.provider?.revision;
  return typeof revision === "string" && /^[0-9a-f]{40}$/.test(revision) ? revision : null;
}

/** Where this checkout keeps the backend's record, log and managed InferOps checkouts. */
export function backendPaths(root: string): { dir: string; record: string; log: string; logsDir: string } {
  const dir = join(root, ".inferops");
  return { dir, record: join(dir, "backend.json"), log: join(dir, "logs", "inferops.log"), logsDir: join(dir, "logs") };
}

/** What `up` records about the backend it started; never a credential. */
export interface BackendRecord {
  pid: number;
  port: number;
  apiUrl: string;
  inferosPort: number;
  database: string;
  checkout: string;
  revision: string;
  /** The checkout had uncommitted changes when the API started (only possible with `--dir`). */
  dirty: boolean;
  /** The checkout is a worktree this command created under `.inferops/`. */
  managed: boolean;
  startedAt: string;
  log: string;
  /** How `pnpm local start --inferops` last wired the stack to it; absent until then. */
  wiring?: "sign-in" | "stopgap";
}

export function writeBackendRecord(root: string, record: BackendRecord): void {
  const { record: path } = backendPaths(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function readBackendRecord(root: string): BackendRecord | null {
  const record = readJson(backendPaths(root).record);
  return record && typeof record.pid === "number" && typeof record.port === "number" ? (record as unknown as BackendRecord) : null;
}

/**
 * Cloud and deploy credentials the backend must not run beside, by name only (a value is never
 * read). Model-provider keys come from runner.ts's `providerVariables`, so the two guards agree;
 * `factory.ts` imports this same pattern for its sandboxes.
 */
export const CLOUD_VAR = /^(?:AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|PROFILE)|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CREDENTIALS|GOOGLE_OAUTH_ACCESS_TOKEN|CLOUDSDK_AUTH_ACCESS_TOKEN|CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE|CLOUDFLARE_API_TOKEN|CLOUDFLARE_API_KEY|CF_API_TOKEN|CF_API_KEY|AZURE_CLIENT_SECRET|ARM_CLIENT_SECRET|PULUMI_ACCESS_TOKEN|NEON_API_KEY|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|VERCEL_TOKEN|FLY_API_TOKEN|DIGITALOCEAN_ACCESS_TOKEN|NPM_TOKEN)$/;

export function forbiddenCredentials(env: NodeJS.ProcessEnv): string[] {
  const names = new Set(providerVariables(env));
  for (const [name, value] of Object.entries(env)) if (value && CLOUD_VAR.test(name)) names.add(name);
  return [...names].toSorted();
}

/** The gatekeeper wirings a shell may already carry (see the gatekeeper's `connectionFromEnv` and `inferLabAuthOrigin`). */
const WIRING_NAMES = ["INFERLAB_AUTH_ORIGIN", "INFEROPS_BASE_URL", "INFEROPS_API_TOKEN", "INFEROPS_WORKSPACE_ID", "INFEROPS_WORKSPACE_SLUG"] as const;

/** The gatekeeper's own `.dev.vars`, where the dev server parks `INFEROPS_API_TOKEN` as a hidden secret (and a crash can leave it). */
const GATEKEEPER_DEV_VARS = "custom-gatekeepers/gatekeeper-inferops/.dev.vars";

/**
 * Which wiring variables `env` sets, by name, so `start --inferops` never silently overrides or
 * doubles one. With `root`, a name left in the gatekeeper's `.dev.vars` counts too: that file wins
 * over a generated value, so a stale bearer there would quietly replace a fresh one.
 */
export function existingWiring(env: NodeJS.ProcessEnv, root?: string): string[] {
  const names = WIRING_NAMES.filter(name => Boolean(env[name])).map(String);
  if (root && existsSync(join(root, GATEKEEPER_DEV_VARS))) {
    try {
      const parked = parseEnv(readFileSync(join(root, GATEKEEPER_DEV_VARS), "utf8"));
      for (const name of WIRING_NAMES) if (parked[name]) names.push(`${name} (${GATEKEEPER_DEV_VARS})`);
    } catch {
      // Unreadable: nothing to report from it.
    }
  }
  return names.toSorted();
}

export type Wiring = { mode: "sign-in"; apiUrl: string } | { mode: "stopgap"; apiUrl: string; token: string };

/**
 * The variables that point InferOS's gatekeeper at the backend. The two wirings are exclusive by the
 * gatekeeper's rules: an auth origin means every person brings their own session (the API endpoint
 * derives from it, so `INFEROPS_BASE_URL` stays unset); the stopgap is one shared bearer and must
 * run without an auth origin, or the gatekeeper refuses to auto-provision the account.
 */
export function wiringEnv(wiring: Wiring, env: NodeJS.ProcessEnv): Record<string, string> {
  if (wiring.mode === "sign-in") {
    const vendors = (env.AUTH_GATEKEEPERS ?? "").split(",").map(v => v.trim()).filter(Boolean);
    if (!vendors.includes("inferops")) vendors.push("inferops");
    return { INFERLAB_AUTH_ORIGIN: wiring.apiUrl, AUTH_GATEKEEPERS: vendors.join(","), INFEROPS_ENABLED: "true" };
  }
  return {
    INFEROPS_BASE_URL: wiring.apiUrl, INFEROPS_API_TOKEN: wiring.token,
    INFEROPS_WORKSPACE_ID: STOPGAP_WORKSPACE.id, INFEROPS_WORKSPACE_SLUG: STOPGAP_WORKSPACE.slug, INFEROPS_ENABLED: "true",
  };
}

// ---------------------------------------------------------------------------------------------
// The commands.

/** What the commands touch outside their own logic; `pnpm local`'s deps satisfy it. */
export type BackendDeps = Pick<CodingDeps, "root" | "env" | "runCli" | "launch" | "git" | "signal" | "processAlive" | "sleep" | "now"> & {
  /** Run argv to completion in `cwd` (the InferOps checkout's install, migrate and seed), bounded by `timeoutMs`. */
  runIn: (argv: string[], env: Record<string, string>, cwd: string, timeoutMs: number) => ProcessResult;
  isPortListening: (port: number) => Promise<boolean>;
  fetchImpl: typeof fetch;
  /** This checkout's backend record (see `readBackendRecord`), or null; injectable so an offline suite never sees a developer's live backend. */
  backendRecord: (root: string) => BackendRecord | null;
  /** The command line of a live process, or null when it cannot be read; how a recorded pid is told from a reused one. */
  processIdentity: (pid: number) => string | null;
};

export const BACKEND_SUBCOMMANDS = ["up", "status", "down", "verify", "env", "logs"] as const;

export interface BackendOptions {
  sub: (typeof BACKEND_SUBCOMMANDS)[number];
  /** `--dir`: an existing InferOps checkout to run as it is, instead of the managed worktree at the pin. */
  dir?: string;
  /** `--rev`: the revision for the managed worktree, instead of the pinned one. */
  rev?: string;
  /** `--fresh`: drop and recreate the database even when it was prepared at this revision. */
  fresh: boolean;
  /** `down --purge`: also drop the database and remove the managed worktree. */
  purge: boolean;
  /** `env`/`verify --stopgap`: the acme owner bearer instead of per-person sign-in. */
  stopgap: boolean;
  /** `--allow-local-config`: run a `--dir` checkout even though it holds `config/gcp-credentials.json`. */
  allowLocalConfig: boolean;
  timeoutSeconds: number;
  lines: number;
}

export interface BackendResult {
  exitCode: number;
  report: Record<string, unknown>;
  headline: string;
}

const OK = 0;
const FAILED = 1;
const STEP_TIMEOUT_MS = 15 * 60_000;
const READY_POLL_MS = 2_000;
const STOP_TIMEOUT_MS = 30_000;
/** Throwaway reserved-seed keys: valid nowhere but this database (inferops CI uses the same shape). */
const RESERVED_SEED_KEYS = { SYNTHETICS_PROBE_KEY: "iex_synthetic_inferos_local_0000", SMOKE_MCP_KEY: "iex_smoke_mcp_inferos_local_00000" } as const;
const DEFAULT_PG_ADMIN_URL = "postgres://postgres:postgres@localhost:5432/postgres";

/** What `pnpm local help inferops` prints: the verbs, and where the backend comes from and what it shares. */
export const BACKEND_USAGE = `Usage: pnpm local inferops <up|status|down|verify|env|logs> [--json] [--port N]
  up [--dir DIR] [--rev SHA] [--fresh] [--timeout S] [--allow-local-config]
                          Run the InferOps API from source beside this stack, seeded, headless; a running one is adopted
  status                  Ownership (running | not-running | port-in-use-by-other), pid, revision, database, /health/ready
  down [--purge]          Stop it (SIGTERM, SIGKILL after 30 s); --purge also drops the database and the managed worktrees
  verify [--stopgap]      Prove it without a browser: health, the acme ENG board with an owner bearer, the GROK board
                          through the stub SSO dance the gatekeeper runs
  env [--stopgap]         Print the wiring as export lines: sign-in, or with --stopgap the four connection variables
                          and the INFEROPS_LIVE_* set for the opt-in live suite
  logs [--lines N]        Tail .inferops/logs/inferops.log (every database step and the API's own log)

Where it comes from and what it shares
  Revision   custom-gatekeepers/gatekeeper-inferops/connection.json, compatibility.provider.revision (the contract
             pin). --rev runs another revision; --dir runs an existing checkout as it is (refused while it holds
             config/gcp-credentials.json unless --allow-local-config).
  Checkout   A detached git worktree of the sibling inferops repository (INFEROPS_REPO, else ../inferops beside this
             repository's main checkout) under .inferops/checkout-<sha12>, installed once with
             bun install --frozen-lockfile --ignore-scripts; never edited, never bootstrapped, no cloud credential.
  Port       This stack's port + ${API_PORT_SHIFT} (8787 → 18787; a pnpm wt worktree's 88xx → 188xx).
  Database   inferos_<port> in inferops' shared local Postgres (INFEROPS_PG_ADMIN_URL, default
             ${DEFAULT_PG_ADMIN_URL}). When nothing answers, up starts it the way
             inferops' own dev up does: docker network create \`inferlab\`, then docker compose -p \`inferops\`
             -f <sibling>/docker/compose.dev.yml up -d postgres. It is never stopped from here. The database is
             created, migrated and seeded at the revision (stamp .inferops/db-<database>.json); --fresh rebuilds it.
  Boot       NODE_CONFIG_ENV=factory (no secret layer, stub auth), the shell minus pnpm's variables and every name
             inferops' own config cascade reads; ready when /health/ready answers 200 within --timeout (default 180 s).
  State      .inferops/backend.json (0600), .inferops/logs/, .inferops/db-*.json, .inferops/checkout-*/
  Wiring     pnpm local start --inferops: per-person sign-in (INFERLAB_AUTH_ORIGIN); --stopgap: one acme owner bearer.
             Never both; a wiring already in the shell, .env.worktree, .dev.vars or .env is refused, not overridden.
`;

function pgAdminUrl(env: NodeJS.ProcessEnv): string {
  return env.INFEROPS_PG_ADMIN_URL || DEFAULT_PG_ADMIN_URL;
}

/** The admin URL with the database swapped in and TLS off (the compose Postgres serves a self-signed certificate). */
export function databaseUrl(adminUrl: string, database: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  url.search = "sslmode=disable";
  return url.toString();
}

/** A `psql` invocation whose argv never carries the password: it travels as `PGPASSWORD` instead. */
function psql(connection: string, args: string[], env: Record<string, string>): { argv: string[]; env: Record<string, string> } {
  const url = new URL(connection);
  const password = decodeURIComponent(url.password);
  url.password = "";
  return { argv: ["psql", url.toString(), ...args], env: password ? { ...env, PGPASSWORD: password } : env };
}

/** The only databases this module may drop: its own, named for a stack port. */
const OWN_DATABASE = /^inferos_\d{1,5}$/;
/** The highest stack port that leaves room for the API port. */
const MAX_STACK_PORT = 65_535 - API_PORT_SHIFT;

/** `/proc/<pid>/cmdline` on Linux, else `ps -o args=`; null when the process is gone or unreadable. */
export function processCommandLine(pid: number, runCli?: BackendDeps["runCli"]): string | null {
  try {
    const line = readFileSync(`/proc/${pid}/cmdline`, "latin1").split("\0").filter(Boolean).join(" ");
    if (line) return line;
  } catch {
    // Not Linux, or not ours to read.
  }
  if (!runCli) return null;
  const result = runCli(["ps", "-o", "args=", "-p", String(pid)], { PATH: process.env.PATH ?? "" });
  return result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

const fail = (command: string, report: Record<string, unknown>, headline: string): BackendResult =>
  ({ exitCode: FAILED, report: { ok: false, command, ...report }, headline });

function tailFile(path: string, lines: number): string[] {
  if (!existsSync(path)) return [];
  const all = readFileSync(path, "utf8").split("\n");
  if (all.at(-1) === "") all.pop();
  return all.slice(-lines);
}

function appendLog(log: string, text: string): void {
  mkdirSync(dirname(log), { recursive: true });
  appendFileSync(log, text);
}

/** Where the sibling inferops repository is: `INFEROPS_REPO`, else `inferops` beside the InferOS main checkout. */
function inferopsRepo(deps: BackendDeps): string {
  if (deps.env.INFEROPS_REPO) return deps.env.INFEROPS_REPO;
  const common = deps.git(["-C", deps.root, "rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout.trim();
  const main = common ? dirname(common) : deps.root;
  return join(dirname(main), "inferops");
}

interface ResolvedCheckout {
  checkout: string;
  revision: string;
  managed: boolean;
  dirty: boolean;
  installed: boolean;
}

/** The InferOps checkout to run: `--dir` as it is, else the managed worktree at the pin (created and installed once). */
function resolveCheckout(options: BackendOptions, deps: BackendDeps): ResolvedCheckout | { error: string } {
  if (options.dir) {
    const checkout = resolve(options.dir);
    if (!apiEntrypoint(checkout)) return { error: `${checkout} is not an InferOps checkout (no @inferlab/shared-api workspace with src/main.ts)` };
    if (existsSync(join(checkout, "config", "gcp-credentials.json")) && !options.allowLocalConfig) {
      return { error: `${checkout} holds config/gcp-credentials.json; its config/local.json and credentials would apply to the backend. Use the managed worktree (no --dir), or pass --allow-local-config knowingly` };
    }
    const head = deps.git(["-C", checkout, "rev-parse", "HEAD"]);
    if (head.exitCode !== 0) return { error: `${checkout}: git rev-parse HEAD failed: ${head.stderr.trim()}` };
    const dirty = deps.git(["-C", checkout, "status", "--porcelain"]).stdout.trim() !== "";
    return { checkout, revision: head.stdout.trim(), managed: false, dirty, installed: false };
  }
  const revision = options.rev ?? pinnedRevision(deps.root);
  if (!revision) return { error: "No InferOps revision: custom-gatekeepers/gatekeeper-inferops/connection.json has no compatibility.provider.revision, and --rev was not given" };
  if (!/^[0-9a-f]{40}$/.test(revision)) return { error: `--rev must be a full 40-character commit SHA, got ${revision}` };
  const checkout = join(backendPaths(deps.root).dir, `checkout-${revision.slice(0, 12)}`);
  if (!existsSync(join(checkout, "package.json"))) {
    const repo = inferopsRepo(deps);
    if (deps.git(["-C", repo, "cat-file", "-e", `${revision}^{commit}`]).exitCode !== 0) {
      const fetched = deps.git(["-C", repo, "fetch", "origin", revision]);
      if (fetched.exitCode !== 0) return { error: `${repo} does not have ${revision} and could not fetch it: ${fetched.stderr.trim() || "git fetch failed"}. Set INFEROPS_REPO to an inferops clone that has it` };
    }
    mkdirSync(dirname(checkout), { recursive: true });
    const added = deps.git(["-C", repo, "worktree", "add", "--detach", checkout, revision]);
    if (added.exitCode !== 0) return { error: `git worktree add failed for ${checkout}: ${added.stderr.trim()}` };
  }
  if (!apiEntrypoint(checkout)) return { error: `${checkout} at ${revision} has no @inferlab/shared-api workspace; this revision cannot serve as the backend` };
  let installed = false;
  if (!existsSync(join(checkout, "node_modules"))) {
    // --ignore-scripts: the root `prepare` would install git hooks into the developer's own inferops clone.
    const install = deps.runIn(["bun", "install", "--frozen-lockfile", "--ignore-scripts"], backendChildEnv(deps.env), checkout, STEP_TIMEOUT_MS);
    if (install.exitCode !== 0) return { error: `bun install failed in ${checkout} (exit ${install.exitCode}): ${install.stderr.trim().split("\n").at(-1) ?? ""}` };
    installed = true;
  }
  return { checkout, revision, managed: true, dirty: false, installed };
}

async function healthy(apiUrl: string, deps: BackendDeps): Promise<boolean> {
  try {
    const response = await deps.fetchImpl(`${apiUrl}/health/ready`, { redirect: "manual", signal: AbortSignal.timeout(3_000) });
    await response.body?.cancel();
    return response.status === 200;
  } catch {
    return false;
  }
}

/**
 * Shared local Postgres: already answering, or started from the sibling inferops repository's own
 * compose file under inferops' project name (what its `platform:up` does from the main checkout).
 * Never from the managed worktree: the service bind-mounts files from the compose file's directory,
 * and a worktree under `.inferops/` is removable.
 */
async function ensurePostgres(deps: BackendDeps): Promise<string | null> {
  const admin = new URL(pgAdminUrl(deps.env));
  const host = admin.hostname || "localhost";
  const port = admin.port || "5432";
  const ready = () => deps.runCli(["pg_isready", "-h", host, "-p", port, "-q"], { PATH: deps.env.PATH ?? "", HOME: deps.env.HOME ?? "" }).exitCode === 0;
  if (ready()) return null;
  if (host !== "localhost" && host !== "127.0.0.1") return `Postgres is not answering at ${host}:${port} (INFEROPS_PG_ADMIN_URL); start it and retry`;
  const compose = join(inferopsRepo(deps), "docker", "compose.dev.yml");
  if (!existsSync(compose)) return `Postgres is not listening on ${host}:${port}, and ${compose} does not exist to start it; run bun run dev up (or bunx turbo run platform:up) in the inferops main checkout, or set INFEROPS_REPO, and retry`;
  const docker = { PATH: deps.env.PATH ?? "", HOME: deps.env.HOME ?? "" };
  deps.runCli(["docker", "network", "create", "inferlab"], docker);
  const composeUp = deps.runCli(["docker", "compose", "-p", "inferops", "-f", compose, "up", "-d", "postgres"], docker);
  if (composeUp.exitCode !== 0) return `docker compose up postgres failed: ${composeUp.stderr.trim().split("\n").at(-1) ?? ""}`;
  const deadline = deps.now() + 60_000;
  while (!ready()) {
    if (deps.now() >= deadline) return `Postgres did not answer on ${host}:${port} within 60 s of docker compose up`;
    await deps.sleep(1_000);
  }
  return null;
}

/** Signal a process group we launched and wait for its leader to exit. */
async function stopGroup(pid: number, deps: BackendDeps): Promise<boolean> {
  const send = (signal: NodeJS.Signals) => {
    try {
      deps.signal(-pid, signal);
    } catch {
      // Already gone.
    }
  };
  send("SIGTERM");
  const deadline = deps.now() + STOP_TIMEOUT_MS;
  while (deps.processAlive(pid)) {
    if (deps.now() >= deadline) {
      send("SIGKILL");
      await deps.sleep(500);
      return !deps.processAlive(pid);
    }
    await deps.sleep(250);
  }
  return true;
}

/** The revision a database was last prepared at, so `up` reuses it instead of reseeding from scratch. */
function stampPath(root: string, database: string): string {
  return join(backendPaths(root).dir, `db-${database}.json`);
}

interface Inspection {
  record: BackendRecord | null;
  /** The recorded pid lives and is still our API (its command line names the recorded checkout). */
  alive: boolean;
  listening: boolean;
  backend: "running" | "not-running" | "port-in-use-by-other";
}

/** Whether the recorded pid is still the API we started, not a process that took the pid over after a reboot. */
export function ownsRecord(record: BackendRecord | null, deps: Pick<BackendDeps, "processAlive" | "processIdentity">): record is BackendRecord {
  if (!record || !deps.processAlive(record.pid)) return false;
  const identity = deps.processIdentity(record.pid);
  return identity !== null && identity.includes(record.checkout);
}

/**
 * Who holds the backend's port. A live record of our own process is the authority for where this
 * checkout's backend listens (it was written after readiness); without one, a listener on the
 * derived port is a stranger. A record whose pid is gone or reused is stale, never signalled.
 */
async function inspect(apiPort: number, deps: BackendDeps): Promise<Inspection> {
  const record = deps.backendRecord(deps.root);
  const alive = ownsRecord(record, deps);
  const listening = await deps.isPortListening(alive ? record.port : apiPort);
  const backend = !listening ? "not-running" : alive ? "running" : "port-in-use-by-other";
  return { record, alive, listening, backend };
}

const stranger = (apiPort: number) =>
  `Port ${apiPort} is in use by a process this checkout did not start (no live backend record for it); stop that process or move this stack to another port`;

async function up(stack: LocalStack, options: BackendOptions, deps: BackendDeps): Promise<BackendResult> {
  const command = "inferops up";
  const credentials = forbiddenCredentials(deps.env);
  if (credentials.length) {
    return fail(command, { credentials, error: `The shell holds credentials the backend must not run beside: ${credentials.join(", ")}. Unset them (a clean shell) and retry` },
      `inferops up refused: ${credentials.join(", ")} set`);
  }
  if (!Number.isInteger(stack.port) || stack.port < 1 || stack.port > MAX_STACK_PORT) {
    return fail(command, { error: `the stack port must be 1 to ${MAX_STACK_PORT} so the API port (stack port + ${API_PORT_SHIFT}) fits; got ${stack.port}` }, `inferops up: stack port ${stack.port} leaves no room for the API port`);
  }
  const ports = backendPorts(stack.port);
  const database = backendDatabase(stack.port);
  const paths = backendPaths(deps.root);
  const started = deps.now();
  const inspection = await inspect(ports.apiPort, deps);
  if (inspection.backend === "port-in-use-by-other") {
    return fail(command, { backend: inspection.backend, apiUrl: ports.apiUrl, error: stranger(ports.apiPort) }, `inferops up: ${ports.apiPort} is in use by another process`);
  }
  if (inspection.backend === "running" && inspection.record && await healthy(inspection.record.apiUrl, deps)) {
    const { record } = inspection;
    const asked = options.fresh ? "--fresh" : options.rev && options.rev !== record.revision ? `--rev ${options.rev.slice(0, 12)}`
      : options.dir && resolve(options.dir) !== record.checkout ? `--dir ${resolve(options.dir)}` : null;
    if (asked) {
      return fail(command, { backend: "running", apiUrl: record.apiUrl, revision: record.revision, checkout: record.checkout,
        error: `a backend is already running on ${record.apiUrl} at ${record.revision.slice(0, 12)} from ${record.checkout}; ${asked} needs a restart: run pnpm local inferops down first` },
        `inferops up: already running; run down before ${asked}`);
    }
    return {
      exitCode: OK,
      report: { ok: true, command, reused: true, apiUrl: record.apiUrl, port: record.port, database: record.database, checkout: record.checkout,
        revision: record.revision, managed: record.managed, dirty: record.dirty, signIn: signInSupported(record.checkout), fresh: false, log: record.log, recipe: recipe(options) },
      headline: `inferops up: already running on ${record.apiUrl} (rev ${record.revision.slice(0, 12)})`,
    };
  }
  if (inspection.record && inspection.alive) {
    return fail(command, { backend: "starting", apiUrl: inspection.record.apiUrl, pid: inspection.record.pid, error: `A backend (pid ${inspection.record.pid}) is recorded but not answering on ${inspection.record.port}; wait for it, or run pnpm local inferops down` },
      `inferops up: pid ${inspection.record.pid} recorded but not answering`);
  }
  if (inspection.record) rmSync(paths.record, { force: true }); // a dead or reused pid: stale record

  const resolved = resolveCheckout(options, deps);
  if ("error" in resolved) return fail(command, { error: resolved.error }, `inferops up: ${resolved.error}`);
  const { checkout, revision, managed, dirty } = resolved;
  const entry = apiEntrypoint(checkout)!;
  const initDb = initDbPath(checkout);
  const migration = migrationCommands(checkout);
  if (!initDb || !migration) return fail(command, { error: `${checkout} lacks init-db.sql or the migration package scripts (migrate, seed, seed:reserved)` }, "inferops up: checkout is missing its database tooling");

  const postgres = await ensurePostgres(deps);
  if (postgres) return fail(command, { error: postgres }, `inferops up: ${postgres}`);

  const admin = pgAdminUrl(deps.env);
  const dbUrl = databaseUrl(admin, database);
  const childEnv = backendChildEnv(deps.env, { DATABASE_URL: dbUrl }, checkout);
  const log = paths.log;
  appendLog(log, `\n=== pnpm local inferops up ${new Date().toISOString()} rev ${revision} db ${database} api ${ports.apiUrl}\n`);
  const run = (name: string, argv: string[], env: Record<string, string>, cwd: string): string | null => {
    const result = deps.runIn(argv, env, cwd, STEP_TIMEOUT_MS);
    appendLog(log, `$ ${name} (exit ${result.exitCode})\n${result.stdout}${result.stderr}\n`);
    return result.exitCode === 0 ? null : `${name} exited ${result.exitCode} in ${cwd}; see ${log}`;
  };
  const probe = psql(admin, ["-v", "ON_ERROR_STOP=1", "-tAc", `SELECT 1 FROM pg_database WHERE datname = '${database}'`], childEnv);
  const exists = deps.runIn(probe.argv, probe.env, checkout, STEP_TIMEOUT_MS);
  if (exists.exitCode !== 0) return fail(command, { error: `psql could not reach ${new URL(admin).host}: ${exists.stderr.trim()}` }, "inferops up: psql failed");
  let stampedRevision: string | null = null;
  try {
    stampedRevision = (JSON.parse(readFileSync(stampPath(deps.root, database), "utf8")) as { revision?: string }).revision ?? null;
  } catch {
    stampedRevision = null;
  }
  const fresh = options.fresh || exists.stdout.trim() !== "1" || stampedRevision !== revision;
  const steps: [string, string[], Record<string, string>, string][] = [];
  if (fresh) {
    // The old stamp goes first: an interrupted rebuild must not pass for a prepared database.
    rmSync(stampPath(deps.root, database), { force: true });
    const drop = psql(admin, ["-v", "ON_ERROR_STOP=1", "-q", "-c", `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`], childEnv);
    const create = psql(admin, ["-v", "ON_ERROR_STOP=1", "-q", "-c", `CREATE DATABASE ${database}`], childEnv);
    const init = psql(dbUrl, ["-v", "ON_ERROR_STOP=1", "-q", "-f", initDb], childEnv);
    steps.push(["drop database", drop.argv, drop.env, checkout], ["create database", create.argv, create.env, checkout], ["init-db.sql", init.argv, init.env, checkout]);
  }
  steps.push(
    ["migrate", migration.migrate, childEnv, migration.cwd],
    ["seed", migration.seed, childEnv, migration.cwd],
    ["seed:reserved", migration.seedReserved, { ...childEnv, ...RESERVED_SEED_KEYS }, migration.cwd],
  );
  const timings: Record<string, number> = {};
  for (const [name, argv, env, cwd] of steps) {
    const t0 = deps.now();
    const problem = run(name, argv, env, cwd);
    timings[name] = deps.now() - t0;
    if (problem) return fail(command, { step: name, error: problem, logTail: tailFile(log, 20) }, `inferops up failed at ${name}`);
  }
  writeFileSync(stampPath(deps.root, database), JSON.stringify({ database, revision, preparedAt: new Date().toISOString() }, null, 2) + "\n");

  const apiEnv = backendChildEnv(deps.env, {
    DATABASE_URL: dbUrl, API_PORT: String(ports.apiPort), VERSION: "inferos-local", NODE_CONFIG: ssoLayer(ports.inferosOrigin),
  }, checkout);
  mkdirSync(paths.logsDir, { recursive: true });
  const pid = deps.launch(["bun", entry], apiEnv, log, checkout);
  const deadline = deps.now() + options.timeoutSeconds * 1_000;
  for (;;) {
    if (!deps.processAlive(pid)) {
      return fail(command, { pid, error: `the API exited before answering on ${ports.apiUrl}; see ${log}`, logTail: tailFile(log, 30) }, "inferops up: the API exited");
    }
    if (await healthy(ports.apiUrl, deps)) break;
    if (deps.now() >= deadline) {
      const stopped = await stopGroup(pid, deps);
      const outcome = stopped ? "stopped it" : `could not stop pid ${pid}; stop it by hand before the next up`;
      return fail(command, { pid, error: `the API was not ready within ${options.timeoutSeconds} s on ${ports.apiUrl}; ${outcome}. See ${log}`, logTail: tailFile(log, 30) },
        `inferops up: not ready within ${options.timeoutSeconds} s`);
    }
    await deps.sleep(READY_POLL_MS);
  }
  const record: BackendRecord = {
    pid, port: ports.apiPort, apiUrl: ports.apiUrl, inferosPort: ports.inferosPort, database, checkout, revision, dirty, managed,
    startedAt: new Date().toISOString(), log,
  };
  writeBackendRecord(deps.root, record);
  const signIn = signInSupported(checkout);
  return {
    exitCode: OK,
    report: { ok: true, command, reused: false, apiUrl: ports.apiUrl, port: ports.apiPort, database, checkout, revision, managed, dirty, installed: resolved.installed,
      fresh, signIn, pid, log, elapsedMs: deps.now() - started, timings, recipe: recipe(options) },
    headline: `inferops up: ${ports.apiUrl} (rev ${revision.slice(0, 12)}, db ${database}${fresh ? ", fresh seeds" : ""}${signIn ? "" : ", no persona sign-in at this revision: use --stopgap"})`,
  };
}

function recipe(options: BackendOptions): string {
  return options.stopgap ? "pnpm local start --inferops --stopgap" : "pnpm local start --inferops";
}

async function status(stack: LocalStack, deps: BackendDeps): Promise<BackendResult> {
  const ports = backendPorts(stack.port);
  const { record, alive, listening, backend } = await inspect(ports.apiPort, deps);
  const where = alive ? { apiUrl: record!.apiUrl, port: record!.port } : { apiUrl: ports.apiUrl, port: ports.apiPort };
  const ok = backend === "running" && await healthy(where.apiUrl, deps);
  const report = {
    ok, command: "inferops status", backend, apiUrl: where.apiUrl, port: where.port, listening, healthy: ok,
    ...(backend === "port-in-use-by-other" ? { error: stranger(ports.apiPort) } : {}),
    ...(record ? { pid: record.pid, alive, database: record.database, checkout: record.checkout, revision: record.revision, managed: record.managed, dirty: record.dirty, startedAt: record.startedAt, log: record.log } : {}),
    ...(record && !alive ? { stale: true } : {}),
  };
  const headline = backend === "running" && ok ? `inferops running: ${where.apiUrl} (rev ${record!.revision.slice(0, 12)}, db ${record!.database})`
    : backend === "running" ? `inferops degraded: ${where.apiUrl} answers but /health/ready is not 200`
    : backend === "port-in-use-by-other" ? `inferops port-in-use-by-other: ${ports.apiPort} answers, but not with this checkout's backend`
    : record && !alive ? `inferops not-running: stale record for pid ${record.pid}`
    : `inferops not-running: nothing listens on ${ports.apiPort} (pnpm local inferops up)`;
  return { exitCode: ok ? OK : FAILED, report, headline };
}

async function down(stack: LocalStack, options: BackendOptions, deps: BackendDeps): Promise<BackendResult> {
  const command = "inferops down";
  const ports = backendPorts(stack.port);
  const paths = backendPaths(deps.root);
  const { record, alive, listening } = await inspect(ports.apiPort, deps);
  let stopped = false;
  let problem: string | null = null;
  if (record && alive) {
    stopped = await stopGroup(record.pid, deps);
    if (!stopped) problem = `pid ${record.pid} did not exit within ${STOP_TIMEOUT_MS / 1000} s`;
  } else if (listening) {
    problem = record
      ? `pid ${record.pid} is gone but something else listens on ${ports.apiPort}; it was not signalled`
      : `Something listens on ${ports.apiPort} but this checkout recorded no backend; stop it from its own terminal`;
  }
  if (record && (stopped || !alive)) rmSync(paths.record, { force: true });
  const purged: string[] = [];
  if (options.purge && !problem) {
    const database = record?.database ?? backendDatabase(stack.port);
    if (!OWN_DATABASE.test(database)) {
      problem = `refusing to drop ${database}: only this module's own inferos_<port> databases are dropped`;
    } else {
      const drop = psql(pgAdminUrl(deps.env), ["-v", "ON_ERROR_STOP=1", "-q", "-c", `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`], backendChildEnv(deps.env));
      const dropped = deps.runIn(drop.argv, drop.env, deps.root, STEP_TIMEOUT_MS);
      if (dropped.exitCode === 0) {
        purged.push(`database ${database}`);
        rmSync(stampPath(deps.root, database), { force: true });
      } else problem = `could not drop ${database}: ${dropped.stderr.trim()}`;
    }
    // Every managed worktree under .inferops/, whether or not a record still names one.
    const managed = existsSync(paths.dir)
      ? readdirSync(paths.dir, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name.startsWith("checkout-")).map(entry => join(paths.dir, entry.name))
      : [];
    for (const checkout of managed) {
      const removed = deps.git(["-C", inferopsRepo(deps), "worktree", "remove", "--force", checkout]);
      if (removed.exitCode === 0) purged.push(`worktree ${checkout}`);
      else problem = `could not remove ${checkout}: ${removed.stderr.trim()}`;
    }
  }
  const ok = problem === null;
  return {
    exitCode: ok ? OK : FAILED,
    report: { ok, command, stopped, ...(record ? { pid: record.pid } : {}), listening, purged, ...(problem ? { error: problem } : {}) },
    headline: !ok ? `inferops down: ${problem}` : stopped ? `inferops down: stopped pid ${record!.pid}${purged.length ? `, purged ${purged.join(", ")}` : ""}`
      : purged.length ? `inferops down: nothing was running; purged ${purged.join(", ")}` : "inferops down: nothing to stop",
  };
}

function logs(options: BackendOptions, deps: BackendDeps): BackendResult {
  const file = backendPaths(deps.root).log;
  const lines = tailFile(file, options.lines);
  return { exitCode: OK, report: { ok: true, command: "inferops logs", file, lines }, headline: lines.length ? `inferops log: ${file}` : `inferops log: nothing written yet at ${file}` };
}

/** Run one `pnpm local inferops <sub>` command for the InferOS stack `stack`. */
export async function runInferopsBackend(stack: LocalStack, options: BackendOptions, deps: BackendDeps): Promise<BackendResult> {
  switch (options.sub) {
    case "up": return up(stack, options, deps);
    case "status": return status(stack, deps);
    case "down": return down(stack, options, deps);
    case "logs": return logs(options, deps);
    case "verify": return verify(stack, deps);
    case "env": return envCommand(stack, options, deps);
  }
}

// ---------------------------------------------------------------------------------------------
// verify and env: the API as the gatekeeper sees it, without a browser and without InferOS.

/** The persona form refused the persona id: this revision does not know it. */
class UnknownPersona extends Error {
  readonly personaId: string;
  constructor(personaId: string) {
    super(`persona ${personaId} is unknown to this revision`);
    this.personaId = personaId;
  }
}

class StepFailure extends Error {
  readonly step: string;
  constructor(step: string, message: string) {
    super(message);
    this.step = step;
  }
}

interface Session {
  bearer: string;
  workspaces: { workspaceId: string; product: string }[];
}

async function call(deps: BackendDeps, step: string, url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await deps.fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(15_000), ...init });
  } catch (error) {
    throw new StepFailure(step, `${init.method ?? "GET"} ${new URL(url).pathname}: ${(error as Error).message}`);
  }
}

async function callJson<T>(deps: BackendDeps, step: string, url: string, init: RequestInit = {}): Promise<T> {
  const response = await call(deps, step, url, init);
  const text = await response.text();
  if (!response.ok) throw new StepFailure(step, `${init.method ?? "GET"} ${new URL(url).pathname} answered ${response.status}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new StepFailure(step, `${new URL(url).pathname} did not answer JSON`);
  }
}

/** A headless bearer for a catalog persona (`POST /auth/inferlab-login`, the stub-mode dev login). */
async function personaSession(deps: BackendDeps, step: string, apiUrl: string, personaId: string): Promise<Session> {
  const body = await callJson<{ token?: string; user?: { workspaces?: Session["workspaces"] } }>(deps, step, `${apiUrl}/auth/inferlab-login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ personaId, product: "inferops", transport: "bearer" }),
  });
  if (!body.token) throw new StepFailure(step, `/auth/inferlab-login answered without a bearer for ${personaId}`);
  return { bearer: body.token, workspaces: body.user?.workspaces ?? [] };
}

const authHeaders = (bearer: string, workspaceId?: string): Record<string, string> =>
  ({ authorization: `Bearer ${bearer}`, ...(workspaceId ? { "x-workspace-id": workspaceId } : {}) });

async function workspaceList(deps: BackendDeps, step: string, apiUrl: string, bearer: string): Promise<{ id: string; slug: string; product: string }[]> {
  return callJson(deps, step, `${apiUrl}/workspaces`, { headers: authHeaders(bearer) });
}

/** The board `identifier` in `workspaceId`, read the way the gatekeeper reads it: project list, then the board. */
async function boardSummary(deps: BackendDeps, step: string, apiUrl: string, bearer: string, workspaceId: string, identifier: string): Promise<{ project: string; states: number; issues: number }> {
  const { projects } = await callJson<{ projects: { id: string; identifier: string }[] }>(deps, step, `${apiUrl}/project/projects`, { headers: authHeaders(bearer, workspaceId) });
  const project = projects.find(p => p.identifier === identifier);
  if (!project) throw new StepFailure(step, `project ${identifier} is not in workspace ${workspaceId} (seen: ${projects.map(p => p.identifier).join(", ") || "none"})`);
  const board = await callJson<{ states?: { issues?: unknown[] }[]; columns?: { issues?: unknown[] }[] }>(deps, step, `${apiUrl}/project/board?${new URLSearchParams({ projectId: project.id })}`, { headers: authHeaders(bearer, workspaceId) });
  const columns = board.states ?? board.columns ?? [];
  return { project: identifier, states: columns.length, issues: columns.reduce((sum, column) => sum + (column.issues?.length ?? 0), 0) };
}

function inferopsWorkspace(session: Session, step: string): string {
  const workspace = session.workspaces.find(w => w.product === "inferops");
  if (!workspace) throw new StepFailure(step, "the persona holds no inferops workspace");
  return workspace.workspaceId;
}

/** The record of a backend that is running and answering, or the failure to report. */
async function requireBackend(stack: LocalStack, command: string, deps: BackendDeps): Promise<BackendRecord | BackendResult> {
  const ports = backendPorts(stack.port);
  const { record, backend } = await inspect(ports.apiPort, deps);
  if (backend !== "running" || !record) {
    return fail(command, { step: "backend", backend, apiUrl: ports.apiUrl, error: backend === "port-in-use-by-other" ? stranger(ports.apiPort) : `No backend of this checkout answers on ${ports.apiUrl}; start it with pnpm local inferops up` },
      `${command}: backend ${backend}`);
  }
  if (!await healthy(record.apiUrl, deps)) return fail(command, { step: "health", apiUrl: record.apiUrl, error: `${record.apiUrl}/health/ready is not 200` }, `${command}: backend unhealthy`);
  return record;
}

/** The stub SSO dance as InferOS's gatekeeper runs it in a browser: authorize page, persona form, PKCE code exchange. */
async function personaSignIn(deps: BackendDeps, apiUrl: string, redirectUri: string, personaId: string): Promise<Session> {
  const step = "sign-in";
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const state = randomBytes(12).toString("base64url");
  const authorize = { client_id: "inferos", redirect_uri: redirectUri, state, code_challenge: codeChallenge, code_challenge_method: "S256" };
  const page = await call(deps, step, `${apiUrl}/authorize?${new URLSearchParams(authorize)}`);
  await page.body?.cancel();
  if (page.status !== 200) throw new StepFailure(step, `GET /authorize answered ${page.status}: is ${new URL(redirectUri).origin} in InferOps' auth.sso.inferosOrigins?`);
  const cookies = typeof page.headers.getSetCookie === "function" ? page.headers.getSetCookie() : [page.headers.get("set-cookie") ?? ""];
  const csrf = cookies.map(cookie => /iex_authz_csrf=([^;]+)/.exec(cookie)?.[1]).find(Boolean);
  if (!csrf) throw new StepFailure(step, "GET /authorize set no persona CSRF cookie: this revision has no stub persona sign-in (inferops #2445)");
  const form = await call(deps, step, `${apiUrl}/authorize/persona`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: `iex_authz_csrf=${csrf}`, origin: new URL(apiUrl).origin },
    body: new URLSearchParams({ ...authorize, csrf, persona: personaId }).toString(),
  });
  await form.body?.cancel();
  const location = form.headers.get("location");
  if (form.status === 401) throw new UnknownPersona(personaId);
  if (form.status !== 302 || !location) throw new StepFailure(step, `POST /authorize/persona answered ${form.status} for ${personaId} (expected a 302 to ${redirectUri})`);
  const callback = new URL(location);
  if (callback.origin + callback.pathname !== redirectUri) throw new StepFailure(step, `the callback went to ${callback.origin}${callback.pathname}, not ${redirectUri}`);
  if (callback.searchParams.get("state") !== state) throw new StepFailure(step, "the callback's state does not match");
  const code = callback.searchParams.get("code");
  if (!code) throw new StepFailure(step, `the callback carried no code (${callback.searchParams.get("error") ?? "no error either"})`);
  const exchanged = await callJson<{ token?: string; user?: { workspaces?: Session["workspaces"] } }>(deps, step, `${apiUrl}/auth/token`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: "inferos", code, codeVerifier, redirectUri }),
  });
  if (!exchanged.token) throw new StepFailure(step, "POST /auth/token answered without a bearer");
  return { bearer: exchanged.token, workspaces: exchanged.user?.workspaces ?? [] };
}

/**
 * Reserved sign-in personas, newest first: the grokbot owner (inferops #2460) holds the GROK board;
 * the internal and canary inspector seats exist since the stub persona sign-in itself (#2445) and
 * hold no seeded board, so against an older revision the sign-in is still proven, the board is not.
 */
const SIGN_IN_PERSONAS = ["grokbot-owner", "internal-admin", "canary-inspector"] as const;
const SIGN_IN_BOARD = "GROK";
const STOPGAP_BOARD = "ENG";

async function verify(stack: LocalStack, deps: BackendDeps): Promise<BackendResult> {
  const command = "inferops verify";
  const record = await requireBackend(stack, command, deps);
  if ("exitCode" in record) return record;
  const { apiUrl } = record;
  const report: Record<string, unknown> = { ok: false, command, apiUrl, revision: record.revision, health: { ok: true } };
  const failed = (error: StepFailure): BackendResult =>
    ({ exitCode: FAILED, report: { ...report, ok: false, step: error.step, error: error.message }, headline: `${command} failed at ${error.step}: ${error.message}` });
  try {
    const owner = await personaSession(deps, "stopgap", apiUrl, STOPGAP_WORKSPACE.persona);
    const slugs = await workspaceList(deps, "stopgap", apiUrl, owner.bearer);
    const workspace = slugs.find(w => w.id === STOPGAP_WORKSPACE.id)?.slug;
    if (workspace !== STOPGAP_WORKSPACE.slug) throw new StepFailure("stopgap", `workspace ${STOPGAP_WORKSPACE.id} is not slug ${STOPGAP_WORKSPACE.slug} (seen ${workspace ?? "nothing"})`);
    report.stopgap = { ok: true, persona: STOPGAP_WORKSPACE.persona, workspace, ...await boardSummary(deps, "stopgap", apiUrl, owner.bearer, STOPGAP_WORKSPACE.id, STOPGAP_BOARD) };
  } catch (error) {
    if (!(error instanceof StepFailure)) throw error;
    report.stopgap = { ok: false, error: error.message };
    return failed(error);
  }
  const redirectUri = `${backendPorts(record.inferosPort).inferosOrigin}/gatekeeper/inferops/oauth`;
  if (!signInSupported(record.checkout)) {
    report.signIn = { ok: false, skipped: `revision ${record.revision.slice(0, 12)} predates the stub persona sign-in (inferops #2445); only the stopgap wiring applies` };
  } else {
    let persona: string = SIGN_IN_PERSONAS[0];
    try {
      let session: Session | null = null;
      const unknown: string[] = [];
      for (const candidate of SIGN_IN_PERSONAS) {
        persona = candidate;
        try {
          session = await personaSignIn(deps, apiUrl, redirectUri, candidate);
          break;
        } catch (error) {
          if (!(error instanceof UnknownPersona)) throw error;
          unknown.push(candidate);
        }
      }
      if (!session) throw new StepFailure("sign-in", `POST /authorize/persona answered 401 for every reserved persona (${unknown.join(", ")})`);
      const workspaceId = inferopsWorkspace(session, "sign-in");
      const { projects } = await callJson<{ projects: { id: string; identifier: string }[] }>(deps, "sign-in", `${apiUrl}/project/projects`, { headers: authHeaders(session.bearer, workspaceId) });
      const board = projects.find(p => p.identifier === SIGN_IN_BOARD) ?? projects[0];
      report.signIn = board
        ? { ok: true, persona, redirectUri, ...await boardSummary(deps, "sign-in", apiUrl, session.bearer, workspaceId, board.identifier) }
        : { ok: true, persona, redirectUri, project: null, states: null, issues: null, note: `signed in, but ${persona}'s workspace has no project board at this revision (the GROK board needs the grokbot seats, inferops #2460)` };
    } catch (error) {
      if (!(error instanceof StepFailure)) throw error;
      report.signIn = { ok: false, persona, redirectUri, error: error.message };
      return failed(error);
    }
  }
  const stopgap = report.stopgap as { states: number; issues: number };
  const signIn = report.signIn as { ok: boolean; persona?: string; project?: string | null; states?: number | null; issues?: number | null; skipped?: string };
  return {
    exitCode: OK,
    report: { ...report, ok: true },
    headline: `${command}: verified ${apiUrl}: ${STOPGAP_BOARD} ${stopgap.states} states/${stopgap.issues} issues by bearer; ` +
      (!signIn.ok ? `persona sign-in skipped (${signIn.skipped})`
        : signIn.project ? `${signIn.project} ${signIn.states} states/${signIn.issues} issues through persona sign-in as ${signIn.persona}`
        : `persona sign-in as ${signIn.persona} (no board in that workspace at this revision)`),
  };
}

const shellLine = (name: string, value: string) => `export ${name}='${value.replace(/'/g, `'\\''`)}'`;

async function envCommand(stack: LocalStack, options: BackendOptions, deps: BackendDeps): Promise<BackendResult> {
  const command = "inferops env";
  const record = await requireBackend(stack, command, deps);
  if ("exitCode" in record) return record;
  const { apiUrl } = record;
  let variables: Record<string, string>;
  if (!options.stopgap) {
    variables = wiringEnv({ mode: "sign-in", apiUrl }, deps.env);
  } else {
    try {
      const owner = await personaSession(deps, "stopgap", apiUrl, STOPGAP_WORKSPACE.persona);
      const wiki = (await workspaceList(deps, "stopgap", apiUrl, owner.bearer)).find(w => w.product === "infermind");
      variables = {
        ...wiringEnv({ mode: "stopgap", apiUrl, token: owner.bearer }, deps.env),
        INFEROPS_LIVE_BASE_URL: apiUrl, INFEROPS_LIVE_TOKEN: owner.bearer,
        INFEROPS_LIVE_WORKSPACE_ID: STOPGAP_WORKSPACE.id, INFEROPS_LIVE_WORKSPACE_SLUG: STOPGAP_WORKSPACE.slug,
        INFEROPS_LIVE_TENANT: "acme", INFEROPS_LIVE_PROJECT: STOPGAP_BOARD, INFEROPS_LIVE_POLICY_PROJECT: "CPOL", INFEROPS_LIVE_DISPATCH_PROJECT: "CODE",
        ...(wiki ? { INFEROPS_LIVE_WIKI_WORKSPACE_ID: wiki.id, INFEROPS_LIVE_WIKI_WORKSPACE_SLUG: wiki.slug } : {}),
      };
    } catch (error) {
      if (!(error instanceof StepFailure)) throw error;
      return fail(command, { step: error.step, apiUrl, error: error.message }, `${command} failed at ${error.step}: ${error.message}`);
    }
  }
  const mode = options.stopgap ? "stopgap" : "sign-in";
  return {
    exitCode: OK,
    report: { ok: true, command, mode, apiUrl, exports: Object.keys(variables), shell: Object.entries(variables).map(([name, value]) => shellLine(name, value)).join("\n") },
    headline: `${command}: ${mode} wiring for ${apiUrl} (${Object.keys(variables).length} variables; eval "$(pnpm local inferops env${options.stopgap ? " --stopgap" : ""})")`,
  };
}

// ---------------------------------------------------------------------------------------------
// What the rest of `pnpm local` asks of the backend.

/** The floor for per-person sign-in: inferops #2445, stub-mode reserved-persona sign-in on the central SSO page. */
const SIGN_IN_FLOOR = "3cf153566";

/**
 * `pnpm local start --inferops`: bring the backend up (or adopt it), choose the wiring, and return
 * the variables the stack starts with. Refuses when the shell (or the files the dev server reads)
 * already wires the gatekeeper somewhere: never two backends, never a silent override.
 */
export async function wireStack(stack: LocalStack, { stopgap }: { stopgap: boolean }, deps: BackendDeps): Promise<{ env: Record<string, string>; record: BackendRecord } | BackendResult> {
  const wired = existingWiring(localEnv(deps.root, deps.env), deps.root);
  if (wired.length) {
    return fail("start", { wiring: wired, error: `The gatekeeper is already wired by ${wired.join(", ")} (shell, .env.worktree, .dev.vars or .env); unset them to use --inferops, or start without it` },
      `start --inferops refused: ${wired.join(", ")} already set`);
  }
  const brought = await up(stack, { sub: "up", fresh: false, purge: false, stopgap, allowLocalConfig: false, timeoutSeconds: 180, lines: 50 }, deps);
  if (brought.exitCode !== OK) return brought;
  const record = deps.backendRecord(deps.root);
  if (!record) return fail("start", { error: "the backend came up but left no record" }, "start --inferops: no backend record");
  if (!stopgap && !signInSupported(record.checkout)) {
    return fail("start", { apiUrl: record.apiUrl, revision: record.revision, error: `InferOps ${record.revision.slice(0, 12)} predates the stub persona sign-in (inferops ${SIGN_IN_FLOOR}, #2445): use --stopgap, or pnpm local inferops up --rev <newer sha>` },
      "start --inferops: this revision has no persona sign-in; use --stopgap");
  }
  let env: Record<string, string>;
  if (stopgap) {
    try {
      const owner = await personaSession(deps, "stopgap", record.apiUrl, STOPGAP_WORKSPACE.persona);
      env = wiringEnv({ mode: "stopgap", apiUrl: record.apiUrl, token: owner.bearer }, deps.env);
    } catch (error) {
      if (!(error instanceof StepFailure)) throw error;
      return fail("start", { apiUrl: record.apiUrl, error: `could not mint the stopgap bearer: ${error.message}` }, "start --inferops: no stopgap bearer");
    }
  } else {
    env = wiringEnv({ mode: "sign-in", apiUrl: record.apiUrl }, deps.env);
  }
  const wiring = stopgap ? "stopgap" : "sign-in";
  const wiredRecord: BackendRecord = { ...record, wiring };
  writeBackendRecord(deps.root, wiredRecord);
  return { env, record: wiredRecord };
}

/** The backend as `pnpm local status` shows it: only while its process lives. Never a credential. */
export async function backendRow(stack: LocalStack, deps: BackendDeps): Promise<{ apiUrl: string; revision: string; wiring: "sign-in" | "stopgap" | null; healthy: boolean } | null> {
  const { record, alive, backend } = await inspect(backendPorts(stack.port).apiPort, deps);
  if (!record || !alive) return null;
  return { apiUrl: record.apiUrl, revision: record.revision, wiring: record.wiring ?? null, healthy: backend === "running" && await healthy(record.apiUrl, deps) };
}

/** The wiring the stack was last started with, while that backend still runs; null otherwise. */
export function recordedWiring(deps: Pick<BackendDeps, "root" | "processAlive" | "processIdentity" | "backendRecord">): "sign-in" | "stopgap" | null {
  const record = deps.backendRecord(deps.root);
  return ownsRecord(record, deps) ? record.wiring ?? null : null;
}

/** Record how a stack was just wired to the backend (by `start --inferops`, or the factory's connect). */
export function markWiring(deps: Pick<BackendDeps, "root" | "backendRecord">, wiring: "sign-in" | "stopgap"): void {
  const record = deps.backendRecord(deps.root);
  if (record) writeBackendRecord(deps.root, { ...record, wiring });
}

/** `stop` and a plain `start` forget how the stack was wired; the backend itself keeps running. */
export function clearWiring(deps: Pick<BackendDeps, "root" | "backendRecord">): void {
  const record = deps.backendRecord(deps.root);
  if (!record?.wiring) return;
  const { wiring: _wiring, ...rest } = record;
  writeBackendRecord(deps.root, rest);
}

/** `pnpm local reset`: drop a stopped backend's record and log (the database and checkout stay); a live one keeps both. */
export function resetBackend(deps: Pick<BackendDeps, "root" | "processAlive" | "processIdentity" | "backendRecord">): string[] {
  const paths = backendPaths(deps.root);
  const record = deps.backendRecord(deps.root);
  if (ownsRecord(record, deps)) return [];
  const removed: string[] = [];
  for (const path of [paths.record, paths.logsDir]) {
    if (!existsSync(path)) continue;
    rmSync(path, { recursive: true, force: true });
    removed.push(path);
  }
  return removed;
}
