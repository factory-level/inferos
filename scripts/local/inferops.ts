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

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { providerVariables } from "./runner.ts";

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
  "INIT_CWD", "NODE_OPTIONS", "NODE_ENV", "AUTH_MODE", "WORKTREE_OFFSET", "API_PORT", "DATABASE_URL",
  "NODE_CONFIG_DIR", "NODE_CONFIG", "NODE_CONFIG_ENV", "GCP_KMS_KEY", "GOOGLE_APPLICATION_CREDENTIALS",
];

/** The environment every InferOps step runs with: the shell minus {@link DROPPED_NAMES}, pinned to `factory`, plus `extra`. */
export function backendChildEnv(env: NodeJS.ProcessEnv, extra: Record<string, string> = {}): Record<string, string> {
  const child: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || DROPPED_ENV.test(name) || DROPPED_NAMES.includes(name)) continue;
    child[name] = value;
  }
  return { ...child, NODE_CONFIG_ENV: "factory", SUPPRESS_NO_CONFIG_WARNING: "1", ...extra };
}

/** node-config's `NODE_CONFIG` layer registering the InferOS origin as the `inferos` SSO client's redirect origin. */
export function ssoLayer(inferosOrigin: string): string {
  return JSON.stringify({ auth: { sso: { inferosOrigins: [new URL(inferosOrigin).origin] } } });
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
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
 * read). Model-provider keys come from runner.ts's `providerVariables`, so the two guards agree.
 */
const CLOUD_VAR = /^(?:AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|PROFILE)|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CREDENTIALS|GOOGLE_OAUTH_ACCESS_TOKEN|CLOUDSDK_AUTH_ACCESS_TOKEN|CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE|CLOUDFLARE_API_TOKEN|CLOUDFLARE_API_KEY|CF_API_TOKEN|CF_API_KEY|AZURE_CLIENT_SECRET|ARM_CLIENT_SECRET|PULUMI_ACCESS_TOKEN|NEON_API_KEY|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|VERCEL_TOKEN|FLY_API_TOKEN|DIGITALOCEAN_ACCESS_TOKEN|NPM_TOKEN)$/;

export function forbiddenCredentials(env: NodeJS.ProcessEnv): string[] {
  const names = new Set(providerVariables(env));
  for (const [name, value] of Object.entries(env)) if (value && CLOUD_VAR.test(name)) names.add(name);
  return [...names].toSorted();
}

/** The gatekeeper wirings a shell may already carry (see the gatekeeper's `connectionFromEnv` and `inferLabAuthOrigin`). */
const WIRING_NAMES = ["INFERLAB_AUTH_ORIGIN", "INFEROPS_BASE_URL", "INFEROPS_API_TOKEN", "INFEROPS_WORKSPACE_ID", "INFEROPS_WORKSPACE_SLUG"] as const;

/** Which wiring variables `env` sets, by name, so `start --inferops` never silently overrides or doubles one. */
export function existingWiring(env: NodeJS.ProcessEnv): string[] {
  return WIRING_NAMES.filter(name => Boolean(env[name])).toSorted();
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
