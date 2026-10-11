#!/usr/bin/env node

// `pnpm check:full`: the one full local validation before hand-off (AGENTS.md, "Iteration loop").
// CI is still the final gate; this is what an agent runs once, not after every edit -- the inner
// loop is `pnpm check:fast` (check-fast.ts).
//
// Sequential and fail-fast, with each step's output streamed as it runs and a timing summary at
// the end. The root scripts' suites run on their own before `pnpm test` (which also runs them, as
// `@gadgets/scripts`'s cached `test` task) because they take seconds and fail most often, so a
// broken one stops the run before the long workerd suites start.

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pnpmCommand } from "./pnpm-command.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Every suite under `scripts/`, tracked or new, that is still on disk. A git pathspec `*` matches
// across `/` already; `scripts/**/*.test.ts` would skip the top-level ones, since its `/` after `**`
// must match.
const scriptSuites = execFileSync("git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "--", "scripts/*.test.ts"],
  { cwd: ROOT, encoding: "utf8" })
  .split("\n").filter(file => file && existsSync(join(ROOT, file)));

const steps: [label: string, command: string, args: string[]][] = [
  ["pnpm lint", ...pnpmCommand(["run", "lint"])],
  ["pnpm docs:check", ...pnpmCommand(["run", "docs:check"])],
  [`node --test scripts (${scriptSuites.length} suites)`, process.execPath, ["--test", ...scriptSuites]],
  ["pnpm test", ...pnpmCommand(["run", "test"])],
];

function run(command: string, args: string[]): Promise<number> {
  return new Promise(done => {
    const child = spawn(command, args, { cwd: ROOT, stdio: "inherit" });
    child.on("error", () => done(1));
    child.on("close", code => done(code ?? 1));
  });
}

const started = performance.now();
const results: [label: string, status: string, seconds: number][] = [];
let exitCode = 0;
for (const [label, command, args] of steps) {
  if (exitCode !== 0) {
    results.push([label, "skip", 0]);
    continue;
  }
  process.stdout.write(`\n=== check:full: ${label} ===\n`);
  const stepStarted = performance.now();
  exitCode = await run(command, args);
  results.push([label, exitCode === 0 ? "ok" : "FAIL", (performance.now() - stepStarted) / 1000]);
}

const width = Math.max(...results.map(([label]) => label.length));
process.stdout.write("\n");
for (const [label, status, seconds] of results) {
  process.stdout.write(`  ${status.padEnd(4)}  ${label.padEnd(width)}  ${seconds.toFixed(1).padStart(6)}s\n`);
}
const total = ((performance.now() - started) / 1000).toFixed(1);
process.stdout.write(`check:full ${exitCode === 0 ? "passed" : "failed"} in ${total}s\n`);
process.exitCode = exitCode;
