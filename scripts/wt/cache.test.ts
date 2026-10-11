import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { parseVpStatistics, seedTaskCache, taskCacheDir } from "./cache.ts";

const fixtures = mkdtempSync(join(tmpdir(), "wt-cache-"));
after(() => rmSync(fixtures, { recursive: true, force: true }));
let count = 0;

async function checkoutWithCache(): Promise<string> {
  const root = join(fixtures, `main-${++count}`);
  const dir = join(taskCacheDir(root), "v18");
  mkdirSync(dir, { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(dir, "cache.db"));
  db.exec("create table cache_entries (key text primary key, value text); insert into cache_entries values ('k', 'v');");
  db.close();
  writeFileSync(join(dir, "abc.tar.zst"), "archive");
  writeFileSync(join(dir, "db_open.lock"), "");
  writeFileSync(join(dir, "last-summary.json"), "{}");
  return root;
}

describe("seedTaskCache", () => {
  it("copies the database and archives, not the main checkout's lock or last summary", async () => {
    const main = await checkoutWithCache();
    const worktree = join(fixtures, `wt-${count}`);
    const result = await seedTaskCache(main, worktree);
    assert.deepEqual(result, { seeded: true, files: 2 });
    const copied = join(taskCacheDir(worktree), "v18");
    assert.deepEqual(readdirSync(copied).toSorted(), ["abc.tar.zst", "cache.db"]);
    assert.equal(readFileSync(join(copied, "abc.tar.zst"), "utf8"), "archive");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(copied, "cache.db"), { readOnly: true });
    assert.deepEqual({ ...db.prepare("select value from cache_entries where key = 'k'").get() }, { value: "v" });
    db.close();
  });

  it("never overwrites a worktree's own cache, and tolerates a main checkout without one", async () => {
    const main = await checkoutWithCache();
    const worktree = join(fixtures, `wt-own-${count}`);
    mkdirSync(taskCacheDir(worktree), { recursive: true });
    assert.equal((await seedTaskCache(main, worktree)).seeded, false);
    const bare = await seedTaskCache(join(fixtures, "nothing"), join(fixtures, "nothing-wt"));
    assert.equal(bare.seeded, false);
    assert.equal(existsSync(taskCacheDir(join(fixtures, "nothing-wt"))), false);
  });
});

describe("parseVpStatistics", () => {
  it("reads every summary shape vp prints, last one winning", () => {
    assert.deepEqual(parseVpStatistics("x\n---\nvp run: 15/30 cache hit (50%), 7.57s saved."), { hits: 15, tasks: 30 });
    assert.deepEqual(parseVpStatistics("vp run: cache hit, 123ms saved."), { hits: 1, tasks: 1 });
    assert.deepEqual(parseVpStatistics("vp run: cache miss"), { hits: 0, tasks: 1 });
    assert.deepEqual(parseVpStatistics("Statistics:   3 tasks • 2 cache hits • 1 cache misses"), { tasks: 3, hits: 2 });
    assert.deepEqual(parseVpStatistics("\x1b[1mvp run: 0/2 cache hit\x1b[0m\nvp run: 2/2 cache hit"), { hits: 2, tasks: 2 });
    assert.equal(parseVpStatistics("nothing here"), null);
  });
});
