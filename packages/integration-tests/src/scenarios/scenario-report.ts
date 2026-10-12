// What every programmed local scenario's report shares: the loopback-only target rule, the case
// record, the isolation check and the verdict, and writing a report that holds no token. Each
// scenario keeps its own contract and data beside its own module; this is not a scenario runner.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Refuse any target that is not a plain-HTTP loopback Workshop. */
export function assertLoopbackTarget(target: URL, scenarioId: string): URL {
  if (target.protocol !== "http:" || !LOOPBACK_HOSTS.has(target.hostname)) {
    throw new Error(`Scenario ${scenarioId} runs only against a loopback Workshop, not ${target.origin}`);
  }
  return target;
}

/** One case's outcome as the report records it. */
export type ScenarioCase = {
  name: string;
  outcome: "PASS" | "FAIL";
  observed: Record<string, unknown>;
  failure?: string;
};

/** Outbound requests nothing answered in process; any one, or an unchecked run, fails the verdict. */
export type ScenarioIsolation = { checked: boolean; unmockedRequests: number | null; origins: string[] };

/** A scenario's bounded, credential-free report. */
export type ScenarioReport<Id extends string = string> = {
  scenario: { id: Id; version: number };
  revision: { commit: string; dirty: boolean | null };
  source: "mock";
  liveProviderProof: false;
  target: "wrangler createTestHarness on loopback";
  boundaries: { mocked: string[]; real: string[] };
  fixtures: Record<string, unknown>;
  isolation: ScenarioIsolation;
  cases: ScenarioCase[];
  verdict: "PASS" | "FAIL";
};

/**
 * The isolation check from the interceptor's unanswered calls, or unchecked when the harness did
 * not shut down cleanly enough to read them. Only the count and origins: a full URL could carry
 * query data.
 */
export function isolationOf(unmocked: string[] | undefined): ScenarioIsolation {
  return unmocked === undefined ? { checked: false, unmockedRequests: null, origins: [] }
    : { checked: true, unmockedRequests: unmocked.length,
      origins: [...new Set(unmocked.map(call => new URL(call.slice(call.indexOf(" ") + 1)).origin))] };
}

/**
 * PASS only for every expected case recorded in order and passing, and an isolation check that ran
 * and found no unanswered request.
 */
export function scenarioVerdict(expected: readonly string[], cases: readonly ScenarioCase[],
    isolation: ScenarioIsolation): ScenarioReport["verdict"] {
  return cases.map(entry => entry.name).join() === expected.join() && cases.every(entry => entry.outcome === "PASS")
    && isolation.checked && isolation.unmockedRequests === 0 ? "PASS" : "FAIL";
}

/** The tested commit and whether the tree had local changes, from git where it can be read. */
export function scenarioRevision(cwd: string): ScenarioReport["revision"] {
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  try { return { commit: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain").length > 0 }; }
  catch { return { commit: "unknown", dirty: null }; }
}

/** Write `report` to `path`, refusing if any of `secrets` would appear in it, and print one line. */
export function writeScenarioReport(path: string, report: ScenarioReport, secrets: readonly string[]): void {
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (secrets.some(secret => secret && text.includes(secret))) {
    throw new Error("The scenario report would contain a session token");
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  console.info(`Scenario ${report.scenario.id} v${report.scenario.version} (mock, not live provider proof): ` +
    `${report.verdict} [${report.cases.map(entry => `${entry.name}=${entry.outcome}`).join(", ")}; ` +
    `unmocked requests ${report.isolation.unmockedRequests}] -> ${path}`);
}
