// `pnpm wt rm` against a throwaway clone (never this repository): every attempt to steer a removal
// outside `.worktrees/` must refuse and delete nothing, and a legitimate removal still works.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { readRegistry, writeRegistry, type WorktreeEntry } from "./registry.ts";
import { runWt } from "./wt.ts";

let temp: string;
let main: string;
let registryPath: string;
let sibling: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const listed = () => git(main, "worktree", "list", "--porcelain");
const entry = (name: string, path: string, portBase = 8810): WorktreeEntry =>
  ({ name, path, mainCheckout: main, branch: name, portBase, createdAt: "" });

/** Quietly run `wt` against the fixture; returns the error it threw, if any. */
async function wt(...argv: string[]): Promise<Error | null> {
  const log = console.log;
  console.log = () => {};
  try {
    await runWt(argv, { repoRoot: main, registryPath });
    return null;
  } catch (error) {
    return error as Error;
  } finally {
    console.log = log;
  }
}

function assertSiblingIntact(): void {
  assert.ok(existsSync(join(sibling, "marker.txt")), "the sibling worktree's files must survive");
  assert.ok(listed().includes(sibling), "the sibling must still be a git worktree");
}

before(() => {
  temp = realpathSync(mkdtempSync(join(tmpdir(), "wt-rm-")));
  git(temp, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(temp, "clone", "-q", join(temp, "origin.git"), "main");
  main = join(temp, "main");
  writeFileSync(join(main, ".gitignore"), "/.worktrees/\n.wrangler\nnode_modules/\n.env\n.env.worktree\n");
  writeFileSync(join(main, "README.md"), "fixture\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "init");
  git(main, "push", "-q", "origin", "HEAD:main");
  mkdirSync(join(main, ".worktrees"));
  // The kind of target the bug reached: a real worktree beside the main checkout.
  sibling = join(temp, "main-wt-sibling");
  git(main, "worktree", "add", "-q", "-b", "sibling", sibling, "origin/main");
  writeFileSync(join(sibling, "marker.txt"), "keep me\n");
  registryPath = join(temp, "config", "inferos", "worktrees.json");
});
after(() => rmSync(temp, { recursive: true, force: true }));

describe("wt rm refuses anything outside .worktrees/", () => {
  for (const name of ["..", "../..", "../main-wt-sibling", "../../main-wt-sibling", "a/b", "a\\b", "", ".hidden"]) {
    it(`refuses the name ${JSON.stringify(name)}, with or without --force`, async () => {
      for (const force of [[], ["--force"]]) {
        const error = await wt("rm", name, ...force);
        assert.ok(error, "must refuse");
        assertSiblingIntact();
      }
    });
  }

  it("refuses an absolute path", async () => {
    assert.ok(await wt("rm", sibling, "--force"));
    assertSiblingIntact();
  });

  it("refuses a symlink inside .worktrees/ that points outside", async () => {
    const link = join(main, ".worktrees", "link");
    symlinkSync(sibling, link);
    writeRegistry(registryPath, { version: 1, worktrees: [entry("link", link)] });
    try {
      for (const force of [[], ["--force"]]) {
        const error = await wt("rm", "link", ...force);
        assert.match(String(error), /symbolic link/);
        assertSiblingIntact();
      }
    } finally {
      rmSync(link);
      writeRegistry(registryPath, { version: 1, worktrees: [] });
    }
  });

  it("refuses a tampered registry entry whose path points outside", async () => {
    writeRegistry(registryPath, { version: 1, worktrees: [entry("evil", sibling)] });
    try {
      for (const force of [[], ["--force"]]) {
        const error = await wt("rm", "evil", ...force);
        assert.match(String(error), /Refusing: .*main-wt-sibling is not a worktree directory directly inside/);
        assertSiblingIntact();
      }
      // Nor does any registry write steer an overlay there.
      assert.equal(existsSync(join(sibling, ".env.worktree")), false);
    } finally {
      writeRegistry(registryPath, { version: 1, worktrees: [] });
    }
  });
});

describe("wt rm refuses a registry entry that disagrees with its name", () => {
  it("refuses an entry whose path names another .worktrees/ child", async () => {
    const other = join(main, ".worktrees", "other");
    git(main, "worktree", "add", "-q", "-b", "other", other, "origin/main");
    writeRegistry(registryPath, { version: 1, worktrees: [entry("decoy", other)] });
    try {
      assert.match(String(await wt("rm", "decoy", "--force")), /registry entry for decoy points at/);
      assert.ok(existsSync(other));
    } finally {
      writeRegistry(registryPath, { version: 1, worktrees: [] });
      git(main, "worktree", "remove", "--force", other);
    }
  });
});

describe("wt rm with .worktrees/ itself a symlink out of the checkout", () => {
  it("refuses everything under it", async () => {
    const outside = join(temp, "elsewhere");
    mkdirSync(outside);
    const target = join(outside, "victim");
    git(main, "worktree", "add", "-q", "-b", "victim", target, "origin/main");
    const real = join(main, ".worktrees");
    const moved = join(temp, "worktrees-moved");
    execFileSync("mv", [real, moved]);
    symlinkSync(outside, real);
    writeRegistry(registryPath, { version: 1, worktrees: [entry("victim", join(real, "victim"))] });
    try {
      assert.match(String(await wt("rm", "victim", "--force")), /Refusing/);
      assert.ok(existsSync(join(target, "README.md")));
    } finally {
      rmSync(real);
      execFileSync("mv", [moved, real]);
      writeRegistry(registryPath, { version: 1, worktrees: [] });
      git(main, "worktree", "remove", "--force", target);
    }
  });
});

describe("wt rm inside .worktrees/", () => {
  it("removes a registered, clean worktree through git", async () => {
    const path = join(main, ".worktrees", "ok");
    git(main, "worktree", "add", "-q", "-b", "ok", path, "origin/main");
    mkdirSync(join(path, "node_modules", "x"), { recursive: true });
    mkdirSync(join(path, ".wrangler", "tmp"), { recursive: true });
    writeRegistry(registryPath, { version: 1, worktrees: [entry("ok", path)] });
    assert.equal(await wt("rm", "ok"), null);
    assert.equal(existsSync(path), false);
    assert.deepEqual(readRegistry(registryPath).worktrees, []);
    assertSiblingIntact();
  });

  it("refuses to delete ignored local state without --force, and lists it", async () => {
    const path = join(main, ".worktrees", "stateful");
    git(main, "worktree", "add", "-q", "-b", "stateful", path, "origin/main");
    mkdirSync(join(path, ".wrangler", "state", "v3", "d1"), { recursive: true });
    writeFileSync(join(path, ".wrangler", "state", "v3", "d1", "db.sqlite"), "data");
    writeFileSync(join(path, ".env"), "LOCAL=1\n");
    writeRegistry(registryPath, { version: 1, worktrees: [entry("stateful", path)] });
    const error = await wt("rm", "stateful");
    assert.match(String(error), /ignored local state that removal would delete: /);
    assert.match(String(error), /\.wrangler\/state\//);
    assert.match(String(error), /\.env\b/);
    assert.ok(existsSync(join(path, ".wrangler", "state", "v3", "d1", "db.sqlite")));
    assert.equal(await wt("rm", "stateful", "--force"), null);
    assert.equal(existsSync(path), false);
  });

  it("refuses an unregistered .worktrees/ entry unless --force", async () => {
    const path = join(main, ".worktrees", "byhand");
    git(main, "worktree", "add", "-q", "-b", "byhand", path, "origin/main");
    assert.match(String(await wt("rm", "byhand")), /did not create/);
    assert.ok(existsSync(path));
    assert.equal(await wt("rm", "byhand", "--force"), null);
    assert.equal(existsSync(path), false);
  });

  it("drops a registration whose directory is not a git worktree, deleting nothing", async () => {
    const path = join(main, ".worktrees", "plain");
    mkdirSync(path);
    writeFileSync(join(path, "keep.txt"), "x");
    writeRegistry(registryPath, { version: 1, worktrees: [entry("plain", path)] });
    assert.equal(await wt("rm", "plain"), null);
    assert.ok(existsSync(join(path, "keep.txt")));
    assert.deepEqual(readRegistry(registryPath).worktrees, []);
    rmSync(path, { recursive: true });
  });
});
