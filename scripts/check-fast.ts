#!/usr/bin/env node

// `pnpm check:fast [--base <ref> | --uncommitted] [--dry-run] [paths…]`: the per-change check for
// the inner loop (AGENTS.md, "Iteration loop").
//
// It checks only what the change can affect, and says so whenever it checks less. The changed files
// are the branch's diff from its merge-base with `origin/main` (`--base <ref>` overrides it; a base
// that cannot be resolved is an error, never a silent "nothing changed"), plus staged, unstaged and
// untracked files. `--uncommitted` asks for the working-tree changes against HEAD alone. Explicit
// paths replace both, and a directory stands for every file in it. Renames are listed as a deletion
// plus an addition (`--no-renames`), so the old path's package is checked too.
//
//   - A file in a workspace package type-checks that package with the same `vp run … build` task
//     `pnpm lint` (`types:check` → `pnpm build`) runs for every package. Its tests run under each
//     `vitest run` in the package's `test:run` script, with the same arguments, after that script's
//     other `&&` segments (workshop-backend's codegen, integration-tests' prebuild):
//       * changed test files run directly;
//       * other changed files run `vitest related`, and a config for which that finds no test runs in
//         full -- a fixture, a Worker `main` or a file read at runtime has no static import edge, so
//         "no related tests" says nothing about whether the change is safe;
//       * a deleted non-test file, or a changed vitest/Vite config, runs every config in full,
//         because nothing can be related to a file that is gone or to the config itself.
//     A package with tests but no vitest `test:run` gets the type-check only and is listed as such.
//   - Any `scripts/**` file runs every `scripts/` `node --test` suite (they are workspace-wide guards
//     and take seconds), plus `pnpm types:scripts` for TypeScript.
//   - `env.d.ts` files and the generated configuration reference also run
//     `scripts/consumer/settings.test.ts`, which fails when that reference is stale.
//   - A file under `docs/` runs `pnpm docs:check`, and so does a package's own docs file (see
//     `isPackageDoc`), which is never a source change and so never runs a config in full.
//
// Anything else (root configs, the lockfile, skills) is listed as not checked, as is a test file no
// config ran, a deleted test suite and a package with no `build` task. The footer always names what
// this never covers: dependent packages and full suites, which are `pnpm check:full` (check-full.ts)
// before hand-off, then CI.
//
// Packages run in parallel, and within one package its prelude runs before its checks, which then
// run in parallel. The codegen steps a prelude and the type-check both run write only when their
// output changed, so the second writer never truncates a file a running check is reading. The
// type-checks share one `vp run` concurrency budget (vp/concurrency.ts) rather than each taking it.
//
// `--dry-run` prints the plan without running it.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { resolveBinEntry } from "./bin-entry.ts";
import { mapConcurrent } from "./map-concurrent.ts";
import { pnpmCommand } from "./pnpm-command.ts";
import { vpRunEnv } from "./vp/concurrency.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** One command to run, with what the summary calls it. */
export interface Step {
  label: string;
  command: string;
  args: string[];
  cwd: string;
  /** Run through a shell: a `test:run` segment, which pnpm would also hand to one. */
  shell?: boolean;
  /** A `vp run` whose concurrency comes out of the run's shared budget. */
  vp?: boolean;
  /** Output meaning "nothing to do here" rather than failure, and the note that replaces it. */
  skip?: { when: RegExp; note: string };
  /** For `vitest related`: what runs instead when it finds no test file. */
  fallback?: Step;
  /** For a run of changed test files: they count as checked only if some such run found a file. */
  countsTestFiles?: boolean;
}

/** Steps that share a prelude: one package, or the repo-level checks. */
export interface Group {
  name: string;
  prelude: Step[];
  checks: Step[];
  /** Changed test files to report as not checked if none of the `countsTestFiles` steps ran one. */
  testFiles?: string[];
}

/** A changed file no check here covers, and why. */
export interface Unchecked {
  file: string;
  reason: string;
}

export interface Plan {
  groups: Group[];
  unchecked: Unchecked[];
}

/** A workspace package: its directory relative to the repo root, name and test setup. */
export interface WorkspacePackage {
  dir: string;
  name: string;
  testRun?: string;
  /** Whether it has test files or a vitest config at all, whatever `test:run` says. */
  hasTests?: boolean;
}

