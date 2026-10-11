// The per-user registry of `pnpm wt` worktrees: which worktree holds which port block. Per user, not
// per checkout, because ports are a machine-wide resource and several clones may share a machine.
//
// Several agents run `wt new` at once, so every change is a locked read-modify-write: an exclusive
// lock file (O_EXCL create) serializes writers, and the file itself is replaced by rename, so a
// reader never sees a half-written registry and a crash mid-write leaves the previous one intact. A
// lock left behind by a dead process is reclaimed once its owner is gone or it is old enough that
// no live writer could still hold it (writers hold it for milliseconds, never across a build).

import { mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** One registered worktree. */
export interface WorktreeEntry {
  /** The `wt new` name, which is also the directory under `<main checkout>/.worktrees/`. */
  name: string;
  /** Absolute path of the worktree. */
  path: string;
  /** Absolute path of the main checkout it belongs to (where the shared `.git` lives). */
  mainCheckout: string;
  /** The branch `wt new` checked out. The live branch may since have changed; `wt ls` reads it. */
  branch: string;
  /** First port of the worktree's block of {@link PORT_BLOCK_SIZE}. */
  portBase: number;
  createdAt: string;
}

/** The registry file's contents. */
export interface Registry {
  version: 1;
  worktrees: WorktreeEntry[];
}

/** Ports per worktree: backend, Vite, and spares for whatever else a stack grows. */
export const PORT_BLOCK_SIZE = 10;

/** `$XDG_CONFIG_HOME/inferos/worktrees.json`, defaulting to `~/.config`. */
export function registryPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "inferos", "worktrees.json");
}

const emptyRegistry = (): Registry => ({ version: 1, worktrees: [] });

/** The registry at `path`; empty when the file does not exist yet. A corrupt file throws. */
export function readRegistry(path: string): Registry {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyRegistry();
    throw error;
  }
  const parsed = JSON.parse(text) as Partial<Registry>;
  if (parsed?.version !== 1 || !Array.isArray(parsed.worktrees)) {
    throw new Error(`${path} is not a version 1 worktree registry; move it aside to start a new one.`);
  }
  return { version: 1, worktrees: parsed.worktrees };
}

/** Replace the registry at `path` atomically: write a sibling temp file, then rename over it. */
export function writeRegistry(path: string, registry: Registry): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify(registry, null, 2) + "\n");
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}

/** Lock tuning, injectable for tests. */
export interface LockOptions {
  /** Give up after this long. */
  timeoutMs?: number;
  /** A lock older than this is presumed abandoned even if its pid looks alive (pid reuse). */
  staleMs?: number;
}

function ownerAlive(lockPath: string): boolean {
  let pid: number;
  try {
    pid = Number(readFileSync(lockPath, "utf8").split("\n")[0]);
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function tryReclaim(lockPath: string, staleMs: number): void {
  try {
    const age = Date.now() - statSync(lockPath).mtimeMs;
    if (age > staleMs || (age > 1_000 && !ownerAlive(lockPath))) unlinkSync(lockPath);
  } catch {
    // Released (or reclaimed by someone else) in the meantime: just retry.
  }
}

/**
 * Run `fn` holding the registry's lock. Retries with jittered backoff while another process holds
 * it, and throws after `timeoutMs`.
 */
export async function withRegistryLock<T>(path: string, fn: () => T | Promise<T>, options: LockOptions = {}): Promise<T> {
  const { timeoutMs = 20_000, staleMs = 60_000 } = options;
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let fd: number | undefined;
  for (let attempt = 0; fd === undefined; attempt++) {
    try {
      fd = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${lockPath}; remove it if no wt command is running.`, { cause: error });
      tryReclaim(lockPath, staleMs);
      await new Promise(resolve => setTimeout(resolve, Math.min(200, 10 * 2 ** Math.min(attempt, 4)) * (0.5 + Math.random())));
    }
  }
  try {
    writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
    closeSync(fd);
    return await fn();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // Reclaimed as stale while we held it (we were slower than `staleMs`); nothing to release.
    }
  }
}

/**
 * Locked read-modify-write: `fn` receives the current registry, mutates it in place, and the result
 * is written back before the lock is released. `fn`'s return value is passed through.
 */
export function updateRegistry<T>(path: string, fn: (registry: Registry) => T | Promise<T>, options?: LockOptions): Promise<T> {
  return withRegistryLock(path, async () => {
    const registry = readRegistry(path);
    const result = await fn(registry);
    writeRegistry(path, registry);
    return result;
  }, options);
}
