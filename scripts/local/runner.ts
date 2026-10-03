// The local coding runner as `pnpm local runner …` and `pnpm local coding doctor` see it: which
// wrapper configures it, the `runner.json` written from that wrapper's `codingWorkbench.repos`, the
// environment the InferOps CLI is launched with, and how its state on disk is read back.
//
// The runner itself is InferOps' (`inferops runner codex --result patch`, factory-level/inferops#2327).
// Nothing here claims, executes or finishes a run: this module only decides whether the runner may
// start, what it is given, and what it left behind. No credential value is ever put in a report.

import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseConsumerConfig, type CodingRepo, type ConsumerConfig } from "../consumer/config.ts";
import { resolveCodingWorkbenchEnabled } from "../dev-server-config.ts";
import { localEnv } from "./stack.ts";

/**
 * The parent variables the launched InferOps CLI inherits, matching the runner's own child
 * allowlist (`PATH`, `HOME`, `CODEX_HOME`, `LANG`, `LC_*`, `TERM`, `TMPDIR`, `SHELL`, `USER`).
 * Everything else, provider keys included, stays in this process.
 */
export const INHERITED_VARS = ["PATH", "HOME", "CODEX_HOME", "LANG", "TERM", "TMPDIR", "SHELL", "USER"] as const;

/**
 * What the runner needs on top of {@link INHERITED_VARS}, read from the shell or the wrapper's
 * `.dev.vars`: the API base URL, the workspace, the service key (`run:execute`) and, optionally, a
 * `codex` executable that is not on `PATH`. The runner keeps the key to itself and gives its own
 * children only the inherited set.
 */
export const RUNNER_VARS = ["INFEROPS_ENDPOINT", "INFEROPS_WORKSPACE_ID", "INFEROPS_API_KEY", "CODEX_PATH"] as const;

/** The pause file the runner writes on `AUTH_BLOCKED` / `QUOTA_BLOCKED`, in its workdir. */
export const PAUSE_FILE = ".inferops-runner.paused";

/** Where the runner keeps one run's test evidence, inside that run's checkout. */
export const ARTIFACTS_DIR = ".inferops-artifacts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Names that select or pay for a model provider. A variable matching any of these must never reach
 * the runner: a subscription sign-in is the only billing mode, and a key in the environment is how
 * a CLI silently switches to API billing.
 */
const PROVIDER_VAR = /^(?:OPENAI|ANTHROPIC|AZURE_OPENAI|AZURE_AI|CODEX|GEMINI|GOOGLE_GENERATIVE_AI|GOOGLE_API|VERTEX|MISTRAL|GROQ|DEEPSEEK|XAI|OPENROUTER|COHERE|TOGETHER|FIREWORKS|PERPLEXITY|HUGGINGFACE|AWS_BEDROCK|BEDROCK)_/;

/** Whether `name` would select or pay for a model provider (see {@link PROVIDER_VAR}). */
export function isProviderVariable(name: string): boolean {
  if (name === "CODEX_HOME" || name === "CODEX_PATH") return false;
  return PROVIDER_VAR.test(name) || (name.endsWith("_API_KEY") && name !== "INFEROPS_API_KEY");
}

/** The provider variables set in `env`, by name only. */
export function providerVariables(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter(name => env[name] && isProviderVariable(name)).toSorted();
}

/**
 * The launched CLI's whole environment: {@link INHERITED_VARS} and `LC_*` from `env`, plus
 * {@link RUNNER_VARS}. Built from an allowlist, so a variable nobody listed cannot leak in.
 */
export function runnerChildEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const child: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const allowed = (INHERITED_VARS as readonly string[]).includes(name) || /^LC_[A-Z_]+$/.test(name) ||
      (RUNNER_VARS as readonly string[]).includes(name);
    if (allowed && !isProviderVariable(name)) child[name] = value;
  }
  return child;
}

const SECRET_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|SESSION)/i;

/** Every credential-looking value in `env`, longest first, for {@link redact}. */
export function secretValues(env: NodeJS.ProcessEnv): string[] {
  return [...new Set(Object.entries(env)
    .filter(([name, value]) => value && value.length >= 6 && (SECRET_NAME.test(name) || isProviderVariable(name)))
    .map(([, value]) => value!))]
    .toSorted((a, b) => b.length - a.length);
}

