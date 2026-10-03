import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

/**
 * Top-level directories whose children are workspace packages that may hold a Worker. `packages/`
 * is the upstream platform; `custom-gatekeepers/` holds this fork's own gatekeepers, kept apart so
 * upstream merges never touch them. Discovery treats both alike: a child with a `wrangler.jsonc`
 * is a deployable Worker, and a `gatekeeper-*` one is bound to the backend as `GATEKEEPER_<NAME>`.
 */
export const WORKER_PACKAGE_ROOTS = ["packages", "custom-gatekeepers"] as const;

/**
 * The directory of a consumer wrapper whose children are the wrapper's own gatekeepers. It is a
 * discovery root only when a caller passes the wrapper explicitly (`--consumer-root`); nothing infers
 * a wrapper from the working directory or from where this checkout sits.
 */
export const CONSUMER_GATEKEEPER_ROOT = "gatekeepers";

/** A wrapper gatekeeper's directory name: `gatekeeper-` plus a slug the router maps back from its binding. */
const CONSUMER_GATEKEEPER_NAME = /^gatekeeper-[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Options for {@link workerPackageDirs}. */
export interface WorkerDirOptions {
  /**
   * A consumer wrapper whose `gatekeepers/` children join the discovery (see
   * {@link consumerGatekeeperDirs}). Omitted, discovery covers this checkout alone, which is what
   * the release manifest, worker types and CI checks use.
   */
  consumerRoot?: string;
}

const pinnedPackageDirs = (root: string): Map<string, string> => {
  const dirs = new Map<string, string>();
  for (const parent of WORKER_PACKAGE_ROOTS) {
    let entries;
    try {
      entries = readdirSync(join(root, parent), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const existing = dirs.get(entry.name);
      if (existing) {
        throw new Error(`package "${entry.name}" exists in both ${existing} and ${parent}; names must be unique`);
      }
      dirs.set(entry.name, join(root, parent, entry.name));
    }
  }
  return dirs;
};

const isSymlink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * The package directories under the wrapper's `gatekeepers/`, with nothing outside the wrapper
 * reachable through them. A missing directory means the wrapper has none. Every child directory must
 * be a real directory (no symbolic links, for the directory itself, a child, or a child's Worker
 * config), so a wrapper cannot alias a path outside itself or a pinned package. A child that holds a
 * Worker config must be named `gatekeeper-<slug>`, the binding the router routes by; one without a
 * `wrangler.jsonc` or `cloudflare.config.ts` is a library and is listed but never deployable. A name
 * that `pinnedNames` already holds is rejected, because Worker names and bindings are keyed by it.
 */
export function consumerGatekeeperDirs(consumerRoot: string, pinnedNames: Iterable<string> = []): string[] {
  const parent = join(consumerRoot, CONSUMER_GATEKEEPER_ROOT);
  let stat;
  try {
    stat = lstatSync(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`the wrapper's ${CONSUMER_GATEKEEPER_ROOT}/ directory must not be a symbolic link`);
  if (!stat.isDirectory()) throw new Error(`the wrapper's ${CONSUMER_GATEKEEPER_ROOT} path must be a directory`);
  const canonicalParent = realpathSync(parent);
  const pinned = new Set(pinnedNames);
  const dirs: string[] = [];
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isSymbolicLink()) {
      throw new Error(`${CONSUMER_GATEKEEPER_ROOT}/${entry.name} must not be a symbolic link`);
    }
    if (!entry.isDirectory()) continue;
    const dir = join(parent, entry.name);
    const rel = relative(canonicalParent, realpathSync(dir));
    if (rel !== entry.name || rel.split(sep).includes("..")) {
      throw new Error(`${CONSUMER_GATEKEEPER_ROOT}/${entry.name} must stay inside the wrapper's ${CONSUMER_GATEKEEPER_ROOT}/ directory`);
    }
    const configs = ["wrangler.jsonc", "cloudflare.config.ts"].filter(name => existsSync(join(dir, name)) || isSymlink(join(dir, name)));
    for (const name of configs) {
      if (isSymlink(join(dir, name))) throw new Error(`${CONSUMER_GATEKEEPER_ROOT}/${entry.name}/${name} must not be a symbolic link`);
    }
    if (configs.length && !CONSUMER_GATEKEEPER_NAME.test(entry.name)) {
      throw new Error(`${CONSUMER_GATEKEEPER_ROOT}/${entry.name} holds a Worker config, so it must be named gatekeeper-<lowercase-slug>`);
    }
    if (pinned.has(entry.name)) {
      throw new Error(`wrapper gatekeeper "${entry.name}" collides with a package of the pinned InferOS; names must be unique`);
    }
    dirs.push(dir);
  }
  return dirs;
}

/**
 * Every package directory under the worker package roots of `root`, plus the wrapper's own
 * gatekeepers when `options.consumerRoot` is given, sorted by package name. A missing root is
 * skipped, so a checkout without custom gatekeepers behaves as before. Two packages with the same
 * directory name are an error: Worker names, bindings and release entries are keyed by it.
 */
export function workerPackageDirs(root: string, options: WorkerDirOptions = {}): string[] {
  const dirs = pinnedPackageDirs(root);
  if (options.consumerRoot !== undefined) {
    for (const dir of consumerGatekeeperDirs(options.consumerRoot, dirs.keys())) {
      dirs.set(basename(dir), dir);
    }
  }
  return [...dirs].toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, dir]) => dir);
}
