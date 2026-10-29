// `pnpm local factory up <sandbox>|status|doctor|down`: the software factory's sandbox
// environments, hosted by this checkout (InferOS is the vessel). A sandbox is a reproducible,
// credential-free set of local services an agent builds, runs, attacks and loads:
//
//   dev          InferOS `pnpm run-local` (this checkout) + the InferOps stack, started in ITS OWN
//                checkout with ITS OWN toolchain (`bun run dev up --docker --seed`), or, in image
//                mode (`--inferops-image`), the built InferOps API image run the way the InferOps
//                CI's local-deploy node runs it: no secret layer (so no KMS), its own database,
//                migrated and seeded from that checkout, published on 127.0.0.1 only
//   infra        dev + floci-gcp (an existing listener on the port is reused, else a container
//                is started, published on 127.0.0.1 only) + Wrangler for the bindings proof
//   verify       dev + the security/perf tool images (Semgrep, gitleaks, OSV-Scanner, Trivy, ZAP,
//                Artillery with its Playwright engine)
//   stage-probe  no services: only checks the smoke credentials are present, by name
//
// `doctor` reports one READY/FAIL line per check, each service's health JSON, and FAILS while a
// cloud, model-provider or prod credential is in the environment (smoke credentials are allowed
// in `stage-probe` only). `up` refuses in that case too. No credential value is ever read into a
// report. What the factory started is recorded in `.factory/sandbox.json`; `down` stops exactly
// that and leaves anything it merely reused running.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { CodingDeps, ProcessResult } from "./coding.ts";
import { providerVariables } from "./runner.ts";
import {
  configuredWorkers, probeWorkers, resolveLocalStack, stackOwnership,
  type DevServerRecord, type LocalStack,
} from "./stack.ts";

export const SANDBOXES = ["dev", "infra", "verify", "stage-probe"] as const;
export type Sandbox = (typeof SANDBOXES)[number];
export const FACTORY_COMMANDS = ["up", "status", "doctor", "down"] as const;
type FactoryCommand = (typeof FACTORY_COMMANDS)[number];

type ServiceName = "inferos" | "inferops" | "floci";

/** The services each sandbox runs. `stage-probe` runs none. */
export const SANDBOX_SERVICES: Record<Sandbox, readonly ServiceName[]> = {
  dev: ["inferos", "inferops"],
  infra: ["inferos", "inferops", "floci"],
  verify: ["inferos", "inferops"],
  "stage-probe": [],
};

/** The tool images `verify` needs locally (pulled ahead, so a gate never waits on a download). */
export const VERIFY_IMAGES = [
  "semgrep/semgrep:latest",
  "zricethezav/gitleaks:latest",
  "ghcr.io/google/osv-scanner:latest",
  "aquasec/trivy:latest",
  "ghcr.io/zaproxy/zaproxy:stable",
  "artilleryio/artillery:latest",
] as const;

/**
 * The stage smoke credentials, by name. Only `stage-probe` may hold them (and must); in every other
 * sandbox their presence is a failed credential check. `GROKBOT_PERSONA_*` are proposed names.
 * ponytail: the names are fixed here; upgrade path is reading them from the stage config once the
 * grokbot persona smoke (release graph node 10) lands.
 */
export const SMOKE_CREDENTIAL_VARS = [
  "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "GROKBOT_PERSONA_USER", "GROKBOT_PERSONA_PASSWORD",
] as const;

/**
 * Cloud and deploy credentials no sandbox may hold. Model-provider keys come from runner.ts's
 * `providerVariables`, so the two guards cannot drift.
 * ponytail: a name list, not value scanning; a credential under an unlisted name passes. Upgrade
 * path: also run gitleaks over the environment dump in `doctor`.
 */
const CLOUD_VAR = /^(?:AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|PROFILE)|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CREDENTIALS|GOOGLE_OAUTH_ACCESS_TOKEN|CLOUDSDK_AUTH_ACCESS_TOKEN|CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE|CLOUDFLARE_API_TOKEN|CLOUDFLARE_API_KEY|CF_API_TOKEN|CF_API_KEY|AZURE_CLIENT_SECRET|ARM_CLIENT_SECRET|PULUMI_ACCESS_TOKEN|NEON_API_KEY|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|VERCEL_TOKEN|FLY_API_TOKEN|DIGITALOCEAN_ACCESS_TOKEN|NPM_TOKEN)$/;

