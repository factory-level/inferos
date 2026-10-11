import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { readRegistry, registryPath, tryReclaim, updateRegistry, withRegistryLock, writeRegistry } from "./registry.ts";

const fixtures = mkdtempSync(join(tmpdir(), "wt-registry-"));
after(() => rmSync(fixtures, { recursive: true, force: true }));
let count = 0;

/**
 * Run a child Node script to completion. Its stdio is never the test runner's: stdout is
 * discarded and stderr captured (bounded) for the failure message, so no child can touch the fds
 * the runner shares with its parent.
 */
function runChild(script: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { if (stderr.length < 4096) stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(`child exited ${code}: ${stderr.slice(0, 4096)}`)));
  });
}
const freshPath = () => join(fixtures, `case-${++count}`, "inferos", "worktrees.json");

describe("registryPath", () => {
  it("lives under XDG_CONFIG_HOME, defaulting to ~/.config", () => {
    assert.equal(registryPath({ XDG_CONFIG_HOME: "/x" }, "/home/u"), "/x/inferos/worktrees.json");
    assert.equal(registryPath({}, "/home/u"), "/home/u/.config/inferos/worktrees.json");
  });
});

describe("readRegistry / writeRegistry", () => {
  it("starts empty and round-trips, leaving no temp files and a private file", () => {
    const path = freshPath();
    assert.deepEqual(readRegistry(path), { version: 1, worktrees: [] });
    const entry = { name: "a", path: "/r/.worktrees/a", mainCheckout: "/r", branch: "a", portBase: 8800, createdAt: "2026-10-11T00:00:00.000Z" };
    writeRegistry(path, { version: 1, worktrees: [entry] });
    assert.deepEqual(readRegistry(path).worktrees, [entry]);
    assert.deepEqual(readdirSync(join(path, "..")), ["worktrees.json"]);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });

  it("refuses a file that is not a registry rather than overwriting it", () => {
    const path = freshPath();
    writeRegistry(path, { version: 1, worktrees: [] });
    writeFileSync(path, JSON.stringify({ something: "else" }));
    assert.throws(() => readRegistry(path), /not a version 1 worktree registry/);
  });
});

describe("withRegistryLock", () => {
  it("reclaims a lock its dead owner left behind", async () => {
    const path = freshPath();
    writeRegistry(path, { version: 1, worktrees: [] });
    // A pid that cannot be alive, written long enough ago to be past the grace period.
    writeFileSync(`${path}.lock`, "2147483646\n");
    const old = new Date(Date.now() - 5_000);
    utimesSync(`${path}.lock`, old, old);
    assert.equal(await withRegistryLock(path, () => "ran", { timeoutMs: 2_000 }), "ran");
    assert.equal(existsSync(`${path}.lock`), false);
  });

  it("times out while a live owner holds it", async () => {
    const path = freshPath();
    writeRegistry(path, { version: 1, worktrees: [] });
    writeFileSync(`${path}.lock`, `${process.pid}\n`);
    await assert.rejects(withRegistryLock(path, () => "ran", { timeoutMs: 300 }), /Timed out/);
    rmSync(`${path}.lock`);
  });

  it("releases the lock when the critical section throws", async () => {
    const path = freshPath();
    await assert.rejects(withRegistryLock(path, () => { throw new Error("boom"); }), /boom/);
    assert.equal(existsSync(`${path}.lock`), false);
  });
});

