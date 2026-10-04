// Wrapper maintenance: `pnpm inferos verify | recover | upgrade`. Copied into wrappers as
// `.inferos/maintenance.ts` beside runtime.ts, which loads it before its own configuration check, so
// these commands still answer (with a JSON report) when the wrapper is broken.
//
// Every command prints one JSON object on stdout and exits 0 when its result is healthy, 1 when it
// is not, and 2 on a usage error, like the local lifecycle operator.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveConsumerConfig } from "./config.ts";
import { assertLocalPortAvailable, checkConsumer, diagnoseConsumer, pinnedSchemaSupported } from "./runtime.ts";

/** Exit codes, shared with `scripts/local/lifecycle.ts`. */
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

class UsageError extends Error {}

/** One verify check. */
export interface VerifyCheck {
  name: "check" | "doctor" | "local-status" | "local-verify";
  status: "pass" | "fail" | "skipped";
  /** Why it failed or was skipped; never a credential or subprocess output beyond the operator's own report. */
  reasons: string[];
  details?: unknown;
}

const lifecycleScript = (upstream: string) => join(upstream, "scripts/local/lifecycle.ts");

/** Run the pinned lifecycle operator with `--json` against the wrapper's port, returning its report. */
function lifecycle(root: string, args: string[]): { exitCode: number; report: Record<string, any> | null; stderr: string } {
  const upstream = join(root, "inferos");
  const port = readPort(root);
  const env = { ...process.env, ...(port ? { VITE_BACKEND_HOST: `localhost:${port}` } : {}) };
  const result = spawnSync(process.execPath, [lifecycleScript(upstream), ...args, "--json"], { cwd: upstream, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  let report: Record<string, any> | null = null;
  try { report = JSON.parse(result.stdout); } catch { /* the operator failed before reporting; stderr says why */ }
  return { exitCode: result.status ?? 1, report, stderr: (result.stderr ?? "").trim() };
}

function readPort(root: string): number | null {
  try { return resolveConsumerConfig(JSON.parse(readFileSync(join(root, "inferos.config.json"), "utf8"))).config.local.port; }
  catch { return null; }
}

/**
 * Whether the stack `local status` saw is this wrapper's own. A pin whose operator reports `stack`
 * decides it; an older pin reports only `listening`, which any server on the port satisfies, so the
 * wrapper checks the submodule's dev-server record for that port itself.
 */
function stackOwnership(root: string, report: Record<string, any> | null): "running" | "not-running" | "port-in-use-by-other" {
  if (report?.stack === "running" || report?.stack === "not-running" || report?.stack === "port-in-use-by-other") return report.stack;
  if (report?.listening !== true) return "not-running";
  const port = readPort(root);
  return port !== null && recordedDevServer(root)?.port === port ? "running" : "port-in-use-by-other";
}

/**
 * check + doctor + local status, and local verify while the stack runs. A stack that is not running,
 * or a port held by a process this wrapper did not start (`port-in-use-by-other`), skips the live
 * checks unless `live` requires them; local verify never runs against such a process.
 */
export async function verifyWrapper(root: string, { live = false } = {}) {
  const checks: VerifyCheck[] = [];
  let revision: string | null = null;
  try {
    const consumer = checkConsumer(root);
    revision = consumer.config.upstream.revision;
    const reasons: string[] = [];
    if (!await pinnedSchemaSupported(root, consumer.upstream, consumer.config)) reasons.push("The pinned revision cannot read this configuration schema version");
    if (consumer.blocked.length) reasons.push(`Enabled capabilities are not supported by this installation: ${consumer.blocked.join(", ")}`);
    checks.push({ name: "check", status: reasons.length ? "fail" : "pass", reasons, details: { revision, schemaVersion: consumer.config.schemaVersion, modifiedUpstream: consumer.modifiedUpstream, pending: consumer.pending } });
  } catch (error) {
    checks.push({ name: "check", status: "fail", reasons: [error instanceof SyntaxError ? "Invalid JSON configuration" : (error as Error).message] });
  }
  const upstream = join(root, "inferos");
  const hasLifecycle = existsSync(lifecycleScript(upstream));
  const status = hasLifecycle ? lifecycle(root, ["status"]) : null;
  const ownership = status ? stackOwnership(root, status.report) : "not-running";
  // Only this wrapper's own stack counts as live: a stranger on the port is never verified.
  const listening = ownership === "running";
  const doctor = await diagnoseConsumer(root);
  // A running stack holds its own port; doctor's port preflight is about starting a new one.
  const errors = doctor.checks.filter(check => check.status === "error" && !(listening && check.name === "port"));
  checks.push({ name: "doctor", status: errors.length ? "fail" : "pass", reasons: errors.map(check => `${check.name}: ${check.message}`),
    details: { checks: doctor.checks } });
  if (!status) {
    checks.push({ name: "local-status", status: live ? "fail" : "skipped", reasons: ["The pinned revision has no local lifecycle operator (scripts/local/lifecycle.ts)"] });
  } else if (ownership === "port-in-use-by-other") {
    const reason = `port-in-use-by-other: ${status.report?.error ?? `port ${readPort(root)} answers, but not with this wrapper's dev server`}`;
    checks.push({ name: "local-status", status: live ? "fail" : "skipped", reasons: [reason], details: status.report ?? undefined });
    checks.push({ name: "local-verify", status: live ? "fail" : "skipped", reasons: [`Not run against a process this wrapper did not start (${reason})`] });
  } else if (!listening) {
    checks.push({ name: "local-status", status: live ? "fail" : "skipped", reasons: [status.report?.error ?? "The local stack is not running (pnpm local start)"], details: status.report ?? undefined });
  } else {
    checks.push({ name: "local-status", status: status.exitCode === 0 ? "pass" : "fail",
      reasons: status.exitCode === 0 ? [] : [status.report?.error ?? `local status: ${status.stderr || "degraded"}`], details: status.report });
  }
  if (listening) {
    const verified = lifecycle(root, ["verify"]);
    checks.push({ name: "local-verify", status: verified.exitCode === 0 ? "pass" : "fail",
      reasons: verified.exitCode === 0 ? [] : [`${verified.report?.step ?? "verify"}: ${verified.report?.error ?? verified.stderr ?? "failed"}`], details: verified.report ?? undefined });
  } else if (ownership !== "port-in-use-by-other") {
    checks.push({ name: "local-verify", status: live ? "fail" : "skipped", reasons: ["Runs only while the local stack is running"] });
  }
  const failures = checks.filter(check => check.status === "fail").map(check => check.name);
  return { ok: failures.length === 0, operation: "verify", revision, live: listening, failures, checks };
}

/** What `recover` found and what it did or would do. */
export interface RecoveryAction {
  description: string;
  /** `manual`: the command will not do it; the description says what a person must decide. */
  kind: "auto" | "manual";
  applied: boolean;
  error?: string;
}

/** The recover targets. */
export const RECOVER_TARGETS = ["ports", "config", "fixtures", "state"] as const;
type RecoverTarget = typeof RECOVER_TARGETS[number];

/** The rollback limit `recover state` states before it does anything. */
export const STATE_ROLLBACK_LIMIT =
  "Local state is reset only, never migrated back. Durable Object and storage migrations a newer pin applied cannot be reversed, so after a downgrade or a failed upgrade the only recovery is deleting inferos/.wrangler/state: every local account, workspace, seeded board and approval goes with it. Wrapper files and cloud state are not touched.";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** The recorded dev server for the wrapper's stack (the lifecycle runs from the submodule). */
function recordedDevServer(root: string): { pid: number; port: number } | null {
  try {
    const record = JSON.parse(readFileSync(join(root, "inferos/.wrangler/local/dev-server.json"), "utf8"));
    if (typeof record?.pid !== "number") return null;
    try { process.kill(record.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPERM") return null; }
    return record;
  } catch { return null; }
}

async function portFree(port: number) {
  try { await assertLocalPortAvailable(port); return true; } catch { return false; }
}

/** Rewrite one field of the customer's configuration, keeping the rest of the file as written. */
function setLocalPort(root: string, port: number) {
  const path = join(root, "inferos.config.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  config.local = { ...config.local, port };
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
}

async function recoverPorts(root: string, apply: boolean): Promise<{ findings: string[]; actions: RecoveryAction[] }> {
  const port = readPort(root);
  if (port === null) return { findings: ["inferos.config.json cannot be read; run pnpm inferos recover config"], actions: [] };
  if (await portFree(port)) return { findings: [`Port ${port} is free`], actions: [] };
  const running = recordedDevServer(root);
  if (running && running.port === port) {
    const action: RecoveryAction = { description: `Stop this wrapper's own dev server (pid ${running.pid}) on port ${port} with pnpm local stop`, kind: "auto", applied: false };
    if (apply) {
      const stopped = lifecycle(root, ["stop"]);
      action.applied = stopped.exitCode === 0;
      if (!action.applied) action.error = stopped.report?.error ?? stopped.stderr ?? "stop failed";
    }
    return { findings: [`Port ${port} is held by this wrapper's dev server`], actions: [action] };
  }
  // Another process owns the port. It is never stopped; the wrapper moves instead.
  let free: number | null = null;
  for (let candidate = port + 1; candidate <= Math.min(port + 100, 65535) && free === null; candidate++) if (await portFree(candidate)) free = candidate;
  if (free === null) return { findings: [`Port ${port} is held by another process`], actions: [{ description: `No free port in ${port + 1}-${port + 100}; choose local.port by hand`, kind: "manual", applied: false }] };
  const action: RecoveryAction = { description: `Port ${port} is held by a process this wrapper did not start; set local.port to ${free} in inferos.config.json (the other process is never stopped)`, kind: "auto", applied: false };
  if (apply) { setLocalPort(root, free); action.applied = true; }
  return { findings: [`Port ${port} is held by another process`], actions: [action] };
}

async function recoverConfig(root: string, apply: boolean): Promise<{ findings: string[]; actions: RecoveryAction[] }> {
  const findings: string[] = [];
  const actions: RecoveryAction[] = [];
  let config;
  try { config = resolveConsumerConfig(JSON.parse(readFileSync(join(root, "inferos.config.json"), "utf8"))).config; }
  catch (error) {
    findings.push(error instanceof SyntaxError ? "inferos.config.json is not valid JSON" : `inferos.config.json is invalid: ${(error as Error).message}`);
    actions.push({ description: "inferos.config.json is customer-owned: fix it by hand or restore it from Git (git checkout -- inferos.config.json); recover never rewrites it", kind: "manual", applied: false });
    return { findings, actions };
  }
  const upstream = join(root, "inferos");
  const pinned = config.upstream.revision;
  const gitlink = git(root, "ls-files", "--stage", "--", "inferos").split(/\s+/)[1] ?? null;
  let head: string | null = null;
  try { head = git(upstream, "rev-parse", "HEAD"); } catch { head = null; }
  if (gitlink !== pinned) {
    findings.push(`The wrapper's gitlink pins ${gitlink ?? "nothing"} but upstream.revision is ${pinned}`);
    actions.push({ description: "Decide which pin is intended: restore the committed files (git checkout -- inferos.config.json && git submodule update), or move to a new pin with pnpm inferos upgrade <sha>", kind: "manual", applied: false });
  } else if (head !== pinned) {
    findings.push(head ? `The submodule checkout is at ${head}, not the pinned ${pinned}` : "The submodule is not checked out");
    let dirty = false;
    try { dirty = head !== null && git(upstream, "status", "--porcelain", "--untracked-files=no").length > 0; } catch { dirty = false; }
    if (dirty) {
      actions.push({ description: "The submodule has local changes; commit, move or discard them inside inferos/ before restoring the pin", kind: "manual", applied: false });
    } else {
      const action: RecoveryAction = { description: `Check out the pinned commit with git submodule update --init inferos`, kind: "auto", applied: false };
      if (apply) {
        try {
          const transport = (config.upstream.repository as string).includes("://") ? [] : ["-c", "protocol.file.allow=always"];
          execFileSync("git", ["-C", root, ...transport, "submodule", "update", "--init", "--", "inferos"], { stdio: "pipe" });
          action.applied = true;
        } catch { action.error = "git submodule update failed; check the submodule remote and network access"; }
      }
      actions.push(action);
    }
  }
  // InferOS-owned files, restored from the pin's own templates when it ships them.
  const pinnedFiles = join(upstream, "scripts/consumer/wrapper-files.ts");
  if (!existsSync(pinnedFiles)) {
    findings.push("The pinned revision predates .inferos/files.json; generated and template files are not checked");
    return { findings, actions };
  }
  const files = await import(pathToFileURL(pinnedFiles).href) as typeof import("./wrapper-files.ts");
  const record = (() => { try { return files.readFilesManifest(root); } catch { return null; } })();
  if (!record) findings.push(`${files.FILES_MANIFEST} is missing or unreadable; edited templates cannot be told apart, so only missing files are restored`);
  const bootstrapPath = join(root, ".inferos/bootstrap.json");
  const bootstrap = JSON.stringify({ version: 1, repository: config.upstream.repository, revision: pinned }, null, 2) + "\n";
  const restore = (path: string, content: string, description: string) => {
    const action: RecoveryAction = { description, kind: "auto", applied: false };
    if (apply) { writeFileSync(join(root, path), content); action.applied = true; }
    actions.push(action);
  };
  if (!existsSync(bootstrapPath) || readFileSync(bootstrapPath, "utf8") !== bootstrap) {
    findings.push(".inferos/bootstrap.json does not match the configured pin");
    restore(".inferos/bootstrap.json", bootstrap, "Rewrite .inferos/bootstrap.json (generated) from upstream.revision");
  }
  for (const [path, file] of files.managedFiles(upstream)) {
    const current = existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : undefined;
    if (file.class === "generated") {
      if (current === undefined) continue;
      const merged = files.renderPackageJson(upstream, current);
      if (merged !== current) {
        findings.push(`${path}: InferOS-managed scripts or versions are missing or changed`);
        restore(path, merged, `Re-merge the managed keys of ${path}, keeping every key and script the wrapper added`);
      }
    } else if (current === undefined) {
      findings.push(`${path} is missing`);
      const action: RecoveryAction = { description: `Restore ${path} from the pinned InferOS`, kind: "auto", applied: false };
      if (apply) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), file.content);
        action.applied = true;
      }
      actions.push(action);
    } else if (current !== file.content && record?.files[path]?.sha256 !== files.sha256(current)) {
      findings.push(`${path} differs from the pinned template and was edited; left as is`);
    }
  }
  return { findings, actions };
}

async function recoverFixtures(root: string, apply: boolean): Promise<{ findings: string[]; actions: RecoveryAction[] }> {
  let config;
  try { config = resolveConsumerConfig(JSON.parse(readFileSync(join(root, "inferos.config.json"), "utf8"))).config; }
  catch { return { findings: ["inferos.config.json cannot be read; run pnpm inferos recover config"], actions: [] }; }
  if (config.inferops.mode !== "fixture") return { findings: ["inferops.mode is remote; there is no fixture to recover"], actions: [] };
  const upstream = join(root, "inferos");
  const script = join(upstream, "scripts/consumer/fixtures.ts");
  if (!existsSync(script)) return { findings: ["The pinned revision has no fixture validator"], actions: [] };
  let validator: { checkConsumerFixture: (root: string) => unknown; validateBoardFixture: (input: unknown, targetRef: string) => unknown };
  try { validator = await import(pathToFileURL(script).href); }
  catch { return { findings: ["The fixture validator cannot load; run pnpm run setup first"], actions: [] }; }
  try {
    validator.checkConsumerFixture(root);
    return { findings: [`${config.inferops.fixture} is valid`], actions: [] };
  } catch (error) {
    const finding = `${config.inferops.fixture} is invalid: ${(error as Error).message}`;
    const starterPath = join(upstream, "scripts/consumer/project-board.json");
    const starter = existsSync(starterPath) ? readFileSync(starterPath, "utf8") : null;
    let starterFits = false;
    try { if (starter) { validator.validateBoardFixture(JSON.parse(starter), config.inferops.targetRef); starterFits = true; } } catch { starterFits = false; }
    if (!starterFits) {
      return { findings: [finding], actions: [{ description: "The pinned starter fixture does not match inferops.targetRef either; fix the fixture (or targetRef) by hand", kind: "manual", applied: false }] };
    }
    const target = join(root, config.inferops.fixture);
    const kept = `${config.inferops.fixture}.invalid-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const action: RecoveryAction = {
      description: existsSync(target) ? `Move the current fixture to ${kept} (kept, never deleted) and restore the pinned starter fixture` : "Restore the pinned starter fixture",
      kind: "auto", applied: false,
    };
    if (apply) {
      if (existsSync(target)) renameSync(target, join(root, kept));
      writeFileSync(target, starter!);
      action.applied = true;
    }
    return { findings: [finding], actions: [action] };
  }
}

function recoverState(root: string, apply: boolean): { findings: string[]; actions: RecoveryAction[] } {
  const upstream = join(root, "inferos");
  const stateDir = join(upstream, ".wrangler/state");
  if (!existsSync(lifecycleScript(upstream))) return { findings: ["The pinned revision has no local lifecycle operator to reset state with"], actions: [] };
  const findings = [existsSync(stateDir) ? "Local state exists at inferos/.wrangler/state" : "No local state at inferos/.wrangler/state"];
  if (!existsSync(stateDir)) return { findings, actions: [] };
  const action: RecoveryAction = { description: "Delete inferos/.wrangler/state with pnpm local reset --yes (refused while the stack runs; stop it first)", kind: "auto", applied: false };
  if (apply) {
    const reset = lifecycle(root, ["reset", "--yes"]);
    action.applied = reset.exitCode === 0;
    if (!action.applied) action.error = reset.report?.error ?? reset.stderr ?? "reset failed";
  }
  return { findings, actions: [action] };
}

/** Describe (and with `apply`, perform) one bounded recovery. Never deletes a customer-owned file. */
export async function recoverWrapper(root: string, target: RecoverTarget, { apply = false } = {}) {
  const { findings, actions } = target === "ports" ? await recoverPorts(root, apply)
    : target === "config" ? await recoverConfig(root, apply)
    : target === "fixtures" ? await recoverFixtures(root, apply)
    : recoverState(root, apply);
  const outstanding = actions.filter(action => !action.applied);
  return {
    ok: outstanding.length === 0, operation: "recover", target, mode: apply ? "apply" : "dry-run",
    findings, actions,
    ...(target === "state" ? { rollback: STATE_ROLLBACK_LIMIT } : {}),
    ...(!apply && actions.some(action => action.kind === "auto") ? { next: `pnpm inferos recover ${target} --apply` } : {}),
  };
}

/**
 * `pnpm inferos upgrade <sha> [flags]`: fetch the commit into the submodule if needed, check it out as
 * a temporary worktree, and run that revision's own `scripts/consumer/upgrade.ts` with the flags, so
 * the target, not this copy, decides which flags (`--plan`, `--apply`, `--branch`, `--open-pr`) it takes.
 */
export function runUpgrade(root: string, revision: string, flags: string[]): number {
  const upstream = join(root, "inferos");
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new UsageError("The target must be a full 40-character commit SHA");
  const present = () => spawnSync("git", ["-C", upstream, "cat-file", "-e", `${revision}^{commit}`], { stdio: "ignore" }).status === 0;
  if (!present()) {
    let remote = "";
    try { remote = git(upstream, "remote", "get-url", "origin"); } catch { /* reported below */ }
    const transport = remote.includes("://") ? [] : ["-c", "protocol.file.allow=always"];
    spawnSync("git", ["-C", upstream, ...transport, "fetch", "--quiet", "origin", revision], { stdio: "ignore" });
    if (!present()) throw new Error("The target commit is not in the submodule and could not be fetched from its origin");
  }
  const worktree = mkdtempSync(join(tmpdir(), "inferos-upgrade-"));
  rmSync(worktree, { recursive: true, force: true });
  try {
    git(upstream, "worktree", "add", "--quiet", "--detach", worktree, revision);
    const script = join(worktree, "scripts/consumer/upgrade.ts");
    if (!existsSync(script)) throw new Error("The target revision does not support pnpm inferos upgrade");
    const result = spawnSync(process.execPath, [script, root, revision, ...flags], { cwd: worktree, stdio: "inherit" });
    return result.status ?? EXIT_FAILED;
  } finally {
    spawnSync("git", ["-C", upstream, "worktree", "remove", "--force", worktree], { stdio: "ignore" });
    rmSync(worktree, { recursive: true, force: true });
    spawnSync("git", ["-C", upstream, "worktree", "prune"], { stdio: "ignore" });
  }
}

const USAGE = `Usage: pnpm inferos verify [--live]
       pnpm inferos recover ports|config|fixtures|state [--apply]
       pnpm inferos upgrade <full-sha> [--plan|--apply [--branch <name> [--open-pr <owner/repo>]]]`;

/** Run one maintenance command; returns the exit code. */
export async function runMaintenance(root: string, command: string, args: string[]): Promise<number> {
  try {
    if (command === "verify") {
      if (args.some(arg => arg !== "--live")) throw new UsageError(USAGE);
      const report = await verifyWrapper(root, { live: args.includes("--live") });
      console.log(JSON.stringify(report, null, 2));
      return report.ok ? EXIT_OK : EXIT_FAILED;
    }
    if (command === "recover") {
      const [target, ...rest] = args;
      if (!(RECOVER_TARGETS as readonly string[]).includes(target ?? "") || rest.some(arg => arg !== "--apply")) throw new UsageError(USAGE);
      const report = await recoverWrapper(root, target as RecoverTarget, { apply: rest.includes("--apply") });
      console.log(JSON.stringify(report, null, 2));
      return report.ok ? EXIT_OK : EXIT_FAILED;
    }
    if (command === "upgrade") {
      const [revision, ...flags] = args;
      if (!revision || revision.startsWith("--")) throw new UsageError(USAGE);
      return runUpgrade(root, revision, flags);
    }
    throw new UsageError(USAGE);
  } catch (error) {
    const usage = error instanceof UsageError;
    console.error(usage ? error.message : error instanceof Error && !("status" in error) ? error.message : "Git operation failed");
    return usage ? EXIT_USAGE : EXIT_FAILED;
  }
}