/** The credential variables `sandbox` must not hold, by name only, sorted. */
export function forbiddenCredentials(env: NodeJS.ProcessEnv, sandbox: Sandbox): string[] {
  const names = new Set(providerVariables(env));
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    if (CLOUD_VAR.test(name)) names.add(name);
    if (sandbox !== "stage-probe" && (SMOKE_CREDENTIAL_VARS as readonly string[]).includes(name)) names.add(name);
  }
  return [...names].toSorted();
}

/** What the factory touches outside its own logic; `pnpm local`'s deps satisfy it as they are. */
export type FactoryDeps = Pick<CodingDeps, "root" | "env" | "runCli" | "launch" | "signal" | "processAlive" | "sleep" | "now"> & {
  /** Run argv to completion in `cwd` (the InferOps checkout's migrate and seed), bounded by `timeoutMs`. */
  runIn: (argv: string[], env: Record<string, string>, cwd: string, timeoutMs: number) => ProcessResult;
  isPortListening: (port: number) => Promise<boolean>;
  devServerRecord: (recordPath: string) => DevServerRecord | null;
  fetchImpl: typeof fetch;
};

/** One factory command's outcome, shaped like the rest of `pnpm local`. */
export interface FactoryResult {
  exitCode: number;
  report: Record<string, unknown>;
  headline: string;
}

/** Where the services of a sandbox are, from flags and the environment. */
export interface FactoryConfig {
  inferos: LocalStack;
  /** The InferOps checkout `bun run dev up` runs in (image mode: migrate + seed run there); unset means the inferops service FAILs. */
  inferopsDir: string | null;
  /** Image mode: the InferOps API image to run (best by digest); null runs `bun run dev up`. */
  inferopsImage: string | null;
  /** Image mode: the database the container uses, recreated by `up` in the Postgres at `pgAdminUrl`. */
  inferopsDb: string;
  /** Image mode: an admin connection to the local Postgres (the InferOps compose one by default). */
  pgAdminUrl: string;
  inferopsUrl: string;
  flociPort: number;
  flociImage: string;
}

/**
 * Read the configuration. The InferOps API port follows that checkout's worktree offset
 * (8080 + offset x 100), given as `FACTORY_INFEROPS_OFFSET`.
 * ponytail: the offset is not read from the InferOps checkout's `config/local.json`, which also holds
 * that checkout's secrets; upgrade path is an InferOps CLI command that prints only its ports.
 */
export function factoryConfig(root: string, env: NodeJS.ProcessEnv, inferopsDir?: string, inferopsImage?: string): FactoryConfig {
  const dir = inferopsDir ?? env.FACTORY_INFEROPS_DIR;
  const image = inferopsImage ?? env.FACTORY_INFEROPS_IMAGE ?? null;
  if (image !== null && !/^\w[\w.-]*(?::\d+)?(?:\/\w[\w.-]*)*(?::\w[\w.-]*)?(?:@sha256:[0-9a-f]{64})?$/.test(image)) {
    throw new Error("--inferops-image / FACTORY_INFEROPS_IMAGE must be an image reference (registry/name[:tag][@sha256:digest])");
  }
  const inferopsDb = env.FACTORY_INFEROPS_DB ?? "inferos_factory";
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(inferopsDb)) throw new Error("FACTORY_INFEROPS_DB must be a lower-case Postgres identifier");
  const offset = Number(env.FACTORY_INFEROPS_OFFSET ?? 0);
  if (!Number.isInteger(offset) || offset < 0 || offset > 500) throw new Error("FACTORY_INFEROPS_OFFSET must be a whole number from 0 to 500");
  const flociPort = Number(env.FACTORY_FLOCI_PORT ?? 4588);
  if (!Number.isInteger(flociPort) || flociPort < 1 || flociPort > 65535) throw new Error("FACTORY_FLOCI_PORT must be a TCP port");
  return {
    inferos: resolveLocalStack(root, [], env),
    inferopsDir: dir ? resolve(dir) : null,
    inferopsImage: image,
    inferopsDb,
    pgAdminUrl: env.FACTORY_PG_ADMIN_URL ?? "postgres://postgres:postgres@localhost:5432/postgres",
    inferopsUrl: env.FACTORY_INFEROPS_URL ?? `http://127.0.0.1:${8080 + offset * 100}`,
    flociPort,
    flociImage: env.FACTORY_FLOCI_IMAGE ?? "floci/floci-gcp:latest",
  };
}

