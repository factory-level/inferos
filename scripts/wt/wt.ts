#!/usr/bin/env node

// `pnpm wt` -- shared infrastructure for parallel worktrees of this repo, so several agents (or one
// person) can each run a checkout with its own dev server and builds without stepping on the others.
//
//   pnpm wt new <name> [--from <ref>] [--branch <b>]   create <main>/.worktrees/<name>, ready to run
//               [--no-cache-seed | --seed-from <dir>]  (vp cache: skip seeding, or seed from another checkout)
//   pnpm wt ls                                          registered worktrees: branch, ports, state
//   pnpm wt rm <name> [--force]                         remove one (refuses unpushed/uncommitted work)
//   pnpm wt ports                                       the port table
//   pnpm wt doctor [--fix]                              registry drift, secrets links, cache hits
//
// Worktrees live inside the main checkout's ignored `.worktrees/`, never as siblings, so nothing
// that cleans up sibling directories reaches them; `wt rm` is the supported way to remove one.
// State that must be machine-wide (who holds which ports) is in the per-user registry
// (registry.ts); everything a worktree's own tools need is in its `.env.worktree` overlay
// (../worktree-env.ts). See docs/wiki/local-development.md.

import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { DEV_PREFLIGHT_VP_BUILDS } from "../dev-server-config.ts";
import { isPortListening } from "../local/stack.ts";
import { pnpmCommand } from "../pnpm-command.ts";
import { defaultConcurrencyLimit, measureMachine, splitConcurrencyLimit, VP_RUN_CONCURRENCY_LIMIT } from "../vp/concurrency.ts";
import { readWorktreeEnv, REPO_ROOT, WORKTREE_ENV_FILE } from "../worktree-env.ts";
import { parseVpStatistics, seedTaskCache, taskCacheDir, type VpStatistics } from "./cache.ts";
import {
  allocatePortBlock, concurrencyShare, LINKED_SECRET_FILES, overlayContents, portLayout, validWorktreeName,
} from "./layout.ts";
import { readRegistry, registryPath, updateRegistry, type Registry, type WorktreeEntry } from "./registry.ts";

const USAGE = `Usage: pnpm wt <command>
  new <name> [--from <ref>] [--branch <b>] [--no-cache-seed | --seed-from <checkout>]
                                            Create .worktrees/<name> (default: --from origin/main, --branch <name>,
                                            vp cache seeded from the main checkout)
  ls                                        List registered worktrees
  rm <name> [--force]                       Remove a worktree; --force discards uncommitted/unpushed work
  ports                                     Show the port table
  doctor [--fix]                            Check registry, secrets links and the vp cache; --fix prunes stale entries`;

class UsageError extends Error {}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** The main checkout: the directory holding the `.git` every worktree of this repo shares. */
function mainCheckout(): string {
  const common = git(REPO_ROOT, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (basename(common) !== ".git") throw new Error(`Unsupported repository layout: ${common} is not a .git directory.`);
  return dirname(common);
}

interface GitWorktree { path: string; branch: string | null }

function gitWorktrees(main: string): GitWorktree[] {
  const result: GitWorktree[] = [];
  for (const block of git(main, ["worktree", "list", "--porcelain"]).split("\n\n")) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    if (!path) continue;
    result.push({ path, branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null });
  }
  return result;
}

/** Live git state of a worktree directory. */
interface WorktreeState {
  exists: boolean;
  branch?: string;
  /** Uncommitted changes, ignored files excluded. */
  dirty?: boolean;
  /** Commits reachable from HEAD that no remote-tracking ref has. */
  unpushed?: number;
}

function worktreeState(path: string): WorktreeState {
  if (!existsSync(join(path, ".git"))) return { exists: false };
  return {
    exists: true,
    branch: git(path, ["branch", "--show-current"]) || "(detached)",
    dirty: git(path, ["status", "--porcelain"]) !== "",
    unpushed: Number(git(path, ["rev-list", "--count", "HEAD", "--not", "--remotes"])),
  };
}

// ---------------------------------------------------------------------------
// overlays and secrets
// ---------------------------------------------------------------------------

/** This machine's whole `vp run` budget, before it is shared out (vp/concurrency.ts). */
function machineConcurrency(): number {
  const { cpus, memoryBytes } = measureMachine();
  return defaultConcurrencyLimit(cpus, memoryBytes);
}

/**
 * Rewrite every registered worktree's overlay, so the concurrency share follows the number of
 * worktrees. Ports never change once allocated.
 */