/** `value` with every occurrence of each secret replaced by `[redacted]`, recursively. */
export function redact<T>(value: T, secrets: readonly string[]): T {
  if (!secrets.length) return value;
  if (typeof value === "string") {
    let text: string = value;
    for (const secret of secrets) text = text.split(secret).join("[redacted]");
    return text as T;
  }
  if (Array.isArray(value)) return value.map(item => redact(item, secrets)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, secrets)])) as T;
  }
  return value;
}

/**
 * One wrapper test command as the runner's argv. The runner executes it without a shell, so shell
 * syntax is refused rather than passed on as literal arguments. Single and double quotes group
 * words; there are no escapes.
 */
export function splitTestCommand(line: string): string[] {
  const argv: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let started = false;
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === "'" || char === "\"") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) argv.push(current);
      current = "";
      started = false;
    } else if ("|&;<>()$`\\*?{}".includes(char)) {
      throw new Error(`"${char}" needs a shell, and the runner runs test commands without one`);
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) throw new Error("unbalanced quote");
  if (started) argv.push(current);
  if (!argv.length) throw new Error("empty command");
  return argv;
}

/** `runner.json` as the InferOps runner reads it (`--config`). */
export interface RunnerFile {
  repos: Record<string, { path: string; baseRef?: string; testCommands: string[][] }>;
}

/** The runner's allowlist from the wrapper's `codingWorkbench.repos`. Throws naming the bad command. */
export function buildRunnerFile(repos: readonly CodingRepo[]): RunnerFile {
  return {
    repos: Object.fromEntries(repos.map((repo, index) => [repo.repoId, {
      path: repo.path,
      ...(repo.baseRef !== undefined ? { baseRef: repo.baseRef } : {}),
      testCommands: repo.testCommands.map((command, n) => {
        try {
          return splitTestCommand(command);
        } catch (error) {
          throw new Error(`codingWorkbench.repos[${index}].testCommands[${n}]: ${(error as Error).message}`, { cause: error });
        }
      }),
    }])),
  };
}

/** Everything the runner commands know before touching a process. */
export interface CodingContext {
  /** The wrapper whose `inferos.config.json` configures the runner. */
  consumerRoot: string;
  /** Whether that wrapper has an `inferos.config.json`. */
  configured: boolean;
  /** `CODING_WORKBENCH_ENABLED` as the dev server would resolve it. */
  enabled: boolean;
  /** Where the switch came from: the wrapper's version 2 capability, or the shell. */
  enabledSource: "wrapper" | "shell";
  repos: CodingRepo[];
  /** Local, git-ignored state: runner.json, the pid record, the log and (by default) the workdir. */
  stateDir: string;
  runnerFile: string;
  recordPath: string;
  logPath: string;
  workdir: string;
  pausePath: string;
  /** `INFEROPS_CLI`: the pinned InferOps binary. Never searched for and never downloaded. */
  cli: string | null;
  endpoint: string | null;
  workspaceId: string | null;
  /** Whether `INFEROPS_API_KEY` is set. The value stays in {@link env}. */
  apiKey: boolean;
  /** The merged environment (shell, then `.dev.vars`, then `.env`). Never reported. */
  env: NodeJS.ProcessEnv;
  /** Problems found while reading the configuration, before any process runs. */
  problems: string[];
}

/**
 * Read the wrapper's coding configuration and the runner settings. `checkoutRoot` is this InferOS
 * checkout; `consumerRoot` the wrapper (the checkout itself when run in-repo).
 */
