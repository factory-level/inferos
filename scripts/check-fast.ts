#!/usr/bin/env node

// `pnpm check:fast [paths…]`: the per-change check for the inner loop (AGENTS.md, "Iteration loop").
//
// It checks only what the change can affect. The changed files are the branch's diff from its
// merge-base with `origin/main` (`--base <ref>` overrides it) plus staged, unstaged and untracked
// files, or the paths given as arguments. Each one maps to the narrowest check that covers it:
//
//   - A file in a workspace package type-checks that package with the same `vp run … build` task
//     `pnpm lint` (`types:check` → `pnpm build`) runs for every package, and runs
//     `vitest related <files> --run` once for each `vitest run` in the package's `test:run` script,
//     with the same `--config`. `test:run` is read rather than the `vitest*.config.ts` files on disk
//     because it is what decides which configs a package runs and what codegen they need first:
//     its other `&&` segments (workshop-backend's codegen, integration-tests' prebuild) run first.
//   - A file under `scripts/` runs the `node --test` suites that import it (or sit beside it), and
//     `pnpm types:scripts`.
//   - The consumer settings sources and `env.d.ts` also run `scripts/consumer/settings.test.ts`,
//     which fails when the generated `docs/wiki/configuration-reference.md` table is stale.
//   - A file under `docs/` runs `pnpm docs:check`.
//
// Anything else (root configs, the lockfile, a package's vitest config) is listed as not checked,
// since only the full run covers it: `pnpm check:full` (check-full.ts) before hand-off, then CI.
//
// Packages run in parallel, and within one package its prelude runs before its checks, which then
// run in parallel. The codegen steps a prelude and the type-check both run write only when their
// output changed, so the second writer never truncates a file a running check is reading.
//
// `--dry-run` prints the plan without running it.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { resolveBinEntry } from "./bin-entry.ts";
import { mapConcurrent } from "./map-concurrent.ts";
import { pnpmCommand } from "./pnpm-command.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** One command to run, with what the summary calls it. */
export interface Step {
  label: string;
  command: string;
  args: string[];
  cwd: string;
  /** Run through a shell: a `test:run` segment, which pnpm would also hand to one. */
  shell?: boolean;
  /** Output meaning "nothing to do here" rather than failure (a package with no `build` task). */
  skipWhen?: RegExp;
}

/** Steps that share a prelude: one package, or the repo-level checks. */
export interface Group {
  name: string;
  prelude: Step[];
  checks: Step[];
}

export interface Plan {
  groups: Group[];
  /** Changed files no check here covers, with the reason. */
  unchecked: { file: string; reason: string }[];
}

/** A workspace package: its directory relative to the repo root, name and `test:run` script. */
export interface WorkspacePackage {
  dir: string;
  name: string;
  testRun?: string;
}

/** What the planner needs to know about the checkout, injectable so the tests need no repo. */
export interface Workspace {
  root: string;
  packages: WorkspacePackage[];
  /** Every `scripts/**\/*.test.ts`, repo-relative with `/` separators. */
  scriptTests: string[];
  readFile: (repoRelative: string) => string;
  exists: (repoRelative: string) => boolean;
  /** `[command, args]` that run `bin` from `pkgDir`'s own node_modules. */
  bin: (pkgDir: string, bin: string) => [string, string[]];
}

const SETTINGS_TEST = "scripts/consumer/settings.test.ts";
const VITEST_CONFIG = /(^|\/)vite(st)?(\.[\w-]+)?\.config\.[cm]?[jt]s$/;

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

