// What every factory CI step (`scripts/ci/<node>.ts`) shares: its argument shape, where its
// evidence goes, how it runs a command, and how it records the outcome.
//
// Each node is one script, run the same way by `scripts/ci/pipeline.ts --target=local` (one child
// per node) and by the thin composite actions under `.github/actions/*` that the reusable
// workflows call. A node writes `.factory/runs/<run-id>/<node>/result.json` plus one log per
// command, and exits 0 only when its gate passed.

import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** One command a node ran: what, where its output went, and how it ended. */
export interface CommandRecord {
  argv: string[];
  exitCode: number;
  durationMs: number;
  log: string;
}

/** A node's outcome, written as `result.json` beside its logs. */
export interface NodeResult {
  node: string;
  ok: boolean;
  /** What the gate is, in words, so the evidence explains itself. */
  gate: string;
  commands: CommandRecord[];
  details?: Record<string, unknown>;
}

/** What a node runs with: its evidence directory and the run it belongs to. */
export interface NodeContext {
  node: string;
  root: string;
  runId: string;
  /** `.factory/runs/<run-id>/<node>/`, created. */
  dir: string;
  target: "local" | "gha";
  /** Node-specific selector (`verify --part lint`). */
  part?: string;
  /** The ref the change is compared against (gitleaks range, baseline diffs). */
  baseRef: string;
  env: NodeJS.ProcessEnv;
}

/** A run id: `local-<utc timestamp>-<sha7>`, sortable and tied to the commit. */
export function newRunId(root: string, now = new Date()): string {
  const sha = spawnSync("git", ["rev-parse", "--short=7", "HEAD"], { cwd: root, encoding: "utf8" }).stdout?.trim() || "nogit";
  return `local-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${sha}`;
}

export const runsDir = (root: string) => join(root, ".factory", "runs");

/** Parse a node script's own arguments (`--run-id`, `--part`, `--base`). */
export function nodeContext(node: string, argv: readonly string[], env: NodeJS.ProcessEnv = process.env, root = ROOT): NodeContext {
  const { values } = parseArgs({
    args: [...argv],
    options: { "run-id": { type: "string" }, part: { type: "string" }, base: { type: "string" }, target: { type: "string", default: env.GITHUB_ACTIONS ? "gha" : "local" } },
  });
  if (values.target !== "local" && values.target !== "gha") throw new Error(`--target must be local or gha, not ${values.target}`);
  const runId = values["run-id"] ?? env.FACTORY_RUN_ID ?? newRunId(root);
  if (!/^[\w.-]+$/.test(runId)) throw new Error(`invalid run id ${runId}`);
  const dir = join(runsDir(root), runId, node);
  mkdirSync(dir, { recursive: true });
  return { node, root, runId, dir, target: values.target, part: values.part, baseRef: values.base ?? env.FACTORY_BASE_REF ?? "origin/main", env };
}

/** Options for {@link exec}. */
export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Log file name inside the node's directory. */
  log: string;
  /** Write stdout (only) to this file in the node's directory as well, for tools that print a report. */
  stdoutFile?: string;
}

/** Run `argv` to completion, teeing its output to the console and to `<dir>/<log>`. */
export function exec(ctx: NodeContext, argv: string[], options: ExecOptions): Promise<CommandRecord> {
  const started = Date.now();
  const logPath = join(ctx.dir, options.log);
  const log = createWriteStream(logPath);
  const stdoutFile = options.stdoutFile ? createWriteStream(join(ctx.dir, options.stdoutFile)) : null;
  log.write(`$ ${argv.join(" ")}\n`);
  return new Promise(settle => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: options.cwd ?? ctx.root, env: options.env ?? ctx.env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", chunk => {
      log.write(chunk);
      if (stdoutFile) stdoutFile.write(chunk);
      else process.stdout.write(chunk);
    });
    child.stderr.on("data", chunk => {
      log.write(chunk);
      process.stderr.write(chunk);
    });
    let settled = false;
    const done = (exitCode: number) => {
      if (settled) return;
      settled = true;
      child.stdout.destroy();
      child.stderr.destroy();
      stdoutFile?.end();
      log.end(() => settle({ argv, exitCode, durationMs: Date.now() - started, log: logPath }));
    };
    child.on("error", error => {
      log.write(`\n${error.message}\n`);
      done(127);
    });
    child.on("close", code => done(code ?? 1));
    // A grandchild that outlives the command (an orphaned vitest worker) keeps the pipes open, so
    // `close` may never come; the exit code is the outcome, after a short drain.
    child.on("exit", code => setTimeout(() => done(code ?? 1), 5_000).unref());
  });
}

