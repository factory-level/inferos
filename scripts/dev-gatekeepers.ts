// Which gatekeeper Workers the local dev server starts. One module so `run-dev-server.ts`, which
// starts them, and `scripts/local/stack.ts`, which probes them for `pnpm local status`, cannot
// disagree.
//
// Discovery: every `gatekeeper-*` package with a `wrangler.jsonc` under `packages/` and
// `custom-gatekeepers/` (worker-dirs.ts), with the fork's own gatekeepers narrowed to those the
// canvas config enables. Then an optional developer selection (`--gatekeepers a,b` or
// `INFEROS_DEV_GATEKEEPERS`) narrows it further. Wrangler restarts every Worker it runs on any
// change, so fewer Workers is a faster edit-to-live loop. The router and backend are not
// gatekeepers and always run; a gatekeeper left out simply loses its service bindings.

import { statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { WORKER_PACKAGE_ROOTS, workerPackageDirs } from "./worker-dirs.ts";

/** The environment variable equivalent of `--gatekeepers`. The flag wins when both are given. */
export const DEV_GATEKEEPERS_ENV = "INFEROS_DEV_GATEKEEPERS";

/** A gatekeeper Worker package the dev server can start. */
export interface DevGatekeeper {
  /** Package directory name, which is also the Worker name. */
  name: string;
  /** Absolute path to the package directory. */
  dir: string;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Every gatekeeper Worker in `root`: a `gatekeeper-*` package with a `wrangler.jsonc` (one without
 * is a library), keeping a `custom-gatekeepers/` one only when `enabledCustom` names it.
 */
export function discoverDevGatekeepers(root: string, enabledCustom: ReadonlySet<string>): DevGatekeeper[] {
  return workerPackageDirs(root)
    .map(dir => ({ name: basename(dir), dir }))
    .filter(({ name, dir }) => name.startsWith("gatekeeper-") && isFile(join(dir, "wrangler.jsonc")))
    .filter(({ name, dir }) => basename(dirname(dir)) !== WORKER_PACKAGE_ROOTS[1] || enabledCustom.has(name));
}

/**
 * The developer's selection from `--gatekeepers a,b` / `--gatekeepers=a,b`, else the environment
 * variable, as full Worker names; `null` when neither is given, which means "all". Names may drop
 * the `gatekeeper-` prefix. `none` selects no gatekeeper at all. An empty environment value counts
 * as unset; an empty flag value is an error, since it can only be a mistake.
 */
export function requestedDevGatekeepers(args: readonly string[], envValue: string | undefined): string[] | null {
  let flag: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg !== "--gatekeepers" && !arg.startsWith("--gatekeepers=")) continue;
    if (flag !== null) throw new Error("--gatekeepers may only be specified once.");
    const value = arg === "--gatekeepers" ? args[++i] : arg.slice("--gatekeepers=".length);
    if (value === undefined || value.trim() === "" || value.startsWith("--")) {
      throw new Error("--gatekeepers needs a comma-separated list of gatekeeper names, or none.");
    }
    flag = value;
  }
  const raw = flag ?? (envValue?.trim() ? envValue : null);
  if (raw === null) return null;
  const names = raw.split(",").map(name => name.trim()).filter(Boolean);
  if (names.length === 1 && names[0] === "none") return [];
  return [...new Set(names.map(name => name.startsWith("gatekeeper-") ? name : `gatekeeper-${name}`))];
}

/**
 * `discovered` narrowed to `requested` (`null` keeps everything). A name that matches nothing
 * discovered throws, listing what is available, rather than quietly starting less than was asked.
 */
export function selectDevGatekeepers<T extends { name: string }>(discovered: readonly T[], requested: readonly string[] | null): T[] {
  if (requested === null) return [...discovered];
  const available = new Set(discovered.map(({ name }) => name));
  const unknown = requested.filter(name => !available.has(name));
  if (unknown.length) {
    throw new Error(`Unknown gatekeeper${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} for --gatekeepers/` +
      `${DEV_GATEKEEPERS_ENV}. Available: ${[...available].toSorted().join(", ") || "(none)"}.`);
  }
  const wanted = new Set(requested);
  return discovered.filter(({ name }) => wanted.has(name));
}
