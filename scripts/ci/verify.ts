#!/usr/bin/env node
// Factory node 1, `verify`: the repository's own gates.
//
//   node scripts/ci/verify.ts [--part all|lint|build|test|docs] [--run-id ID]
//
// `all` (the pipeline's default) is `pnpm lint`, `pnpm test`, `pnpm docs:check`. The parts are what
// CI's two jobs run, kept exactly as `ci.yml` ran them inline before `_verify.yml` called this:
// `lint` is the Lint job (oxlint, scripts/ type check, generated worker configs; package type
// checking lives in `build`), `build` and `test` are the Build and test job.

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exec, execAll, finish, nodeContext, runAsMain, type CommandRecord } from "./lib.ts";

/** The commands of each part, in order. */
export const VERIFY_PARTS: Record<string, string[][]> = {
  all: [["pnpm", "lint"], ["pnpm", "test"], ["pnpm", "docs:check"]],
  lint: [["pnpm", "lint:check"], ["pnpm", "types:scripts"], ["pnpm", "configs:check"]],
  build: [["pnpm", "build"]],
  test: [["pnpm", "test"]],
  docs: [["pnpm", "docs:check"]],
};

export async function main(argv: string[]): Promise<number> {
  const ctx = nodeContext("verify", argv);
  const part = ctx.part ?? "all";
  const commands = VERIFY_PARTS[part];
  if (!commands) throw new Error(`--part must be one of ${Object.keys(VERIFY_PARTS).join(", ")}`);
  // The failure report reads this marker to tell this run's vp summary from an earlier one's.
  const marker = ctx.env.RUNNER_TEMP ? join(ctx.env.RUNNER_TEMP, "test-step-started") : join(ctx.dir, "test-step-started");
  if (part === "test" || part === "all") writeFileSync(marker, "");
  const records: CommandRecord[] = await execAll(ctx, commands.map((command, i) => ({ argv: command, log: `${i}-${command.slice(1).join("-").replace(/[^\w-]/g, "_")}.log` })));
  const ok = records.length === commands.length && records.every(record => record.exitCode === 0);
  const testFailed = records.some(record => record.argv.join(" ") === "pnpm test" && record.exitCode !== 0);
  if (testFailed && existsSync(join(ctx.root, "scripts", "vp", "last-run-report.ts"))) {
    // Diagnosis only: always exits 0, so the node keeps the test failure and gains none.
    records.push(await exec(ctx, [process.execPath, "scripts/vp/last-run-report.ts", "--since", marker], { log: "last-run-report.log" }));
  }
  return finish(ctx, { node: "verify", ok, gate: `every command of part "${part}" exits 0`, commands: records, details: { part } });
}

await runAsMain(import.meta.url, main);
