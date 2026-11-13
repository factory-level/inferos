// FAC-141 acceptance 2, the cross-store half: a recovery rehearsal of one company's retained state.
// InferOps Postgres (the pinned backend's own database) is restored together with this checkout's
// InferOS Durable Object, KV and R2 state, and then each store is restored on its own to show
// both skew directions are safe. The as-built runbook is docs/wiki/backup-and-recovery.md. The
// InferOps half, a Postgres dump and restore checked table by table, is inferops `bun run
// proof:recovery` (docs/agent/architecture/upgrade-and-recovery.md there).
//
//   node scripts/proof/recovery-rehearsal.ts --worktree <abs path of a pnpm wt worktree> [--report <file>]
//
// Local and disposable only. It refuses (`rehearsalRefusal`, each with a test):
//   - a target that isn't a worktree under this repository's .worktrees/, or is the main checkout;
//   - a target with uncommitted changes, untracked files included;
//   - a target whose stack or backend is already running (it must be this run's own);
//   - a shell holding cloud, deploy or model-provider credentials (`forbiddenCredentials`);
//   - a Postgres admin URL whose host isn't localhost, or that carries a `host=`/`hostaddr=` override;
//   - a Postgres server that isn't the local Compose Postgres: its `system_identifier`, read
//     read-only over the admin URL, must equal the one read inside the inferops Compose project's
//     postgres container, found by Compose itself (`docker compose -p inferops ps -q postgres`,
//     exactly one, its project and service labels checked), never named by the environment; so a
//     localhost tunnel or proxy to another server is refused, and so is an unreadable identifier, no
//     container, several, or one with other labels;
//   - a checkout the `pnpm wt` registry (`~/.config/inferos/worktrees.json`, read only) doesn't
//     hold exactly once, or whose port settings (the shell, then `.env.worktree`, as the stack reads
//     them) disagree with its registered port: the database is `inferos_<registered port>`, never
//     what `.env.worktree` (gitignored) or `up` says.
// Every guard runs before any command that could touch a database or start a stack: before them,
// only `pnpm local status`, `pnpm local inferops status`, `git status` and the two identity reads
// run. After `up`, the database it reports must be the derived one before anything else runs
// (`rehearse`, whose commands are injected so the tests show this with a spy).
// In a `finally`, it always stops the stack and the backend it started, and the report says
// whether they stopped. It drops no database: the backend's own is left restored to the rehearsal's
// last state, and the next `pnpm local inferops up` reuses it.
//
// The rehearsal, against the acme ENG board under the stopgap bearer:
//   1. `inferops up`, `start --inferops --stopgap`, and `seed --approval`, which holds one pending
//      move in the gatekeeper.
//   2. Pair A, quiesced: stop both, then `pg_dump -Fc` the backend database and archive
//      `.wrangler/state`.
//   3. Start both, approve the move (it applies in InferOps), stop, and archive the state again
//      (state B, newer).
//   4. Joint restore of pair A: the database and the state equal pair A's, and the move is pending
//      again.
//   5. Skew 1, InferOS older than InferOps: approve (it applies), then restore only state A. The
//      replayed approval is refused, and the issue moved exactly once.
//   6. Skew 2, InferOS newer than InferOps: restore database A with state B. InferOS shows the
//      board InferOps holds (the issue unmoved), and starting and reading writes nothing back.
// It exits 1 on any mismatch and prints one JSON report.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { backendDatabase, forbiddenCredentials, INFEROPS_COMPOSE_PROJECT, INFEROPS_COMPOSE_SERVICE } from "../local/inferops.ts";
import { readRegistry, registryPath, type Registry } from "../wt/registry.ts";
import { portLayout } from "../wt/layout.ts";
import { homedir } from "node:os";
import { resolveLocalStack } from "../local/stack.ts";
import { withWorktreeEnv } from "../worktree-env.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The acme operations workspace the stopgap bearer reaches (inferops seeds). */
const ACME_OPS = "00000000-0000-4000-8000-000000000011";
const ENG_BOARD = "inferops://acme.operations/project/board/ENG";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const DEFAULT_PG_ADMIN_URL = "postgres://postgres:postgres@localhost:5432/postgres";