/** What `up` started (or reused), so `down` stops exactly that. */
export interface SandboxState {
  sandbox: Sandbox;
  startedAt: string;
  services: Partial<Record<ServiceName, { pid?: number; container?: string; image?: string; database?: string; log?: string; startedByFactory: boolean }>>;
}

export const stateFile = (root: string) => join(root, ".factory", "sandbox.json");

export function readState(root: string): SandboxState | null {
  try {
    return JSON.parse(readFileSync(stateFile(root), "utf8"));
  } catch {
    return null;
  }
}

export function writeState(root: string, state: SandboxState): void {
  mkdirSync(dirname(stateFile(root)), { recursive: true });
  writeFileSync(stateFile(root), JSON.stringify(state, null, 2) + "\n");
}

/** One doctor line. */
export interface Check {
  name: string;
  status: "READY" | "FAIL";
  detail: string;
  health?: unknown;
}

const FLOCI_CONTAINER = "inferos-factory-floci";
const INFEROPS_CONTAINER = "inferos-factory-inferops";

/** Docker needs only these; nothing else of this environment reaches it. */
const dockerEnv = (deps: FactoryDeps): Record<string, string> => ({ PATH: deps.env.PATH ?? "", HOME: deps.env.HOME ?? "" });

async function getJson(url: string, deps: FactoryDeps): Promise<{ status: number | null; body: unknown }> {
  try {
    const response = await deps.fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(3_000) });
    const text = await response.text();
    let body: unknown = text.slice(0, 2_000);
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON: keep the (bounded) text.
    }
    return { status: response.status, body };
  } catch (error) {
    return { status: null, body: (error as Error).message };
  }
}

async function inferosHealth(config: FactoryConfig, deps: FactoryDeps): Promise<Check> {
  const stack = config.inferos;
  const listening = await deps.isPortListening(stack.port);
  const ownership = stackOwnership(listening, deps.devServerRecord(stack.recordPath), stack.port);
  if (ownership !== "running") {
    return { name: "service:inferos", status: "FAIL", detail: `${stack.url}: ${ownership}`, health: { url: stack.url, ownership } };
  }
  const workers = await probeWorkers(stack.url, configuredWorkers(deps.root), deps.fetchImpl);
  const failing = workers.filter(worker => worker.state !== "up").map(worker => worker.name);
  // A router that answers 404 for the document is up but serving no shell (a stale asset manifest).
  const shell = (await getJson(`${stack.url}/`, deps)).status;
  if (shell !== 200) failing.push(`shell (/ answered ${shell ?? "nothing"})`);
  return {
    name: "service:inferos", status: failing.length ? "FAIL" : "READY",
    detail: failing.length ? `${failing.join(", ")} not answering on ${stack.url}` : `${workers.length} Workers and the shell answering on ${stack.url}`,
    health: { url: stack.url, ownership, shell, workers: workers.map(({ name, state, status }) => ({ name, state, status })) },
  };
}

/**
 * `/health/ready` answers 200 even while Postgres is down; the body's `status` is the verdict. A body
 * without one (an older API) is judged by the HTTP status alone.
 */
function readyBodyOk(body: unknown): boolean {
  const status = body && typeof body === "object" ? (body as { status?: unknown }).status : undefined;
  return status === undefined || (typeof status === "string" && /^(?:ok|up|ready)$/.test(status));
}