export function resolveCodingContext(checkoutRoot: string, consumerRoot: string, shell: NodeJS.ProcessEnv): CodingContext {
  const env = localEnv(consumerRoot, shell);
  const problems: string[] = [];
  const configPath = join(consumerRoot, "inferos.config.json");
  let config: ConsumerConfig | null = null;
  if (existsSync(configPath)) {
    try {
      config = parseConsumerConfig(JSON.parse(readFileSync(configPath, "utf8")));
    } catch (error) {
      problems.push(`inferos.config.json: ${error instanceof SyntaxError ? "invalid JSON" : (error as Error).message}`);
    }
  } else {
    problems.push(`No inferos.config.json in ${consumerRoot}: the runner's allowlist is a version 2 wrapper's codingWorkbench.repos (pass --consumer-root <wrapper>)`);
  }
  const v2 = config?.schemaVersion === 2 ? config : null;
  let enabled = false;
  try {
    const inferOpsEnabled = v2 ? (v2.capabilities.INFEROPS_ENABLED ? "true" : "false")
      : env.INFEROPS_ENABLED === "false" ? "false" : "true";
    enabled = resolveCodingWorkbenchEnabled({
      capability: v2 ? v2.capabilities.CODING_WORKBENCH_ENABLED : null, inferOpsEnabled, shell: env.CODING_WORKBENCH_ENABLED,
    }) === "true";
  } catch (error) {
    problems.push((error as Error).message);
  }
  const repos = v2?.codingWorkbench?.repos ?? [];
  const stateDir = resolve(consumerRoot) === resolve(checkoutRoot)
    ? join(checkoutRoot, ".wrangler", "local", "runner")
    : join(consumerRoot, ".inferos", "state", "runner");
  const workdir = env.INFEROPS_RUNNER_WORKDIR ? resolve(consumerRoot, env.INFEROPS_RUNNER_WORKDIR) : join(stateDir, "runs");

  const cli = env.INFEROPS_CLI || null;
  if (!cli) problems.push("INFEROPS_CLI is not set: point it at the pinned inferops binary (it is never downloaded)");
  else if (!isAbsolute(cli)) problems.push("INFEROPS_CLI must be an absolute path to the pinned inferops binary");
  else if (!executable(cli)) problems.push("INFEROPS_CLI does not name an executable file");

  const endpoint = env.INFEROPS_ENDPOINT || env.INFEROPS_BASE_URL || null;
  if (!endpoint) problems.push("INFEROPS_ENDPOINT is not set (the InferOps API base URL; INFEROPS_BASE_URL is used when it is unset)");
  else if (!/^https?:\/\//.test(endpoint) || !URL.canParse(endpoint)) problems.push("INFEROPS_ENDPOINT is not an http(s) URL");
  const workspaceId = env.INFEROPS_WORKSPACE_ID || null;
  if (!workspaceId) problems.push("INFEROPS_WORKSPACE_ID is not set");
  else if (!UUID.test(workspaceId)) problems.push("INFEROPS_WORKSPACE_ID is not a UUID");
  const apiKey = !!env.INFEROPS_API_KEY;
  if (!apiKey) problems.push("INFEROPS_API_KEY is not set (a service-account key holding run:execute, in .dev.vars)");

  return {
    consumerRoot, configured: config !== null, enabled, enabledSource: v2 ? "wrapper" : "shell", repos,
    stateDir, runnerFile: join(stateDir, "runner.json"), recordPath: join(stateDir, "runner.pid.json"),
    logPath: join(stateDir, "runner.log"), workdir, pausePath: join(workdir, PAUSE_FILE),
    cli, endpoint, workspaceId, apiKey, env, problems,
  };
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The context as a report shows it: presence and hosts, never a credential. */
export function describeContext(context: CodingContext) {
  let endpointHost: string | null = null;
  try {
    endpointHost = context.endpoint ? new URL(context.endpoint).host : null;
  } catch {
    endpointHost = null;
  }
  return {
    consumerRoot: context.consumerRoot,
    codingWorkbench: { enabled: context.enabled, source: context.enabledSource, repos: context.repos.length },
    cli: context.cli, endpoint: endpointHost, workspaceId: context.workspaceId,
    apiKey: context.apiKey ? "set" : "missing",
    runnerFile: context.runnerFile, workdir: context.workdir, log: context.logPath,
  };
}

/** The argv that starts the runner (`check` adds `--check`, which claims nothing). */
export function runnerArgv(context: CodingContext, options: { check?: boolean; once?: boolean } = {}): string[] {
  return [
    context.cli!, "runner", "codex", "--result", "patch", "--config", context.runnerFile,
    "--workdir", context.workdir, "--json",
    ...(options.check ? ["--check"] : []), ...(options.once ? ["--once"] : []),
  ];
}

/** Write `runner.json` (paths and test commands; no credential) and create the workdir. */
export function writeRunnerFile(context: CodingContext): RunnerFile {
  const file = buildRunnerFile(context.repos);
  mkdirSync(context.stateDir, { recursive: true });
  mkdirSync(context.workdir, { recursive: true });
  writeFileSync(context.runnerFile, JSON.stringify(file, null, 2) + "\n");
  return file;
}

/** What `inferops runner codex --check --json` reported. */
export interface Readiness {
  ready: boolean;
  authMode: string | null;
  codexVersion: string | null;
  repos: number | null;
  paused: string | null;
  problems: string[];
}

/** Read the CLI's `--check --json` envelope (`{ok, data}` or `{ok:false, error:{message, details}}`). */
export function parseReadiness(result: { exitCode: number; stdout: string; stderr: string }): Readiness {
  let envelope: { ok?: boolean; data?: Partial<Readiness>; error?: { code?: string; message?: string; details?: Partial<Readiness> } };
  try {
    envelope = JSON.parse(result.stdout);
  } catch {
    const tail = result.stderr.trim().split("\n").at(-1) ?? "";
    return { ready: false, authMode: null, codexVersion: null, repos: null, paused: null,
      problems: [`The runner check printed no JSON report (exit ${result.exitCode})${tail ? `: ${tail}` : ""}`] };
  }
  const data = envelope.ok ? envelope.data ?? {} : envelope.error?.details ?? {};
  const problems = Array.isArray(data.problems) ? data.problems.map(String)
    : envelope.ok ? [] : [`${envelope.error?.code ?? "ERROR"}: ${envelope.error?.message ?? "the runner check failed"}`];
  return {
    ready: envelope.ok === true && data.ready === true && result.exitCode === 0,
    authMode: typeof data.authMode === "string" ? data.authMode : null,
    codexVersion: typeof data.codexVersion === "string" ? data.codexVersion : null,
    repos: typeof data.repos === "number" ? data.repos : null,
    paused: typeof data.paused === "string" ? data.paused : null,
    problems,
  };
}

/** The pause record the runner wrote, or null when it is not paused. Unreadable still counts as paused. */
export function readPause(pausePath: string): { reasonCode: string; runId: string; at: string } | null {
  if (!existsSync(pausePath)) return null;
  try {
    const record = JSON.parse(readFileSync(pausePath, "utf8"));
    return { reasonCode: String(record.reasonCode ?? "unknown"), runId: String(record.runId ?? "unknown"), at: String(record.at ?? "unknown") };
  } catch {
    return { reasonCode: "unknown", runId: "unknown", at: "unknown" };
  }
}

/** What `runner start` records so `status` and `stop` can find the process. */
export interface RunnerRecord {
  pid: number;
  startedAt: string;
  cli: string;
  workdir: string;
  log: string;
}

/** The recorded runner, or null when none is recorded. Liveness is the caller's question. */
export function readRunnerRecord(recordPath: string): RunnerRecord | null {
  try {
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    return typeof record?.pid === "number" ? record : null;
  } catch {
    return null;
  }
}

/** One run directory the runner left in its workdir. */
export interface RunDirectory {
  runId: string;
  path: string;
  modifiedAt: string;
  /** `result.patch`, when written (on success, and as the partial patch otherwise). */
  patch: { path: string; bytes: number } | null;
  /** The test commands' exit codes, from each `test-<n>.json` record. */
  tests: { passed: number; failed: number; records: string[] } | null;
  /** Whether the recovery sidecar is there (the run can be resumed or reported unknown). */
  sidecar: boolean;
}

/** The newest `limit` run directories in `workdir`, newest first. */
export function recentRuns(workdir: string, limit = 5): RunDirectory[] {
  if (!existsSync(workdir)) return [];
  return readdirSync(workdir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && UUID.test(entry.name))
    .map(entry => ({ name: entry.name, path: join(workdir, entry.name), mtime: statSync(join(workdir, entry.name)).mtimeMs }))
    .toSorted((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map(({ name, path, mtime }): RunDirectory => {
      const patchPath = join(path, "result.patch");
      const artifacts = join(path, ARTIFACTS_DIR);
      let tests: RunDirectory["tests"] = null;
      if (existsSync(artifacts)) {
        const records = readdirSync(artifacts).filter(file => /^test-\d+\.json$/.test(file)).toSorted();
        let passed = 0;
        for (const file of records) {
          try {
            if (JSON.parse(readFileSync(join(artifacts, file), "utf8")).exitCode === 0) passed++;
          } catch {
            // An unreadable record is not a pass.
          }
        }
        tests = { passed, failed: records.length - passed, records: records.map(file => join(artifacts, file)) };
      }
      return {
        runId: name, path, modifiedAt: new Date(mtime).toISOString(),
        patch: existsSync(patchPath) ? { path: patchPath, bytes: statSync(patchPath).size } : null,
        tests, sidecar: existsSync(join(path, ".inferops-run.json")),
      };
    });
}

/** The last `lines` lines of the runner log, or [] when there is none. */
export function logTail(logPath: string, lines = 20): string[] {
  if (!existsSync(logPath)) return [];
  const all = readFileSync(logPath, "utf8").split("\n");
  if (all.at(-1) === "") all.pop();
  return all.slice(-lines);
}
