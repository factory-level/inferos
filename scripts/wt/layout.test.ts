import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { getDevServerConfig } from "../dev-server-config.ts";
import { devClientServerOptions, readWorktreeEnv, WORKTREE_ENV_FILE } from "../worktree-env.ts";
import {
  allocatePortBlock, blockPorts, concurrencyShare, LINKED_SECRET_FILES, overlayContents, PORT_BLOCK_COUNT,
  PORT_BLOCK_START, portLayout, validWorktreeName,
} from "./layout.ts";

const nothingListens = async () => false;

describe("allocatePortBlock", () => {
  it("starts at 8800 and skips blocks the registry holds", async () => {
    assert.equal(await allocatePortBlock([], nothingListens), PORT_BLOCK_START);
    assert.equal(await allocatePortBlock([8800, 8810], nothingListens), 8820);
    // A freed block in the middle is reused before a new one is opened.
    assert.equal(await allocatePortBlock([8800, 8820], nothingListens), 8810);
  });

  it("skips a block in which anything listens, spares included", async () => {
    const listening = new Set([8800, 8817]);
    assert.equal(await allocatePortBlock([], async port => listening.has(port)), 8820);
  });

  it("fails loudly when every block is taken", async () => {
    const all = Array.from({ length: PORT_BLOCK_COUNT }, (_, i) => PORT_BLOCK_START + i * 10);
    await assert.rejects(allocatePortBlock(all, nothingListens), /No free port block/);
  });

  it("never reaches Node's inspector port", () => {
    const last = PORT_BLOCK_START + (PORT_BLOCK_COUNT - 1) * 10;
    assert.ok(Math.max(...blockPorts(last)) < 9229);
  });
});

describe("concurrencyShare", () => {
  it("divides the machine and never goes below 2", () => {
    assert.equal(concurrencyShare(14, 1), 14);
    assert.equal(concurrencyShare(14, 2), 7);
    assert.equal(concurrencyShare(14, 5), 2);
    assert.equal(concurrencyShare(14, 20), 2);
    assert.equal(concurrencyShare(4, 0), 4);
  });
});

describe("overlayContents", () => {
  it("is read back by the dev server and Vite as this worktree's ports", () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-overlay-"));
    try {
      const entry = { name: "probe", path: dir, mainCheckout: "/m", branch: "probe", portBase: 8830, createdAt: "" };
      writeFileSync(join(dir, WORKTREE_ENV_FILE), overlayContents(entry, 7));
      const overlay = readWorktreeEnv(dir);
      assert.equal(overlay.VP_RUN_CONCURRENCY_LIMIT, "7");
      assert.deepEqual(getDevServerConfig([], overlay.VITE_BACKEND_HOST), { backendHost: "localhost:8830", wranglerPort: "8830" });
      assert.deepEqual(devClientServerOptions(dir, {}), { port: portLayout(8830).devClient, strictPort: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("secrets", () => {
  // The backend's .dev.vars is the dev server's per-run scratch file, and it refuses a symlink.
  it("links the root .env and .dev.vars only", () => {
    assert.deepEqual([...LINKED_SECRET_FILES], [".env", ".dev.vars"]);
  });
});

describe("validWorktreeName", () => {
  it("accepts one branch-safe path segment", () => {
    for (const name of ["probe-a", "feat_1", "v2.3"]) assert.ok(validWorktreeName(name), name);
    for (const name of ["", "../x", "a/b", "-x", ".hidden", "x.lock", "a..b", "x".repeat(65)]) {
      assert.equal(validWorktreeName(name), false, name);
    }
  });
});
