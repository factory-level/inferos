// The per-worktree environment overlay that `pnpm wt new` writes (scripts/wt/). A worktree shares
// the main checkout's secrets by symlinking its `.env` and `.dev.vars`, so the settings that must
// differ per worktree -- the backend and Vite ports, the public base URL and the `vp run`
// concurrency share -- cannot go in those files without changing every checkout at once. They go in
// `.env.worktree` at the worktree root instead, which only `wt` writes and which is gitignored.
//
// Precedence everywhere is: the shell, then `.env.worktree`, then `.dev.vars`, then `.env`. The
// overlay sits directly under the shell because its whole purpose is to override what the shared,
// symlinked files say for this one worktree; the shell still wins so a one-off
// `VITE_BACKEND_HOST=... pnpm dev-server` behaves as it always has. A checkout without the file
// (the main checkout, CI) is unaffected.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

/** The overlay's file name, at the root of a worktree. */
export const WORKTREE_ENV_FILE = ".env.worktree";

/**
 * The variable naming the port `pnpm dev-client` (Vite) listens on. Not `VITE_`-prefixed, so it is
 * never inlined into the client bundle.
 */
export const DEV_CLIENT_PORT = "DEV_CLIENT_PORT";

/** The repo root this module belongs to: scripts → root. */
export const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The variables in the env file at `path`, or `{}` when it does not exist. */
export function readEnvFile(path: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  return Object.fromEntries(Object.entries(parseEnv(text))
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

/** The overlay at `root`, or `{}` outside a `wt` worktree. */
export function readWorktreeEnv(root: string = REPO_ROOT): Record<string, string> {
  return readEnvFile(join(root, WORKTREE_ENV_FILE));
}

/** `env` with the overlay's values filled in wherever `env` leaves them unset. */
export function withWorktreeEnv(root: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...env };
  for (const [key, value] of Object.entries(readWorktreeEnv(root))) {
    if (merged[key] === undefined) merged[key] = value;
  }
  return merged;
}

/**
 * Vite's `server.port`/`strictPort` for `pnpm dev-client`, and the backend host it should proxy
 * to, honouring the overlay. Without `DEV_CLIENT_PORT` this is the long-standing default (3000, and
 * Vite may move to the next free port). With one, `strictPort` is on: a worktree whose Vite silently
 * drifted onto another port would no longer match the `PUBLIC_BASE_URL` its backend was started
 * with, and connect flows would fail far from the cause.
 *
 * `VITE_BACKEND_HOST` from the overlay is copied into `env` (normally `process.env`) when unset,
 * because Vite reads `VITE_*` for `import.meta.env` from the process environment after loading the
 * config. Only call this for `vite serve`: a build would inline the value without the task cache
 * fingerprinting it.
 */
export function devClientServerOptions(
  root: string = REPO_ROOT, env: NodeJS.ProcessEnv = process.env,
): { port: number; strictPort: boolean } {
  const overlay = readWorktreeEnv(root);
  if (env.VITE_BACKEND_HOST === undefined && overlay.VITE_BACKEND_HOST !== undefined) {
    env.VITE_BACKEND_HOST = overlay.VITE_BACKEND_HOST;
  }
  const raw = env[DEV_CLIENT_PORT] ?? overlay[DEV_CLIENT_PORT];
  if (raw === undefined || raw.trim() === "") return { port: 3000, strictPort: false };
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${DEV_CLIENT_PORT} must be an integer between 1 and 65535, got "${raw}".`);
  }
  return { port, strictPort: true };
}
