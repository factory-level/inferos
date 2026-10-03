// `pnpm local runner start|status|stop` and `pnpm local coding doctor`: the local lifecycle of the
// InferOps coding runner (`inferops runner codex --result patch`) for one wrapper. See
// docs/wiki/local-coding-runner.md for the runbook and runner.ts for what is read and written.
//
// The runner is a detached process recorded like the dev server. It is launched only while the
// wrapper's CODING_WORKBENCH_ENABLED is on, only from the binary INFEROPS_CLI names, with an
// allowlisted environment, and only after its own `--check` reports ready.

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  describeContext, logTail, parseReadiness, providerVariables, readPause, readRunnerRecord, recentRuns,
  redact, resolveCodingContext, runnerArgv, runnerChildEnv, secretValues, splitTestCommand, writeRunnerFile,
  type CodingContext, type Readiness, type RunnerRecord,
} from "./runner.ts";

/** A finished child process, as the runner commands read it. */
export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** What the runner commands touch outside their own logic; tests replace every one. */
export interface CodingDeps {
  /** This InferOS checkout. */
  root: string;
  env: NodeJS.ProcessEnv;
  /** Run the InferOps CLI to completion (`--check`, `--version`) with exactly `env`. */
  runCli: (argv: string[], env: Record<string, string>) => ProcessResult;
  /** Start the runner detached, its output appended to `logPath`; returns its pid. */
  launch: (argv: string[], env: Record<string, string>, logPath: string, cwd: string) => number;
  /** Run git (read-only checks of the allowlisted repositories). */
  git: (args: string[]) => ProcessResult;
  signal: (pid: number, signal: NodeJS.Signals) => void;
  processAlive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/** One command's outcome, shaped like the rest of `pnpm local`. */
export interface CodingResult {
  exitCode: number;
  report: Record<string, unknown>;
  headline: string;
}

/** Options the runner commands take. */
export interface CodingOptions {
  /** The wrapper whose configuration applies; the checkout itself when omitted. */
  consumerRoot?: string;
  /** `runner start --once`: execute at most one run, then exit. */
  once?: boolean;
}

const STOP_TIMEOUT_MS = 30_000;
/** How long `start` watches the new process before calling it started. */
const START_GRACE_MS = 1_000;

/** Run the CLI's own readiness check: Codex version, sign-in mode, repos and pause state. */
function runnerCheck(context: CodingContext, deps: CodingDeps): Readiness {
  return parseReadiness(deps.runCli(runnerArgv(context, { check: true }), runnerChildEnv(context.env)));
}

function finish(context: CodingContext | null, deps: CodingDeps, result: CodingResult): CodingResult {
  // Belt and braces: nothing above should put a credential in a report, but CLI output is relayed.
  const secrets = secretValues(context?.env ?? deps.env);
  return { ...result, report: redact(result.report, secrets), headline: redact(result.headline, secrets) };
}

/** Problems that refuse `runner start` before anything is written or launched. */
function startRefusals(context: CodingContext): string[] {
  if (!context.configured) return context.problems;
  if (!context.enabled) {
    return ["CODING_WORKBENCH_ENABLED is off for this wrapper: switch the capability on in inferos.config.json (it requires INFEROPS_ENABLED)"];
  }
  const problems = [...context.problems];
  if (!context.repos.length) problems.push("codingWorkbench.repos is empty: the runner would have nothing it may claim");
  return problems;
}

function liveRecord(context: CodingContext, deps: CodingDeps): RunnerRecord | null {
  const record = readRunnerRecord(context.recordPath);
  return record && deps.processAlive(record.pid) ? record : null;
}

async function start(context: CodingContext, options: CodingOptions, deps: CodingDeps): Promise<CodingResult> {
  const command = "runner start";
  const refusals = startRefusals(context);
  if (refusals.length) {
    return { exitCode: 1, report: { ok: false, command, refused: true, problems: refusals, ...describeContext(context) },
      headline: `runner start refused: ${refusals[0]}` };
  }
  const running = liveRecord(context, deps);
  if (running) {
    return { exitCode: 1, report: { ok: false, command, pid: running.pid, error: `The runner already runs (pid ${running.pid}); stop it first` },
      headline: `runner start: already running (pid ${running.pid})` };
  }
  try {
    writeRunnerFile(context);
  } catch (error) {
    return { exitCode: 1, report: { ok: false, command, refused: true, problems: [(error as Error).message] },
      headline: `runner start refused: ${(error as Error).message}` };
  }
  const check = runnerCheck(context, deps);
  if (!check.ready) {
    return { exitCode: 1, report: { ok: false, command, refused: true, check, problems: check.problems, ...describeContext(context) },
      headline: `runner start refused: not ready (${check.problems.join(" ") || "the check failed"})` };
  }
  const env = runnerChildEnv(context.env);
  const pid = deps.launch(runnerArgv(context, { once: options.once }), env, context.logPath, context.workdir);
  const record: RunnerRecord = { pid, startedAt: new Date(deps.now()).toISOString(), cli: context.cli!, workdir: context.workdir, log: context.logPath };
  writeFileSync(context.recordPath, JSON.stringify(record, null, 2) + "\n");
  await deps.sleep(START_GRACE_MS);
  if (!deps.processAlive(pid) && !options.once) {
    rmSync(context.recordPath, { force: true });
    // It may have claimed a run whose turn hit a blocked login or quota, and paused.
    const pause = readPause(context.pausePath);
    return { exitCode: 1, report: { ok: false, command, pid, paused: pause, error: "The runner exited right after starting", log: logTail(context.logPath) },
      headline: pause ? `runner start: pid ${pid} paused at once (${pause.reasonCode}, run ${pause.runId})`
        : `runner start: pid ${pid} exited at once; see ${context.logPath}` };
  }
  return {
    exitCode: 0,
    report: { ok: true, command, pid, once: options.once === true, check, ...describeContext(context),
      inherited: Object.keys(env).toSorted(), withheld: providerVariables(context.env) },
    headline: `runner started: pid ${pid}, ${context.repos.length} repositor${context.repos.length === 1 ? "y" : "ies"}, Codex ${check.codexVersion ?? "?"} (${check.authMode})`,
  };
}

function status(context: CodingContext, deps: CodingDeps): CodingResult {
  const record = readRunnerRecord(context.recordPath);
  const alive = record ? deps.processAlive(record.pid) : false;
  // The check needs a runnable CLI and complete settings; without them, say why instead. It reads
  // the runner.json the runner was started with, writing one only when there is none yet.
  const ready = context.configured && !context.problems.length && context.repos.length > 0;
  if (ready && !existsSync(context.runnerFile)) writeRunnerFile(context);
  const check = ready ? runnerCheck(context, deps) : null;
  const pause = readPause(context.pausePath);
  const runs = recentRuns(context.workdir);
  const ok = alive && !pause && (check?.ready ?? false);
  const report = {
    ok, command: "runner status",
    runner: record ? { pid: record.pid, alive, startedAt: record.startedAt } : null,
    paused: pause ? { ...pause, file: context.pausePath } : null,
    check, problems: check ? check.problems : context.problems,
    recentRuns: runs, logTail: logTail(context.logPath, 10), ...describeContext(context),
  };
  const headline = pause ? `paused (${pause.reasonCode}, run ${pause.runId}): fix the sign-in or wait for the quota, confirm with doctor, then remove ${context.pausePath}`
    : !record ? "runner: not started"
    : !alive ? `runner: pid ${record.pid} is not running (see ${context.logPath})`
    : check && !check.ready ? `runner: pid ${record.pid} running, not ready: ${check.problems.join(" ")}`
    : `runner: pid ${record.pid} running, ${runs.length} recent run(s)`;
  return { exitCode: ok ? 0 : 1, report, headline };
}

async function stop(context: CodingContext, deps: CodingDeps): Promise<CodingResult> {
  const record = readRunnerRecord(context.recordPath);
  if (!record || !deps.processAlive(record.pid)) {
    rmSync(context.recordPath, { force: true });
    return { exitCode: 0, report: { ok: true, command: "runner stop", stopped: false }, headline: "runner stop: nothing to stop" };
  }
  // The runner relays the signal to its Codex child and keeps the checkout and partial patch.
  deps.signal(record.pid, "SIGTERM");
  const deadline = deps.now() + STOP_TIMEOUT_MS;
  while (deps.processAlive(record.pid)) {
    if (deps.now() >= deadline) {
      return { exitCode: 1, report: { ok: false, command: "runner stop", stopped: false, pid: record.pid, error: `pid ${record.pid} did not exit within ${STOP_TIMEOUT_MS / 1000}s` },
        headline: `runner stop: pid ${record.pid} is still running` };
    }
    await deps.sleep(200);
  }
  rmSync(context.recordPath, { force: true });
  return { exitCode: 0, report: { ok: true, command: "runner stop", stopped: true, pid: record.pid }, headline: `runner stopped (pid ${record.pid})` };
}

/** One doctor finding. */
interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

function doctor(context: CodingContext, deps: CodingDeps): CodingResult {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  add("config", context.configured, context.configured ? `${context.consumerRoot}/inferos.config.json` : context.problems[0] ?? "no configuration");
  add("flag", context.enabled, context.enabled ? `CODING_WORKBENCH_ENABLED is on (${context.enabledSource})`
    : `CODING_WORKBENCH_ENABLED is off (${context.enabledSource}); the runner will not start`);

  // The allowlist: every path a git checkout, every base ref resolvable, every command runnable without a shell.
  add("repos", context.repos.length > 0, `${context.repos.length} allowlisted repositor${context.repos.length === 1 ? "y" : "ies"}`);
  for (const repo of context.repos) {
    const top = deps.git(["-C", repo.path, "rev-parse", "--show-toplevel"]);
    const problems: string[] = [];
    if (top.exitCode !== 0) problems.push("not a git repository");
    else if (repo.baseRef && deps.git(["-C", repo.path, "rev-parse", "--verify", "--quiet", `${repo.baseRef}^{commit}`]).exitCode !== 0) {
      problems.push(`base ref ${repo.baseRef} does not resolve`);
    }
    for (const command of repo.testCommands) {
      try {
        splitTestCommand(command);
      } catch (error) {
        problems.push(`test command: ${(error as Error).message}`);
      }
    }
    add(`repo ${repo.repoId}`, !problems.length, problems.length ? `${repo.path}: ${problems.join("; ")}` : `${repo.path} (${repo.testCommands.length} test command(s))`);
  }

  // The runner's settings, by presence only.
  const settingProblems = context.problems.filter(problem => /INFEROPS_(?:CLI|ENDPOINT|WORKSPACE_ID|API_KEY)/.test(problem));
  add("settings", !settingProblems.length, settingProblems.length ? settingProblems.join("; ")
    : `INFEROPS_ENDPOINT ${describeContext(context).endpoint}, workspace ${context.workspaceId}, INFEROPS_API_KEY set`);

  // No provider key may reach the runner, whatever the parent holds.
  const child = runnerChildEnv(context.env);
  const leaked = Object.keys(child).filter(name => providerVariables({ [name]: child[name] }).length);
  const withheld = providerVariables(context.env);
  add("child-env", !leaked.length, leaked.length ? `would pass ${leaked.join(", ")}`
    : `inherits ${Object.keys(child).toSorted().join(", ")}${withheld.length ? `; withholds ${withheld.join(", ")}` : ""}`);

  // The CLI's own version and readiness (Codex version, sign-in mode, pause state).
  let cliVersion: string | null = null;
  let readiness: Readiness | null = null;
  if (context.cli && !context.problems.some(problem => problem.startsWith("INFEROPS_CLI"))) {
    const version = deps.runCli([context.cli, "--version", "--json"], child);
    try {
      cliVersion = String(JSON.parse(version.stdout).data.version);
    } catch {
      cliVersion = null;
    }
    add("cli", cliVersion !== null, cliVersion ? `inferops ${cliVersion} at ${context.cli}` : `${context.cli} --version printed no version`);
    if (context.configured && context.repos.length && !settingProblems.length) {
      try {
        writeRunnerFile(context);
        readiness = runnerCheck(context, deps);
        add("runner-check", readiness.ready, readiness.ready ? `ready: Codex ${readiness.codexVersion}, sign-in ${readiness.authMode}`
          : readiness.problems.join(" ") || "not ready");
        add("sign-in", readiness.authMode === "chatgpt", `Codex sign-in mode: ${readiness.authMode ?? "unknown"}${readiness.authMode === "api-key" ? " (refused: API-key billing)" : ""}`);
      } catch (error) {
        add("runner-check", false, (error as Error).message);
      }
    }
  } else {
    add("cli", false, context.problems.find(problem => problem.startsWith("INFEROPS_CLI")) ?? "INFEROPS_CLI is not usable");
  }
  const pause = readPause(context.pausePath);
  add("paused", !pause, pause ? `paused (${pause.reasonCode}, run ${pause.runId}); remove ${context.pausePath} once fixed` : "not paused");

  const failed = checks.filter(check => !check.ok);
  const ok = !failed.length;
  return {
    exitCode: ok ? 0 : 1,
    report: { ok, command: "coding doctor", cliVersion, readiness, checks, ...describeContext(context) },
    headline: [ok ? "coding doctor: ready" : `coding doctor: not ready (${failed.map(check => check.name).join(", ")})`,
      ...checks.map(check => `  ${check.ok ? "ok  " : "FAIL"} ${check.name}: ${check.detail}`)].join("\n"),
  };
}

/** Run `runner start|status|stop` or `coding doctor`. */
export async function runCoding(command: "runner" | "coding", sub: string, options: CodingOptions, deps: CodingDeps): Promise<CodingResult> {
  const context = resolveCodingContext(deps.root, resolve(options.consumerRoot ?? deps.root), deps.env);
  const result = command === "coding" ? doctor(context, deps)
    : sub === "start" ? await start(context, options, deps)
    : sub === "status" ? status(context, deps)
    : await stop(context, deps);
  return finish(context, deps, result);
}
