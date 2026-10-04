#!/usr/bin/env node

// Lifecycle of this checkout's local stack, for people and agents alike:
//
//   pnpm local status [--json]                   Is this checkout's stack up, which Workers answer, mock or live InferOps
//   pnpm local start [-- <run-local flags>]      Start the public origin (scripts/run-local.ts) after a port check
//   pnpm local stop [--json]                     Signal the recorded dev server and wait for it to exit
//   pnpm local seed [--json] [--screen ID] [--no-approval]
//                                                Local user, mock model, InferOps account, demo screen and board connection
//   pnpm local verify [--json] [--board URL]     Readiness over the authenticated RPC: what an agent would see
//   pnpm local reset [--json] --yes              Delete this checkout's .wrangler/state (and nothing else)
//   pnpm local logs [--json] [--lines N]         Where Wrangler's log files are, and the newest one's tail
//   pnpm local runner start|status|stop [--json] [--consumer-root DIR] [--once]
//                                                The InferOps coding runner for a wrapper (scripts/local/coding.ts)
//   pnpm local coding doctor [--json] [--consumer-root DIR]
//                                                Whether that runner may start: flag, allowlist, CLI, sign-in, environment
//
// Every command honours `--port N` / `VITE_BACKEND_HOST`, the dev server's own port rules, and
// exits 0 when its check passed, 1 when it failed, 2 on a usage error. With `--json` the only
// stdout is one JSON object; without it a headline precedes the same object, pretty-printed.
//
// `start` and `stop` are thin: the stack itself is `scripts/run-local.ts` and
// `scripts/run-dev-server.ts`, which records its pid so `stop` and `status` can find it. That
// record is also how a listener is known to be this checkout's: `status`, `seed` and `verify` treat
// a port that answers without a live record for it as `port-in-use-by-other`, never as the stack.
// `seed` and `verify` drive the Workshop through the operator scripts under
// `packages/workshop-backend/scripts/` (dev-setup.ts and dev-verify.ts), which hold the RPC code.

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readCanvasConfig } from "../consumer/canvas.ts";
import { assertLocalPortAvailable } from "../consumer/runtime.ts";
import { relayTermination } from "../relay-termination.ts";
import { runCoding, type CodingDeps, type ProcessResult } from "./coding.ts";
import {
  configuredWorkers, inferOpsConfiguration, isPortListening, latestWranglerLog, localEnv,
  probeWorkers, processAlive, readDevServerRecord, resetLocalState, resolveLocalStack, stackOwnership,
  wranglerLogDir, type DevServerRecord, type LocalStack, type StackOwnership,
} from "./stack.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OPERATORS = join(ROOT, "packages", "workshop-backend", "scripts");

export const COMMANDS = ["status", "start", "stop", "seed", "verify", "reset", "logs", "runner", "coding"] as const;
export type Command = (typeof COMMANDS)[number];

/** Exit codes every command shares. */
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

export const USAGE = `Usage: pnpm local <command> [--json] [--port N]
  status                  Report the stack: port, Workers, InferOps mode, state directory
  start [-- flags]        Start the public origin via scripts/run-local.ts (checks the port first)
  stop                    Stop the recorded dev server and wait for it to exit
  seed [--screen ID] [--no-approval] [--user U] [--password P]
                          Prepare a running stack: account, mock model, InferOps account, demo screen, board connection
  verify [--board URL] [--user U] [--password P]
                          Sign in, read the demo board through the gatekeeper, reach the approval queue
  reset --yes             Delete this checkout's .wrangler/state; refuses while the stack runs
  logs [--lines N]        Locate Wrangler's log directory and show the newest file's tail
  runner start|status|stop [--consumer-root DIR] [--once]
                          Run the InferOps coding runner (patch mode) for a wrapper's codingWorkbench.repos
  coding doctor [--consumer-root DIR]
                          Check the runner can start: flag, allowlist, CLI version, Codex sign-in, child env`;

/** The subcommands of the two-word commands. */
const SUBCOMMANDS: Partial<Record<Command, readonly string[]>> = {
  runner: ["start", "status", "stop"],
  coding: ["doctor"],
};

/** What one operator script run produced: its JSON report, or why there is none. */
export interface OperatorResult {
  exitCode: number;
  report: Record<string, unknown> | null;
  stderr: string;
}