/** Relative import specifiers in a module's source. */
const RELATIVE_IMPORTS = /(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g;

/**
 * The `scripts/**` suites a change to `file` should run: the file itself if it is a suite, its
 * `<name>.test.ts` sibling, every suite that imports it directly, and for a non-TypeScript file
 * (fixtures, templates) every suite in its directory.
 */
export function scriptTestsFor(file: string, workspace: Pick<Workspace, "scriptTests" | "readFile">): string[] {
  if (file.endsWith(".test.ts")) return workspace.scriptTests.includes(file) ? [file] : [];
  const found = new Set<string>();
  const sibling = file.replace(/\.ts$/, ".test.ts");
  if (workspace.scriptTests.includes(sibling)) found.add(sibling);
  if (file.endsWith(".ts")) {
    for (const test of workspace.scriptTests) {
      for (const match of workspace.readFile(test).matchAll(RELATIVE_IMPORTS)) {
        const target = join(dirname(test), match[1]).split(sep).join("/");
        if (target === file) found.add(test);
      }
    }
  } else {
    let dir = dirname(file);
    // A data file nested under a suite's directory (`consumer/fixtures/intake/…`) belongs to that
    // directory's suites, so walk up to the first directory that has any.
    while (dir.startsWith("scripts") && found.size === 0) {
      for (const test of workspace.scriptTests) if (dirname(test) === dir) found.add(test);
      dir = dirname(dir);
    }
  }
  return [...found].toSorted();
}

/** True when `file` feeds the generated settings reference (the check that bit #219). */
export function touchesSettings(file: string): boolean {
  return file.startsWith("scripts/consumer/") || file === "scripts/dev-server-config.ts" ||
    file.endsWith("env.d.ts") || /(^|\/)settings[^/]*$/.test(file) ||
    file === "docs/wiki/configuration-reference.md";
}

/** Maps changed files (repo-relative, `/`-separated) to the checks that cover them. */
export function planChecks(files: string[], workspace: Workspace): Plan {
  const unchecked: Plan["unchecked"] = [];
  const byPackage = new Map<WorkspacePackage, string[]>();
  const scriptTests = new Set<string>();
  let typeCheckScripts = false;
  let docs = false;

  for (const file of [...new Set(files)].toSorted()) {
    let covered = false;
    if (file.startsWith("scripts/")) {
      covered = true;
      if (file.endsWith(".ts")) typeCheckScripts = true;
      for (const test of scriptTestsFor(file, workspace)) scriptTests.add(test);
      if (file === "scripts/check-docs.sh") docs = true;
    } else if (file.startsWith("docs/")) {
      covered = true;
      docs = true;
    } else {
      const pkg = packageFor(file, workspace.packages);
      if (pkg && VITEST_CONFIG.test(file)) {
        unchecked.push({ file, reason: `a test config; run \`pnpm --filter ${pkg.name} test:run\`` });
      } else if (pkg) {
        covered = true;
        byPackage.set(pkg, [...byPackage.get(pkg) ?? [], file]);
      }
    }
    if (touchesSettings(file)) {
      covered = true;
      scriptTests.add(SETTINGS_TEST);
    }
    if (!covered && !unchecked.some(entry => entry.file === file)) {
      unchecked.push({ file, reason: "outside every package check" });
    }
  }

  const groups: Group[] = [];
  for (const [pkg, changed] of byPackage) {
    const cwd = join(workspace.root, pkg.dir);
    const run = splitTestRun(pkg.testRun);
    const existing = changed.filter(file => workspace.exists(file)).map(file => join(workspace.root, file));
    const [vitest, vitestArgs] = workspace.bin(cwd, "vitest");
    const checks: Step[] = [{
      label: "type-check (vp run build)",
      command: process.execPath,
      args: [join(workspace.root, "scripts/vp/run.ts"), "-F", pkg.name, "--cache", "build"],
      cwd: workspace.root,
      skipWhen: /Task "build" not found/,
    }];
    if (existing.length > 0) {
      for (const args of run.vitest) {
        const config = args[args.findIndex(arg => arg === "--config" || arg === "-c") + 1];
        checks.push({
          label: `vitest related (${args.includes("--config") || args.includes("-c") ? config : "default config"})`,
          command: vitest,
          args: [...vitestArgs, "related", ...existing, "--run", "--passWithNoTests", ...args],
          cwd,
        });
      }
    }
    if (pkg.testRun && run.vitest.length === 0) {
      unchecked.push({ file: pkg.dir, reason: `tests are not vitest (\`${pkg.testRun}\`)` });
    }
    groups.push({
      name: pkg.name,
      prelude: checks.length > 1
        ? run.prelude.map(segment => ({ label: segment, command: segment, args: [], cwd, shell: true }))
        : [],
      checks,
    });
  }

  const repoChecks: Step[] = [];
  if (scriptTests.size > 0) {
    repoChecks.push({
      label: `node --test (${scriptTests.size} suite${scriptTests.size === 1 ? "" : "s"})`,
      command: process.execPath,
      args: ["--test", ...[...scriptTests].toSorted()],
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

/** The checkout as `planChecks` sees it. */
export function loadWorkspace(root: string = ROOT): Workspace {
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
      packages.push({ dir, name, testRun: scripts?.["test:run"] });
    }
  }
  const scriptTests = git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "scripts/"])
    .filter(file => file.endsWith(".test.ts") && !file.includes("/node_modules/"));
  return {
    root,
    // `scripts` is a workspace package too, but its suites are `node --test`, planned above.
    packages: packages.filter(pkg => pkg.dir !== "scripts"),
    scriptTests,
    readFile: file => readFileSync(join(root, file), "utf8"),
    exists: file => existsSync(join(root, file)) && statSync(join(root, file)).isFile(),
    bin: (pkgDir, bin) => {
      const entry = resolveBinEntry(pkgDir, bin);
      return entry ? [process.execPath, [entry]] : pnpmCommand(["exec", bin]);
    },
  };
}

function git(root: string, args: string[]): string[] {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
}

/**
 * Files changed against `base`'s merge-base with HEAD, staged or not, plus untracked files. Falls
 * back to HEAD when the merge-base cannot be found (no `origin/main` fetched).
 */
export function changedFiles(root: string, base: string): string[] {
  let from = "HEAD";
  try {
    from = git(root, ["merge-base", base, "HEAD"])[0] ?? "HEAD";
  } catch {
    process.stderr.write(`check:fast: no merge-base with ${base}; checking uncommitted changes only\n`);
  }
  return [...new Set([
    ...git(root, ["diff", "--name-only", from]),
    ...git(root, ["ls-files", "--others", "--exclude-standard"]),
  ])].toSorted();
}

export interface StepResult {
  group: string;
  label: string;
  status: "ok" | "FAIL" | "skip";
  seconds: number;
  output: string;
  /** The last `Test Files …` line vitest printed, for the summary. */
  detail?: string;
}

/** Runs one step to completion, capturing its output. */
export function runStep(group: string, step: Step): Promise<StepResult> {
  const started = performance.now();
  return new Promise(done => {
    const child = spawn(step.command, step.args, {
      cwd: step.cwd, shell: step.shell ?? false, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const finish = (code: number | null) => {
      const seconds = (performance.now() - started) / 1000;
      const plain = stripVTControlCharacters(output);
      const detail = [...plain.matchAll(/Test Files\s+(.+)/g)].at(-1)?.[1].trim() ??
        [...plain.matchAll(/^(?:#|ℹ) (pass|fail) (\d+)$/gm)].map(match => `${match[1]} ${match[2]}`).join(", ");
      const status = code === 0 ? "ok" : step.skipWhen?.test(plain) ? "skip" : "FAIL";
      done({ group, label: step.label, status, seconds, output, detail: detail || undefined });
    };
    child.on("error", error => { output += String(error); finish(null); });
    child.on("close", finish);
  });
}

/** Runs each group's prelude in order and then its checks in parallel; groups run side by side. */
export async function runGroups(groups: Group[], limit: number): Promise<StepResult[]> {
  const perGroup = await mapConcurrent(groups, limit, async group => {
    const results: StepResult[] = [];
    for (const step of group.prelude) {
      const result = await runStep(group.name, step);
      results.push(result);
      if (result.status === "FAIL") {
        for (const check of group.checks) {
          results.push({ group: group.name, label: check.label, status: "skip", seconds: 0, output: "" });
        }
        return results;
      }
    }
    results.push(...await Promise.all(group.checks.map(step => runStep(group.name, step))));
    return results;
  });
  return perGroup.flat();
}

/** Prints failed steps' output, then one line per step and the total. Returns the exit code. */
export function report(
  results: StepResult[], seconds: number, write: (text: string) => void = text => process.stdout.write(text),
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
  const failed = results.filter(entry => entry.status === "FAIL").length;
  write(`${failed === 0 ? "passed" : `${failed} failed`} in ${seconds.toFixed(1)}s\n`);
  return failed === 0 ? 0 : 1;
}

function parseArgs(argv: string[]): { base: string; dryRun: boolean; paths: string[] } {
  let base = "origin/main";
  let dryRun = false;
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") base = argv[++i];
    else if (argv[i] === "--dry-run") dryRun = true;
    else paths.push(argv[i]);
  }
  return { base, dryRun, paths };
}

async function main(): Promise<number> {
  const started = performance.now();
  const { base, dryRun, paths } = parseArgs(process.argv.slice(2));
  const files = paths.length > 0
    ? paths.map(path => relative(ROOT, resolve(path)).split(sep).join("/"))
    : changedFiles(ROOT, base);
  if (files.length === 0) {
    process.stdout.write("check:fast: no changed files\n");
    return 0;
  }
  const plan = planChecks(files, loadWorkspace(ROOT));
  process.stdout.write(`check:fast: ${files.length} changed file${files.length === 1 ? "" : "s"}\n`);
  for (const { file, reason } of plan.unchecked) {
    process.stdout.write(`  not checked here: ${file} (${reason})\n`);
  }
  if (dryRun) {
    for (const group of plan.groups) {
      for (const step of [...group.prelude, ...group.checks]) {
        process.stdout.write(`  ${group.name}: ${step.label}\n    ${[step.command, ...step.args].join(" ")}\n`);
      }
    }
    return 0;
  }
  const results = await runGroups(plan.groups, Math.max(2, Math.floor(availableParallelism() / 4)));
  if (plan.unchecked.length > 0) {
    process.stdout.write("\nSome changes are covered only by `pnpm check:full`; see \"not checked here\" above.\n");
  }
  return report(results, (performance.now() - started) / 1000);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
