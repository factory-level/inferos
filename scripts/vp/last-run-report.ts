#!/usr/bin/env node
// After a failed CI test step: print that same run's per-task outcomes and the integration suite's
// phase timings, so a failure such as an idle-watchdog kill is attributed from the run itself.
//
//     node scripts/vp/last-run-report.ts --since <marker-file>
//
// `vp run` writes `node_modules/.vite/task-cache/<v>/last-summary.json` after every graph execution,
// failed ones included (vite-task `summary.rs`), and `--last-details` would render it -- but a later
// `vp` invocation replaces it, so a report read at any other time describes some other run. The
// marker file is touched just before the test step starts; a summary or phase log older than it
// belongs to an earlier invocation and is withheld rather than shown.
//
// Read only, bounded, and always exits 0: it is diagnosis after a failure and must neither turn the
// job green nor fail it for a second reason. It prints task identities, cache and outcome *kinds*,
// exit codes and phase timestamps -- not commands, paths read, env values or error messages, which
// can carry anything.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const taskCache = (root: string) => join(root, "node_modules", ".vite", "task-cache");
/** Where `packages/integration-tests/src/phase-log.ts` writes (`phase-log-path.ts`). */
const phaseLog = (root: string) => join(root, "packages", "integration-tests", "node_modules", ".vite", "integration-phases.jsonl");
/** Bounds on what is printed, whatever the files hold. */
const LIMITS = { tasks: 200, tail: 40, gaps: 5, open: 20, phaseBytes: 4 * 1024 * 1024 } as const;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const kind = (value: unknown): string => (isObject(value) ? Object.keys(value)[0] ?? "?" : typeof value === "string" ? value : "?");
const safe = (value: unknown, max = 120): string => (typeof value === "string" ? value.replace(/[^\w@./:# -]/gu, "?").slice(0, max) : "?");

/** One task's line: identity, cache status kind, outcome kind and exit code. */
export function describeTask(task: unknown): string {
  if (!isObject(task)) return "  (malformed task entry)";
  const name = `${safe(task.package_name)}#${safe(task.task_name)}`;
  const result = task.result;
  if (result === "InProcess") return `  ${name}: in-process`;
  if (!isObject(result)) return `  ${name}: (unrecognized result)`;
  if (isObject(result.CacheHit)) return `  ${name}: cache hit`;
  if (!isObject(result.Spawned)) return `  ${name}: ${safe(kind(result))}`;
  const { cache_status: cache, outcome } = result.Spawned;
  const cacheText = cache === "Disabled" ? "cache disabled" : isObject(cache) && cache.Miss !== undefined ? `cache miss (${safe(kind(cache.Miss))})` : `cache ${safe(kind(cache))}`;
  let outcomeText = `outcome ${safe(kind(outcome))}`;
  if (isObject(outcome) && isObject(outcome.Failed)) outcomeText = `FAILED exit ${Number.isInteger(outcome.Failed.exit_code) ? outcome.Failed.exit_code : "?"}`;
  else if (isObject(outcome) && outcome.SpawnError !== undefined) outcomeText = `SPAWN ERROR (${safe(kind(outcome.SpawnError))})`;
  else if (isObject(outcome) && isObject(outcome.Success)) {
    const infra = outcome.Success.infra_error;
    outcomeText = infra ? `success with infrastructure error (${safe(kind(infra))})` : "success";
  }
  return `  ${name}: ${outcomeText}; ${cacheText}`;
}

/** The summary lines, failed tasks first. */
export function describeSummary(summary: unknown): string[] {
  if (!isObject(summary) || !Array.isArray(summary.tasks)) return ["  (unrecognized summary format)"];
  const lines = summary.tasks.slice(0, LIMITS.tasks).map(describeTask);
  const failed = lines.filter(line => /FAILED|SPAWN ERROR|infrastructure error/u.test(line));
  return [
    `  exit code ${Number.isInteger(summary.exit_code) ? summary.exit_code : "?"}; ${summary.tasks.length} task(s), ${failed.length} not successful`,
    ...failed, ...lines.filter(line => !failed.includes(line)),
    ...(summary.tasks.length > LIMITS.tasks ? [`  (${summary.tasks.length - LIMITS.tasks} more not shown)`] : []),
  ];
}

interface PhaseEvent { t: string; ms: number; pid: number; event: string; file: string | null; test?: string; state?: string }

/** Tail, still-open phases at the end of the log, and the longest silences between events. */
export function describePhases(text: string, runEndMs?: number): string[] {
  const events: PhaseEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as Json;
      const ms = Date.parse(String(entry.t));
      if (!Number.isFinite(ms) || typeof entry.event !== "string") continue;
      events.push({ t: String(entry.t), ms, pid: Number(entry.pid), event: entry.event, file: typeof entry.file === "string" ? entry.file : null, test: typeof entry.test === "string" ? entry.test : undefined, state: typeof entry.state === "string" ? entry.state : undefined });
    } catch { /* a torn final line from a killed worker */ }
  }
  if (events.length === 0) return ["  (no phase events recorded)"];
  events.sort((a, b) => a.ms - b.ms);
  const label = (e: PhaseEvent) => `${e.t} pid ${e.pid} ${safe(e.event)} ${safe(e.file ?? "-")}${e.test ? ` > ${safe(e.test, 160)}` : ""}${e.state ? ` [${safe(e.state)}]` : ""}`;
  // A phase is open when its start has no matching end: what each worker was inside when the log stopped.
  const open = new Map<string, PhaseEvent>();
  for (const e of events) {
    const key = `${e.pid}|${e.file}|${e.event.startsWith("test-") ? e.test : ""}`;
    if (e.event.endsWith("-start")) open.set(`${e.event.replace("-start", "")}|${key}`, e);
    else open.delete(`${e.event.replace("-end", "")}|${key}`);
  }
  const gaps = events.slice(1).map((e, i) => ({ seconds: (e.ms - events[i]!.ms) / 1000, before: events[i]!, after: e }))
    .toSorted((a, b) => b.seconds - a.seconds).slice(0, LIMITS.gaps);
  const last = events.at(-1)!;
  return [
    `  ${events.length} event(s), ${events[0]!.t} to ${last.t}`,
    ...(runEndMs === undefined ? [] : [`  ${((runEndMs - last.ms) / 1000).toFixed(1)}s from the last event to the end of the vp run (last-summary.json written)`]),
    `  open at the end of the log (${open.size}):`,
    ...[...open.values()].slice(0, LIMITS.open).map(e => `    ${label(e)}`),
    "  longest gaps between consecutive events:",
    ...gaps.map(g => `    ${g.seconds.toFixed(1)}s after ${label(g.before)}`),
    `  last ${Math.min(LIMITS.tail, events.length)} event(s):`,
    ...events.slice(-LIMITS.tail).map(e => `    ${label(e)}`),
  ];
}

/** The newest `last-summary.json` under the task cache, or null. */
function findSummary(root: string): string | null {
  let best: { path: string; mtime: number } | null = null;
  let versions: string[] = [];
  try { versions = readdirSync(taskCache(root)); } catch { return null; }
  for (const version of versions) {
    const path = join(taskCache(root), version, "last-summary.json");
    try {
      const stat = lstatSync(path);
      if (stat.isFile() && (!best || stat.mtimeMs > best.mtime)) best = { path, mtime: stat.mtimeMs };
    } catch { /* absent in this version directory */ }
  }
  return best?.path ?? null;
}

/** File text if it is a regular file written at or after `since`, else why not. */
function readSince(path: string, since: number, maxBytes: number): { text: string } | { withheld: string } {
  let stat;
  try { stat = lstatSync(path); } catch { return { withheld: "not found" }; }
  if (!stat.isFile()) return { withheld: "not a regular file" };
  if (stat.mtimeMs < since) return { withheld: "older than this test step's start marker, so it describes an earlier invocation" };
  if (stat.size > maxBytes) return { withheld: `larger than ${maxBytes} bytes` };
  return { text: readFileSync(path, "utf8") };
}

/** The whole report. `root` is the repository root; tests point it at a fixture tree. */
export function report(argv: string[], root = ROOT): string[] {
  const at = argv.indexOf("--since");
  const marker = at >= 0 ? argv[at + 1] : undefined;
  if (!marker) return ["last-run-report: usage: last-run-report.ts --since <marker-file>"];
  let since: number;
  try { since = lstatSync(marker).mtimeMs; } catch { return ["last-run-report: the start marker is missing; nothing can be attributed to this run, so nothing is shown"]; }
  const lines = ["last-run-report: this test step's vp task outcomes (from last-summary.json)"];
  const summaryPath = findSummary(root);
  const summary = summaryPath ? readSince(summaryPath, since, 4 * 1024 * 1024) : { withheld: "not found" };
  const runEndMs = summaryPath && !("withheld" in summary) ? lstatSync(summaryPath).mtimeMs : undefined;
  if ("withheld" in summary) lines.push(`  withheld: ${summary.withheld}`);
  else {
    try { lines.push(...describeSummary(JSON.parse(summary.text))); } catch { lines.push("  (summary is not valid JSON)"); }
  }
  lines.push("last-run-report: integration-tests phase timings (integration-phases.jsonl)");
  const phases = readSince(phaseLog(root), since, LIMITS.phaseBytes);
  if ("withheld" in phases) lines.push(`  withheld: ${phases.withheld}`);
  else lines.push(...describePhases(phases.text, runEndMs));
  return lines;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(`${report(process.argv.slice(2)).join("\n")}\n`); } catch { process.stdout.write("last-run-report: failed to build the report\n"); }
  process.exitCode = 0;
}
