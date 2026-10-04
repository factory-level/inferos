// A consumer wrapper's own gatekeepers: the `gatekeepers/` children of the wrapper, discovered
// through scripts/worker-dirs.ts like this checkout's packages and run beside them in local
// development without editing the pinned checkout. Cloud packaging (the release manifest) does not
// include them yet.
//
// A directory is a candidate, never an authority. One is bound only when all of these hold, and is
// otherwise refused with a reason and left unexecuted (its cloudflare.config.ts is not even
// imported): `features.customCloudflareCode` is on; `inferos.config.json` lists its slug under
// `gatekeepers` with `enabled: true`; its `connection.json` validates against
// `connection-package.schema.json` and names the same id; and it lists this checkout's
// gatekeeper API level under `compatibility.inferos.gatekeeperApi`. The wrapper's `workers/`
// (custom Workers, `extensions.ts`) is never a gatekeeper root.
//
// Usage: node scripts/consumer/gatekeepers.ts WRAPPER [--write]

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { gatekeeperBinding } from "../dev-server-config.ts";
import { renderWorkerConfig, syncWorkerConfigs } from "../generate-worker-configs.ts";
import type { WranglerConfig } from "../release/manifest-lib.ts";
import { consumerGatekeeperDirs, workerPackageDirs } from "../worker-dirs.ts";
import { GATEKEEPER_API_LEVEL, readConnection, type ConnectionStatus } from "../connection-package.ts";
import { parseConsumerConfig, type ConsumerConfig } from "./config.ts";

const UPSTREAM = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A wrapper-owned gatekeeper Worker, as local development runs it. */
export interface ConsumerGatekeeper {
  /** Directory name, which is also the Worker name and the service the bindings target. */
  name: string;
  /** Absolute directory inside the wrapper's `gatekeepers/`. */
  directory: string;
  /** The backend and router binding, `GATEKEEPER_<NAME>`. */
  binding: string;
  /** The public path the router forwards to it, on the same origin as `/api`. */
  route: string;
  /** What its `connection.json` declares. Any status may run locally; none of them ships. */
  status: ConnectionStatus;
}

/**
 * A wrapper gatekeeper that is not bound, and why. `error` means the wrapper asked for it (listed
 * and enabled) and it cannot load; `notice` means it was not asked for (unlisted or disabled).
 */
export interface RefusedGatekeeper {
  name: string;
  severity: "error" | "notice";
  reason: string;
}

/** The wrapper's gatekeepers sorted into those that may load and those refused, before any runs. */
export interface ConsumerGatekeeperManifest {
  /** Whether `features.customCloudflareCode` switches the wrapper's gatekeepers on. */
  enabled: boolean;
  /** Directories that pass every gate, with their declared status. */
  accepted: { directory: string; status: ConnectionStatus }[];
  /** Everything refused, with a reason. */
  refused: RefusedGatekeeper[];
}

/** The result of {@link checkConsumerGatekeepers}. */
export interface ConsumerGatekeeperReport {
  /** Whether `features.customCloudflareCode` switches the wrapper's gatekeepers on. */
  enabled: boolean;
  /** Deployable gatekeepers (a generated `wrangler.jsonc` beside their `cloudflare.config.ts`). */
  gatekeepers: ConsumerGatekeeper[];
  /** Wrapper-relative `wrangler.jsonc` paths that differ from what their `cloudflare.config.ts` generates. */
  stale: string[];
  /** Gatekeepers found or listed but not bound, with the reason. */
  refused: RefusedGatekeeper[];
}

const hasConfig = (dir: string) => existsSync(join(dir, "cloudflare.config.ts")) || existsSync(join(dir, "wrangler.jsonc"));

const rejectsRemote = (value: unknown): boolean => !!value && typeof value === "object" &&
  Object.entries(value).some(([key, nested]) => (key === "remote" && nested === true) || rejectsRemote(nested));

