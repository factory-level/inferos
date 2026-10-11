// The guards every `pnpm wt` path that removes or writes inside a worktree goes through. A worktree
// name or a registry entry is user- or file-supplied input; neither may ever steer a removal (or an
// overlay write) outside `<main checkout>/.worktrees/`, and removal is only ever `git worktree
// remove` of a path git itself lists -- never a recursive delete.

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { validWorktreeName } from "./layout.ts";

/** `<main>/.worktrees`, with `main` resolved through any symlinks. */
export function worktreesRoot(main: string): string {
  return join(realpathSync(main), ".worktrees");
}

/**
 * The real path of the worktree at `path`, or a thrown error unless it is a direct child of
 * `<main>/.worktrees/` with a valid worktree name. Symlinks are refused outright (a link inside
 * `.worktrees/` pointing elsewhere is exactly the escape this exists to stop), and the parent is
 * compared after `realpath`, so `..` segments and a symlinked `.worktrees/` cannot reach out.
 */
export function containedWorktreePath(main: string, path: string): string {
  const root = worktreesRoot(main);
  const absolute = resolve(path);
  let isLink = false;
  try {
    isLink = lstatSync(absolute).isSymbolicLink();
  } catch {
    // Absent: checked by its parent below.
  }
  if (isLink) throw new Error(`Refusing: ${absolute} is a symbolic link, not a worktree directory.`);
  let parent: string;
  try {
    parent = realpathSync(dirname(absolute));
  } catch {
    throw new Error(`Refusing: ${absolute} is not inside ${root}.`);
  }
  const real = join(parent, basename(absolute));
  if (parent !== root || !validWorktreeName(basename(real))) {
    throw new Error(`Refusing: ${absolute} is not a worktree directory directly inside ${root}.`);
  }
  return real;
}

/** The real paths `git worktree list` reports for the repository at `main`. */
export function listedWorktreePaths(main: string): Set<string> {
  const out = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: main, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const paths = new Set<string>();
  for (const match of out.matchAll(/^worktree (.+)$/gm)) {
    const listed = match[1]!;
    paths.add(existsSync(listed) ? realpathSync(listed) : listed);
  }
  return paths;
}

/**
 * Ignored files whose loss `wt rm` should not inflict without `--force`. Build outputs and the
 * files `wt` itself manages are fine to drop; local state (Wrangler's D1/KV/DO data under
 * `.wrangler/state`), a real (non-symlink) `.env`/`.dev.vars`, and anything else ignored are not.
 */
const DISPOSABLE_SEGMENTS = new Set(["node_modules", "dist", "dist-app", "generated"]);
const DISPOSABLE_FILES = new Set([".env.worktree", "wrangler.dev.jsonc", ".run-local-stamp"]);
/** `.wrangler/` children that are scratch or rebuilt: bundles, validated builds, the dev-server record. */
const DISPOSABLE_WRANGLER = new Set(["tmp", "validate", "local"]);
const LINKABLE = new Set([".env", ".dev.vars"]);

function disposable(worktree: string, relative: string): boolean {
  const trimmed = relative.replace(/\/$/, "");
  const segments = trimmed.split("/");
  const name = segments.at(-1)!;
  if (segments.some(segment => DISPOSABLE_SEGMENTS.has(segment))) return true;
  if (DISPOSABLE_FILES.has(name) || name.endsWith(".tsbuildinfo")) return true;
  if (LINKABLE.has(name) && segments.length === 1) {
    try {
      return lstatSync(join(worktree, trimmed)).isSymbolicLink();
    } catch {
      return true;
    }
  }
  return false;
}

/** The ignored, non-disposable paths in `worktree`, relative to it. */
export function precious(worktree: string): string[] {
  const out = execFileSync("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory"],
    { cwd: worktree, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  const found: string[] = [];
  for (const entry of out.split("\n").filter(Boolean)) {
    const trimmed = entry.replace(/\/$/, "");
    if (basename(trimmed) === ".wrangler") {
      // Collapsed to the directory; judge its children, since `state/` is the one that matters.
      let children: string[] = [];
      try {
        children = readdirSync(join(worktree, trimmed));
      } catch {
        // Gone meanwhile.
      }
      for (const child of children) if (!DISPOSABLE_WRANGLER.has(child)) found.push(`${trimmed}/${child}/`);
      continue;
    }
    if (!disposable(worktree, entry)) found.push(entry);
  }
  return found;
}
