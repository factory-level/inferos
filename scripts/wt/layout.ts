// What a `pnpm wt` worktree gets: its port block, its share of the machine's build concurrency, the
// `.env.worktree` overlay that carries both (scripts/worktree-env.ts), and which of the main
// checkout's secret files it links. Pure functions, so the rules are testable without git.

import { DEV_CLIENT_PORT, DEV_INSPECTOR_PORT, WORKTREE_ENV_FILE } from "../worktree-env.ts";
import { PORT_BLOCK_SIZE, type WorktreeEntry } from "./registry.ts";

/** The first port block, above the main checkout's 8787. */
export const PORT_BLOCK_START = 8800;

/** How many blocks to try: 8800-9199, stopping short of Node's 9229 inspector port. */
export const PORT_BLOCK_COUNT = 40;

/**
 * InferOps runs beside InferOS on the same machine, and shifts its base ports (API 8080, agentic
 * 8000, MCP 8001, worker 8090, clients 3000-3002) by `offset × 100` per worktree (inferops
 * CLAUDE.md). Offsets 8-11 land inside 8800-9199, always on these last two digits, so a block
 * holding any of them is never handed out: within each hundred only x10-x79 are used.
 */
export const INFEROPS_PORT_RESIDUES: ReadonlySet<number> = new Set([0, 1, 2, 80, 90]);

/** Whether a block could collide with some InferOps worktree's ports. */
export function clashesWithInferOps(base: number): boolean {
  return blockPorts(base).some(port => INFEROPS_PORT_RESIDUES.has(port % 100));
}

/** The ports in a block, by role. */
export interface PortLayout {
  /** Wrangler's public origin (the router): `VITE_BACKEND_HOST`. */
  backend: number;
  /** `pnpm dev-client` (Vite), and therefore the default `PUBLIC_BASE_URL`. */
  devClient: number;
  /** Wrangler's inspector (`--inspector-port`), which it would otherwise race other servers for. */
  inspector: number;
  /** Unassigned, reserved for this worktree. */
  spare: [number, number];
}

export function portLayout(base: number): PortLayout {
  return { backend: base, devClient: base + 1, inspector: base + 2, spare: [base + 3, base + PORT_BLOCK_SIZE - 1] };
}

/** Every port in the block starting at `base`. */
export function blockPorts(base: number): number[] {
  return Array.from({ length: PORT_BLOCK_SIZE }, (_, i) => base + i);
}

/**
 * The first block that no registry entry holds and in which nothing is listening. Listening is
 * probed for every port in the block, since a spare that is busy today is a clash tomorrow.
 */
export async function allocatePortBlock(
  taken: Iterable<number>, isListening: (port: number) => Promise<boolean>,
): Promise<number> {
  const held = new Set(taken);
  for (let i = 0; i < PORT_BLOCK_COUNT; i++) {
    const base = PORT_BLOCK_START + i * PORT_BLOCK_SIZE;
    if (held.has(base) || clashesWithInferOps(base)) continue;
    const busy = await Promise.all(blockPorts(base).map(isListening));
    if (!busy.some(Boolean)) return base;
  }
  throw new Error(`No free port block between ${PORT_BLOCK_START} and ` +
    `${PORT_BLOCK_START + PORT_BLOCK_COUNT * PORT_BLOCK_SIZE - 1}; remove unused worktrees (pnpm wt rm).`);
}

/**
 * Each worktree's `VP_RUN_CONCURRENCY_LIMIT`: the machine's limit (vp/concurrency.ts's formula,
 * which already caps CPUs by memory) divided by the number of registered worktrees, never below 2.
 * Without it every worktree's `vp run` claims the whole machine and N of them oversubscribe it N
 * times; the main checkout keeps its own default.
 */
export function concurrencyShare(machineLimit: number, activeWorktrees: number): number {
  return Math.max(2, Math.floor(machineLimit / Math.max(1, activeWorktrees)));
}