/**
 * The wrapper's gatekeeper directories that hold a Worker config, validated by `worker-dirs.ts`
 * (contained, no symbolic links, `gatekeeper-<slug>` names, no collision with the pinned checkout at
 * `upstream`). Library packages, which have neither config file, are left out.
 */
function configuredDirs(root: string, upstream: string): string[] {
  const pinned = workerPackageDirs(upstream).map(dir => basename(dir));
  return consumerGatekeeperDirs(root, pinned).filter(hasConfig);
}

function readConfig(root: string): ConsumerConfig {
  return parseConsumerConfig(JSON.parse(readFileSync(join(root, "inferos.config.json"), "utf8")));
}

/** Why one candidate directory may not load, or null when it may. Reads data only; executes nothing. */
function refusalFor(dir: string, listed: ConsumerConfig["gatekeepers"]): { reason: string; severity: RefusedGatekeeper["severity"] } | { status: ConnectionStatus } {
  const slug = basename(dir).slice("gatekeeper-".length);
  const entry = listed?.find(candidate => candidate.slug === slug);
  if (!entry) return { severity: "notice", reason: `not listed: add { "slug": "${slug}", "enabled": true } to "gatekeepers" in inferos.config.json to load it` };
  if (!entry.enabled) return { severity: "notice", reason: "disabled in inferos.config.json" };
  const read = readConnection(dir);
  if (read.state === "missing") return { severity: "error", reason: "no connection.json: a wrapper gatekeeper must declare its contract (pnpm gatekeepers:scaffold writes one)" };
  if (read.state === "invalid") return { severity: "error", reason: read.reason };
  const { contract } = read;
  if (contract.id !== slug) return { severity: "error", reason: `connection.json id "${contract.id}" must be the directory's slug "${slug}"` };
  const levels = contract.compatibility.inferos?.gatekeeperApi;
  if (!levels) return { severity: "error", reason: "incompatible: connection.json declares no compatibility.inferos.gatekeeperApi" };
  if (!levels.includes(GATEKEEPER_API_LEVEL)) {
    return { severity: "error", reason: `incompatible: built for gatekeeper API ${levels.join(", ")}; this InferOS implements ${GATEKEEPER_API_LEVEL}` };
  }
  return { status: contract.status };
}

/**
 * Sort the wrapper's gatekeeper directories into accepted and refused without importing or running
 * any of them. Structural problems (symbolic links, escaping paths, bad names, collisions with the
 * pinned checkout) still throw, as before. While `features.customCloudflareCode` is off nothing in
 * `gatekeepers/` is read at all.
 */
export function readConsumerGatekeepers(root: string, upstream = UPSTREAM): ConsumerGatekeeperManifest {
  const config = readConfig(root);
  if (!config.features.customCloudflareCode) return { enabled: false, accepted: [], refused: [] };
  const dirs = configuredDirs(root, upstream);
  const accepted: ConsumerGatekeeperManifest["accepted"] = [];
  const refused: RefusedGatekeeper[] = [];
  for (const dir of dirs) {
    const verdict = refusalFor(dir, config.gatekeepers);
    if ("status" in verdict) accepted.push({ directory: dir, status: verdict.status });
    else refused.push({ name: basename(dir), ...verdict });
  }
  const found = new Set(dirs.map(dir => basename(dir)));
  for (const { slug, enabled } of config.gatekeepers ?? []) {
    if (enabled && !found.has(`gatekeeper-${slug}`)) {
      refused.push({ name: `gatekeeper-${slug}`, severity: "error", reason: `listed and enabled, but gatekeepers/gatekeeper-${slug} holds no Worker config` });
    }
  }
  return { enabled: true, accepted, refused };
}