function writeOverlays(registry: Registry): void {
  const share = concurrencyShare(machineConcurrency(), registry.worktrees.length);
  for (const entry of registry.worktrees) {
    if (!existsSync(entry.path)) continue;
    writeFileSync(join(entry.path, WORKTREE_ENV_FILE), overlayContents(entry, share));
  }
}

/** Whether git ignores `path` in the checkout at `root`: secrets must never be stageable. */
function gitIgnores(root: string, path: string): boolean {
  try {
    git(root, ["check-ignore", "-q", "--no-index", path]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Make sure git ignores the overlay even on a branch whose `.gitignore` predates it, through the
 * shared `info/exclude`, so `wt rm`'s uncommitted-changes check never trips over it.
 */
function ensureOverlayExcluded(main: string, worktree: string): void {
  if (gitIgnores(worktree, WORKTREE_ENV_FILE)) return;
  const exclude = join(main, ".git", "info", "exclude");
  mkdirSync(dirname(exclude), { recursive: true });
  appendFileSync(exclude, `\n# pnpm wt (scripts/wt/wt.ts)\n${WORKTREE_ENV_FILE}\n`);
}

interface LinkResult { file: string; state: "linked" | "absent-in-main" | "exists" | "not-ignored" }

function linkSecrets(main: string, worktree: string): LinkResult[] {
  return LINKED_SECRET_FILES.map((file): LinkResult => {
    const target = join(main, file);
    const link = join(worktree, file);
    if (!existsSync(target)) return { file, state: "absent-in-main" };
    if (!gitIgnores(worktree, file)) return { file, state: "not-ignored" };
    try {
      lstatSync(link);
      return { file, state: "exists" };
    } catch {
      // Absolute target: a relative one would break if the worktree moved within the main checkout.
      symlinkSync(target, link);
      return { file, state: "linked" };
    }
  });
}

// ---------------------------------------------------------------------------
// builds
// ---------------------------------------------------------------------------

/** Run `pnpm <args>` in `cwd`, streaming its output, and return what it printed. */
function runPnpm(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
  const [command, argv] = pnpmCommand([...args]);
  return runCommand(cwd, command, argv, env, `pnpm ${args.join(" ")}`);
}

function runCommand(cwd: string, command: string, argv: string[], env: NodeJS.ProcessEnv, label: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; process.stdout.write(chunk); });
    child.stderr.on("data", chunk => { output += chunk; process.stderr.write(chunk); });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolvePromise(output) : reject(new Error(`${label} failed (exit ${code})`)));
  });
}