/** What the guards read about the target, injected for tests. */
export type TargetFacts = {
  /** The target's real path, or null when it doesn't exist. */
  realPath: string | null;
  /** This repository's real root. */
  repoRoot: string;
  /** `git status --porcelain` in the target, untracked files included, or null when git failed. */
  changes: string | null;
  /** The Postgres admin URL the rehearsal would use (`INFEROPS_PG_ADMIN_URL`, else the local default). */
  adminUrl: string;
  /** `pnpm local status`'s `stack` value. */
  stack: string;
  /** `pnpm local inferops status`'s `backend` value. */
  backend: string;
  /** The shell's environment (names only are read for credentials). */
  env: Record<string, string | undefined>;
  /**
   * The target's own variable files, by name (`ENV_FILES`), as read through any symlink (a pnpm wt
   * worktree's `.env` points at the main checkout's), or null when absent. Read only for which
   * credential names they set; their values are never printed.
   */
  envFiles: Record<string, string | null>;
};

/**
 * Why the rehearsal must not run against `target`, or null when it may. Every refusal names what it
 * found, never a credential's value.
 */
export function rehearsalRefusal(target: string, facts: TargetFacts): string | null {
  if (!isAbsolute(target)) return `--worktree must be an absolute path, got ${target}`;
  if (facts.realPath === null) return `${target} does not exist`;
  const worktrees = join(facts.repoRoot, ".worktrees") + sep;
  if (facts.realPath === facts.repoRoot) return "--worktree names the main checkout; give the rehearsal its own pnpm wt worktree";
  if (!facts.realPath.startsWith(worktrees) || relative(worktrees, facts.realPath).includes(sep)) {
    return `${target} is not a worktree directly under ${worktrees} (make one with pnpm wt new)`;
  }
  if (facts.changes === null) return `git status failed in ${target}`;
  if (facts.changes !== "") return `${target} has uncommitted changes or untracked files:\n${facts.changes}`;
  const admin = adminUrlRefusal(facts.adminUrl);
  if (admin) return admin;
  if (facts.stack !== "not-running") return `${target}'s stack is ${facts.stack}; stop it first, so the one this rehearsal stops is its own`;
  if (facts.backend !== "not-running") return `${target}'s InferOps backend is ${facts.backend}; run pnpm local inferops down first`;
  const credentials = forbiddenCredentials(facts.env as NodeJS.ProcessEnv);
  if (credentials.length > 0) return `the shell holds ${credentials.join(", ")}; run from a clean shell (env -i PATH="$PATH" HOME="$HOME" bash)`;
  // The stack reads these files too, so a credential there reaches it whatever the shell holds.
  for (const [file, text] of Object.entries(facts.envFiles)) {
    if (text === null) continue;
    const named = forbiddenCredentials(envFileVariables(text) as NodeJS.ProcessEnv);
    if (named.length > 0) return `${target}/${file} sets ${named.join(", ")}; give the rehearsal a worktree whose ${file} holds no credential`;
  }
  return null;
}

/** The main checkout of this repository: the parent of git's common dir, real path. */
function repositoryRoot(): string {
  const common = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: ROOT, encoding: "utf8" });
  if (common.status !== 0) throw new Error(`git rev-parse --git-common-dir failed in ${ROOT}`);
  return realpathSync(dirname(common.stdout.trim()));
}

/** The variable files a target's stack reads, which must hold no credential (FAC-141). */
export const ENV_FILES = [".env", ".dev.vars", ".env.worktree"] as const;