/** Everything the commands touch outside their own logic, injectable so tests need no stack. */
export interface LifecycleDeps extends CodingDeps {
  root: string;
  env: NodeJS.ProcessEnv;
  isPortListening: (port: number) => Promise<boolean>;
  /** This checkout's live dev-server record (see `readDevServerRecord`), or null. */
  devServerRecord: (recordPath: string) => DevServerRecord | null;
  fetchImpl: typeof fetch;
  /** Run an operator script from packages/workshop-backend/scripts and parse its JSON. */
  runOperator: (script: string, args: string[], env: NodeJS.ProcessEnv) => OperatorResult;
  /** Start the stack in the foreground; resolves only in tests, which stub it. */
  startStack: (stack: LocalStack, passthrough: string[]) => Promise<void>;
  signal: (pid: number, signal: NodeJS.Signals) => void;
  processAlive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
  wranglerLogDir: () => string;
  now: () => number;
}

/** A command's outcome: the exit code, the report to print, and a one-line headline. */
export interface LifecycleResult {
  exitCode: number;
  report: Record<string, unknown>;
  headline: string;
}

function runOperatorScript(script: string, args: string[], env: NodeJS.ProcessEnv): OperatorResult {
  const result = spawnSync(process.execPath, [join(OPERATORS, script), ...args],
    { cwd: ROOT, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  let report: Record<string, unknown> | null = null;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    // The script died before printing a report; its stderr says why.
  }
  return { exitCode: result.status ?? 1, report, stderr: result.stderr.trim() };
}

function startStackForeground(stack: LocalStack, passthrough: string[]): Promise<void> {
  const child = spawn(process.execPath,
    [join(ROOT, "scripts", "run-local.ts"), "--port", String(stack.port), ...passthrough],
    { cwd: ROOT, stdio: "inherit" });
  relayTermination(child);
  // The relay exits this process the way the child did; nothing resolves before that.
  return new Promise(() => {});
}

function runProcess(argv: string[], env: Record<string, string> | NodeJS.ProcessEnv): ProcessResult {
  const result = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? (result.error ? String(result.error.message) : "") };
}

/** Start the runner in its own process group, detached, appending its output to `logPath`. */
function launchDetached(argv: string[], env: Record<string, string>, logPath: string, cwd: string): number {
  mkdirSync(cwd, { recursive: true });
  const log = openSync(logPath, "a");
  try {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env, detached: true, stdio: ["ignore", log, log] });
    child.unref();
    if (child.pid === undefined) throw new Error(`Could not start ${argv[0]}`);
    return child.pid;
  } finally {
    closeSync(log);
  }
}

export const defaultDeps: LifecycleDeps = {
  root: ROOT,
  env: process.env,
  isPortListening: port => isPortListening(port),
  devServerRecord: readDevServerRecord,
  fetchImpl: fetch,
  runOperator: runOperatorScript,
  startStack: startStackForeground,
  signal: (pid, signal) => process.kill(pid, signal),
  processAlive,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  wranglerLogDir: () => wranglerLogDir(),
  now: Date.now,
  runCli: runProcess,
  launch: launchDetached,
  git: args => runProcess(["git", ...args], process.env),
};

type Parsed = {
  command: Command;
  sub?: string;
  consumerRoot?: string;
  once: boolean;
  json: boolean;
  port?: string;
  screen?: string;
  approval: boolean;
  user?: string;
  password?: string;
  board?: string;
  yes: boolean;
  lines: number;
  passthrough: string[];
};

class UsageError extends Error {}