async function inferopsHealth(config: FactoryConfig, deps: FactoryDeps): Promise<Check> {
  const url = `${config.inferopsUrl}/health/ready`;
  const { status, body } = await getJson(url, deps);
  const ready = status === 200 && readyBodyOk(body);
  const configured = config.inferopsImage ? `image ${config.inferopsImage} on database ${config.inferopsDb}`
    : config.inferopsDir ? `checkout ${config.inferopsDir}` : "no InferOps checkout configured (--inferops-dir or FACTORY_INFEROPS_DIR)";
  return {
    name: "service:inferops", status: ready ? "READY" : "FAIL",
    detail: ready ? `${url} answered 200 (${configured})`
      : `${url} ${status === null ? "did not answer" : status === 200 ? "answered 200 but not ready" : `answered ${status}`}; ${configured}`,
    health: { url, status, body },
  };
}

async function flociHealth(config: FactoryConfig, deps: FactoryDeps): Promise<Check> {
  const url = `http://127.0.0.1:${config.flociPort}/health`;
  const { status, body } = await getJson(url, deps);
  return {
    name: "service:floci", status: status === 200 ? "READY" : "FAIL",
    detail: status === 200 ? `${url} answered 200` : `${url} ${status === null ? "did not answer" : `answered ${status}`}`,
    health: { url, status, body },
  };
}

const HEALTH: Record<ServiceName, (config: FactoryConfig, deps: FactoryDeps) => Promise<Check>> = {
  inferos: inferosHealth, inferops: inferopsHealth, floci: flociHealth,
};

function credentialCheck(sandbox: Sandbox, deps: FactoryDeps): Check {
  const found = forbiddenCredentials(deps.env, sandbox);
  return {
    name: "credentials", status: found.length ? "FAIL" : "READY",
    detail: found.length ? `cloud/provider/prod credentials present (names only): ${found.join(", ")}; unset them for the sandbox`
      : "no cloud, model-provider or prod credential in the environment",
  };
}

function smokeCheck(deps: FactoryDeps): Check {
  const missing = SMOKE_CREDENTIAL_VARS.filter(name => !deps.env[name]);
  return {
    name: "smoke-credentials", status: missing.length ? "FAIL" : "READY",
    detail: missing.length ? `missing (names only): ${missing.join(", ")}` : `present (names only): ${SMOKE_CREDENTIAL_VARS.join(", ")}`,
  };
}

function toolChecks(sandbox: Sandbox, deps: FactoryDeps): Check[] {
  const checks: Check[] = [];
  if (sandbox === "infra" || sandbox === "verify") {
    const wrangler = join(deps.root, "node_modules", ".bin", "wrangler");
    checks.push({ name: "tool:wrangler", status: existsSync(wrangler) ? "READY" : "FAIL", detail: existsSync(wrangler) ? wrangler : "run pnpm install" });
  }
  if (sandbox === "infra" || sandbox === "verify") {
    const docker = deps.runCli(["docker", "version", "--format", "{{.Server.Version}}"], dockerEnv(deps));
    checks.push({ name: "tool:docker", status: docker.exitCode === 0 ? "READY" : "FAIL", detail: docker.exitCode === 0 ? `server ${docker.stdout.trim()}` : docker.stderr.trim() || "docker is not reachable" });
  }
  if (sandbox === "verify") {
    for (const image of VERIFY_IMAGES) {
      const present = deps.runCli(["docker", "image", "inspect", "--format", "{{.Id}}", image], dockerEnv(deps)).exitCode === 0;
      checks.push({ name: `tool:${image}`, status: present ? "READY" : "FAIL", detail: present ? "image present" : `docker pull ${image}` });
    }
  }
  return checks;
}

async function allChecks(sandbox: Sandbox, config: FactoryConfig, deps: FactoryDeps): Promise<Check[]> {
  const services = await Promise.all(SANDBOX_SERVICES[sandbox].map(name => HEALTH[name](config, deps)));
  return [
    credentialCheck(sandbox, deps),
    ...(sandbox === "stage-probe" ? [smokeCheck(deps)] : []),
    ...services,
    ...toolChecks(sandbox, deps),
  ];
}

