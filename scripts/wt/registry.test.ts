import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { readRegistry, registryPath, updateRegistry, withRegistryLock, writeRegistry } from "./registry.ts";

const fixtures = mkdtempSync(join(tmpdir(), "wt-registry-"));
after(() => rmSync(fixtures, { recursive: true, force: true }));
let count = 0;
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
    await Promise.all(Array.from({ length: writers }, (_, id) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, path, `w${id}`, String(perWriter)], { stdio: "inherit" });
      child.on("exit", code => code === 0 ? resolve() : reject(new Error(`writer ${id} exited ${code}`)));
    })));
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