/** `NAME=value` (or `export NAME=value`) lines of a dotenv file, by name; comments and blanks skipped. */
export function envFileVariables(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match) out[match[1]!] = match[2]!.replace(/^(["'])(.*)\1$/, "$2").trim();
  }
  return out;
}

/**
 * Why the Postgres admin URL must not be used, or null: it parses, its host is localhost, and no
 * `host=` or `hostaddr=` query parameter (which libpq honours over the URL's host) overrides it.
 * Names the host or the parameter, never the URL (it may hold a password).
 */
export function adminUrlRefusal(adminUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(adminUrl);
  } catch {
    return "the Postgres admin URL does not parse";
  }
  if (!LOCAL_HOSTS.has(url.hostname)) return `the Postgres host is ${url.hostname}; the rehearsal runs only against localhost`;
  const override = [...url.searchParams.keys()].find(key => /^host(?:addr)?$/i.test(key));
  if (override) return `the Postgres admin URL sets ${override}=, which would override localhost; remove it`;
  return null;
}

/**
 * Why the server behind the admin URL must not be touched, or null: its `system_identifier` must be
 * read, and equal the local Compose Postgres container's own. A localhost URL alone proves nothing:
 * a tunnel or proxy on localhost can reach any server.
 */
export function serverRefusal(server: string | null, compose: string | null): string | null {
  if (compose === null) return "the local Compose Postgres's system_identifier could not be read (is its container running? start it with the inferops Compose project's postgres service); the rehearsal runs only against it";
  if (server === null) return "the Postgres server's system_identifier could not be read over the admin URL; the rehearsal runs only against the local Compose Postgres";
  if (server !== compose) return "the Postgres server behind the admin URL is not the local Compose Postgres (another system_identifier); a tunnel or proxy to another server is refused";
  return null;
}

/**
 * The database this checkout's backend uses, or why there is none to trust: `inferos_<port>` for
 * the backend port the `pnpm wt` registry holds for `realPath` (exactly one entry of this
 * repository's), and only when the port the stack would really use (the shell, then
 * `.env.worktree`, which is gitignored and so may be edited without dirtying the tree) agrees.
 */
export function expectedDatabase(realPath: string, repoRoot: string, registry: Registry,
    env: Record<string, string | undefined>): { database: string } | { refusal: string } {
  const entries = registry.worktrees.filter(entry => realOrNull(entry.path) === realPath && realOrNull(entry.mainCheckout) === repoRoot);
  if (entries.length !== 1) {
    return { refusal: `${realPath} is ${entries.length === 0 ? "not in" : "listed more than once in"} the pnpm wt registry; give the rehearsal a worktree made with pnpm wt new` };
  }
  const registered = portLayout(entries[0]!.portBase).backend;
  let port: number;
  try {
    port = resolveLocalStack(realPath, [], withWorktreeEnv(realPath, env as NodeJS.ProcessEnv)).port;
  } catch {
    return { refusal: "the stack's port settings (VITE_BACKEND_HOST) do not parse" };
  }
  if (port !== registered) return { refusal: `the stack would run on port ${port}, but the pnpm wt registry holds ${registered} for this worktree; fix .env.worktree or the shell's VITE_BACKEND_HOST` };
  return { database: backendDatabase(registered) };
}

/**
 * The inferops Compose project's Postgres `system_identifier`, read inside its container, or why it
 * can't be trusted. The container is found by Compose itself, never named by the environment:
 * exactly one running container of the project's service, whose own project and service labels
 * say so. `docker` runs one docker command and returns its result.
 */
