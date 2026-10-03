// What `scripts/local/lifecycle.ts` knows about this checkout's local stack: where it listens,
// which Workers the dev server binds, where Wrangler keeps its state and logs, and whether the
// InferOps gatekeeper is configured for mock or live data. Pure inspection -- nothing here starts,
// stops or seeds anything, and no credential value is ever read into a report.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { canvasInventory, readCanvasConfig, selectedCustomGatekeepers } from "../consumer/canvas.ts";
import { getDevServerConfig } from "../dev-server-config.ts";
import { WORKER_PACKAGE_ROOTS, workerPackageDirs } from "../worker-dirs.ts";

/** Where the local stack of a checkout lives: the origin plus the files Wrangler keeps for it. */
export interface LocalStack {
  /** The checkout the stack belongs to. */
  root: string;
  /** `host:port` of the public origin, as the dev server resolves it. */
  backendHost: string;
  port: number;
  url: string;
  /**
   * Wrangler's persisted local state (Durable Objects, KV, R2, cache) for this checkout. The dev
   * server starts Wrangler from the repo root, so every Worker's state lands here, and nothing
   * outside it holds local data: it is exactly what `reset` clears.
   */
  stateDir: string;
  /** The running dev server's record, written by `recordDevServer`; absent while nothing runs. */
  recordPath: string;
}

/** Resolve the stack from the dev server's own port rules (`--port`, then `VITE_BACKEND_HOST`). */
export function resolveLocalStack(root: string, args: readonly string[], env: NodeJS.ProcessEnv): LocalStack {
  const { backendHost, wranglerPort } = getDevServerConfig(args, env.VITE_BACKEND_HOST);
  const port = Number(wranglerPort ?? 8787);
  return {
    root,
    backendHost,
    port,
    url: `http://${backendHost}`,
    stateDir: join(root, ".wrangler", "state"),
    recordPath: join(root, ".wrangler", "local", "dev-server.json"),
  };
}

