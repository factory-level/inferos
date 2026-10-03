// The coding runner commands (`pnpm local runner …`, `pnpm local coding doctor`). The runner and
// Codex here are the MOCK binaries in testdata/: these tests prove what the lifecycle decides, writes
// and passes on, not what the InferOps runner does with it.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { localLifecycleArgs } from "../consumer/runtime.ts";
import { defaultDeps, EXIT_FAILED, EXIT_OK, EXIT_USAGE, runLifecycle, type LifecycleDeps } from "./lifecycle.ts";
import {
  buildRunnerFile, isProviderVariable, PAUSE_FILE, redact, runnerChildEnv, secretValues, splitTestCommand,
} from "./runner.ts";
import { makeCodingWrapper, REPO_ID } from "./testdata/coding-wrapper.ts";

const REPO = join(import.meta.dirname, "..", "..");

/** A parent environment full of things the runner must not receive. */
const PARENT_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
  OPENAI_API_KEY: "sk-openai-parent-secret", OPENAI_BASE_URL: "https://api.openai.example",
  ANTHROPIC_API_KEY: "sk-ant-parent-secret", CODEX_API_KEY: "codex-parent-secret",
  AZURE_OPENAI_API_KEY: "azure-parent-secret", GH_TOKEN: "ghp_parentsecret", INFEROPS_API_TOKEN: "person-token-secret",
};

function deps(overrides: Partial<LifecycleDeps> = {}): LifecycleDeps & { launches: string[][] } {
  const launches: string[][] = [];
  return {
    ...defaultDeps,
    root: REPO,
    env: PARENT_ENV,
    sleep: async () => {},
    launch: (argv) => {
      launches.push(argv);
      throw new Error("launch must not be reached");
    },
    launches,
    ...overrides,
  };
}

test("test commands become argv without a shell; shell syntax is refused", () => {
  assert.deepEqual(splitTestCommand("pnpm test"), ["pnpm", "test"]);
  assert.deepEqual(splitTestCommand(`node  --test "a b.test.ts" 'c*'`), ["node", "--test", "a b.test.ts", "c*"]);
  assert.deepEqual(splitTestCommand(`echo ""`), ["echo", ""]);
  for (const bad of ["pnpm test && rm -rf /", "a | b", "echo $HOME", "a > out", "`id`", "\"open", "   "]) {
    assert.throws(() => splitTestCommand(bad), Error, bad);
  }
  assert.deepEqual(buildRunnerFile([{ repoId: REPO_ID, path: "/src/demo", testCommands: ["pnpm test", "pnpm lint"], baseRef: "main" }]), {
    repos: { [REPO_ID]: { path: "/src/demo", baseRef: "main", testCommands: [["pnpm", "test"], ["pnpm", "lint"]] } },
  });
  assert.throws(() => buildRunnerFile([{ repoId: REPO_ID, path: "/x", testCommands: ["a; b"] }]), /repos\[0\]\.testCommands\[0\]/);
});

test("the launched CLI gets an allowlist: no provider key, no person token, no git token", () => {
  const child = runnerChildEnv({
    ...PARENT_ENV, INFEROPS_ENDPOINT: "http://x", INFEROPS_WORKSPACE_ID: "w", INFEROPS_API_KEY: "k",
    CODEX_HOME: "/c", CODEX_PATH: "/bin/codex", TERM: "xterm", SHELL: "/bin/sh", USER: "me", TMPDIR: "/tmp",
    NODE_OPTIONS: "--require evil", SSH_AUTH_SOCK: "/s",
  });
  assert.deepEqual(Object.keys(child).toSorted(), [
    "CODEX_HOME", "CODEX_PATH", "HOME", "INFEROPS_API_KEY", "INFEROPS_ENDPOINT", "INFEROPS_WORKSPACE_ID",
    "LANG", "LC_ALL", "PATH", "SHELL", "TERM", "TMPDIR", "USER",
  ]);
  for (const name of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "ANTHROPIC_API_KEY", "CODEX_API_KEY", "AZURE_OPENAI_API_KEY", "GEMINI_API_KEY", "SOME_VENDOR_API_KEY"]) {
    assert.ok(isProviderVariable(name), name);
  }
  for (const name of ["INFEROPS_API_KEY", "CODEX_HOME", "CODEX_PATH", "PATH"]) assert.ok(!isProviderVariable(name), name);
});

test("redaction replaces every credential value anywhere in a report", () => {
  const secrets = secretValues({ INFEROPS_API_KEY: "iops_sk_abcdef", OPENAI_API_KEY: "sk-xyz123", PATH: "/usr/bin" });
  assert.deepEqual(redact({ a: "key iops_sk_abcdef and sk-xyz123", b: ["/usr/bin"], c: 3 }, secrets),
    { a: "key [redacted] and [redacted]", b: ["/usr/bin"], c: 3 });
});

test("usage: runner and coding need a subcommand; --once and --consumer-root are scoped", async () => {
  for (const argv of [["runner"], ["runner", "go"], ["coding"], ["coding", "check"], ["runner", "status", "--once"], ["status", "--consumer-root", "/x"]]) {
    const result = await runLifecycle(argv, deps());
    assert.equal(result.exitCode, EXIT_USAGE, argv.join(" "));
  }
});