/** The cache counts of the last `vp run` in `cwd`, from `vp run --last-details`. */
function lastRunStatistics(cwd: string): VpStatistics | null {
  const [command, argv] = pnpmCommand(["exec", "vp", "run", "--last-details"]);
  try {
    return parseVpStatistics(execFileSync(command, argv, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch {
    return null;
  }
}

/** One timed step of `wt new`, for the closing summary. */
interface Step { label: string; ms: number; note?: string }

async function timed<T>(steps: Step[], label: string, fn: () => T | Promise<T>, note?: (result: T) => string | undefined): Promise<T> {
  console.log(`\n==> ${label}`);
  const start = performance.now();
  const result = await fn();
  steps.push({ label, ms: performance.now() - start, note: note?.(result) });
  return result;
}

const formatStats = (stats: VpStatistics | null) => stats ? `${stats.hits}/${stats.tasks} cache hits` : "no vp summary";

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function commandNew(
  name: string, options: { from: string; branch: string; seedCache: boolean; seedFrom: string | undefined },
): Promise<void> {
  if (!validWorktreeName(name)) throw new UsageError(`Invalid worktree name "${name}": use letters, digits, ".", "_" and "-".`);
  const started = performance.now();
  const main = mainCheckout();
  const path = join(main, ".worktrees", name);
  const regPath = registryPath();
  if (existsSync(path)) throw new Error(`${path} already exists.`);
  if (readRegistry(regPath).worktrees.some(entry => entry.path === path)) {
    throw new Error(`${name} is still registered; run pnpm wt doctor --fix first.`);
  }
  const steps: Step[] = [];

  await timed(steps, `git worktree add ${relative(main, path)} (${options.branch} from ${options.from})`, () => {
    const remote = /^origin\/(.+)$/.exec(options.from)?.[1];
    if (remote) git(main, ["fetch", "--quiet", "origin", remote]);
    const branchExists = (() => {
      try {
        git(main, ["show-ref", "--verify", "--quiet", `refs/heads/${options.branch}`]);
        return true;
      } catch {
        return false;
      }
    })();
    git(main, branchExists
      ? ["worktree", "add", path, options.branch]
      : ["worktree", "add", "--no-track", "-b", options.branch, path, options.from]);
  });

  // Registered straight after the directory exists, so a concurrent `wt new` cannot pick the same
  // ports while this one is still installing.
  ensureOverlayExcluded(main, path);
  const entry = await timed(steps, "allocate ports and write .env.worktree", () => updateRegistry(regPath, async registry => {
    const created: WorktreeEntry = {
      name, path, mainCheckout: main, branch: options.branch,
      portBase: await allocatePortBlock(registry.worktrees.map(({ portBase }) => portBase), port => isPortListening(port, "127.0.0.1", 300)),
      createdAt: new Date().toISOString(),
    };
    registry.worktrees.push(created);
    writeOverlays(registry);
    return created;
  }), created => `ports ${created.portBase}-${created.portBase + 9}`);

  const links = await timed(steps, "link secrets from the main checkout", () => linkSecrets(main, path),
    results => results.map(({ file, state }) => `${file}: ${state}`).join(", "));
  for (const { file, state } of links) {
    if (state === "not-ignored") console.warn(`warning: ${file} is not gitignored in this branch, so it was not linked.`);
  }

  await timed(steps, "pnpm install --frozen-lockfile", () => runPnpm(path, ["install", "--frozen-lockfile"], process.env));

  const seed = options.seedCache
    ? await timed(steps, `seed the vp task cache from ${options.seedFrom ? relative(main, resolve(options.seedFrom)) || "." : "the main checkout"}`,
      () => seedTaskCache(options.seedFrom ? resolve(options.seedFrom) : main, path),
      result => result.seeded ? `${result.files} files` : `skipped: ${result.reason}`)
    : { seeded: false, reason: "--no-cache-seed", files: 0 };

  // The worktree's own share of the machine, unless the shell already set one.
  const share = readWorktreeEnv(path)[VP_RUN_CONCURRENCY_LIMIT];
  const buildEnv: NodeJS.ProcessEnv = { ...process.env };
  if (buildEnv[VP_RUN_CONCURRENCY_LIMIT] === undefined && share !== undefined) buildEnv[VP_RUN_CONCURRENCY_LIMIT] = share;

  // One task prints no summary on a miss, so the counts come from `--last-details`.
  await timed(steps, "build @gadgets/typed-storage", async () => {
    await runPnpm(path, ["exec", "vp", "run", "--cache", "@gadgets/typed-storage#build"], buildEnv);
    return lastRunStatistics(path);
  }, formatStats);

  // The dev server's own pre-flight (dev-server-config.ts), plus the bundled blueprints it generates
  // first, so `pnpm dev-server` in the new worktree starts from warm outputs.
  const preflightEnv = splitConcurrencyLimit(buildEnv, DEV_PREFLIGHT_VP_BUILDS.length);
  await timed(steps, "dev-server pre-flight builds", async () => {
    const outputs = await Promise.all([
      runCommand(join(path, "packages", "workshop-backend"), process.execPath,
        [join(path, "packages", "workshop-backend", "scripts", "build-bundled-blueprints.ts")], buildEnv, "bundled blueprints"),
      ...DEV_PREFLIGHT_VP_BUILDS.map(({ args }) => runPnpm(path, args, preflightEnv)),
    ]);
    return outputs.slice(1).map(parseVpStatistics);
  }, stats => DEV_PREFLIGHT_VP_BUILDS.map(({ label }, i) => `${label}: ${formatStats(stats[i] ?? null)}`).join("; "));

  const ports = portLayout(entry.portBase);
  const total = (performance.now() - started) / 1000;
  console.log(`\nWorktree ${name} ready in ${total.toFixed(1)}s`);
  for (const step of steps) console.log(`  ${(step.ms / 1000).toFixed(1).padStart(6)}s  ${step.label}${step.note ? ` (${step.note})` : ""}`);
  console.log(`
  path      ${path}
  branch    ${options.branch}
  backend   http://localhost:${ports.backend}   (pnpm dev-server)
  frontend  http://localhost:${ports.devClient}   (pnpm dev-client)
  spare     ${ports.spare[0]}-${ports.spare[1]}
  vp cache  ${seed.seeded ? `seeded (${seed.files} files)` : `not seeded (${seed.reason})`}

  cd ${path}`);
}

async function commandLs(): Promise<void> {
  const main = mainCheckout();
  const entries = readRegistry(registryPath()).worktrees.filter(entry => entry.mainCheckout === main);
  if (!entries.length) {
    console.log("No registered worktrees. Create one with: pnpm wt new <name>");
    return;
  }
  const rows = entries.map(entry => {
    const state = worktreeState(entry.path);
    const ports = portLayout(entry.portBase);
    return [
      entry.name,
      state.exists ? state.branch! : "(missing)",
      `${ports.backend}/${ports.devClient}`,
      !state.exists ? "-" : [state.dirty ? "dirty" : "clean", state.unpushed ? `${state.unpushed} unpushed` : ""].filter(Boolean).join(", "),
    ];
  });
  printTable(["NAME", "BRANCH", "BACKEND/VITE", "STATE"], rows);
}

async function commandRm(name: string, force: boolean): Promise<void> {
  const main = mainCheckout();
  const regPath = registryPath();
  const entry = readRegistry(regPath).worktrees.find(candidate => candidate.mainCheckout === main && candidate.name === name);
  const path = entry?.path ?? join(main, ".worktrees", name);
  if (!entry && !existsSync(path)) throw new Error(`No worktree named ${name}.`);
  const state = worktreeState(path);
  if (state.exists && !force) {
    const problems = [state.dirty ? "uncommitted changes" : "", state.unpushed ? `${state.unpushed} unpushed commit(s)` : ""].filter(Boolean);
    if (problems.length) throw new Error(`Refusing to remove ${name}: ${problems.join(" and ")}. Push or commit first, or pass --force to discard.`);
  }
  if (resolve(path) === resolve(REPO_ROOT)) throw new Error(`Run pnpm wt rm ${name} from another checkout; this command runs from inside it.`);
  if (state.exists) git(main, ["worktree", "remove", ...(force ? ["--force"] : []), path]);
  // node_modules and other ignored files keep the directory alive after `git worktree remove` only
  // when git refused; on success it is gone.
  await updateRegistry(regPath, registry => {
    registry.worktrees = registry.worktrees.filter(candidate => candidate.path !== path);
    writeOverlays(registry);
  });
  console.log(`Removed ${name}${entry ? ` and freed ports ${entry.portBase}-${entry.portBase + 9}` : ""}.`);
}

async function commandPorts(): Promise<void> {
  const entries = readRegistry(registryPath()).worktrees.toSorted((a, b) => a.portBase - b.portBase);
  if (!entries.length) {
    console.log("No ports allocated.");
    return;
  }
  const rows = await Promise.all(entries.map(async entry => {
    const ports = portLayout(entry.portBase);
    const [backendUp, viteUp] = await Promise.all([ports.backend, ports.devClient].map(port => isPortListening(port, "127.0.0.1", 300)));
    return [
      entry.name, String(ports.backend), String(ports.devClient), `${ports.spare[0]}-${ports.spare[1]}`,
      [backendUp ? "backend up" : "", viteUp ? "vite up" : ""].filter(Boolean).join(", ") || "idle",
      relative(process.cwd(), entry.path) || ".",
    ];
  }));
  printTable(["NAME", "BACKEND", "VITE", "SPARE", "LISTENING", "PATH"], rows);
}

async function commandDoctor(fix: boolean): Promise<number> {
  const main = mainCheckout();
  const regPath = registryPath();
  const registry = readRegistry(regPath);
  const ours = registry.worktrees.filter(entry => entry.mainCheckout === main);
  const gitPaths = new Set(gitWorktrees(main).map(({ path }) => path));
  let problems = 0;
  const report = (level: "ok" | "warn" | "error", message: string) => {
    if (level === "error") problems++;
    console.log(`${level === "ok" ? "  ok  " : level === "warn" ? " warn " : "ERROR "} ${message}`);
  };

  console.log(`registry: ${regPath}`);
  // Registry vs git.
  const stale = ours.filter(entry => !gitPaths.has(entry.path) || !existsSync(entry.path));
  for (const entry of stale) report(fix ? "warn" : "error", `${entry.name}: registered (ports ${entry.portBase}-${entry.portBase + 9}) but ${entry.path} is not a git worktree${fix ? " -- pruned" : "; pnpm wt doctor --fix prunes it"}`);
  const worktreesDir = join(main, ".worktrees");
  for (const path of gitPaths) {
    if (dirname(path) === worktreesDir && !ours.some(entry => entry.path === path)) {
      report("warn", `${relative(main, path)}: a git worktree that pnpm wt did not create; it has no ports or overlay`);
    }
  }
  // Port clashes between entries (machine-wide, across clones).
  const byBase = new Map<number, WorktreeEntry[]>();
  for (const entry of registry.worktrees) byBase.set(entry.portBase, [...byBase.get(entry.portBase) ?? [], entry]);
  for (const [base, entries] of byBase) {
    if (entries.length > 1) report("error", `port block ${base} is allocated to ${entries.map(({ name }) => name).join(" and ")}`);
  }

  const live = ours.filter(entry => !stale.includes(entry));
  for (const entry of live) {
    // Overlay agrees with the registry.
    const overlay = readWorktreeEnv(entry.path);
    const expected = `localhost:${portLayout(entry.portBase).backend}`;
    if (overlay.VITE_BACKEND_HOST !== expected) report("error", `${entry.name}: ${WORKTREE_ENV_FILE} names ${overlay.VITE_BACKEND_HOST ?? "no backend"}, registry says ${expected}`);
    else report("ok", `${entry.name}: ${WORKTREE_ENV_FILE} matches ports ${entry.portBase}-${entry.portBase + 9}`);
    // Secrets links.
    for (const file of LINKED_SECRET_FILES) {
      const target = join(main, file);
      const link = join(entry.path, file);
      if (!existsSync(target)) continue;
      let linkTarget: string | null = null;
      try {
        linkTarget = lstatSync(link).isSymbolicLink() ? readlinkSync(link) : "(regular file)";
      } catch {
        linkTarget = null;
      }
      if (linkTarget === null) report("error", `${entry.name}: ${file} is missing (main checkout has one); recreate with ln -s ${target} ${link}`);
      else if (resolve(dirname(link), linkTarget) !== target) report("warn", `${entry.name}: ${file} is ${linkTarget}, not a link to ${target}`);
      else report("ok", `${entry.name}: ${file} -> main checkout`);
    }
  }
  for (const file of LINKED_SECRET_FILES) {
    const target = join(main, file);
    if (existsSync(target) && (statSync(target).mode & 0o077)) {
      report("warn", `${target} is readable by other users (mode ${(statSync(target).mode & 0o777).toString(8)}); chmod 600 it`);
    }
  }

  // vp cache: run one cheap cached task in each live worktree and report hit or miss.
  for (const entry of live) {
    if (!existsSync(taskCacheDir(entry.path))) {
      report("warn", `${entry.name}: no vp task cache yet`);
      continue;
    }
    try {
      const [command, argv] = pnpmCommand(["exec", "vp", "run", "--cache", "@gadgets/typed-storage#build"]);
      execFileSync(command, argv, { cwd: entry.path, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      const stats = lastRunStatistics(entry.path);
      if (stats && stats.hits === stats.tasks) report("ok", `${entry.name}: vp cache hit (@gadgets/typed-storage#build)`);
      else report("warn", `${entry.name}: vp cache miss on @gadgets/typed-storage#build (${formatStats(stats)}); vp run --last-details says why`);
    } catch (error) {
      report("error", `${entry.name}: vp run failed: ${(error as Error).message.split("\n")[0]}`);
    }
  }

  if (fix && stale.length) {
    await updateRegistry(regPath, current => {
      current.worktrees = current.worktrees.filter(entry => !stale.some(gone => gone.path === entry.path));
      writeOverlays(current);
    });
  }
  console.log(problems ? `\n${problems} problem(s).` : "\nNo problems.");
  return problems ? 1 : 0;
}

function printTable(header: string[], rows: string[][]): void {
  const widths = header.map((cell, i) => Math.max(cell.length, ...rows.map(row => row[i]!.length)));
  for (const row of [header, ...rows]) console.log(row.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd());
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

export async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      from: { type: "string" },
      branch: { type: "string" },
      force: { type: "boolean", default: false },
      fix: { type: "boolean", default: false },
      "no-cache-seed": { type: "boolean", default: false },
      "seed-from": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, name, ...extra] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return command || values.help ? 0 : 2;
  }
  const needsName = command === "new" || command === "rm";
  if (needsName ? !name || extra.length : name !== undefined) throw new UsageError(USAGE);
  switch (command) {
    case "new":
      await commandNew(name!, { from: values.from ?? "origin/main", branch: values.branch ?? name!, seedCache: !values["no-cache-seed"], seedFrom: values["seed-from"] });
      return 0;
    case "ls": await commandLs(); return 0;
    case "rm": await commandRm(name!, values.force); return 0;
    case "ports": await commandPorts(); return 0;
    case "doctor": return commandDoctor(values.fix);
    default: throw new UsageError(USAGE);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof UsageError || (error as NodeJS.ErrnoException).code === "ERR_PARSE_ARGS_UNKNOWN_OPTION"
      ? (error as Error).message : `wt: ${(error as Error).message}`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
