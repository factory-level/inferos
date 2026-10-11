// Seeding a new worktree's Vite+ task cache from the main checkout's. vp keeps the cache per
// checkout at `node_modules/.vite/task-cache/` and has no setting to share or relocate it, so a fresh
// worktree would rebuild every UI bundle and blueprint the main checkout already built. The entries
// are keyed on workspace-relative inputs (scripts/vitest-task-vite-config.ts), so they carry over to
// a worktree whose files match.
//
// Copied, never symlinked: vp writes the cache as it runs, and two checkouts writing one SQLite
// database and archive directory concurrently is not something vp is built for. The database is
// copied through SQLite's online backup, so a vp run in the main checkout mid-write cannot hand us a
// torn file; the archives are copied after it, so every archive the snapshot names already exists.

import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** vp's cache directory under a checkout. */
export function taskCacheDir(root: string): string {
  return join(root, "node_modules", ".vite", "task-cache");
}

/** Files that describe a checkout's own runs or locks, not reusable results. */
const NOT_COPIED = new Set(["db_open.lock", "last-summary.json"]);

async function backupDatabase(source: string, destination: string): Promise<void> {
  // `node:sqlite` still prints an ExperimentalWarning on import; it is not ours to show.
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning.message;
    if (!/SQLite is an experimental feature/.test(text)) (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  let sqlite: typeof import("node:sqlite");
  try {
    sqlite = await import("node:sqlite");
  } finally {
    process.emitWarning = emitWarning;
  }
  const db = new sqlite.DatabaseSync(source, { readOnly: true });
  try {
    await sqlite.backup(db, destination);
  } finally {
    db.close();
  }
}

/** What {@link seedTaskCache} did. */
export interface SeedResult {
  seeded: boolean;
  /** Why nothing was copied, when `seeded` is false. */
  reason?: string;
  files: number;
}

/**
 * Copy `fromRoot`'s task cache into `toRoot`, which must not have one yet (a worktree's own cache
 * is never overwritten). Each versioned subdirectory (`v18/`, …) is copied: database first, then
 * the archives it names.
 */
export async function seedTaskCache(fromRoot: string, toRoot: string): Promise<SeedResult> {
  const from = taskCacheDir(fromRoot);
  const to = taskCacheDir(toRoot);
  if (!existsSync(from)) return { seeded: false, reason: `no task cache at ${from}`, files: 0 };
  if (existsSync(to)) return { seeded: false, reason: `${to} already exists`, files: 0 };
  let files = 0;
  for (const version of readdirSync(from, { withFileTypes: true })) {
    if (!version.isDirectory()) continue;
    const source = join(from, version.name);
    const target = join(to, version.name);
    mkdirSync(target, { recursive: true });
    const entries = readdirSync(source, { withFileTypes: true }).filter(entry => !NOT_COPIED.has(entry.name));
    const db = entries.find(entry => entry.name === "cache.db");
    if (db) {
      await backupDatabase(join(source, db.name), join(target, db.name));
      files++;
    }
    for (const entry of entries) {
      // The database's journal files belong to the live database; the backup is self-contained.
      if (entry.name.startsWith("cache.db")) continue;
      cpSync(join(source, entry.name), join(target, entry.name), { recursive: true, preserveTimestamps: true });
      files++;
    }
  }
  return { seeded: true, files };
}

/** A `vp run` summary's counts. */
export interface VpStatistics {
  tasks: number;
  hits: number;
}

/**
 * The cache counts a `vp run` reports, from either its closing line ("vp run: 15/30 cache hit
 * (50%) …", or "vp run: cache hit, 123ms saved." for one task) or `vp run --last-details`
 * ("Statistics:   3 tasks • 2 cache hits • 1 cache misses"). The last match wins, so captured
 * output from a whole run parses to its final summary. Null when there is none.
 */
export function parseVpStatistics(text: string): VpStatistics | null {
  const plain = text.replaceAll(new RegExp(String.raw`\x1b\[[0-9;]*m`, "g"), "");
  let result: VpStatistics | null = null;
  const pattern = /vp run: (\d+)\/(\d+) cache hit|vp run: cache (hit|miss)|Statistics:\s*(\d+) tasks?\D+(\d+) cache hit/g;
  for (const match of plain.matchAll(pattern)) {
    if (match[1] !== undefined) result = { hits: Number(match[1]), tasks: Number(match[2]) };
    else if (match[3] !== undefined) result = { hits: match[3] === "hit" ? 1 : 0, tasks: 1 };
    else result = { tasks: Number(match[4]), hits: Number(match[5]) };
  }
  return result;
}