test("runner start is refused with CODING_WORKBENCH_ENABLED off, before anything is written or launched", async () => {
  const wrapper = makeCodingWrapper({ enabled: false });
  try {
    const d = deps();
    const result = await runLifecycle(["runner", "start", "--json", "--consumer-root", wrapper.root], d);
    assert.equal(result.exitCode, EXIT_FAILED);
    assert.equal(result.report.refused, true);
    assert.match(String((result.report.problems as string[])[0]), /CODING_WORKBENCH_ENABLED is off/);
    assert.equal(d.launches.length, 0);
    assert.ok(!existsSync(join(wrapper.root, ".inferos", "state", "runner", "runner.json")));
  } finally {
    rmSync(wrapper.parent, { recursive: true, force: true });
  }
});

test("runner start is refused without a wrapper, without INFEROPS_CLI, and when Codex is signed in with an API key", async () => {
  const noWrapper = await runLifecycle(["runner", "start", "--consumer-root", "/nonexistent-wrapper"], deps());
  assert.equal(noWrapper.exitCode, EXIT_FAILED);
  assert.match(JSON.stringify(noWrapper.report), /No inferos.config.json/);

  const noCli = makeCodingWrapper({ devVars: { INFEROPS_CLI: "" } });
  const apiKey = makeCodingWrapper({ codex: { auth: "api-key" } });
  try {
    const d = deps();
    const missing = await runLifecycle(["runner", "start", "--consumer-root", noCli.root], d);
    assert.equal(missing.exitCode, EXIT_FAILED);
    assert.match(JSON.stringify(missing.report), /INFEROPS_CLI is not set/);
    const signedInWithKey = await runLifecycle(["runner", "start", "--consumer-root", apiKey.root], d);
    assert.equal(signedInWithKey.exitCode, EXIT_FAILED);
    assert.equal((signedInWithKey.report.check as { authMode: string }).authMode, "api-key");
    assert.equal(d.launches.length, 0);
  } finally {
    rmSync(noCli.parent, { recursive: true, force: true });
    rmSync(apiKey.parent, { recursive: true, force: true });
  }
});

test("coding doctor: ready on a ChatGPT sign-in, names withheld provider keys, never prints the service key", async () => {
  const wrapper = makeCodingWrapper();
  try {
    const result = await runLifecycle(["coding", "doctor", "--json", "--consumer-root", wrapper.root], deps());
    const text = JSON.stringify(result.report) + result.headline;
    assert.equal(result.exitCode, EXIT_OK, result.headline);
    assert.equal(result.report.cliVersion, "0.0.0-stub");
    const checks = result.report.checks as { name: string; ok: boolean; detail: string }[];
    assert.ok(checks.every(check => check.ok));
    assert.match(checks.find(check => check.name === "child-env")!.detail, /withholds ANTHROPIC_API_KEY, AZURE_OPENAI_API_KEY, CODEX_API_KEY, OPENAI_API_KEY, OPENAI_BASE_URL/);
    assert.equal(result.report.apiKey, "set");
    for (const secret of [wrapper.apiKey, "sk-openai-parent-secret", "person-token-secret"]) assert.ok(!text.includes(secret), secret);
    // The runner.json it wrote holds paths and argv, nothing secret.
    const runnerFile = JSON.parse(readFileSync(join(wrapper.root, ".inferos", "state", "runner", "runner.json"), "utf8"));
    assert.deepEqual(runnerFile.repos[REPO_ID].testCommands, [["node", "check.mjs"]]);
  } finally {
    rmSync(wrapper.parent, { recursive: true, force: true });
  }
});

test("coding doctor fails on an API-key sign-in, a non-git path and the pause file", async () => {
  const wrapper = makeCodingWrapper({
    codex: { auth: "api-key" },
    repos: [{ repoId: REPO_ID, path: "/nonexistent/repo", testCommands: ["pnpm test"] }],
  });
  try {
    const workdir = join(wrapper.root, ".inferos", "state", "runner", "runs");
    mkdirSync(workdir, { recursive: true });
    writeFileSync(join(workdir, PAUSE_FILE), JSON.stringify({ reasonCode: "QUOTA_BLOCKED", runId: "r1", at: "t" }));
    const result = await runLifecycle(["coding", "doctor", "--consumer-root", wrapper.root], deps());
    assert.equal(result.exitCode, EXIT_FAILED);
    const failed = (result.report.checks as { name: string; ok: boolean }[]).filter(check => !check.ok).map(check => check.name);
    assert.deepEqual(failed, [`repo ${REPO_ID}`, "runner-check", "sign-in", "paused"]);
    assert.match(result.headline, /FAIL sign-in: Codex sign-in mode: api-key \(refused: API-key billing\)/);
  } finally {
    rmSync(wrapper.parent, { recursive: true, force: true });
  }
});