/** Run `commands` in order, stopping at the first that fails. */
export async function execAll(ctx: NodeContext, commands: { argv: string[]; log: string; env?: NodeJS.ProcessEnv }[]): Promise<CommandRecord[]> {
  const records: CommandRecord[] = [];
  for (const command of commands) {
    const record = await exec(ctx, command.argv, { log: command.log, env: command.env });
    records.push(record);
    if (record.exitCode !== 0) break;
  }
  return records;
}

/** Record the result and return the process exit code (0 only when the gate passed). */
export function finish(ctx: NodeContext, result: NodeResult): number {
  writeFileSync(join(ctx.dir, "result.json"), JSON.stringify(result, null, 2) + "\n");
  const line = `[factory] ${result.node}: ${result.ok ? "PASS" : "FAIL"} — ${result.gate} (evidence ${ctx.dir})`;
  (result.ok ? console.log : console.error)(line);
  if (ctx.env.GITHUB_STEP_SUMMARY) {
    try {
      writeFileSync(ctx.env.GITHUB_STEP_SUMMARY, `${line}\n`, { flag: "a" });
    } catch {
      // The summary is a convenience; the exit code is the gate.
    }
  }
  return result.ok ? 0 : 1;
}

/**
 * Docker arguments every tool container shares: removed afterwards, this user's uid (so files it
 * writes are ours), no Docker socket, and no published ports. Tools that must reach the local stack
 * on 127.0.0.1 use `--network host`, which publishes nothing.
 */
export function dockerRun(ctx: NodeContext, extra: string[]): string[] {
  const uid = typeof process.getuid === "function" ? `${process.getuid()}:${process.getgid?.()}` : "1000:1000";
  return ["docker", "run", "--rm", "-u", uid, "-e", "HOME=/tmp", ...extra];
}

/**
 * The image's `/etc/passwd` with a `factory` entry for `uid:gid` appended, or null when the image
 * already names that uid. Node's `os.userInfo()` (Artillery) and ZAP's start script fail for a uid
 * the image does not know: on a laptop the user is usually uid 1000, which the images name (`node`,
 * `zap`), but a GitHub-hosted runner is uid 1001.
 */
export function passwdWithUser(passwd: string, uid: number, gid: number): string | null {
  const known = passwd.split("\n").some(line => line.split(":")[2] === String(uid));
  return known ? null : `${passwd.replace(/\n?$/, "\n")}factory:x:${uid}:${gid}:factory:/tmp:/bin/sh\n`;
}

/**
 * Docker arguments that give `image` a passwd entry for this user (read-only bind of
 * {@link passwdWithUser}'s file into the node's evidence dir), or none when it already has one.
 * The container still runs as this uid, so what it writes stays ours.
 */
export function userEntryMount(ctx: NodeContext, image: string): string[] {
  if (typeof process.getuid !== "function") return [];
  const read = spawnSync("docker", ["run", "--rm", "--network", "none", "--entrypoint", "cat", image, "/etc/passwd"], { encoding: "utf8" });
  if (read.status !== 0) return [];
  const passwd = passwdWithUser(read.stdout, process.getuid(), process.getgid?.() ?? process.getuid());
  if (passwd === null) return [];
  const file = join(ctx.dir, `.passwd-${image.replace(/[^\w.-]/g, "_")}`);
  writeFileSync(file, passwd);
  return ["-v", `${file}:/etc/passwd:ro`];
}

/** Run a node's `main` when its file is the entry point. */
export async function runAsMain(metaUrl: string, main: (argv: string[]) => Promise<number>): Promise<void> {
  if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(metaUrl)) {
    try {
      process.exitCode = await main(process.argv.slice(2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    }
  }
}