function summarize(command: string, sandbox: Sandbox, checks: Check[], extra: Record<string, unknown> = {}): FactoryResult {
  const failed = checks.filter(check => check.status === "FAIL");
  const ok = failed.length === 0;
  const lines = checks.map(check => `  ${check.status.padEnd(5)} ${check.name}: ${check.detail}`);
  return {
    exitCode: ok ? 0 : 1,
    report: { ok, command: `factory ${command}`, sandbox, checks, ...extra },
    headline: `factory ${command} ${sandbox}: ${ok ? "READY" : `FAIL (${failed.map(check => check.name).join(", ")})`}\n${lines.join("\n")}`,
  };
}

/**
 * The InferOps child's environment: this one minus what pnpm injects into a script's environment,
 * so the bun toolchain never sees pnpm/npm configuration.
 */
export function inferopsChildEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const child: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || /^(?:npm_|PNPM_|pnpm_)/.test(name) || name === "INIT_CWD" || name === "NODE_OPTIONS") continue;
    child[name] = value;
  }
  return child;
}

const asStringEnv = (env: NodeJS.ProcessEnv) =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));

/** Start this checkout's `run-local` detached, in its own process group, logging under `.factory/logs`. */
export function launchInferos(stack: LocalStack, deps: Pick<FactoryDeps, "root" | "env" | "launch">): { pid: number; log: string; startedByFactory: true } {
  const logDir = join(deps.root, ".factory", "logs");
  mkdirSync(logDir, { recursive: true });
  const log = join(logDir, "inferos.log");
  const pid = deps.launch([process.execPath, join(deps.root, "scripts", "run-local.ts"), "--port", String(stack.port)], asStringEnv(deps.env), log, deps.root);
  return { pid, log, startedByFactory: true };
}

/** `postgres://user:pass@host:port/db?x` with the host and database swapped; the credentials stay as given. */
export function databaseUrl(adminUrl: string, database: string, host?: string): string {
  const url = new URL(adminUrl);
  if (host) url.hostname = host;
  url.pathname = `/${database}`;
  url.search = "sslmode=disable";
  return url.toString();
}

/**
 * Image mode: recreate the factory's own database, prepare it from the InferOps checkout the way
 * InferOps CI's `db-ephemeral-setup` does (init-db.sql, migrate, seed, the reserved seed with
 * throwaway keys), then run the image the way its `local-deploy` node does: `NODE_CONFIG_ENV=factory`
 * (no secret layer, so nothing is KMS-decrypted and no credential is mounted), published on
 * 127.0.0.1 only, the Docker socket never mounted. Returns the problems, empty on success.
 */
export function startInferopsImage(config: FactoryConfig, deps: FactoryDeps, log: string): { problems: string[]; service?: SandboxState["services"]["inferops"] } {
  const image = config.inferopsImage!;
  const dir = config.inferopsDir;
  if (!dir) return { problems: ["inferops: image mode needs --inferops-dir (the checkout at the image's commit): the image carries no migrations, so migrate + seed run there"] };
  if (!existsSync(join(dir, "db", "init-db.sql"))) return { problems: [`inferops: ${dir} is not an InferOps checkout (no db/init-db.sql)`] };
  const port = Number(new URL(config.inferopsUrl).port || 80);
  const host = new URL(config.inferopsUrl).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") return { problems: [`inferops: image mode publishes on 127.0.0.1 only; ${config.inferopsUrl} is not local`] };
  const db = config.inferopsDb;
  const url = databaseUrl(config.pgAdminUrl, db);
  const env = { ...inferopsChildEnv(deps.env), DATABASE_URL: url };
  // Throwaway values: this database is the factory's own, recreated on every `up`, valid nowhere else.
  const reserved = { ...env, SYNTHETICS_PROBE_KEY: "iex_synthetic_factory_local_0000", SMOKE_MCP_KEY: "iex_smoke_mcp_factory_local_0000" };
  const steps: [string, string[], Record<string, string>][] = [
    ["drop database", ["psql", config.pgAdminUrl, "-v", "ON_ERROR_STOP=1", "-q", "-c", `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`], env],
    ["create database", ["psql", config.pgAdminUrl, "-v", "ON_ERROR_STOP=1", "-q", "-c", `CREATE DATABASE ${db}`], env],
    ["init-db.sql", ["psql", url, "-v", "ON_ERROR_STOP=1", "-q", "-f", "db/init-db.sql"], env],
    ["migrate", ["bunx", "turbo", "run", "migrate"], env],
    ["seed", ["bunx", "turbo", "run", "seed"], env],
    ["seed:reserved", ["bunx", "turbo", "run", "seed:reserved"], reserved],
  ];
  for (const [name, argv, stepEnv] of steps) {
    const result = deps.runIn(argv, stepEnv, dir, 900_000);
    appendFileSync(log, `$ ${name}: ${argv.slice(0, 3).join(" ")} ... (exit ${result.exitCode})\n${result.stdout}${result.stderr}\n`);
    if (result.exitCode !== 0) return { problems: [`inferops: ${name} exited ${result.exitCode} in ${dir}; see ${log}`] };
  }
  deps.runCli(["docker", "rm", "-f", INFEROPS_CONTAINER], dockerEnv(deps));
  const run = deps.runCli([
    "docker", "run", "-d", "--name", INFEROPS_CONTAINER,
    "--add-host", "host.docker.internal:host-gateway",
    "-p", `127.0.0.1:${port}:8080`,
    "-e", "NODE_ENV=production", "-e", "NODE_CONFIG_ENV=factory", "-e", "SUPPRESS_NO_CONFIG_WARNING=1",
    "-e", "API_PORT=8080", "-e", `DATABASE_URL=${databaseUrl(config.pgAdminUrl, db, "host.docker.internal")}`,
    "-e", "VERSION=factory-image",
    image,
  ], dockerEnv(deps));
  if (run.exitCode !== 0) return { problems: [`inferops: docker run ${image} failed: ${run.stderr.trim()}`] };
  return { problems: [], service: { container: INFEROPS_CONTAINER, image, database: db, log, startedByFactory: true } };
}