describe("tryReclaim", () => {
  // The race: this waiter judged the lock stale, but before it acts another waiter has already
  // reclaimed it and taken a fresh one. A plain unlink would delete that live lock.
  it("never removes a lock that replaced the one it judged stale", () => {
    const path = freshPath();
    writeRegistry(path, { version: 1, worktrees: [] });
    const lock = `${path}.lock`;
    writeFileSync(lock, "2147483646\n");
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    tryReclaim(lock, 60_000, () => {
      rmSync(lock);
      writeFileSync(lock, `${process.pid}\nfresh\n`);
    });
    assert.equal(readFileSync(lock, "utf8"), `${process.pid}\nfresh\n`);
    assert.deepEqual(readdirSync(join(path, "..")).filter(name => name.includes(".stale.")), []);
    rmSync(lock);
  });

  it("removes the stale lock it judged", () => {
    const path = freshPath();
    writeRegistry(path, { version: 1, worktrees: [] });
    writeFileSync(`${path}.lock`, "2147483646\n");
    const old = new Date(Date.now() - 120_000);
    utimesSync(`${path}.lock`, old, old);
    tryReclaim(`${path}.lock`, 60_000);
    assert.equal(existsSync(`${path}.lock`), false);
  });

  it("leaves a holder's release from deleting a lock that replaced its own", async () => {
    const path = freshPath();
    await withRegistryLock(path, () => {
      rmSync(`${path}.lock`);
      writeFileSync(`${path}.lock`, "someone else\n");
    });
    assert.equal(readFileSync(`${path}.lock`, "utf8"), "someone else\n");
    rmSync(`${path}.lock`);
  });
});

describe("stale-lock reclaim under contention", () => {
  // Several waiters judge the same abandoned lock stale at once. Each may reclaim it, but only the
  // stale file may be removed: the first waiter's fresh lock must survive the others' reclaims, so
  // no two processes are ever inside the critical section together.
  it("never lets two processes hold the lock", async () => {
    for (let round = 0; round < 4; round++) {
      const path = freshPath();
      writeRegistry(path, { version: 1, worktrees: [] });
      writeFileSync(`${path}.lock`, "2147483646\n");
      const old = new Date(Date.now() - 120_000);
      utimesSync(`${path}.lock`, old, old);
      const inside = `${path}.inside`;
      const script = `
        import { openSync, closeSync, unlinkSync, appendFileSync } from "node:fs";
        import { withRegistryLock } from ${JSON.stringify(new URL("./registry.ts", import.meta.url).href)};
        const [path, inside] = process.argv.slice(1);
        await withRegistryLock(path, async () => {
          let fd;
          try { fd = openSync(inside, "wx"); } catch { appendFileSync(path + ".violations", "x"); return; }
          await new Promise(resolve => setTimeout(resolve, 20));
          closeSync(fd);
          unlinkSync(inside);
        });`;
      await Promise.all(Array.from({ length: 8 }, () => runChild(script, [path, inside])));
      assert.equal(existsSync(`${path}.violations`), false, `round ${round}: two holders at once`);
      assert.equal(existsSync(`${path}.lock`), false);
      assert.deepEqual(readdirSync(join(path, "..")).filter(name => name.includes(".stale.")), []);
    }
  });
});

describe("updateRegistry under concurrent writers", () => {
  // The property that matters: N processes each appending at once lose nothing. Without the lock,
  // the read-modify-write races and later writers drop earlier writers' entries.
  it("loses no update across processes", async () => {
    const path = freshPath();
    const writers = 6;
    const perWriter = 5;
    const script = `
      import { updateRegistry } from ${JSON.stringify(new URL("./registry.ts", import.meta.url).href)};
      const [path, id, n] = process.argv.slice(1);
      for (let i = 0; i < Number(n); i++) {
        await updateRegistry(path, async registry => {
          await new Promise(resolve => setTimeout(resolve, Math.random() * 5));
          registry.worktrees.push({ name: id + "-" + i, path: "/p/" + id + "-" + i, mainCheckout: "/p",
            branch: "b", portBase: 0, createdAt: "" });
        });
      }`;
    await Promise.all(Array.from({ length: writers }, (_, id) => runChild(script, [path, `w${id}`, String(perWriter)])));
    const names = readRegistry(path).worktrees.map(({ name }) => name);
    assert.equal(names.length, writers * perWriter);
    assert.equal(new Set(names).size, writers * perWriter);
  });

  it("writes nothing when the update throws", async () => {
    const path = freshPath();
    await updateRegistry(path, registry => { registry.worktrees.push({ name: "kept", path: "/k", mainCheckout: "/", branch: "b", portBase: 8800, createdAt: "" }); });
    await assert.rejects(updateRegistry(path, registry => { registry.worktrees = []; throw new Error("nope"); }), /nope/);
    assert.equal(readRegistry(path).worktrees.length, 1);
  });
});