/** The `.env.worktree` overlay for `entry`. Only `wt` writes it; hand edits are overwritten. */
export function overlayContents(entry: WorktreeEntry, concurrency: number): string {
  const ports = portLayout(entry.portBase);
  return [
    `# Written by \`pnpm wt\` for worktree "${entry.name}"; rewritten on every wt new/rm, so do not edit.`,
    "# Loaded by pnpm dev-server/run-local/local and pnpm dev-client ahead of .dev.vars and .env;",
    "# the shell still wins. See docs/wiki/local-development.md.",
    `VITE_BACKEND_HOST=localhost:${ports.backend}`,
    `${DEV_CLIENT_PORT}=${ports.devClient}`,
    `${DEV_INSPECTOR_PORT}=${ports.inspector}`,
    `VP_RUN_CONCURRENCY_LIMIT=${concurrency}`,
    "",
  ].join("\n");
}

/** One finding of {@link checkOverlay}. */
export interface OverlayCheck {
  level: "ok" | "warn" | "error";
  message: string;
}

/**
 * Whether the `.env.worktree` read back from `entry`'s worktree still names the ports its registry
 * entry holds. A wrong backend is an error, since the dev server would bind another worktree's
 * port. A missing or wrong `DEV_INSPECTOR_PORT` is a warning: the first is an overlay written
 * before the inspector port existed, the second a hand edit, and either way that server races
 * others for its inspector (worktree-env.ts). Any `wt new` or `wt rm` rewrites the overlay.
 */
export function checkOverlay(entry: WorktreeEntry, overlay: Readonly<Record<string, string>>): OverlayCheck {
  const ports = portLayout(entry.portBase);
  const block = `ports ${entry.portBase}-${entry.portBase + PORT_BLOCK_SIZE - 1}`;
  const backend = `localhost:${ports.backend}`;
  const inspector = String(ports.inspector);
  const rewrite = "any pnpm wt new or rm rewrites it";
  if (overlay.VITE_BACKEND_HOST !== backend) {
    return { level: "error", message: `${entry.name}: ${WORKTREE_ENV_FILE} names ${overlay.VITE_BACKEND_HOST ?? "no backend"}, registry says ${backend}` };
  }
  const actual = overlay[DEV_INSPECTOR_PORT];
  // Blank counts as unset, as it does for inspectorPortArgs: Wrangler falls back to probing.
  if (actual === undefined || actual.trim() === "") {
    return { level: "warn", message: `${entry.name}: ${WORKTREE_ENV_FILE} sets no ${DEV_INSPECTOR_PORT}=${inspector}; ${rewrite}` };
  }
  // Compared as inspectorPortArgs reads it, so "08832" or " 8832" is the right port. Only decimal
  // digits count: Number would also read "0x2280" as 8832, which inspectorPortArgs refuses.
  const trimmed = actual.trim();
  if (!/^\d+$/.test(trimmed) || Number(trimmed) !== ports.inspector) {
    return { level: "warn", message: `${entry.name}: ${WORKTREE_ENV_FILE} sets ${DEV_INSPECTOR_PORT}=${actual}, but its block's inspector is ${inspector} (${block}); ${rewrite}` };
  }
  return { level: "ok", message: `${entry.name}: ${WORKTREE_ENV_FILE} matches ${block}` };
}

/**
 * The main checkout's local secret files a worktree links to, if they exist there. Linked, never
 * copied, so a rotated key reaches every worktree and no second copy exists to leak; both are
 * gitignored. `packages/workshop-backend/.dev.vars` is deliberately absent: the dev server appends
 * its per-run secrets to that file and refuses a symlink (local-secrets.ts), and a link would have
 * one worktree's run write into the main checkout's file.
 */
export const LINKED_SECRET_FILES = [".env", ".dev.vars"] as const;

/** Whether `name` is usable as a worktree name: one path segment, branch-safe. */
export function validWorktreeName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) && !name.includes("..") && !name.endsWith(".lock");
}
