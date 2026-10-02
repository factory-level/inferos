import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Top-level directories whose children are workspace packages that may hold a Worker. `packages/`
 * is the upstream platform; `custom-gatekeepers/` holds this fork's own gatekeepers, kept apart so
 * upstream merges never touch them. Discovery treats both alike: a child with a `wrangler.jsonc`
 * is a deployable Worker, and a `gatekeeper-*` one is bound to the backend as `GATEKEEPER_<NAME>`.
 */
export const WORKER_PACKAGE_ROOTS = ["packages", "custom-gatekeepers"] as const;

/**
 * Every package directory under the worker package roots of `root`, sorted by package name. A
 * missing root is skipped, so a checkout without custom gatekeepers behaves as before. Two packages
 * with the same directory name are an error: Worker names, bindings and release entries are keyed
 * by it.
 */
export function workerPackageDirs(root: string): string[] {
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
      dirs.set(entry.name, parent);
    }
  }
  return [...dirs].toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([name, parent]) => join(root, parent, name));
}