/** What the planner needs to know about the checkout, injectable so the tests need no repo. */
export interface Workspace {
  root: string;
  packages: WorkspacePackage[];
  /** Every existing `scripts/**\/*.test.ts`, repo-relative with `/` separators. */
  scriptTests: string[];
  exists: (repoRelative: string) => boolean;
  /** `[command, args]` that run `bin` from `pkgDir`'s own node_modules. */
  bin: (pkgDir: string, bin: string) => [string, string[]];
}

const SETTINGS_TEST = "scripts/consumer/settings.test.ts";
const CONFIG_FILE = /(^|\/)vite(st)?(\.[\w-]+)?\.config\.[cm]?[jt]s$/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** The `packages:` globs of `pnpm-workspace.yaml` (only the `dir` and `dir/*` forms are used here). */
export function workspaceGlobs(yaml: string): string[] {
  const globs: string[] = [];
  let inPackages = false;
  for (const line of yaml.split("\n")) {
    if (/^\S/.test(line)) inPackages = line.startsWith("packages:");
    const entry = inPackages ? line.match(/^\s+-\s+['"]?([^'"#\s]+)/) : null;
    if (entry) globs.push(entry[1]);
  }
  return globs;
}

/**
 * Splits a `test:run` script into the commands that prepare a run and the argument lists of each
 * `vitest run`. A package with no `test:run`, or one that is not vitest (`bun test`), has none.
 */
export function splitTestRun(script: string | undefined): { prelude: string[]; vitest: string[][] } {
  const prelude: string[] = [];
  const vitest: string[][] = [];
  for (const segment of (script ?? "").split("&&").map(part => part.trim()).filter(Boolean)) {
    const words = segment.split(/\s+/);
    if (words[0] === "vitest" && words[1] === "run") vitest.push(words.slice(2));
    else prelude.push(segment);
  }
  return { prelude: vitest.length > 0 ? prelude : [], vitest };
}

/** The package whose directory contains `file`, the deepest one if they nest. */
export function packageFor(file: string, packages: WorkspacePackage[]): WorkspacePackage | undefined {
  return packages
    .filter(pkg => file.startsWith(`${pkg.dir}/`))
    .toSorted((a, b) => b.dir.length - a.dir.length)[0];
}

/** True when `file` feeds the generated settings reference (the check that bit #219). */
export function touchesSettings(file: string): boolean {
  return file.startsWith("scripts/consumer/") || file === "scripts/dev-server-config.ts" ||
    file.endsWith("env.d.ts") || /(^|\/)settings[^/]*$/.test(file) ||
    file === "docs/wiki/configuration-reference.md";
}

const configName = (args: string[]) => {
  const index = args.findIndex(arg => arg === "--config" || arg === "-c");
  return index === -1 ? "default config" : args[index + 1];
};

/**
 * True for a docs file of `pkg`: a `*.md` or `README*` at the package root, or any file under the
 * package's `docs/`. It runs `pnpm docs:check` (which fails when an architecture doc's `covers:` names
 * a file that is gone) instead of the package's tests. Only those places: deeper Markdown can be runtime content (a blueprint's
 * `files/README.md` is bundled into its Gadget). Configs are never docs, even when they mostly hold
 * data: `wrangler.jsonc` sets the Worker's `main`, bindings and compatibility flags, which change
 * what runs, so it keeps the full-config fallback like any other non-test file.
 */
export function isPackageDoc(file: string, pkg: WorkspacePackage): boolean {
  const inside = file.slice(pkg.dir.length + 1);
  if (inside.startsWith("docs/")) return true;
  return !inside.includes("/") && (inside.endsWith(".md") || inside.startsWith("README"));
}

/** Plans one package's checks for its changed files. */
function planPackage(pkg: WorkspacePackage, changed: string[], workspace: Workspace, unchecked: Unchecked[]): Group {
  const cwd = join(workspace.root, pkg.dir);
  const run = splitTestRun(pkg.testRun);
  const exists = (file: string) => workspace.exists(file);
  const configs = changed.filter(file => CONFIG_FILE.test(file));
  const deletedTests = changed.filter(file => !exists(file) && TEST_FILE.test(file));
  const deletedSources = changed.filter(file => !exists(file) && !TEST_FILE.test(file) && !CONFIG_FILE.test(file));
  const tests = changed.filter(file => exists(file) && TEST_FILE.test(file));
  const sources = changed.filter(file => exists(file) && !TEST_FILE.test(file) && !CONFIG_FILE.test(file));
  const fullReason = configs.length > 0 ? "a test config changed"
    : deletedSources.length > 0 ? "a file was deleted" : null;

  const checks: Step[] = [{
    label: "type-check (vp run build)",
    command: process.execPath,
    args: [join(workspace.root, "scripts/vp/run.ts"), "-F", pkg.name, "--cache", "build"],
    cwd: workspace.root,
    vp: true,
    skip: { when: /Task "build" not found/, note: "no `build` task, so not type-checked" },
  }];

  if (run.vitest.length === 0) {
    if (pkg.testRun || pkg.hasTests) {
      const reason = pkg.testRun
        ? `tests not run: \`test:run\` is not vitest (\`${pkg.testRun}\`)`
        : "tests not run: the package has tests but no `test:run` script";
      for (const file of changed) unchecked.push({ file, reason });
    }
    return { name: pkg.name, prelude: [], checks };
  }

  const [vitest, vitestArgs] = workspace.bin(cwd, "vitest");
  const vitestStep = (label: string, args: string[], extra: Partial<Step> = {}): Step =>
    ({ label, command: vitest, args: [...vitestArgs, ...args], cwd, ...extra });
  const fromPackage = (file: string) => relative(cwd, join(workspace.root, file)).split(sep).join("/");

  for (const args of run.vitest) {
    const config = configName(args);
    const full = (why: string) => vitestStep(`vitest run (${config}) in full: ${why}`, ["run", ...args]);
    if (fullReason) {
      checks.push(full(fullReason));
      continue;
    }
    if (sources.length > 0) {
      checks.push(vitestStep(`vitest related (${config})`,
        ["related", ...sources.map(file => join(workspace.root, file)), "--run", "--passWithNoTests", ...args],
        { fallback: full("no related tests") }));
    }
    if (tests.length > 0) {
      checks.push(vitestStep(`vitest run changed tests (${config})`,
        ["run", ...tests.map(fromPackage), "--passWithNoTests", ...args], { countsTestFiles: true }));
    }
  }
  for (const file of deletedTests) unchecked.push({ file, reason: "deleted test suite; nothing left to run" });

  const runsTests = checks.length > 1;
  return {
    name: pkg.name,
    prelude: runsTests
      ? run.prelude.map(segment => ({ label: segment, command: segment, args: [], cwd, shell: true }))
      : [],
    checks,
    testFiles: fullReason ? undefined : tests,
  };
}

/** Maps changed files (repo-relative, `/`-separated) to the checks that cover them. */
export function planChecks(files: string[], workspace: Workspace): Plan {
  const unchecked: Unchecked[] = [];
  const byPackage = new Map<WorkspacePackage, string[]>();
  let scriptSuites: "all" | "settings" | null = null;
  let typeCheckScripts = false;
  let docs = false;

  for (const file of [...new Set(files)].toSorted()) {
    let covered = false;
    if (file.startsWith("scripts/")) {
      covered = true;
      scriptSuites = "all";
      if (file.endsWith(".ts")) typeCheckScripts = true;
      if (file === "scripts/check-docs.sh") docs = true;
    } else if (file.startsWith("docs/")) {
      covered = true;
      docs = true;
    } else {
      const pkg = packageFor(file, workspace.packages);
      if (pkg && isPackageDoc(file, pkg)) {
        covered = true;
        docs = true;
      } else if (pkg) {
        covered = true;
        byPackage.set(pkg, [...byPackage.get(pkg) ?? [], file]);
      }
    }
    if (touchesSettings(file)) {
      covered = true;
      scriptSuites ??= "settings";
    }
    if (!covered) unchecked.push({ file, reason: "outside every package check" });
  }

  const groups = [...byPackage].map(([pkg, changed]) => planPackage(pkg, changed, workspace, unchecked));

  const repoChecks: Step[] = [];
  const suites = scriptSuites === "all" ? workspace.scriptTests
    : scriptSuites === "settings" ? [SETTINGS_TEST] : [];
  if (suites.length > 0) {
    repoChecks.push({
      label: `node --test (${suites.length} suite${suites.length === 1 ? "" : "s"})`,
      command: process.execPath,
      args: ["--test", ...suites],
      cwd: workspace.root,
    });
  }
  if (typeCheckScripts) {
    const [command, args] = pnpmCommand(["run", "types:scripts"]);
    repoChecks.push({ label: "pnpm types:scripts", command, args, cwd: workspace.root });
  }
  if (docs) {
    const [command, args] = pnpmCommand(["run", "docs:check"]);
    repoChecks.push({ label: "pnpm docs:check", command, args, cwd: workspace.root });
  }
  if (repoChecks.length > 0) groups.push({ name: "repo", prelude: [], checks: repoChecks });

  return { groups, unchecked };
}

function git(root: string, args: string[]): string[] {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    .split("\n").filter(Boolean);
}

/** Every non-ignored file, tracked or not, still on disk. */
function listFiles(root: string, pathspec: string[] = []): string[] {
  return git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...pathspec])
    .filter(file => existsSync(join(root, file)));
}

