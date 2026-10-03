#!/usr/bin/env node
// MOCK. A stand-in for the pinned `inferops` binary in tests, implementing only the slice of
// `inferops runner codex --result patch` (factory-level/inferops#2327) that the local lifecycle and
// the mocked end-to-end suite rely on. It is NOT the InferOps runner and proves nothing about it;
// the real runner's lease, recovery and evidence rules are tested in InferOps.
//
//   inferops --version --json
//   inferops runner codex --result patch --config runner.json --workdir DIR --json [--check] [--once]
//
// Like the real one it reads INFEROPS_ENDPOINT, INFEROPS_WORKSPACE_ID and INFEROPS_API_KEY, finds
// `codex` by CODEX_PATH or PATH, refuses to start unless `codex login status` says ChatGPT or while
// DIR/.inferops-runner.paused exists, claims only allowlisted repositories, and per run: `start`,
// a detached `git worktree add`, `codex exec`, a heartbeat naming the thread, `result.patch`, the
// test commands with artifacts under .inferops-artifacts/, then `finish`. A blocked login or quota
// finishes the run `failed` with AUTH_BLOCKED / QUOTA_BLOCKED and writes the pause file.
//
// It records the environment variable NAMES it was started with in DIR/.stub-runner-env.json so a
// test can prove what the lifecycle passed it. Values are never written.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

type RunnerFile = { repos: Record<string, { path: string; baseRef?: string; testCommands?: string[][] }> };
type Run = { id: string; issueId: string; repoId: string; action: string; status: string; baseRef: string | null; leaseGeneration: string };

const PAUSE_FILE = ".inferops-runner.paused";
const CHILD_ENV = ["PATH", "HOME", "CODEX_HOME", "LANG", "TERM", "TMPDIR", "SHELL", "USER"];
const childEnv = Object.fromEntries(Object.entries(process.env)
  .filter(([name, value]) => value !== undefined && (CHILD_ENV.includes(name) || name.startsWith("LC_")))) as Record<string, string>;

function emit(envelope: unknown, code: number): never {
  console.log(JSON.stringify(envelope));
  process.exit(code);
}

const argv = process.argv.slice(2);
if (argv[0] === "--version") emit({ ok: true, data: { version: "0.0.0-stub" } }, 0);
if (argv[0] !== "runner" || argv[1] !== "codex") emit({ ok: false, error: { code: "USAGE", message: "stub: runner codex only" } }, 2);

const { values } = parseArgs({
  args: argv.slice(2),
  options: {
    result: { type: "string" }, config: { type: "string" }, workdir: { type: "string" },
    json: { type: "boolean" }, check: { type: "boolean" }, once: { type: "boolean" },
  },
});
if (values.result !== "patch" || !values.config || !values.workdir) {
  emit({ ok: false, error: { code: "USAGE", message: "stub: needs --result patch --config --workdir" } }, 2);
}
const workdir = values.workdir;
const repos = (JSON.parse(readFileSync(values.config, "utf8")) as RunnerFile).repos;
const codex = process.env.CODEX_PATH ?? "codex";
const sh = (command: string, args: string[], cwd?: string) =>
  spawnSync(command, args, { cwd, env: childEnv, encoding: "utf8" });

function readiness() {
  const problems: string[] = [];
  const version = sh(codex, ["--version"]);
  const status = sh(codex, ["login", "status"]);
  const text = `${status.stdout}\n${status.stderr}`;
  const authMode = /Logged in using ChatGPT/.test(text) ? "chatgpt" : /API key/.test(text) ? "api-key"
    : /Logged in using/.test(text) ? "other" : version.error ? "unavailable" : "none";
  if (authMode !== "chatgpt") problems.push(`Codex sign-in is ${authMode}; patch mode runs only on a ChatGPT sign-in.`);
  let paused: string | null = null;
  if (existsSync(join(workdir, PAUSE_FILE))) {
    paused = JSON.parse(readFileSync(join(workdir, PAUSE_FILE), "utf8")).reasonCode;
    problems.push(`The runner is paused (${paused}). Remove ${join(workdir, PAUSE_FILE)} once fixed.`);
  }
  if (!Object.keys(repos).length) problems.push("runner.json allows no repositories.");
  return { ready: !problems.length, authMode, codexVersion: /\d+\.\d+\.\d+\S*/.exec(version.stdout)?.[0] ?? null,
    repos: Object.keys(repos).length, paused, problems };
}

const ready = readiness();
if (!ready.ready) emit({ ok: false, error: { code: "RUNNER_NOT_READY", message: ready.problems.join(" "), details: ready } }, 1);
if (values.check) emit({ ok: true, data: ready }, 0);

mkdirSync(workdir, { recursive: true });
writeFileSync(join(workdir, ".stub-runner-env.json"), JSON.stringify(Object.keys(process.env).toSorted()));

const endpoint = process.env.INFEROPS_ENDPOINT!.replace(/\/+$/, "");
const headers = {
  authorization: `Bearer ${process.env.INFEROPS_API_KEY}`,
  "x-workspace-id": process.env.INFEROPS_WORKSPACE_ID!,
  "content-type": "application/json",
};
async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${endpoint}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const parsed = await response.json() as T & { error?: { code: string } };
  if (!response.ok) throw new Error(`${parsed.error?.code ?? response.status} on ${method} ${path}`);
  return parsed;
}
const log = (line: string) => console.error(`[stub-runner] ${line}`);

