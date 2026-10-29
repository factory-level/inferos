#!/usr/bin/env node
// Factory node 8, `perf`: Artillery HTTP load on the InferOS router and Artillery's Playwright
// engine profiling an InferOS browser flow with Web Vitals, both against the local stack.
//
//   node scripts/ci/perf.ts [--run-id ID] [--part all|http|browser]
//
// Scenarios live in `load/` (one file per scenario, one command each). Both run in the
// artilleryio/artillery container (its image carries Chromium for the Playwright engine) on the
// host network, so they reach 127.0.0.1 without publishing a port; the checkout's `load/` is
// mounted read-only. Gate: each run's `ensure` thresholds and conditions pass (Artillery exits
// non-zero otherwise). The ceilings are proposed, not agreed (#158).
// ponytail: no comparison against the last green run yet; upgrade path is reading the previous
// `.factory/runs/*/perf/*.json` aggregate and failing on a regression ratio.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveLocalStack } from "../local/stack.ts";
import { dockerRun, exec, finish, nodeContext, runAsMain, type CommandRecord } from "./lib.ts";

export const PERF_SCENARIOS: Record<string, string> = { http: "inferos-http.yml", browser: "inferos-browser.yml" };

/** The headline numbers of an Artillery JSON report: p95s, error counts and every browser metric. */
export function summarizeArtillery(report: { aggregate?: { counters?: Record<string, number>; summaries?: Record<string, { p50?: number; p75?: number; p95?: number; p99?: number }> } }): Record<string, unknown> {
  const counters = report.aggregate?.counters ?? {};
  const summaries = report.aggregate?.summaries ?? {};
  const pick = (prefix: string) => Object.fromEntries(Object.entries(summaries).filter(([name]) => name.startsWith(prefix)).map(([name, s]) => [name, { p50: s.p50, p75: s.p75, p95: s.p95, p99: s.p99 }]));
  return {
    vusers: { created: counters["vusers.created"], completed: counters["vusers.completed"], failed: counters["vusers.failed"] ?? 0 },
    codes: Object.fromEntries(Object.entries(counters).filter(([name]) => name.startsWith("http.codes."))),
    errors: Object.fromEntries(Object.entries(counters).filter(([name]) => name.startsWith("errors."))),
    http: pick("http.response_time"),
    vitals: pick("browser.page."),
    steps: pick("browser.step."),
  };
}

export async function main(argv: string[]): Promise<number> {
  const ctx = nodeContext("perf", argv);
  const part = ctx.part ?? "all";
  const names = part === "all" ? Object.keys(PERF_SCENARIOS) : [part];
  if (names.some(name => !PERF_SCENARIOS[name])) throw new Error(`--part must be all, ${Object.keys(PERF_SCENARIOS).join(", ")}`);
  const target = resolveLocalStack(ctx.root, [], ctx.env).url;
  const records: CommandRecord[] = [];
  const summaries: Record<string, unknown> = {};
  for (const name of names) {
    const record = await exec(ctx, dockerRun(ctx, [
      "--network", "host", "-e", `FACTORY_TARGET=${target}`,
      "-v", `${join(ctx.root, "load")}:/load:ro`, "-v", `${ctx.dir}:/out`,
      "artilleryio/artillery:latest", "run", "--output", `/out/${name}.json`, `/load/${PERF_SCENARIOS[name]}`,
    ]), { log: `${name}.log` });
    records.push(record);
    try {
      summaries[name] = summarizeArtillery(JSON.parse(readFileSync(join(ctx.dir, `${name}.json`), "utf8")));
    } catch {
      summaries[name] = null;
    }
  }
  return finish(ctx, {
    node: "perf", ok: records.every(record => record.exitCode === 0),
    gate: "Artillery ensure thresholds pass for the HTTP load and the Playwright-engine browser profile (proposed ceilings, #158)",
    commands: records, details: { target, summaries },
  });
}

await runAsMain(import.meta.url, main);