/** Check one rendered config against the directory that owns it. */
function assertGatekeeperConfig(dir: string, config: WranglerConfig): void {
  const name = basename(dir);
  if (config.name !== name) throw new Error(`gatekeepers/${name}: the Worker name must be "${name}", its directory name`);
  if (!config.main) throw new Error(`gatekeepers/${name}: the Worker must declare an entrypoint`);
  // The entrypoint may be a build output that does not exist yet, so containment is checked on the path.
  const main = relative(dir, resolve(dir, config.main));
  if (!main || isAbsolute(main) || main.split(sep).includes("..")) {
    throw new Error(`gatekeepers/${name}: the Worker entrypoint must stay inside its directory`);
  }
  // A local gatekeeper must not proxy a resource into a live Cloudflare account.
  if (rejectsRemote(config)) throw new Error(`gatekeepers/${name}: remote bindings are not supported in local development`);
}

const describe = (dir: string, status: ConnectionStatus): ConsumerGatekeeper => {
  const name = basename(dir);
  return { name, directory: dir, binding: gatekeeperBinding(name), route: `/gatekeeper/${name.slice("gatekeeper-".length)}`, status };
};

/**
 * Validate the wrapper's accepted gatekeepers (see {@link readConsumerGatekeepers}) and compare each
 * generated `wrangler.jsonc` with its `cloudflare.config.ts`, writing the regenerated files only with
 * `write`. Refused gatekeepers are reported and never imported. While
 * `features.customCloudflareCode` is off the directory is inert, like the extension manifest: nothing
 * in it is read, validated or executed.
 */
export async function checkConsumerGatekeepers(root: string, { write = false, upstream = UPSTREAM } = {}): Promise<ConsumerGatekeeperReport> {
  const manifest = readConsumerGatekeepers(root, upstream);
  if (!manifest.enabled) return { enabled: false, gatekeepers: [], stale: [], refused: [] };
  const dirs = manifest.accepted.map(({ directory }) => directory);
  for (const dir of dirs) assertGatekeeperConfig(dir, parse(await renderWorkerConfig(dir)));
  const stale = await syncWorkerConfigs(dirs, { check: !write, base: root });
  const gatekeepers = manifest.accepted.filter(({ directory }) => existsSync(join(directory, "wrangler.jsonc")))
    .map(({ directory, status }) => describe(directory, status));
  return { enabled: true, gatekeepers, stale: write ? [] : stale, refused: manifest.refused };
}

/**
 * The wrapper gatekeepers `run-dev-server.ts --consumer-root` starts: validated, with each
 * `wrangler.jsonc` regenerated in the wrapper from its `cloudflare.config.ts` first (as the dev server
 * does for this checkout's own Workers). Only accepted ones (see {@link readConsumerGatekeepers});
 * none while `features.customCloudflareCode` is off.
 */
export async function prepareConsumerGatekeepers(root: string, upstream = UPSTREAM): Promise<ConsumerGatekeeper[]> {
  const report = await checkConsumerGatekeepers(root, { write: true, upstream });
  // Refused gatekeepers stay unbound; the dev server still starts, and says why each is missing.
  for (const { name, reason } of report.refused) console.warn(`wrapper gatekeeper ${name} is not bound: ${reason}`);
  return report.gatekeepers;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, ...flags] = process.argv.slice(2);
  if (!root || flags.some(flag => flag !== "--write")) throw new Error("Usage: gatekeepers.ts CONSUMER_ROOT [--write]");
  const report = await checkConsumerGatekeepers(resolve(root), { write: flags.includes("--write") });
  const errors = report.refused.filter(refused => refused.severity === "error");
  const ok = report.stale.length === 0 && errors.length === 0;
  console.log(JSON.stringify({
    ok, enabled: report.enabled,
    gatekeepers: report.gatekeepers.map(({ name, binding, route, directory, status }) => ({ name, binding, route, status, directory: relative(resolve(root), directory) })),
    refused: report.refused,
    stale: report.stale,
  }));
  if (report.stale.length) {
    console.error(`wrapper gatekeeper configs out of date (run pnpm gatekeepers:generate):\n  ${report.stale.join("\n  ")}`);
  }
  for (const { name, reason } of errors) console.error(`${name} is not loaded: ${reason}`);
  if (!ok) process.exitCode = 1;
}