/** The checkout as `planChecks` sees it. */
export function loadWorkspace(root: string = ROOT): Workspace {
  const files = listFiles(root);
  const packages: WorkspacePackage[] = [];
  for (const glob of workspaceGlobs(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8"))) {
    const dirs = glob.endsWith("/*")
      ? readdirSync(join(root, glob.slice(0, -2)), { withFileTypes: true })
        .filter(entry => entry.isDirectory()).map(entry => `${glob.slice(0, -2)}/${entry.name}`)
      : [glob];
    for (const dir of dirs) {
      const manifest = join(root, dir, "package.json");
      if (!existsSync(manifest)) continue;
      const { name, scripts } = JSON.parse(readFileSync(manifest, "utf8"));
      const hasTests = files.some(file => file.startsWith(`${dir}/`) && !file.includes("/node_modules/") &&
        (TEST_FILE.test(file) || /(^|\/)vitest(\.[\w-]+)?\.config\.[cm]?[jt]s$/.test(file)));
      packages.push({ dir, name, testRun: scripts?.["test:run"], hasTests });
    }
  }
  return {
    root,
    // `scripts` is a workspace package too, but its suites are `node --test`, planned above.
    packages: packages.filter(pkg => pkg.dir !== "scripts"),
    scriptTests: files.filter(file => file.startsWith("scripts/") && file.endsWith(".test.ts") &&
      !file.includes("/node_modules/")),
    exists: file => existsSync(join(root, file)) && statSync(join(root, file)).isFile(),
    bin: (pkgDir, bin) => {
      const entry = resolveBinEntry(pkgDir, bin);
      return entry ? [process.execPath, [entry]] : pnpmCommand(["exec", bin]);
    },
  };
}

/** Where `changedFiles` diffs from. */
export type ChangeSource = { base: string } | { uncommitted: true };

/**
 * Files changed since `source`: against `base`'s merge-base with HEAD (committed, staged and
 * unstaged), or with `uncommitted` against HEAD alone; plus untracked files either way. Renames are
 * split into the old and the new path. Throws when the merge-base cannot be found.
 */
export function changedFiles(root: string, source: ChangeSource): string[] {
  let from = "HEAD";
  if ("base" in source) {
    try {
      from = git(root, ["merge-base", source.base, "HEAD"])[0];
    } catch (error) {
      const detail = (error as { stderr?: string }).stderr?.trim();
      throw new Error(`cannot find the merge-base of ${source.base} and HEAD${detail ? ` (${detail})` : ""}. ` +
        "Fetch it, pass another --base <ref>, or check only uncommitted changes with --uncommitted.",
        { cause: error });
    }
  }
  return [...new Set([
    ...git(root, ["diff", "--no-renames", "--name-only", from]),
    ...git(root, ["diff", "--no-renames", "--name-only", "--cached", from]),
    ...git(root, ["diff", "--no-renames", "--name-only"]),
    ...git(root, ["ls-files", "--others", "--exclude-standard"]),
  ])].toSorted();
}

/**
 * Explicit paths, repo-relative: a directory becomes every non-ignored file in it, and a path that
 * is not on disk is kept as given (a deletion). A directory with no files is an error.
 */
export function expandPaths(root: string, paths: string[], cwd: string = process.cwd()): string[] {
  const files = new Set<string>();
  for (const path of paths) {
    const absolute = resolve(cwd, path);
    const repoPath = relative(root, absolute).split(sep).join("/");
    if (repoPath.startsWith("..")) throw new Error(`${path} is outside the repository`);
    if (existsSync(absolute) && statSync(absolute).isDirectory()) {
      const inside = listFiles(root, [repoPath || "."]);
      if (inside.length === 0) throw new Error(`${path} contains no files git can see`);
      for (const file of inside) files.add(file);
    } else {
      files.add(repoPath);
    }
  }
  return [...files].toSorted();
}

export interface StepResult {
  group: string;
  label: string;
  status: "ok" | "FAIL" | "skip";
  seconds: number;
  output: string;
  /** What vitest or `node --test` reported, or why the step was skipped. */
  detail?: string;
  /** Test files vitest ran, when it said. */
  testFiles?: number;
}

/** Runs one step to completion, capturing its output. */
export function runStep(group: string, step: Step, env: NodeJS.ProcessEnv = process.env): Promise<StepResult> {
  const started = performance.now();
  return new Promise(done => {
    const child = spawn(step.command, step.args, {
      cwd: step.cwd, env, shell: step.shell ?? false, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const finish = (code: number | null) => {
      const seconds = (performance.now() - started) / 1000;
      const plain = stripVTControlCharacters(output);
      const files = [...plain.matchAll(/Test Files\s+(.+)/g)].at(-1)?.[1].trim();
      const total = files?.match(/\((\d+)\)\s*$/)?.[1];
      const nodeTests = [...plain.matchAll(/^(?:#|ℹ) (pass|fail) (\d+)$/gm)]
        .map(match => `${match[1]} ${match[2]}`).join(", ");
      const skipped = code !== 0 && step.skip?.when.test(plain);
      done({
        group, label: step.label, status: code === 0 ? "ok" : skipped ? "skip" : "FAIL", seconds, output,
        detail: skipped ? step.skip?.note : files ?? (nodeTests || undefined),
        testFiles: step.command === process.execPath && step.args.includes("--test") ? undefined
          : total !== undefined ? Number(total) : 0,
      });
    };
    child.on("error", error => { output += String(error); finish(null); });
    child.on("close", finish);
  });
}

export interface RunOutcome {
  results: StepResult[];
  /** What the run found it did not check: test files no config ran, packages never type-checked. */
  unchecked: Unchecked[];
}

/** Runs one step, and its fallback when it found no test file. */
async function runCheck(group: string, step: Step, envFor: (step: Step) => NodeJS.ProcessEnv): Promise<StepResult[]> {
  const result = await runStep(group, step, envFor(step));
  if (step.fallback && result.status === "ok" && result.testFiles === 0) {
    return [result, await runStep(group, step.fallback, envFor(step.fallback))];
  }
  return [result];
}

/** Runs each group's prelude in order and then its checks in parallel; groups run side by side. */
export async function runGroups(
  groups: Group[], limit: number, envFor: (step: Step) => NodeJS.ProcessEnv = () => process.env,
): Promise<RunOutcome> {
  const unchecked: Unchecked[] = [];
  const perGroup = await mapConcurrent(groups, limit, async group => {
    const results: StepResult[] = [];
    for (const step of group.prelude) {
      const result = await runStep(group.name, step, envFor(step));
      results.push(result);
      if (result.status === "FAIL") {
        for (const check of group.checks) {
          results.push({ group: group.name, label: check.label, status: "skip", seconds: 0, output: "",
            detail: "prelude failed" });
        }
        return results;
      }
    }
    const perCheck = await Promise.all(group.checks.map(step => runCheck(group.name, step, envFor)));
    results.push(...perCheck.flat());
    for (const result of results) {
      if (result.status === "skip" && result.detail) unchecked.push({ file: group.name, reason: result.detail });
    }
    // Changed test files count as checked only if some config ran a test file; a failure already
    // fails the run, so it needs no second mention.
    const testRuns = perCheck.filter((_, index) => group.checks[index].countsTestFiles).map(([first]) => first);
    if (group.testFiles?.length && testRuns.every(run => run.status === "ok" && run.testFiles === 0)) {
      for (const file of group.testFiles) {
        unchecked.push({ file, reason: "no vitest config in `test:run` includes it, so it did not run" });
      }
    }
    return results;
  });
  return { results: perGroup.flat(), unchecked };
}

/** The line every run ends with, because no run of this command covers them. */
export const FOOTER = "Not covered by check:fast: dependent packages and full suites -- run `pnpm check:full` before hand-off.";

/**
 * Prints failed steps' output, one line per step, what was not checked and the footer. Returns the
 * exit code: 1 if any step failed.
 */
export function report(
  results: StepResult[], unchecked: Unchecked[], seconds: number,
  write: (text: string) => void = text => process.stdout.write(text),
): number {
  for (const result of results.filter(entry => entry.status === "FAIL")) {
    write(`\n=== FAIL ${result.group}: ${result.label} ===\n${result.output.trimEnd()}\n`);
  }
  const width = Math.max(0, ...results.map(entry => entry.group.length + entry.label.length + 2));
  write("\n");
  for (const result of results) {
    const name = `${result.group}: ${result.label}`.padEnd(width);
    write(`  ${result.status.padEnd(4)}  ${name}  ${result.seconds.toFixed(1).padStart(6)}s` +
      `${result.detail ? `  (${result.detail})` : ""}\n`);
  }
  if (unchecked.length > 0) {
    write(`\nNOT CHECKED (${unchecked.length}):\n`);
    for (const { file, reason } of unchecked) write(`  ${file}: ${reason}\n`);
  }
  const failed = results.filter(entry => entry.status === "FAIL").length;
  const verdict = failed > 0 ? `${failed} failed` : unchecked.length > 0
    ? `passed, but ${unchecked.length} item${unchecked.length === 1 ? " was" : "s were"} not checked`
    : "passed";
  write(`${verdict} in ${seconds.toFixed(1)}s\n${FOOTER}\n`);
  return failed === 0 ? 0 : 1;
}

export interface Options {
  source: ChangeSource;
  dryRun: boolean;
  paths: string[];
}

/** Parses the command line; throws on a usage error. */
export function parseArgs(argv: string[]): Options {
  let base: string | undefined;
  let uncommitted = false;
  let dryRun = false;
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--base") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("-")) throw new Error("--base needs a ref, e.g. --base origin/main");
      base = value;
    } else if (arg.startsWith("--base=")) {
      base = arg.slice("--base=".length);
      if (!base) throw new Error("--base needs a ref, e.g. --base origin/main");
    } else if (arg === "--uncommitted") uncommitted = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
    else paths.push(arg);
  }
  if (uncommitted && base !== undefined) throw new Error("--base and --uncommitted are mutually exclusive");
  if (paths.length > 0 && (uncommitted || base !== undefined)) {
    throw new Error("explicit paths replace --base/--uncommitted; pass one or the other");
  }
  return { source: uncommitted ? { uncommitted: true } : { base: base ?? "origin/main" }, dryRun, paths };
}

async function main(): Promise<number> {
  const started = performance.now();
  let files: string[];
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2));
    files = options.paths.length > 0 ? expandPaths(ROOT, options.paths) : changedFiles(ROOT, options.source);
  } catch (error) {
    process.stderr.write(`check:fast: ${(error as Error).message}\n`);
    return 2;
  }
  if (files.length === 0) {
    process.stdout.write(`check:fast: no changed files\n${FOOTER}\n`);
    return 0;
  }
  const plan = planChecks(files, loadWorkspace(ROOT));
  process.stdout.write(`check:fast: ${files.length} changed file${files.length === 1 ? "" : "s"}\n`);
  if (options.dryRun) {
    for (const group of plan.groups) {
      for (const step of [...group.prelude, ...group.checks]) {
        process.stdout.write(`  ${group.name}: ${step.label}\n    ${[step.command, ...step.args].join(" ")}\n`);
        if (step.fallback) process.stdout.write(`    if no tests: ${step.fallback.label}\n`);
      }
    }
    for (const { file, reason } of plan.unchecked) process.stdout.write(`  not checked: ${file} (${reason})\n`);
    process.stdout.write(`${FOOTER}\n`);
    return 0;
  }
  // One `vp run` budget, divided between the type-checks that run at once.
  const vpSteps = plan.groups.flatMap(group => group.checks).filter(step => step.vp).length;
  const vpEnv = vpSteps > 0 ? vpRunEnv({ concurrentRuns: vpSteps }) : process.env;
  const outcome = await runGroups(plan.groups, Math.max(2, Math.floor(availableParallelism() / 4)),
    step => step.vp ? vpEnv : process.env);
  return report(outcome.results, [...plan.unchecked, ...outcome.unchecked], (performance.now() - started) / 1000);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