/** Whether a container the factory started is still running. */
const containerRunning = (name: string, deps: FactoryDeps) =>
  deps.runCli(["docker", "inspect", "-f", "{{.State.Running}}", name], dockerEnv(deps)).stdout.trim() === "true";

async function startServices(sandbox: Sandbox, config: FactoryConfig, deps: FactoryDeps, state: SandboxState): Promise<string[]> {
  const problems: string[] = [];
  const logDir = join(deps.root, ".factory", "logs");
  mkdirSync(logDir, { recursive: true });
  for (const service of SANDBOX_SERVICES[sandbox]) {
    if (service === "inferos") {
      const stack = config.inferos;
      const ownership = stackOwnership(await deps.isPortListening(stack.port), deps.devServerRecord(stack.recordPath), stack.port);
      if (ownership === "running") {
        state.services.inferos = { pid: deps.devServerRecord(stack.recordPath)?.pid, startedByFactory: false };
      } else if (ownership === "port-in-use-by-other") {
        problems.push(`inferos: port ${stack.port} is in use by a process this checkout did not start`);
      } else {
        state.services.inferos = launchInferos(stack, deps);
      }
    } else if (service === "inferops") {
      if ((await inferopsHealth(config, deps)).status === "READY") {
        state.services.inferops = { startedByFactory: false };
      } else if (config.inferopsImage) {
        const log = join(logDir, "inferops.log");
        writeFileSync(log, "");
        const started = startInferopsImage(config, deps, log);
        problems.push(...started.problems);
        if (started.service) state.services.inferops = started.service;
      } else if (!config.inferopsDir) {
        problems.push("inferops: no InferOps checkout configured (--inferops-dir or FACTORY_INFEROPS_DIR); not started");
      } else if (!existsSync(join(config.inferopsDir, "scripts", "dev.mjs"))) {
        problems.push(`inferops: ${config.inferopsDir} is not an InferOps checkout (no scripts/dev.mjs)`);
      } else {
        // Its own directory, its own toolchain: bun, never pnpm.
        const log = join(logDir, "inferops.log");
        const pid = deps.launch(["bun", "run", "dev", "up", "--docker", "--seed"], inferopsChildEnv(deps.env), log, config.inferopsDir);
        state.services.inferops = { pid, log, startedByFactory: true };
      }
    } else {
      if ((await flociHealth(config, deps)).status === "READY") {
        state.services.floci = { startedByFactory: false };
      } else {
        // Published on loopback only; no Docker socket is mounted.
        const run = deps.runCli(["docker", "run", "-d", "--name", FLOCI_CONTAINER, "-p", `127.0.0.1:${config.flociPort}:4588`, config.flociImage], dockerEnv(deps));
        if (run.exitCode === 0) state.services.floci = { container: FLOCI_CONTAINER, startedByFactory: true };
        else problems.push(`floci: docker run failed: ${run.stderr.trim()}`);
      }
    }
  }
  return problems;
}