const signals = { stopping: false };
process.on("SIGTERM", () => { signals.stopping = true; });

const EXCLUDE = [":(exclude).inferops-run.json", ":(exclude).inferops-artifacts", ":(exclude)result.patch"];

async function execute(run: Run, repo: RunnerFile["repos"][string]): Promise<string | null> {
  const started = (await api<{ run: Run }>("POST", `/project/runs/${run.id}/start`, {})).run;
  const lease = started.leaseGeneration;
  const base = sh("git", ["-C", repo.path, "rev-parse", `${run.baseRef ?? repo.baseRef ?? "HEAD"}^{commit}`]).stdout.trim();
  const dir = join(workdir, run.id);
  sh("git", ["-C", repo.path, "worktree", "add", "--detach", dir, base]);
  writeFileSync(join(dir, ".inferops-run.json"), JSON.stringify({ runId: run.id, baseSha: base, threadId: null }));
  const turn = sh(codex, ["exec", "--json", `Work on issue ${run.issueId}`], dir);
  if (turn.status !== 0) {
    const reasonCode = /usage limit|quota|429/i.test(turn.stderr) ? "QUOTA_BLOCKED"
      : /sign in|not logged in|refresh|401/i.test(turn.stderr) ? "AUTH_BLOCKED" : null;
    if (reasonCode) writeFileSync(join(workdir, PAUSE_FILE), JSON.stringify({ reasonCode, runId: run.id, at: new Date().toISOString() }));
    await api("POST", `/project/runs/${run.id}/finish`, {
      status: "failed", leaseGeneration: lease,
      error: `${reasonCode ?? "AGENT_FAILED"}: ${turn.stderr.trim()}`,
      result: { summary: "The agent turn failed.", ...(reasonCode ? { reasonCode } : {}) },
    });
    return reasonCode;
  }
  const threadId = /"thread_id":"([^"]+)"/.exec(turn.stdout)?.[1];
  writeFileSync(join(dir, ".inferops-run.json"), JSON.stringify({ runId: run.id, baseSha: base, threadId }));
  await api("POST", `/project/runs/${run.id}/heartbeat`, { leaseGeneration: lease, ...(threadId ? { externalRunId: threadId } : {}) });

  sh("git", ["add", "-N", "--", ".", ...EXCLUDE], dir);
  const patchPath = join(dir, "result.patch");
  sh("git", ["diff", "--binary", `--output=${patchPath}`, base, "--", ".", ...EXCLUDE], dir);
  const numstat = sh("git", ["diff", "--numstat", base, "--", ".", ...EXCLUDE], dir).stdout.trim().split("\n").filter(Boolean);
  const patch = {
    path: patchPath, sha256: createHash("sha256").update(readFileSync(patchPath)).digest("hex"), files: numstat.length,
    insertions: numstat.reduce((n, line) => n + (Number(line.split("\t")[0]) || 0), 0),
    deletions: numstat.reduce((n, line) => n + (Number(line.split("\t")[1]) || 0), 0),
  };

  const artifacts = join(dir, ".inferops-artifacts");
  mkdirSync(artifacts, { recursive: true });
  const commands = (repo.testCommands ?? []).map((command, i) => {
    const index = i + 1;
    const startedAt = Date.now();
    const result = sh(command[0]!, command.slice(1), dir);
    const exitCode = result.error ? null : result.status;
    const files = { stdout: join(artifacts, `test-${index}.stdout`), stderr: join(artifacts, `test-${index}.stderr`), record: join(artifacts, `test-${index}.json`) };
    writeFileSync(files.stdout, result.stdout ?? "");
    writeFileSync(files.stderr, result.stderr ?? "");
    const record = { runId: run.id, index, argv: command, cwd: dir, exitCode, timedOut: false, durationMs: Date.now() - startedAt, truncated: false };
    writeFileSync(files.record, JSON.stringify(record, null, 2));
    return { ...record, artifacts: files };
  });
  const passed = commands.filter(command => command.exitCode === 0).length;
  const failed = commands.length - passed;
  const testSummary = commands.length ? `${passed} of ${commands.length} test commands passed.` : "No test commands are configured.";
  await api("POST", `/project/runs/${run.id}/finish`, {
    status: failed ? "failed" : "succeeded", leaseGeneration: lease,
    ...(failed ? { error: `TESTS_FAILED: ${testSummary}` } : {}),
    result: {
      summary: "Stub turn wrote STUB_CHANGE.md.", patch,
      tests: { directory: artifacts, passed, failed, commands }, testSummary,
      ...(failed ? { reasonCode: "TESTS_FAILED" } : {}),
    },
  });
  log(`${run.id}: ${failed ? "failed" : "succeeded"}, patch ${patchPath}`);
  return null;
}

const skipped = new Set<string>();
let executed = 0;
let paused: string | null = null;
while (!signals.stopping && !paused) {
  const { runs } = await api<{ runs: Run[] }>("GET", "/project/runs?status=queued");
  for (const run of runs) {
    const repo = repos[run.repoId];
    if (!repo || run.action !== "code") {
      if (!skipped.has(run.id)) log(`${run.id}: repository not in runner.json; left queued`);
      skipped.add(run.id);
      continue;
    }
    paused = await execute(run, repo);
    executed++;
    break;
  }
  if (values.once && executed) break;
  await new Promise(resolve => setTimeout(resolve, 200));
}
emit({ ok: true, data: { executed, ...(paused ? { paused } : {}) } }, 0);