export function composeIdentity(docker: (argv: string[]) => RunResult): { id: string } | { refusal: string } {
  const ps = docker(["compose", "-p", INFEROPS_COMPOSE_PROJECT, "ps", "-q", INFEROPS_COMPOSE_SERVICE]);
  const ids = ps.code === 0 ? ps.stdout.split("\n").map(line => line.trim()).filter(Boolean) : [];
  if (ps.code !== 0 || ids.length === 0) return { refusal: `no running ${INFEROPS_COMPOSE_SERVICE} container in the ${INFEROPS_COMPOSE_PROJECT} Compose project; start the inferops Compose Postgres first` };
  if (ids.length > 1) return { refusal: `${ids.length} ${INFEROPS_COMPOSE_SERVICE} containers in the ${INFEROPS_COMPOSE_PROJECT} Compose project; the rehearsal needs exactly one` };
  const container = ids[0]!;
  if (!/^[0-9a-f]{12,64}$/.test(container)) return { refusal: "docker compose ps named no container id" };
  const inspect = docker(["inspect", "--format", "{{json .Config.Labels}}", container]);
  let labels: Record<string, string> = {};
  try {
    labels = inspect.code === 0 ? JSON.parse(inspect.stdout) ?? {} : {};
  } catch { /* unreadable labels are wrong labels */ }
  if (labels["com.docker.compose.project"] !== INFEROPS_COMPOSE_PROJECT || labels["com.docker.compose.service"] !== INFEROPS_COMPOSE_SERVICE) {
    return { refusal: `the container Compose named is not labelled ${INFEROPS_COMPOSE_PROJECT}/${INFEROPS_COMPOSE_SERVICE}` };
  }
  const read = docker(["exec", container, "psql", "-U", "postgres", "-At", "-c", IDENTITY_SQL]);
  const id = identity(read.code, read.stdout);
  return id === null ? { refusal: "the local Compose Postgres's system_identifier could not be read inside its container" } : { id };
}

/** Why `adminUrl` or `database` must not be touched, or null: a local admin URL, and only `expected`. */
export function databaseRefusal(adminUrl: string, database: string, expected: string): string | null {
  const admin = adminUrlRefusal(adminUrl);
  if (admin) return admin;
  if (!/^inferos_\d{1,5}$/.test(database)) return `refusing database ${database}: only a backend's own inferos_<port>`;
  if (database !== expected) return `refusing database ${database}: this run's backend uses ${expected}`;
  return null;
}