test("runner start launches the CLI with only the allowlisted environment; status and stop follow it", async () => {
  // An InferOps that never has work: the MOCK runner just polls it until stopped.
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ runs: [] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const wrapper = makeCodingWrapper({ devVars: { INFEROPS_ENDPOINT: `http://127.0.0.1:${port}` } });
  const d: LifecycleDeps = { ...defaultDeps, root: REPO, env: PARENT_ENV };
  try {
    const started = await runLifecycle(["runner", "start", "--json", "--consumer-root", wrapper.root], d);
    assert.equal(started.exitCode, EXIT_OK, JSON.stringify(started.report));
    assert.deepEqual(started.report.withheld, ["ANTHROPIC_API_KEY", "AZURE_OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL"]);
    const workdir = join(wrapper.root, ".inferos", "state", "runner", "runs");
    const envFile = join(workdir, ".stub-runner-env.json");
    for (let i = 0; i < 100 && !existsSync(envFile); i++) await new Promise(resolve => setTimeout(resolve, 50));
    const seen: string[] = JSON.parse(readFileSync(envFile, "utf8"));
    for (const name of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "ANTHROPIC_API_KEY", "CODEX_API_KEY", "AZURE_OPENAI_API_KEY", "GH_TOKEN", "INFEROPS_API_TOKEN"]) {
      assert.ok(!seen.includes(name), `${name} reached the runner`);
    }
    for (const name of ["INFEROPS_API_KEY", "INFEROPS_ENDPOINT", "INFEROPS_WORKSPACE_ID", "CODEX_HOME", "PATH"]) assert.ok(seen.includes(name), name);
    assert.ok(!JSON.stringify(started.report).includes(wrapper.apiKey));

    const again = await runLifecycle(["runner", "start", "--consumer-root", wrapper.root], d);
    assert.equal(again.exitCode, EXIT_FAILED);
    assert.match(again.headline, /already running/);

    const status = await runLifecycle(["runner", "status", "--json", "--consumer-root", wrapper.root], d);
    assert.equal(status.exitCode, EXIT_OK, status.headline);
    assert.equal((status.report.runner as { alive: boolean }).alive, true);
    assert.equal(status.report.paused, null);
    assert.ok(!JSON.stringify(status.report).includes(wrapper.apiKey));

    const stopped = await runLifecycle(["runner", "stop", "--json", "--consumer-root", wrapper.root], d);
    assert.equal(stopped.exitCode, EXIT_OK);
    assert.equal(stopped.report.stopped, true);
    const after = await runLifecycle(["runner", "status", "--consumer-root", wrapper.root], d);
    assert.equal(after.exitCode, EXIT_FAILED);
    assert.equal(after.headline, "runner: not started");
  } finally {
    await runLifecycle(["runner", "stop", "--consumer-root", wrapper.root], d);
    server.close();
    rmSync(wrapper.parent, { recursive: true, force: true });
  }
});

test("runner status reports the pause file and the run directories left behind", async () => {
  const wrapper = makeCodingWrapper();
  try {
    const workdir = join(wrapper.root, ".inferos", "state", "runner", "runs");
    const run = join(workdir, "7a000000-0000-4000-8000-000000000001");
    mkdirSync(join(run, ".inferops-artifacts"), { recursive: true });
    writeFileSync(join(run, "result.patch"), "diff --git a/x b/x\n");
    writeFileSync(join(run, ".inferops-run.json"), "{}");
    writeFileSync(join(run, ".inferops-artifacts", "test-1.json"), JSON.stringify({ exitCode: 0 }));
    writeFileSync(join(run, ".inferops-artifacts", "test-2.json"), JSON.stringify({ exitCode: 1 }));
    writeFileSync(join(workdir, PAUSE_FILE), JSON.stringify({ reasonCode: "AUTH_BLOCKED", runId: "7a000000-0000-4000-8000-000000000001", at: "t" }));
    const status = await runLifecycle(["runner", "status", "--json", "--consumer-root", wrapper.root], deps());
    assert.equal(status.exitCode, EXIT_FAILED);
    assert.match(status.headline, /^paused \(AUTH_BLOCKED/);
    const [recent] = status.report.recentRuns as { runId: string; patch: { bytes: number }; tests: { passed: number; failed: number }; sidecar: boolean }[];
    assert.equal(recent!.runId, "7a000000-0000-4000-8000-000000000001");
    assert.equal(recent!.patch.bytes, 19);
    assert.deepEqual([recent!.tests.passed, recent!.tests.failed], [1, 1]);
    assert.equal(recent!.sidecar, true);
  } finally {
    rmSync(wrapper.parent, { recursive: true, force: true });
  }
});

test("a wrapper's pnpm local runner/coding points the pinned operator at the wrapper", () => {
  assert.deepEqual(localLifecycleArgs("/w", ["runner", "start", "--json"]), ["runner", "start", "--json", "--consumer-root", "/w"]);
  assert.deepEqual(localLifecycleArgs("/w", ["coding", "doctor"]), ["coding", "doctor", "--consumer-root", "/w"]);
  assert.deepEqual(localLifecycleArgs("/w", ["runner", "status", "--consumer-root", "/x"]), ["runner", "status", "--consumer-root", "/x"]);
});
