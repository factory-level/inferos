import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { getDevServerConfig } from "../dev-server-config.ts";
import { DEV_INSPECTOR_PORT, devClientServerOptions, inspectorPortArgs, readWorktreeEnv, WORKTREE_ENV_FILE } from "../worktree-env.ts";
import {
  allocatePortBlock, blockPorts, checkOverlay, clashesWithInferOps, concurrencyShare, LINKED_SECRET_FILES, overlayContents, PORT_BLOCK_COUNT,
  PORT_BLOCK_START, portLayout, validWorktreeName,
} from "./layout.ts";

const nothingListens = async () => false;

describe("allocatePortBlock", () => {
  it("starts at 8810 and skips blocks the registry holds", async () => {
    assert.equal(await allocatePortBlock([], nothingListens), 8810);
    assert.equal(await allocatePortBlock([8810, 8820], nothingListens), 8830);
    // A freed block in the middle is reused before a new one is opened.
    assert.equal(await allocatePortBlock([8810, 8830], nothingListens), 8820);
  });

  it("skips a block in which anything listens, spares included", async () => {
    const listening = new Set([8810, 8827]);
    assert.equal(await allocatePortBlock([], async port => listening.has(port)), 8830);
  });

  // InferOps shifts 8080/8000/8001/8090 and 3000-3002 by offset x 100 per worktree.
  it("never hands out a block holding a port an InferOps worktree could use", async () => {
    const handed: number[] = [];
    for (;;) {
      try {
        handed.push(await allocatePortBlock(handed, nothingListens));
      } catch {
        break;
      }
    }
    const inferOps = new Set<number>();
    for (let offset = 0; offset < 20; offset++) {
      for (const base of [8080, 8000, 8001, 8090, 3000, 3001, 3002]) inferOps.add(base + 100 * offset);
    }
    for (const base of handed) {
      assert.equal(blockPorts(base).some(port => inferOps.has(port)), false, `block ${base}`);
      assert.equal(clashesWithInferOps(base), false);
    }
    assert.equal(handed.length, 28);
    assert.ok(clashesWithInferOps(8880) && clashesWithInferOps(8800) && clashesWithInferOps(8890));
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

describe("every port a dev server pins is the worktree's own", () => {
  // What wrangler dev binds at a fixed number: the public origin (--port, from VITE_BACKEND_HOST)
  // and the inspector (--inspector-port, from DEV_INSPECTOR_PORT); Vite binds DEV_CLIENT_PORT. Its
  // other listeners (miniflare loopback, the proxy workers' entry sockets) are port 0, and the dev
  // registry is a directory, not a port -- nothing else to pin.
  it("gives any two worktrees disjoint ports, each inside its own block", async () => {
    const bases: number[] = [];
    for (let i = 0; i < 6; i++) bases.push(await allocatePortBlock(bases, nothingListens));
    const seen = new Map<number, number>();
    for (const base of bases) {
      const dir = mkdtempSync(join(tmpdir(), "wt-ports-"));
      try {
        writeFileSync(join(dir, WORKTREE_ENV_FILE), overlayContents(
          { name: `w${base}`, path: dir, mainCheckout: "/m", branch: "b", portBase: base, createdAt: "" }, 2));
        const overlay = readWorktreeEnv(dir);
        const pinned = [
          Number(getDevServerConfig([], overlay.VITE_BACKEND_HOST).wranglerPort),
          devClientServerOptions(dir, {}).port,
          Number(inspectorPortArgs(overlay)[1]),
        ];
        assert.equal(new Set(pinned).size, pinned.length, `block ${base} reuses a port`);
        const [spareFrom, spareTo] = portLayout(base).spare;
        for (const port of pinned) {
          assert.ok(blockPorts(base).includes(port), `${port} is outside block ${base}`);
          // A spare is unassigned by definition, so a pinned port there is one wt could hand out twice.
          assert.ok(port < spareFrom || port > spareTo, `${port} is pinned but inside block ${base}'s spares ${spareFrom}-${spareTo}`);
          assert.equal(seen.get(port), undefined, `${port} is shared by blocks ${seen.get(port)} and ${base}`);
          seen.set(port, base);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

describe("portLayout", () => {
  it("gives each role its own port and leaves the rest of the block, and only that, spare", () => {
    for (const base of [8810, 8830, 9170]) {
      const { backend, devClient, inspector, spare: [from, to] } = portLayout(base);
      const spares = blockPorts(base).filter(port => port >= from && port <= to);
      assert.deepEqual([backend, devClient, inspector, ...spares].toSorted((a, b) => a - b), blockPorts(base), `block ${base}`);
    }
  });
});

describe("checkOverlay", () => {
  const entry = { name: "probe", path: "/w", mainCheckout: "/m", branch: "probe", portBase: 8830, createdAt: "" };
  const written = () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-check-"));
    try {
      writeFileSync(join(dir, WORKTREE_ENV_FILE), overlayContents(entry, 2));
      return readWorktreeEnv(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("accepts the overlay wt writes", () => {
    assert.deepEqual(checkOverlay(entry, written()), { level: "ok", message: `probe: ${WORKTREE_ENV_FILE} matches ports 8830-8839` });
  });

  it("is an error when the backend is another block's", () => {
    const check = checkOverlay(entry, { ...written(), VITE_BACKEND_HOST: "localhost:8840" });
    assert.equal(check.level, "error");
    assert.match(check.message, /names localhost:8840, registry says localhost:8830/);
  });

  it("warns when the inspector port is missing", () => {
    const { [DEV_INSPECTOR_PORT]: _, ...old } = written();
    for (const overlay of [old, { ...old, [DEV_INSPECTOR_PORT]: "" }, { ...old, [DEV_INSPECTOR_PORT]: " " }]) {
      const check = checkOverlay(entry, overlay);
      assert.equal(check.level, "warn");
      assert.match(check.message, /sets no DEV_INSPECTOR_PORT=8832;/);
    }
  });

  it("warns, naming both, when the inspector port is not base + 2", () => {
    for (const wrong of ["8839", "9229", "8842", "8831"]) {
      const check = checkOverlay(entry, { ...written(), [DEV_INSPECTOR_PORT]: wrong });
      assert.equal(check.level, "warn", wrong);
      assert.match(check.message, new RegExp(`sets DEV_INSPECTOR_PORT=${wrong}, but its block's inspector is 8832 \\(ports 8830-8839\\)`), wrong);
    }
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
      // Each worktree's own Wrangler inspector, inside its block, so concurrent servers never race.
      assert.equal(overlay[DEV_INSPECTOR_PORT], "8832");
      assert.deepEqual(inspectorPortArgs(overlay), ["--inspector-port", "8832"]);
      assert.deepEqual(portLayout(8830).spare, [8833, 8839]);
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
    for (const name of ["", "..", ".", "../x", "../../x", "a/b", "a\\b", "/abs", "/tmp/x", "-x", ".hidden", "x.lock", "a..b", "x".repeat(65)]) {
      assert.equal(validWorktreeName(name), false, name);
    }
  });
});
