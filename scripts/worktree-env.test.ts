import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { localEnv } from "./local/stack.ts";
import { concurrencyEnv } from "./vp/concurrency.ts";
import {
  DEV_CLIENT_PORT, devClientServerOptions, readEnvFile, readWorktreeEnv, withWorktreeEnv, WORKTREE_ENV_FILE,
} from "./worktree-env.ts";

const fixtures = mkdtempSync(join(tmpdir(), "worktree-env-"));
after(() => rmSync(fixtures, { recursive: true, force: true }));
let count = 0;

/** A checkout root holding the given files. */
function root(files: Record<string, string>): string {
  const dir = mkdtempSync(join(fixtures, `root-${++count}-`));
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents);
  return dir;
}

describe("readEnvFile", () => {
  it("parses dotenv text and treats a missing file as empty", () => {
    const dir = root({ "x.env": "# c\nA=1\nexport B='two'\n" });
    assert.deepEqual(readEnvFile(join(dir, "x.env")), { A: "1", B: "two" });
    assert.deepEqual(readEnvFile(join(dir, "absent")), {});
    assert.deepEqual(readWorktreeEnv(dir), {});
  });
});

describe("precedence: shell, then .env.worktree, then .dev.vars, then .env", () => {
  const dir = root({
    [WORKTREE_ENV_FILE]: "VITE_BACKEND_HOST=localhost:8800\nVP_RUN_CONCURRENCY_LIMIT=3\n",
    ".dev.vars": "VITE_BACKEND_HOST=localhost:1111\nFROM_DEV_VARS=yes\n",
    ".env": "VITE_BACKEND_HOST=localhost:2222\nANTHROPIC_API_KEY=k\n",
  });

  it("withWorktreeEnv fills only what the shell leaves unset", () => {
    assert.equal(withWorktreeEnv(dir, {}).VITE_BACKEND_HOST, "localhost:8800");
    assert.equal(withWorktreeEnv(dir, { VITE_BACKEND_HOST: "localhost:9" }).VITE_BACKEND_HOST, "localhost:9");
    // The overlay alone: shared secrets files are not its business.
    assert.equal(withWorktreeEnv(dir, {}).ANTHROPIC_API_KEY, undefined);
  });

  it("localEnv puts the overlay above the shared .dev.vars and .env", () => {
    const merged = localEnv(dir, {});
    assert.equal(merged.VITE_BACKEND_HOST, "localhost:8800");
    assert.equal(merged.FROM_DEV_VARS, "yes");
    assert.equal(merged.ANTHROPIC_API_KEY, "k");
    assert.equal(localEnv(dir, { VITE_BACKEND_HOST: "shell:1" }).VITE_BACKEND_HOST, "shell:1");
  });

  it("is unchanged for a checkout with no overlay", () => {
    const plain = root({ ".dev.vars": "VITE_BACKEND_HOST=localhost:1111\n", ".env": "VITE_BACKEND_HOST=localhost:2222\n" });
    assert.equal(localEnv(plain, {}).VITE_BACKEND_HOST, "localhost:1111");
  });
});

describe("devClientServerOptions", () => {
  it("keeps Vite's long-standing default without an overlay", () => {
    const env: NodeJS.ProcessEnv = {};
    assert.deepEqual(devClientServerOptions(root({}), env), { port: 3000, strictPort: false });
    assert.equal(env.VITE_BACKEND_HOST, undefined);
  });

  it("takes the overlay's port strictly and hands Vite its backend host", () => {
    const dir = root({ [WORKTREE_ENV_FILE]: `VITE_BACKEND_HOST=localhost:8800\n${DEV_CLIENT_PORT}=8801\n` });
    const env: NodeJS.ProcessEnv = {};
    assert.deepEqual(devClientServerOptions(dir, env), { port: 8801, strictPort: true });
    assert.equal(env.VITE_BACKEND_HOST, "localhost:8800");
  });

  it("lets the shell win for both", () => {
    const dir = root({ [WORKTREE_ENV_FILE]: `VITE_BACKEND_HOST=localhost:8800\n${DEV_CLIENT_PORT}=8801\n` });
    const env: NodeJS.ProcessEnv = { VITE_BACKEND_HOST: "localhost:7000", [DEV_CLIENT_PORT]: "7001" };
    assert.deepEqual(devClientServerOptions(dir, env), { port: 7001, strictPort: true });
    assert.equal(env.VITE_BACKEND_HOST, "localhost:7000");
  });

  it("rejects a port that is not one", () => {
    for (const bad of ["80a", "1.5", "80", "1023", "65536", "-1"]) {
      assert.throws(() => devClientServerOptions(root({}), { [DEV_CLIENT_PORT]: bad }), /between 1024 and 65535/, bad);
    }
    assert.deepEqual(devClientServerOptions(root({}), { [DEV_CLIENT_PORT]: "1024" }), { port: 1024, strictPort: true });
  });
});

describe("concurrency note", () => {
  it("names the overlay when the limit came from it", () => {
    const { env, note } = concurrencyEnv({}, { cpus: 14, memoryBytes: 64 * 1024 ** 3 }, "3", WORKTREE_ENV_FILE);
    assert.equal(env.VP_RUN_CONCURRENCY_LIMIT, "3");
    assert.equal(note, "vp run: concurrency 3 (from .env.worktree)");
  });
});
