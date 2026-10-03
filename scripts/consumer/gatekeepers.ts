// A consumer wrapper's own gatekeepers: the `gatekeepers/` children of the wrapper, discovered
// through scripts/worker-dirs.ts like this checkout's packages and run beside them in local
// development without editing the pinned checkout. Cloud packaging (the release manifest) does not
// include them yet.
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
import { parseConsumerConfig } from "./config.ts";

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
}

/** The result of {@link checkConsumerGatekeepers}. */
export interface ConsumerGatekeeperReport {
  /** Whether `features.customCloudflareCode` switches the wrapper's gatekeepers on. */
  enabled: boolean;
  /** Deployable gatekeepers (a generated `wrangler.jsonc` beside their `cloudflare.config.ts`). */
  gatekeepers: ConsumerGatekeeper[];
  /** Wrapper-relative `wrangler.jsonc` paths that differ from what their `cloudflare.config.ts` generates. */
  stale: string[];
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

/** Whether the wrapper's configuration switches its own Cloudflare code, gatekeepers included, on. */
function customCodeEnabled(root: string): boolean {
  return parseConsumerConfig(JSON.parse(readFileSync(join(root, "inferos.config.json"), "utf8"))).features.customCloudflareCode;
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

const describe = (dir: string): ConsumerGatekeeper => {
  const name = basename(dir);
  return { name, directory: dir, binding: gatekeeperBinding(name), route: `/gatekeeper/${name.slice("gatekeeper-".length)}` };
};

/**
 * Validate the wrapper's gatekeepers and compare each generated `wrangler.jsonc` with its
 * `cloudflare.config.ts`, writing the regenerated files only with `write`. While
 * `features.customCloudflareCode` is off the directory is inert, like the extension manifest: nothing
 * in it is read, validated or executed.
 */
export async function checkConsumerGatekeepers(root: string, { write = false, upstream = UPSTREAM } = {}): Promise<ConsumerGatekeeperReport> {
  if (!customCodeEnabled(root)) return { enabled: false, gatekeepers: [], stale: [] };
  const dirs = configuredDirs(root, upstream);
  for (const dir of dirs) assertGatekeeperConfig(dir, parse(await renderWorkerConfig(dir)));
  const stale = await syncWorkerConfigs(dirs, { check: !write, base: root });
  return { enabled: true, gatekeepers: dirs.filter(dir => existsSync(join(dir, "wrangler.jsonc"))).map(describe), stale: write ? [] : stale };
}

/**
 * The wrapper gatekeepers `run-dev-server.ts --consumer-root` starts: validated, with each
 * `wrangler.jsonc` regenerated in the wrapper from its `cloudflare.config.ts` first (as the dev server
 * does for this checkout's own Workers). None while `features.customCloudflareCode` is off.
 */
export async function prepareConsumerGatekeepers(root: string, upstream = UPSTREAM): Promise<ConsumerGatekeeper[]> {
  return (await checkConsumerGatekeepers(root, { write: true, upstream })).gatekeepers;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, ...flags] = process.argv.slice(2);
  if (!root || flags.some(flag => flag !== "--write")) throw new Error("Usage: gatekeepers.ts CONSUMER_ROOT [--write]");
  const report = await checkConsumerGatekeepers(resolve(root), { write: flags.includes("--write") });
  const ok = report.stale.length === 0;
  console.log(JSON.stringify({
    ok, enabled: report.enabled,
    gatekeepers: report.gatekeepers.map(({ name, binding, route, directory }) => ({ name, binding, route, directory: relative(resolve(root), directory) })),
    stale: report.stale,
  }));
  if (!ok) {
    console.error(`wrapper gatekeeper configs out of date (run pnpm gatekeepers:generate):\n  ${report.stale.join("\n  ")}`);
    process.exitCode = 1;
  }
}