function parse(argv: readonly string[]): Parsed {
  const [command, ...afterCommand] = argv;
  if (!command || !(COMMANDS as readonly string[]).includes(command)) {
    throw new UsageError(command ? `Unknown command "${command}".\n${USAGE}` : USAGE);
  }
  const subcommands = SUBCOMMANDS[command as Command];
  const sub = subcommands ? afterCommand[0] : undefined;
  if (subcommands && (!sub || !subcommands.includes(sub))) {
    throw new UsageError(`${command} needs one of: ${subcommands.join(", ")}.\n${USAGE}`);
  }
  const rest = subcommands ? afterCommand.slice(1) : afterCommand;
  // Flags for the stack itself follow `--` and are forwarded to run-local untouched.
  const separator = rest.indexOf("--");
  const own = separator === -1 ? rest : rest.slice(0, separator);
  const passthrough = separator === -1 ? [] : rest.slice(separator + 1);
  let values;
  try {
    ({ values } = parseArgs({
      args: own,
      options: {
        json: { type: "boolean", default: false },
        port: { type: "string" },
        screen: { type: "string" },
        approval: { type: "boolean", default: true },
        user: { type: "string" },
        password: { type: "string" },
        board: { type: "string" },
        yes: { type: "boolean", default: false },
        lines: { type: "string", default: "50" },
        "consumer-root": { type: "string" },
        once: { type: "boolean", default: false },
      },
      allowNegative: true,
    }));
  } catch (error) {
    throw new UsageError(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
  }
  if (!/^\d+$/.test(values.lines)) throw new UsageError("--lines must be a whole number");
  if (values["consumer-root"] !== undefined && !subcommands) throw new UsageError("--consumer-root applies to runner and coding only");
  if (values.once && sub !== "start") throw new UsageError("--once applies to runner start only");
  return { command: command as Command, sub, consumerRoot: values["consumer-root"], once: values.once, json: values.json, port: values.port, screen: values.screen,
    approval: values.approval, user: values.user, password: values.password, board: values.board,
    yes: values.yes, lines: Number(values.lines), passthrough };
}

function credentialArgs(parsed: Parsed, stack: LocalStack): string[] {
  const args = ["--url", stack.url];
  if (parsed.user !== undefined) args.push("--user", parsed.user);
  if (parsed.password !== undefined) args.push("--password", parsed.password);
  return args;
}

/** The screen template `seed` ensures: an explicit id, else the first in inferos.canvas.json. */
export function seedScreenTemplate(root: string, explicit?: string): string | null {
  if (explicit) return explicit;
  try {
    return readCanvasConfig(root)?.config.screens[0]?.id ?? null;
  } catch {
    return null;
  }
}

/** Probe the port and classify its listener against this checkout's record. */
async function inspectStack(stack: LocalStack, deps: LifecycleDeps): Promise<{ listening: boolean; devServer: DevServerRecord | null; ownership: StackOwnership }> {
  const listening = await deps.isPortListening(stack.port);
  const devServer = deps.devServerRecord(stack.recordPath);
  return { listening, devServer, ownership: stackOwnership(listening, devServer, stack.port) };
}

/** Why a listener that is not this checkout's is refused; shared by status, seed and verify. */
const foreignListener = (stack: LocalStack) =>
  `Port ${stack.port} is in use by a process this checkout did not start (no running dev server is recorded for it on that port); ` +
  `stop that process or move this stack to another port (in a wrapper: pnpm inferos recover ports)`;

/**
 * Fail early when the command needs this checkout's Workshop and it is not what answers: nothing
 * listens, or the listener is someone else's (seeding or verifying it would act on a stranger).
 */
async function requireOwnStack(stack: LocalStack, deps: LifecycleDeps, command: Command): Promise<LifecycleResult | null> {
  const { ownership } = await inspectStack(stack, deps);
  if (ownership === "running") return null;
  if (ownership === "port-in-use-by-other") {
    return {
      exitCode: EXIT_FAILED,
      report: { ok: false, command, url: stack.url, stack: ownership, error: foreignListener(stack) },
      headline: `${command}: ${stack.backendHost} is in use by another process, not this checkout's stack`,
    };
  }
  return {
    exitCode: EXIT_FAILED,
    report: { ok: false, command, url: stack.url, stack: ownership, error: `Nothing listens on ${stack.backendHost}; start the stack first (pnpm local start)` },
    headline: `${command}: nothing listens on ${stack.backendHost}`,
  };
}

async function status(stack: LocalStack, deps: LifecycleDeps): Promise<LifecycleResult> {
  const { listening, devServer, ownership } = await inspectStack(stack, deps);
  const workers = configuredWorkers(deps.root);
  // A foreign listener is not probed: its answers would describe some other server as this stack.
  const probes = ownership === "running"
    ? await probeWorkers(stack.url, workers, deps.fetchImpl)
    : workers.map(worker => ({ ...worker, state: "down" as const }));
  const inferops = inferOpsConfiguration(localEnv(deps.root, deps.env));
  const down = probes.filter(probe => probe.state !== "up").map(probe => probe.name);
  const ok = ownership === "running" && down.length === 0 && inferops.missing.length === 0;
  const report = {
    ok, command: "status", url: stack.url, port: stack.port, listening, stack: ownership,
    ...(ownership === "port-in-use-by-other" ? { error: foreignListener(stack) } : {}),
    devServer: devServer ? { pid: devServer.pid, port: devServer.port, mode: devServer.mode, startedAt: devServer.startedAt } : null,
    workers: probes, inferops,
    state: { directory: stack.stateDir, present: existsSync(stack.stateDir) },
    logs: deps.wranglerLogDir(),
  };
  const headline = !listening ? `down: nothing listens on ${stack.backendHost}`
    : ownership === "port-in-use-by-other" ? `port-in-use-by-other: ${stack.backendHost} answers, but not with this checkout's dev server`
    : down.length ? `degraded: ${down.join(", ")} not answering on ${stack.url}`
    : inferops.missing.length ? `misconfigured: INFEROPS_BASE_URL is set but ${inferops.missing.join(", ")} is not`
    : `up: ${probes.length} workers answering on ${stack.url} (InferOps ${inferops.mode})`;
  return { exitCode: ok ? EXIT_OK : EXIT_FAILED, report, headline };
}

async function start(stack: LocalStack, parsed: Parsed, deps: LifecycleDeps): Promise<LifecycleResult> {
  try {
    await assertLocalPortAvailable(stack.port);
  } catch (error) {
    const running = readDevServerRecord(stack.recordPath);
    const detail = running ? `this checkout's dev server (pid ${running.pid}) already runs there`
      : (error as Error).message;
    return {
      exitCode: EXIT_FAILED,
      report: { ok: false, command: "start", url: stack.url, error: `Port ${stack.port} is busy: ${detail}` },
      headline: `start: port ${stack.port} is busy`,
    };
  }
  await deps.startStack(stack, parsed.passthrough);
  return { exitCode: EXIT_OK, report: { ok: true, command: "start", url: stack.url }, headline: `started ${stack.url}` };
}

const STOP_TIMEOUT_MS = 30_000;

async function stop(stack: LocalStack, deps: LifecycleDeps): Promise<LifecycleResult> {
  const record = readDevServerRecord(stack.recordPath);
  if (!record) {
    const listening = await deps.isPortListening(stack.port);
    return {
      exitCode: listening ? EXIT_FAILED : EXIT_OK,
      report: { ok: !listening, command: "stop", stopped: false, url: stack.url, listening,
        error: listening ? `Something listens on ${stack.backendHost} but this checkout recorded no dev server; stop it from its own terminal` : undefined },
      headline: listening ? `stop: ${stack.backendHost} is busy but not recorded as ours` : "stop: nothing to stop",
    };
  }
  deps.signal(record.pid, "SIGTERM");
  const deadline = deps.now() + STOP_TIMEOUT_MS;
  while (deps.processAlive(record.pid)) {
    if (deps.now() >= deadline) {
      return {
        exitCode: EXIT_FAILED,
        report: { ok: false, command: "stop", stopped: false, pid: record.pid, error: `pid ${record.pid} did not exit within ${STOP_TIMEOUT_MS / 1000}s` },
        headline: `stop: pid ${record.pid} is still running`,
      };
    }
    await deps.sleep(200);
  }
  return { exitCode: EXIT_OK, report: { ok: true, command: "stop", stopped: true, pid: record.pid }, headline: `stopped pid ${record.pid}` };
}

async function seed(stack: LocalStack, parsed: Parsed, deps: LifecycleDeps): Promise<LifecycleResult> {
  const notListening = await requireOwnStack(stack, deps, "seed");
  if (notListening) return notListening;
  const screen = seedScreenTemplate(deps.root, parsed.screen);
  const setupArgs = [...credentialArgs(parsed, stack), "--mock-model", "--inferops"];
  if (screen) setupArgs.push("--screen", screen);
  const setup = deps.runOperator("dev-setup.ts", setupArgs, deps.env);
  if (setup.exitCode !== 0 || !setup.report?.ok) {
    return {
      exitCode: EXIT_FAILED,
      report: { ok: false, command: "seed", url: stack.url, step: "setup", error: setup.stderr || "dev-setup.ts failed" },
      headline: `seed failed: ${setup.stderr || "dev-setup.ts failed"}`,
    };
  }
  // The session token is for `pnpm dev:setup` users; a lifecycle report should be safe to share.
  const { browserLogin: _token, ...prepared } = setup.report;
  const verifyArgs = [...credentialArgs(parsed, stack), "--ensure-board"];
  if (parsed.approval) verifyArgs.push("--approval-scenario");
  const verified = deps.runOperator("dev-verify.ts", verifyArgs, deps.env);
  const ok = verified.exitCode === 0 && verified.report?.ok === true;
  return {
    exitCode: ok ? EXIT_OK : EXIT_FAILED,
    report: {
      ok, command: "seed", url: stack.url,
      screen: screen ?? "skipped: no screen template in inferos.canvas.json (pnpm canvas add-screen)",
      setup: prepared,
      verify: verified.report ?? { ok: false, error: verified.stderr || "dev-verify.ts failed" },
    },
    headline: ok ? `seeded ${stack.url}: ${summarizeVerify(verified.report)}`
      : `seed failed at verify: ${verified.report?.error ?? verified.stderr}`,
  };
}

function summarizeVerify(report: Record<string, unknown> | null): string {
  const view = report?.agentView as { board?: { project?: string; issues?: number; states?: number }; approvalQueue?: { pending?: number } } | undefined;
  if (!view?.board) return "no agent view";
  return `board ${view.board.project} (${view.board.issues} issues in ${view.board.states} states), ` +
    `${view.approvalQueue?.pending ?? 0} pending approval(s)`;
}

async function verify(stack: LocalStack, parsed: Parsed, deps: LifecycleDeps): Promise<LifecycleResult> {
  const notListening = await requireOwnStack(stack, deps, "verify");
  if (notListening) return notListening;
  const args = credentialArgs(parsed, stack);
  if (parsed.board) args.push("--board", parsed.board);
  const result = deps.runOperator("dev-verify.ts", args, deps.env);
  const report = result.report ?? { ok: false, step: "connect", error: result.stderr || "dev-verify.ts failed" };
  const ok = result.exitCode === 0 && report.ok === true;
  return {
    exitCode: ok ? EXIT_OK : EXIT_FAILED,
    report: { ...report, command: "verify" },
    headline: ok ? `ready: ${summarizeVerify(report)}` : `not ready (${report.step}): ${report.error}`,
  };
}

function reset(stack: LocalStack, parsed: Parsed): LifecycleResult {
  try {
    const { removed } = resetLocalState(stack, { confirm: parsed.yes });
    return {
      exitCode: EXIT_OK,
      report: { ok: true, command: "reset", stateDir: stack.stateDir, removed },
      headline: removed.length ? `reset: removed ${removed.join(", ")}` : `reset: ${stack.stateDir} was already absent`,
    };
  } catch (error) {
    return {
      exitCode: EXIT_FAILED,
      report: { ok: false, command: "reset", stateDir: stack.stateDir, error: (error as Error).message },
      headline: `reset refused: ${(error as Error).message}`,
    };
  }
}

function logs(parsed: Parsed, deps: LifecycleDeps): LifecycleResult {
  const directory = deps.wranglerLogDir();
  const latest = latestWranglerLog(directory, parsed.lines);
  return {
    exitCode: EXIT_OK,
    report: { ok: true, command: "logs", directory, file: latest?.file ?? null, lines: latest?.lines ?? [],
      note: "Wrangler's debug log is per user, not per checkout; the terminal running the stack shows request logs" },
    headline: latest ? `newest Wrangler log: ${latest.file}` : `no Wrangler log files in ${directory}`,
  };
}

/** Run one command. Usage errors surface as exit 2 with the usage text in `report.error`. */
export async function runLifecycle(argv: readonly string[], deps: LifecycleDeps = defaultDeps): Promise<LifecycleResult & { json: boolean }> {
  let parsed: Parsed;
  let stack: LocalStack;
  try {
    parsed = parse(argv);
    stack = resolveLocalStack(deps.root, parsed.port === undefined ? [] : ["--port", parsed.port], deps.env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: EXIT_USAGE, json: argv.includes("--json"), headline: message,
      report: { ok: false, command: argv[0] ?? null, error: message } };
  }
  const result = await (async (): Promise<LifecycleResult> => {
    switch (parsed.command) {
      case "status": return status(stack, deps);
      case "start": return start(stack, parsed, deps);
      case "stop": return stop(stack, deps);
      case "seed": return seed(stack, parsed, deps);
      case "verify": return verify(stack, parsed, deps);
      case "reset": return reset(stack, parsed);
      case "logs": return logs(parsed, deps);
      case "runner":
      case "coding":
        return runCoding(parsed.command, parsed.sub!, { consumerRoot: parsed.consumerRoot, once: parsed.once }, deps);
    }
  })();
  return { ...result, json: parsed.json };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { exitCode, report, headline, json } = await runLifecycle(process.argv.slice(2));
  if (exitCode === EXIT_USAGE) console.error(headline);
  else if (!json) console.log(headline);
  console.log(json ? JSON.stringify(report) : JSON.stringify(report, null, 2));
  process.exitCode = exitCode;
}