async function up(sandbox: Sandbox, config: FactoryConfig, deps: FactoryDeps, timeoutMs: number): Promise<FactoryResult> {
  const credentials = credentialCheck(sandbox, deps);
  if (credentials.status === "FAIL") {
    return summarize("up", sandbox, [credentials], { refused: "a sandbox never starts with cloud, provider or prod credentials" });
  }
  const existing = readState(deps.root);
  if (existing && existing.sandbox !== sandbox) {
    return {
      exitCode: 1, report: { ok: false, command: "factory up", sandbox, error: `sandbox ${existing.sandbox} is up; run pnpm local factory down first` },
      headline: `factory up ${sandbox}: refused, sandbox ${existing.sandbox} is up (pnpm local factory down)`,
    };
  }
  const state: SandboxState = existing ?? { sandbox, startedAt: new Date(deps.now()).toISOString(), services: {} };
  const problems = await startServices(sandbox, config, deps, state);
  writeState(deps.root, state);
  // Wait for every service to become healthy, or for one the factory launched to die.
  const deadline = deps.now() + timeoutMs;
  let checks = await allChecks(sandbox, config, deps);
  while (checks.some(check => check.status === "FAIL" && check.name.startsWith("service:")) && deps.now() < deadline) {
    const dead = Object.entries(state.services).filter(([name, s]) => s.startedByFactory &&
      (s.pid !== undefined ? !deps.processAlive(s.pid) : name === "inferops" && s.container !== undefined && !containerRunning(s.container, deps)));
    const pending = checks.filter(check => check.status === "FAIL" && check.name.startsWith("service:"))
      .filter(check => !dead.some(([name]) => check.name === `service:${name}`))
      .filter(check => !(check.name === "service:inferops" && !state.services.inferops));
    if (!pending.length) break;
    await deps.sleep(2_000);
    checks = await allChecks(sandbox, config, deps);
  }
  for (const [name, service] of Object.entries(state.services)) {
    if (service.pid !== undefined && service.startedByFactory && !deps.processAlive(service.pid)) {
      problems.push(`${name}: pid ${service.pid} exited; see ${service.log}`);
    }
  }
  const inferops = state.services.inferops;
  if (inferops?.container === INFEROPS_CONTAINER && inferops.startedByFactory && checks.some(check => check.name === "service:inferops" && check.status === "FAIL")) {
    const logs = deps.runCli(["docker", "logs", "--tail", "40", INFEROPS_CONTAINER], dockerEnv(deps));
    if (inferops.log) appendFileSync(inferops.log, `$ docker logs --tail 40 ${INFEROPS_CONTAINER}\n${logs.stdout}${logs.stderr}\n`);
    problems.push(`inferops: container ${INFEROPS_CONTAINER} ${containerRunning(INFEROPS_CONTAINER, deps) ? "is running but not ready" : "exited"}; see ${inferops.log}`);
  }
  const result = summarize("up", sandbox, checks, { state: stateFile(deps.root), services: state.services, problems });
  if (problems.length) {
    result.headline += `\n${problems.map(problem => `  note  ${problem}`).join("\n")}`;
  }
  return result;
}