/** Every file under `dir` with its sha256, sorted by path: what "the state equals" compares. */
export function stateManifest(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) out[relative(dir, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  if (existsSync(dir)) walk(dir);
  return Object.fromEntries(Object.entries(out).toSorted(([a], [b]) => a.localeCompare(b)));
}

/** Whether two manifests are equal; when not, the paths that differ. */
export function manifestDifferences(a: Record<string, string>, b: Record<string, string>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(path => a[path] !== b[path]).toSorted();
}

type Step = { step: string; ok: boolean; detail?: unknown };

class RehearsalFailed extends Error {}

/** A command's result. */
export type RunResult = { code: number; stdout: string; stderr: string };

/** Every command the rehearsal runs goes through this, injected so the tests can spy on it. */
export type RehearsalIo = {
  /** The `--worktree` argument. */
  target: string;
  env: Record<string, string | undefined>;
  /** This repository's main checkout, real path. */
  repoRoot: string;
  /** A fresh directory for the archives and the stack logs. */
  work: string;
  /** Runs `argv` in the target and waits for it. */
  run(argv: string[], opts?: { extraEnv?: Record<string, string> }): RunResult;
  /** Starts `argv` in the target, detached, its output appended to `log`. */
  spawnDetached(argv: string[], log: string): void;
  wait(ms: number): Promise<void>;
  /** The connected server's `system_identifier`, read-only over `adminUrl`, or null when unreadable. */
  serverIdentity(adminUrl: string): string | null;
  /** Runs one `docker` command (its arguments after `docker`): only `composeIdentity`'s reads. */
  docker(argv: string[]): RunResult;
  /** The `pnpm wt` registry, read only. */
  registry(): Registry;
};

/** The rehearsal: the guards, then the six steps, then stopping what it started. Returns the report. */
export async function rehearse(io: RehearsalIo): Promise<Record<string, unknown>> {
  const { target, env, work, run } = io;
  const steps: Step[] = [];
  const report: Record<string, unknown> = { proof: "recovery-rehearsal", startedAt: new Date().toISOString(), steps };
  let failure: string | null = null;
  let startedStack = false;
  let startedBackend = false;
  const json = (argv: string[]) => {
    const r = run(argv);
    try {
      // pnpm may echo the script line before the JSON; the report is the last line that is an object.
      const line = r.stdout.split("\n").map(l => l.trim()).filter(l => l.startsWith("{")).at(-1) ?? r.stdout;
      return { code: r.code, report: JSON.parse(line) as Record<string, any>, stderr: r.stderr };
    } catch {
      return { code: r.code, report: null, stderr: r.stderr || r.stdout };
    }
  };
  // Stops the stack, then the backend; each is only this run's own (the guards refused anything
  // already running), and `down` never drops the database.
  const stopAll = () => {
    const stop = run(["pnpm", "-s", "local", "stop"]);
    const down = run(["pnpm", "-s", "local", "inferops", "down"]);
    return { stop: stop.code, down: down.code };
  };
  const record = (step: string, ok: boolean, detail?: unknown) => {
    steps.push({ step, ok, ...(detail === undefined ? {} : { detail }) });
    console.error(`${ok ? "✓" : "✗"} ${step}`);
    if (!ok) throw new RehearsalFailed(step);
  };

  try {
    // Guards, before anything starts: only reads run until they pass.
    const stack = json(["pnpm", "-s", "local", "status", "--json"]);
    const backend = json(["pnpm", "-s", "local", "inferops", "status", "--json"]);
    const facts: TargetFacts = {
      realPath: existsSync(target) ? realpathSync(target) : null,
      repoRoot: io.repoRoot,
      changes: target && existsSync(target) ? gitChanges(run(["git", "status", "--porcelain"])) : null,
      adminUrl: env.INFEROPS_PG_ADMIN_URL || DEFAULT_PG_ADMIN_URL,
      stack: String(stack.report?.stack ?? "unknown"),
      backend: String(backend.report?.backend ?? "unknown"),
      env,
      envFiles: Object.fromEntries(ENV_FILES.map(file => {
        const path = join(target, file);
        return [file, existsSync(path) ? readFileSync(path, "utf8") : null];
      })),
    };
    const refusal = rehearsalRefusal(target, facts);
    report.worktree = target;
    if (refusal) record(`guards: ${refusal}`, false);
    // The database this run may touch: the registry's port for this worktree, which the stack's own
    // port settings must agree with (never what `.env.worktree` alone or `up` reports).
    const derived = expectedDatabase(facts.realPath!, io.repoRoot, io.registry(), env);
    if ("refusal" in derived) record(`guards: ${derived.refusal}`, false);
    const expected = (derived as { database: string }).database;
    const named = databaseRefusal(facts.adminUrl, expected, expected);
    if (named) record(`guards: ${named}`, false);
    // The server, identified: connected read-only, before anything that writes, against the
    // container Compose itself names.
    const compose = composeIdentity(argv => io.docker(argv));
    if ("refusal" in compose) record(`guards: ${compose.refusal}`, false);
    const server = serverRefusal(io.serverIdentity(facts.adminUrl), (compose as { id: string }).id);
    if (server) record(`guards: ${server}`, false);
    record("guards: dedicated clean worktree, nothing running, no credentials, the local Compose Postgres", true);
    const head = run(["git", "rev-parse", "HEAD"]).stdout.trim();
    const stateDir = join(target, ".wrangler", "state");
    report.inferosRevision = head;

    // 1. Up, start, seed.
    const up = json(["pnpm", "-s", "local", "inferops", "up", "--json"]);
    startedBackend = up.report?.ok === true;
    record("inferops up", startedBackend, { apiUrl: up.report?.apiUrl, database: up.report?.database, revision: up.report?.revision });
    const database = String(up.report?.database);
    report.inferopsRevision = up.report?.revision;
    report.database = database;
    const admin = facts.adminUrl;
    const dbRefusal = databaseRefusal(admin, database, expected);
    if (dbRefusal) record(`guards: ${dbRefusal}`, false);
    const dbUrl = (() => { const u = new URL(admin); u.pathname = `/${database}`; u.search = "sslmode=disable"; return u; })();
    const pgEnv = { PGPASSWORD: decodeURIComponent(dbUrl.password) };
    const pgConn = ["-h", dbUrl.hostname, "-p", dbUrl.port || "5432", "-U", decodeURIComponent(dbUrl.username)];
    const issues = () => {
      const r = run(["psql", ...pgConn, "-d", database, "-At", "-F", "|", "-c",
        `SELECT identifier, head_seq, state_id FROM inferlab.project_issues WHERE workspace_id = '${ACME_OPS}' AND deleted_at IS NULL ORDER BY identifier`],
        { extraEnv: pgEnv });
      if (r.code !== 0) throw new RehearsalFailed(`psql: ${r.stderr.trim()}`);
      return Object.fromEntries(r.stdout.trim().split("\n").filter(Boolean).map(line => {
        const [identifier, headSeq, stateId] = line.split("|");
        return [identifier!, { headSeq: Number(headSeq), stateId: stateId! }];
      }));
    };
    const fingerprint = () => {
      const r = run(["psql", ...pgConn, "-d", database, "-At", "-c",
        `SELECT md5(string_agg(t::text, E'\\n' ORDER BY t::text)) FROM inferlab.project_issues t WHERE workspace_id = '${ACME_OPS}'`],
        { extraEnv: pgEnv });
      return r.stdout.trim();
    };

    const startStack = async () => {
      io.spawnDetached(["pnpm", "local", "start", "--inferops", "--stopgap", "--", "--no-ui-watchers"], join(work, `stack-${steps.length}.log`));
      startedStack = true;
      for (let i = 0; i < 120; i++) {
        await io.wait(2_000);
        const s = json(["pnpm", "-s", "local", "status", "--json"]);
        if (s.report?.stack === "running" && s.report?.ok === true) return;
      }
      throw new RehearsalFailed("the stack did not come up within 240 s");
    };
    const upAgain = async () => {
      const again = json(["pnpm", "-s", "local", "inferops", "up", "--json"]);
      if (again.report?.ok !== true || again.report?.database !== database) throw new RehearsalFailed(`inferops up again: ${again.stderr}`);
      startedBackend = true;
      await startStack();
    };
    const operate = (verb: "pending" | "approve" | "all") => {
      const r = json(["node", join(ROOT, "scripts", "proof", "rehearsal-operator.ts"), verb, "--url", String(stack.report?.url)]);
      if (r.code !== 0 || !r.report) throw new RehearsalFailed(`operator ${verb}: ${r.stderr.trim()}`);
      return r.report;
    };
    const archive = (name: string) => {
      const file = join(work, `${name}.tgz`);
      const r = run(["tar", "-C", target, "-czf", file, ".wrangler/state"]);
      if (r.code !== 0) throw new RehearsalFailed(`tar ${name}: ${r.stderr}`);
      return file;
    };
    const unarchive = (file: string) => {
      const reset = run(["pnpm", "-s", "local", "reset", "--yes"]);
      if (reset.code !== 0) throw new RehearsalFailed(`reset: ${reset.stderr || reset.stdout}`);
      const r = run(["tar", "-C", target, "-xzf", file]);
      if (r.code !== 0) throw new RehearsalFailed(`untar: ${r.stderr}`);
    };
    const dump = (name: string) => {
      const file = join(work, `${name}.dump`);
      const r = run(["pg_dump", ...pgConn, "-d", database, "-Fc", "-f", file], { extraEnv: pgEnv });
      if (r.code !== 0) throw new RehearsalFailed(`pg_dump: ${r.stderr}`);
      return file;
    };
    const restoreDb = (file: string) => {
      const r = run(["pg_restore", ...pgConn, "-d", database, "--clean", "--if-exists", "--exit-on-error", file], { extraEnv: pgEnv });
      if (r.code !== 0) throw new RehearsalFailed(`pg_restore: ${r.stderr}`);
    };

    await startStack();
    const seeded = json(["pnpm", "-s", "local", "seed", "--approval", "--json"]);
    record("seed: a pending move on the ENG board", seeded.report?.ok === true && Number(seeded.report?.verify?.agentView?.approvalQueue?.pending) >= 1,
      seeded.report?.verify?.agentView ?? seeded.stderr);
    const pendingA = operate("pending");
    record("one pending move held in the gatekeeper", Array.isArray(pendingA.pending) && pendingA.pending.length >= 1, pendingA);

    // 2. Pair A, quiesced.
    report.stopsA = stopAll(); startedStack = false; startedBackend = false;
    const issuesA = issues();
    const printA = fingerprint();
    const manifestA = stateManifest(stateDir);
    const dumpA = dump("pair-a");
    const stateA = archive("pair-a-state");
    record("pair A taken with both stopped", true, { files: Object.keys(manifestA).length, takenAt: new Date().toISOString() });

    // 3. Approve, then state B (newer).
    await upAgain();
    const approved = operate("approve");
    const issuesAfter = issues();
    const moved = Object.keys(issuesA).filter(id => issuesA[id]!.headSeq !== issuesAfter[id]?.headSeq);
    record("the approval applies in InferOps: one issue moves", approved.applied === true && moved.length === 1,
      { approved, moved });
    const movedIssue = moved[0]!;
    report.stopsB = stopAll(); startedStack = false; startedBackend = false;
    const stateB = archive("state-b");

    // 4. Joint restore of pair A.
    restoreDb(dumpA);
    unarchive(stateA);
    record("joint restore: the database equals pair A", fingerprint() === printA);
    record("joint restore: the state equals pair A", manifestDifferences(manifestA, stateManifest(stateDir)).length === 0,
      manifestDifferences(manifestA, stateManifest(stateDir)));
    await upAgain();
    const pendingAgain = operate("pending");
    record("joint restore: the move is pending again", pendingAgain.pending.length === pendingA.pending.length, pendingAgain);

    // 5. Skew 1: InferOS older than InferOps.
    const first = operate("approve");
    record("skew 1: the approval applies", first.applied === true);
    report.stopsSkew1 = stopAll(); startedStack = false; startedBackend = false;
    unarchive(stateA);
    await upAgain();
    const replay = operate("approve");
    const issuesSkew1 = issues();
    record("skew 1: the replayed approval is refused", replay.applied === false, replay);
    record("skew 1: the issue moved exactly once", issuesSkew1[movedIssue]!.headSeq === issuesAfter[movedIssue]!.headSeq,
      { before: issuesA[movedIssue], once: issuesAfter[movedIssue], now: issuesSkew1[movedIssue] });

    // 6. Skew 2: InferOS newer than InferOps.
    report.stopsSkew2 = stopAll(); startedStack = false; startedBackend = false;
    restoreDb(dumpA);
    unarchive(stateB);
    await upAgain();
    const verify = json(["pnpm", "-s", "local", "verify", "--board", ENG_BOARD, "--json"]);
    record("skew 2: InferOS reads the board InferOps holds", verify.report?.ok === true, verify.report?.agentView ?? verify.stderr);
    const all = operate("all");
    record("skew 2: InferOS writes nothing back", fingerprint() === printA && issues()[movedIssue]!.headSeq === issuesA[movedIssue]!.headSeq,
      { issue: issues()[movedIssue], actions: all });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    // Only what this run started: when the guards refused, nothing of the target's is touched.
    const stopped = startedStack || startedBackend ? stopAll() : null;
    const after = stopped === null ? { stack: "not started", backend: "not started" } : {
      stack: json(["pnpm", "-s", "local", "status", "--json"]).report?.stack,
      backend: json(["pnpm", "-s", "local", "inferops", "status", "--json"]).report?.backend,
    };
    report.stopped = { ...stopped, ...after, startedStack, startedBackend,
      bothStopped: stopped === null || (after.stack === "not-running" && after.backend === "not-running") };
    if (!(report.stopped as { bothStopped: boolean }).bothStopped) failure ??= "the stack or the backend did not stop";
    report.finishedAt = new Date().toISOString();
    report.ok = failure === null;
    report.failure = failure;
    report.archives = work;
    // The archives are copies of seeded local data; keep them only for a failing run's inspection.
    if (failure === null) for (const name of readdirSync(work)) if (/\.(dump|tgz)$/.test(name)) rmSync(join(work, name));
  }
  return report;
}

/** The read-only query naming a Postgres cluster: its `system_identifier`, fixed at initdb. */
const IDENTITY_SQL = "SELECT system_identifier FROM pg_control_system()";

/** `path`'s real path, or null when it doesn't resolve. */
function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** A `system_identifier` from a successful read, or null: anything else is never taken as one. */
function identity(status: number | null, stdout: string | null): string | null {
  const id = (stdout ?? "").trim();
  return status === 0 && /^\d{6,24}$/.test(id) ? id : null;
}

/** `git status --porcelain`'s output, trimmed, or null when git failed (a failure is never "clean"). */
function gitChanges(r: RunResult): string | null {
  return r.code === 0 ? r.stdout.trim() : null;
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { worktree: { type: "string" }, report: { type: "string" } } });
  const work = mkdtempSync(join(tmpdir(), "fac141-rehearsal-"));
  const reportPath = values.report ?? join(work, "rehearsal-report.json");
  mkdirSync(dirname(resolve(reportPath)), { recursive: true });
  const target = values.worktree ?? "";
  const env = { ...process.env };
  const report = await rehearse({
    target, env, work,
    // The repository's main checkout, from git's common dir, so the guard holds whether this script
    // runs from the main checkout or from another worktree.
    repoRoot: repositoryRoot(),
    run: (argv, opts = {}) => {
      const r = spawnSync(argv[0]!, argv.slice(1), { cwd: target, env: { ...env, ...opts.extraEnv }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    spawnDetached: (argv, logPath) => {
      const log = openSync(logPath, "a");
      spawn(argv[0]!, argv.slice(1), { cwd: target, env, stdio: ["ignore", log, log], detached: true }).unref();
    },
    wait: ms => new Promise(ok => setTimeout(ok, ms)),
    serverIdentity: adminUrl => {
      const url = new URL(adminUrl);
      const r = spawnSync("psql", ["-h", url.hostname, "-p", url.port || "5432", "-U", decodeURIComponent(url.username), "-d", url.pathname.slice(1) || "postgres",
        "-At", "-c", IDENTITY_SQL], { env: { PATH: env.PATH, HOME: env.HOME, PGPASSWORD: decodeURIComponent(url.password), PGCONNECT_TIMEOUT: "5" }, encoding: "utf8" });
      return identity(r.status, r.stdout);
    },
    docker: argv => {
      // Only PATH and HOME: no DOCKER_HOST or DOCKER_CONTEXT from the shell picks another daemon.
      const r = spawnSync("docker", argv, { env: { PATH: env.PATH, HOME: env.HOME }, encoding: "utf8" });
      return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    // The registry pnpm wt keeps under the person's home, never one an XDG_CONFIG_HOME points at.
    registry: () => readRegistry(registryPath({}, homedir())),
  });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  return report.ok === true ? 0 : 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