/** Whether something accepts TCP connections on `port`. A probe, not a reservation. */
export function isPortListening(port: number, host = "127.0.0.1", timeoutMs = 1_000): Promise<boolean> {
  return new Promise(settle => {
    const socket = connect({ port, host });
    const finish = (listening: boolean) => {
      socket.destroy();
      settle(listening);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** A Worker the dev server binds, with the public path that reaches it through the router. */
export interface ConfiguredWorker {
  name: string;
  /** `router` is the public origin; `backend` the Workshop; the rest are gatekeepers. */
  role: "router" | "backend" | "gatekeeper";
  /** A path the router forwards to this Worker, for a liveness probe. */
  path: string;
}

/**
 * The Workers `pnpm dev-server` would start from this checkout, discovered the way it discovers
 * them: every `gatekeeper-*` package with a `wrangler.jsonc`, with the fork's own gatekeepers
 * filtered by `inferos.canvas.json` when one exists. The router and backend are always present.
 */
export function configuredWorkers(root: string): ConfiguredWorker[] {
  const inventory = canvasInventory(root);
  const enabledCustom = new Set(selectedCustomGatekeepers(readCanvasConfig(root, inventory)?.config, inventory));
  const gatekeepers = workerPackageDirs(root)
    .filter(dir => basename(dir).startsWith("gatekeeper-") && existsSync(join(dir, "wrangler.jsonc")))
    .filter(dir => basename(dirname(dir)) !== WORKER_PACKAGE_ROOTS[1] || enabledCustom.has(basename(dir)))
    .map(dir => basename(dir));
  return [
    { name: "router", role: "router", path: "/" },
    { name: "workshop-backend", role: "backend", path: "/api" },
    ...gatekeepers.map((name): ConfiguredWorker =>
      ({ name, role: "gatekeeper", path: `/gatekeeper/${name.slice("gatekeeper-".length)}` })),
  ];
}

/** One Worker's liveness as seen through the router. */
export interface WorkerProbe extends ConfiguredWorker {
  /**
   * `up`: the Worker answered. A 400, 404 or even a 500 thrown by its own code proves it runs (an
   * RPC-only gatekeeper answers "Entrypoint class does not define a fetch() function" with 500).
   * `error`: 502, 503 or 504, which is what the dev proxy answers for a Worker that is not running.
   * `down`: no HTTP answer at all.
   */
  state: "up" | "error" | "down";
  status?: number;
}

/** Probe each Worker through the public origin. `fetchImpl` is injectable for tests. */
export async function probeWorkers(
    url: string, workers: ConfiguredWorker[], fetchImpl: typeof fetch = fetch, timeoutMs = 3_000,
): Promise<WorkerProbe[]> {
  return Promise.all(workers.map(async worker => {
    try {
      const response = await fetchImpl(new URL(worker.path, url), {
        method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
      });
      await response.body?.cancel();
      const gateway = response.status === 502 || response.status === 503 || response.status === 504;
      return { ...worker, state: gateway ? "error" : "up", status: response.status };
    } catch {
      return { ...worker, state: "down" };
    }
  }));
}

/**
 * The dev server's environment as it loads it: the shell wins over `.dev.vars`, which wins over
 * `.env`. Only presence of keys is reported anywhere; values stay in the returned object.
 */
export function localEnv(root: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...env };
  for (const file of [".dev.vars", ".env"]) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    for (const [key, value] of Object.entries(parseEnv(readFileSync(path, "utf8")))) {
      if (merged[key] === undefined) merged[key] = value;
    }
  }
  return merged;
}

/** The names the gatekeeper reads a live connection from (see its `connectionFromEnv`). */
export const INFEROPS_CONNECTION_VARS = [
  "INFEROPS_BASE_URL", "INFEROPS_API_TOKEN", "INFEROPS_WORKSPACE_ID", "INFEROPS_WORKSPACE_SLUG",
] as const;

/** How the InferOps gatekeeper is configured. Reports which variables are set, never their values. */
export interface InferOpsConfiguration {
  /** `mock`: the bundled demo board. `live`: an InferOps instance named by `INFEROPS_BASE_URL`. */
  mode: "mock" | "live";
  /** The live instance's host, when configured. Display only: a board URL never names it. */
  host?: string;
  /** Variables a live connection needs that are unset; the gatekeeper refuses to start with these. */
  missing: string[];
}

/**
 * Mock unless `INFEROPS_BASE_URL` is set. The token, workspace id and workspace slug are checked
 * for presence only -- this mirrors the gatekeeper's own rule that a base URL without them is an error, not a
 * silent fallback to demo data.
 */
export function inferOpsConfiguration(env: NodeJS.ProcessEnv): InferOpsConfiguration {
  const [baseUrl, ...rest] = INFEROPS_CONNECTION_VARS;
  if (!env[baseUrl]) return { mode: "mock", missing: [] };
  let host: string | undefined;
  try {
    host = new URL(env[baseUrl]).host;
  } catch {
    host = undefined;
  }
  return { mode: "live", host, missing: rest.filter(name => !env[name]) };
}

/** What a running dev server records about itself, so `status` and `stop` can find it. */
export interface DevServerRecord {
  pid: number;
  port: number;
  /** `run-local` serves the built frontend from the router; `dev-server` expects Vite beside it. */
  mode: "run-local" | "dev-server";
  startedAt: string;
}

/**
 * Write the running dev server's record; returns the function that removes it, for the process's
 * `exit` handler. Replaces whatever a crashed run left behind.
 */
export function recordDevServer(root: string, record: Omit<DevServerRecord, "pid" | "startedAt">): () => void {
  const path = join(root, ".wrangler", "local", "dev-server.json");
  mkdirSync(dirname(path), { recursive: true });
  const written: DevServerRecord = { pid: process.pid, startedAt: new Date().toISOString(), ...record };
  writeFileSync(path, JSON.stringify(written, null, 2) + "\n");
  return () => {
    try {
      // Only this run's record: a newer server may have replaced it while this one was dying.
      if (JSON.parse(readFileSync(path, "utf8")).pid === process.pid) unlinkSync(path);
    } catch {
      // Already gone, or unreadable: nothing to remove.
    }
  };
}

/** Whether a process with `pid` exists (signal 0 probes without delivering anything). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else, which still counts as alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The recorded dev server, or null when none is recorded or its process is gone. */
export function readDevServerRecord(recordPath: string): DevServerRecord | null {
  if (!existsSync(recordPath)) return null;
  let record: DevServerRecord;
  try {
    record = JSON.parse(readFileSync(recordPath, "utf8"));
  } catch {
    return null;
  }
  if (typeof record?.pid !== "number" || !processAlive(record.pid)) return null;
  return record;
}

/**
 * Remove this checkout's local state. Refuses without `confirm` (the caller's `--yes`) and while
 * a recorded dev server runs, since Wrangler would keep writing into the directory being removed.
 * Only `stateDir` and the dev-server record go; Wrangler's build scratch and logs stay.
 */
export function resetLocalState(stack: LocalStack, { confirm }: { confirm: boolean }): { removed: string[] } {
  if (!confirm) {
    throw new Error(`Refusing to delete ${stack.stateDir} without --yes. This removes every local account, workspace and seeded board.`);
  }
  if (readDevServerRecord(stack.recordPath)) {
    throw new Error("The local stack is running; stop it (pnpm local stop) before resetting its state.");
  }
  const removed: string[] = [];
  for (const path of [stack.stateDir, dirname(stack.recordPath)]) {
    if (!existsSync(path)) continue;
    rmSync(path, { recursive: true, force: true });
    removed.push(path);
  }
  return { removed };
}

/**
 * Where Wrangler writes its debug log files: `WRANGLER_LOG_PATH`, else `logs/` under its global
 * config directory (the legacy `~/.wrangler` when that exists, else `$XDG_CONFIG_HOME/.wrangler`).
 * Per user, not per checkout: the console of the terminal running the stack is the first log.
 */
export function wranglerLogDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (env.WRANGLER_LOG_PATH) return resolve(env.WRANGLER_LOG_PATH);
  const legacy = join(home, ".wrangler");
  if (existsSync(legacy) && statSync(legacy).isDirectory()) return join(legacy, "logs");
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), ".wrangler", "logs");
}

/** The newest Wrangler log file in `dir` with its last `lines` lines, or null when there is none. */
export function latestWranglerLog(dir: string, lines = 50): { file: string; lines: string[] } | null {
  if (!existsSync(dir)) return null;
  // File names carry the start timestamp, so the lexically last one is the newest.
  const newest = readdirSync(dir).filter(name => /^wrangler-.*\.log$/.test(name)).toSorted().at(-1);
  if (!newest) return null;
  const file = join(dir, newest);
  const all = readFileSync(file, "utf8").split("\n");
  if (all.at(-1) === "") all.pop();
  return { file, lines: all.slice(-lines) };
}