/** Signal a process group the factory launched and wait for its leader to exit. */
export async function stopGroup(pid: number, deps: Pick<FactoryDeps, "signal" | "processAlive" | "sleep" | "now">): Promise<boolean> {
  const send = (signal: NodeJS.Signals) => {
    try {
      deps.signal(-pid, signal);
    } catch {
      // Already gone.
    }
  };
  send("SIGTERM");
  const deadline = deps.now() + 30_000;
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

async function down(deps: FactoryDeps): Promise<FactoryResult> {
  const state = readState(deps.root);
  if (!state) {
    return { exitCode: 0, report: { ok: true, command: "factory down", stopped: [], note: "no sandbox recorded" }, headline: "factory down: no sandbox recorded" };
  }
  const stopped: string[] = [];
  const left: string[] = [];
  const failed: string[] = [];
  const exited: string[] = [];
  for (const [name, service] of Object.entries(state.services)) {
    if (!service.startedByFactory) {
      left.push(name);
    } else if (service.container) {
      const removed = deps.runCli(["docker", "rm", "-f", service.container], dockerEnv(deps));
      (removed.exitCode === 0 ? stopped : failed).push(name);
    } else if (service.pid !== undefined && !deps.processAlive(service.pid)) {
      // Already gone: never signal a group id the kernel may have handed to someone else.
      exited.push(name);
    } else if (service.pid !== undefined) {
      ((await stopGroup(service.pid, deps)) ? stopped : failed).push(name);
    }
  }
  if (!failed.length) rmSync(stateFile(deps.root), { force: true });
  const ok = failed.length === 0;
  return {
    exitCode: ok ? 0 : 1,
    report: { ok, command: "factory down", sandbox: state.sandbox, stopped, alreadyExited: exited, leftRunning: left, failed },
    headline: `factory down ${state.sandbox}: stopped ${stopped.join(", ") || "nothing"}` +
      (exited.length ? `; already exited: ${exited.join(", ")}` : "") +
      (left.length ? `; left running (not started by the factory): ${left.join(", ")}` : "") +
      (failed.length ? `; FAILED to stop ${failed.join(", ")}` : ""),
  };
}

export const FACTORY_USAGE = `Usage: pnpm local factory <up <sandbox>|status|doctor [sandbox]|down> [--json] [--inferops-dir DIR] [--inferops-image REF] [--timeout SECONDS]
  sandboxes: ${SANDBOXES.join(", ")}`;

/** Run one factory command (argv after `factory`). Usage errors exit 2. */
export async function runFactory(argv: readonly string[], deps: FactoryDeps): Promise<FactoryResult> {
  let values;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv], allowPositionals: true,
      options: { json: { type: "boolean", default: false }, "inferops-dir": { type: "string" }, "inferops-image": { type: "string" }, timeout: { type: "string", default: "600" } },
    }));
  } catch (error) {
    return usage((error as Error).message);
  }
  const [command, named, ...extra] = positionals;
  if (!command || !(FACTORY_COMMANDS as readonly string[]).includes(command)) return usage(command ? `Unknown factory command "${command}"` : "");
  if (extra.length) return usage(`Unexpected argument "${extra[0]}"`);
  if (named !== undefined && !(SANDBOXES as readonly string[]).includes(named)) return usage(`Unknown sandbox "${named}"`);
  if (!/^\d+$/.test(values.timeout)) return usage("--timeout must be a whole number of seconds");
  let config: FactoryConfig;
  try {
    config = factoryConfig(deps.root, deps.env, values["inferops-dir"], values["inferops-image"]);
  } catch (error) {
    return usage((error as Error).message);
  }
  const recorded = readState(deps.root)?.sandbox;
  const sandbox = (named ?? recorded) as Sandbox | undefined;
  switch (command as FactoryCommand) {
    case "up":
      if (!named) return usage("up needs a sandbox");
      return up(named as Sandbox, config, deps, Number(values.timeout) * 1_000);
    case "down":
      return down(deps);
    case "status":
    case "doctor": {
      if (!sandbox) {
        return { exitCode: 1, report: { ok: false, command: `factory ${command}`, error: "no sandbox is up; name one or run pnpm local factory up <sandbox>" }, headline: `factory ${command}: no sandbox is up` };
      }
      const checks = await allChecks(sandbox, config, deps);
      // status: the services only; doctor: every check.
      const shown = command === "status" ? checks.filter(check => check.name.startsWith("service:")) : checks;
      return summarize(command, sandbox, shown, { recorded: recorded ?? null });
    }
  }
}

function usage(message: string): FactoryResult {
  const error = message ? `${message}\n${FACTORY_USAGE}` : FACTORY_USAGE;
  return { exitCode: 2, report: { ok: false, command: "factory", error }, headline: error };
}
