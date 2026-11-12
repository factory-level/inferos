#!/usr/bin/env node
// Factory node 2, `security`: SAST (Semgrep), secrets (gitleaks), SCA (OSV-Scanner) and a
// filesystem scan (Trivy: vulnerabilities, misconfigurations, secrets), each in its own container.
//
//   node scripts/ci/security.ts [--run-id ID] [--base REF] [--update-baseline]
//
// Gate: every tool ran, and no high or critical finding is new against the reviewed baseline
// `scripts/ci/security-baseline.json`. A finding is identified by a fingerprint that survives line
// moves (tool, rule or advisory, and file or package), so reformatting does not reopen it.
// `--update-baseline` rewrites the baseline from the current findings; the result is a proposal a
// person reviews in the diff, never a way to make a red run green unseen.
//
// gitleaks scans the commits since `--base` (default origin/main) and, separately, a copy of the
// working tree's changed and untracked files, so an agent's uncommitted patch is covered too.
// Containers mount the checkout read-only, run as this user, publish no ports and never get the
// Docker socket.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { dockerRun, exec, finish, nodeContext, runAsMain, type CommandRecord, type NodeContext } from "./lib.ts";

export type Severity = "critical" | "high" | "medium" | "low" | "unknown";

/** One normalized finding. Only `fingerprint` and `severity` decide the gate. */
export interface Finding {
  tool: string;
  id: string;
  location: string;
  severity: Severity;
  fingerprint: string;
}

/** The reviewed baseline: findings a person accepted, by fingerprint. */
export interface Baseline {
  note: string;
  accepted: { fingerprint: string; severity: Severity; note?: string }[];
}

export const BASELINE_PATH = join("scripts", "ci", "security-baseline.json");

const gated = (severity: Severity) => severity === "critical" || severity === "high";

/** Findings that fail the gate: high or critical and not accepted in the baseline. */
export function newFindings(findings: Finding[], baseline: Baseline): Finding[] {
  const accepted = new Set(baseline.accepted.map(entry => entry.fingerprint));
  return findings.filter(finding => gated(finding.severity) && !accepted.has(finding.fingerprint));
}

const rel = (root: string, path: string) => (path.startsWith("/") ? relative(root, path) : path);

/** Semgrep JSON: `ERROR` is high, `WARNING` medium, `INFO` low. */
export function parseSemgrep(report: { results?: { check_id: string; path: string; extra?: { severity?: string } }[] }, root: string): Finding[] {
  const map: Record<string, Severity> = { ERROR: "high", WARNING: "medium", INFO: "low" };
  return (report.results ?? []).map(result => {
    const location = rel(root, result.path);
    return { tool: "semgrep", id: result.check_id, location, severity: map[result.extra?.severity ?? ""] ?? "unknown", fingerprint: `semgrep:${result.check_id}:${location}` };
  });
}

/** gitleaks JSON: every leak is critical. The file, not the commit, identifies it. */
export function parseGitleaks(report: { RuleID: string; File: string }[] | null, root: string): Finding[] {
  return (report ?? []).map(leak => {
    const location = rel(root, leak.File);
    return { tool: "gitleaks", id: leak.RuleID, location, severity: "critical" as const, fingerprint: `gitleaks:${leak.RuleID}:${location}` };
  });
}

/** A CVSS score (as OSV reports `max_severity`) to a severity band. */
export function cvssSeverity(score: string | undefined): Severity {
  const value = Number(score);
  if (!score || Number.isNaN(value)) return "unknown";
  return value >= 9 ? "critical" : value >= 7 ? "high" : value >= 4 ? "medium" : "low";
}

/** OSV-Scanner JSON: one finding per advisory group and package. */
export function parseOsv(report: { results?: { packages: { package: { name: string; version: string }; groups: { ids: string[]; max_severity?: string }[] }[] }[] }): Finding[] {
  const findings: Finding[] = [];
  for (const result of report.results ?? []) {
    for (const pkg of result.packages) {
      for (const group of pkg.groups) {
        const id = group.ids[0]!;
        findings.push({ tool: "osv", id, location: `${pkg.package.name}@${pkg.package.version}`, severity: cvssSeverity(group.max_severity), fingerprint: `osv:${id}:${pkg.package.name}` });
      }
    }
  }
  return findings;
}

type TrivyItem = { VulnerabilityID?: string; ID?: string; RuleID?: string; PkgName?: string; Severity?: string };

/** Trivy JSON: vulnerabilities by advisory and package; misconfigurations and secrets by rule and file. */
export function parseTrivy(report: { Results?: { Target: string; Vulnerabilities?: TrivyItem[]; Misconfigurations?: TrivyItem[]; Secrets?: TrivyItem[] }[] }): Finding[] {
  const severity = (value?: string): Severity => (["critical", "high", "medium", "low"].includes((value ?? "").toLowerCase()) ? value!.toLowerCase() as Severity : "unknown");
  const findings: Finding[] = [];
  for (const result of report.Results ?? []) {
    for (const v of result.Vulnerabilities ?? []) {
      findings.push({ tool: "trivy", id: v.VulnerabilityID!, location: `${result.Target}:${v.PkgName}`, severity: severity(v.Severity), fingerprint: `trivy:${v.VulnerabilityID}:${v.PkgName}` });
    }
    for (const item of [...(result.Misconfigurations ?? []), ...(result.Secrets ?? [])]) {
      const id = item.ID ?? item.RuleID!;
      findings.push({ tool: "trivy", id, location: result.Target, severity: severity(item.Severity), fingerprint: `trivy:${id}:${result.Target}` });
    }
  }
  return findings;
}

/** Fingerprints are deduplicated: one advisory reaching a package by three paths is one finding. */
export function dedupe(findings: Finding[]): Finding[] {
  return [...new Map(findings.map(finding => [finding.fingerprint, finding])).values()];
}

function readJson<T>(path: string, fallback: T): T {
  try {
    const text = readFileSync(path, "utf8").trim();
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

/** Copy the working tree's changed and untracked files (not deletions) for gitleaks' `dir` scan. */
function stageWorkingChanges(ctx: NodeContext, into: string): string[] {
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all", "-z"], { cwd: ctx.root, encoding: "utf8" }).stdout ?? "";
  const files = status.split("\0").filter(Boolean).map(line => line.slice(3)).filter(path => !path.startsWith(".factory/") && existsSync(join(ctx.root, path)));
  for (const file of files) {
    mkdirSync(dirname(join(into, file)), { recursive: true });
    copyFileSync(join(ctx.root, file), join(into, file));
  }
  return files;
}

export async function main(argv: string[]): Promise<number> {
  const update = argv.includes("--update-baseline");
  const ctx = nodeContext("security", argv.filter(arg => arg !== "--update-baseline"));
  const root = ctx.root;
  const common = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" }).stdout.trim();
  // A worktree's .git points into the common dir, so it is mounted at its own path too.
  const gitMounts = ["-v", `${common}:${common}:ro`, "-v", `${root}:${root}:ro`, "-w", root];
  const out = ["-v", `${ctx.dir}:/out`];
  const changes = join(ctx.dir, "working-changes");
  mkdirSync(changes, { recursive: true });
  const changed = stageWorkingChanges(ctx, changes);
  const trivyCache = join(root, ".factory", "cache", "trivy");
  mkdirSync(trivyCache, { recursive: true });

  const runs: { name: string; argv: string[]; okCodes: number[]; stdoutFile?: string }[] = [
    { name: "semgrep", okCodes: [0], argv: dockerRun(ctx, [...gitMounts, ...out, "semgrep/semgrep:latest", "semgrep", "scan", "--config", "p/default", "--metrics=off", "--json", "--output", "/out/semgrep.json", "--quiet", root]) },
    { name: "gitleaks-commits", okCodes: [0], argv: dockerRun(ctx, [...gitMounts, ...out, "zricethezav/gitleaks:latest", "git", `--log-opts=${ctx.baseRef}..HEAD`, "--report-format", "json", "--report-path", "/out/gitleaks-commits.json", "--exit-code", "0", root]) },
    { name: "gitleaks-working-tree", okCodes: [0], argv: dockerRun(ctx, ["-v", `${changes}:/changes:ro`, ...out, "zricethezav/gitleaks:latest", "dir", "--report-format", "json", "--report-path", "/out/gitleaks-working-tree.json", "--exit-code", "0", "/changes"]) },
    // Exit 1 means "vulnerabilities found", which the gate judges; other codes are tool failures.
    { name: "osv", okCodes: [0, 1], stdoutFile: "osv.json", argv: dockerRun(ctx, ["-v", `${root}:/src:ro`, "ghcr.io/google/osv-scanner:latest", "scan", "source", "--lockfile", "/src/pnpm-lock.yaml", "--format", "json"]) },
    { name: "trivy", okCodes: [0], argv: dockerRun(ctx, ["-v", `${root}:/src:ro`, ...out, "-v", `${trivyCache}:/cache`, "aquasec/trivy:latest", "fs", "--cache-dir", "/cache", "--scanners", "vuln,misconfig,secret", "--skip-dirs", "**/node_modules", "--skip-dirs", "**/.wrangler", "--skip-dirs", "/src/.factory", "--format", "json", "--output", "/out/trivy.json", "--exit-code", "0", "/src"]) },
  ];
  const records: CommandRecord[] = [];
  const toolFailures: string[] = [];
  for (const run of runs) {
    const record = await exec(ctx, run.argv, { log: `${run.name}.log`, stdoutFile: run.stdoutFile });
    records.push(record);
    if (!run.okCodes.includes(record.exitCode)) toolFailures.push(`${run.name} exited ${record.exitCode}`);
  }
  const findings = dedupe([
    ...parseSemgrep(readJson(join(ctx.dir, "semgrep.json"), {}), root),
    ...parseGitleaks(readJson(join(ctx.dir, "gitleaks-commits.json"), []), root),
    // The copy lives at /changes/<path>; report the path in the checkout.
    ...parseGitleaks(readJson<{ RuleID: string; File: string }[]>(join(ctx.dir, "gitleaks-working-tree.json"), []).map(leak => ({ ...leak, File: leak.File.replace(/^\/changes\//, "") })), root),
    ...parseOsv(readJson(join(ctx.dir, "osv.json"), {})),
    ...parseTrivy(readJson(join(ctx.dir, "trivy.json"), {})),
  ]);
  writeFileSync(join(ctx.dir, "findings.json"), JSON.stringify(findings, null, 2) + "\n");
  const baselinePath = join(root, BASELINE_PATH);
  if (update) {
    const baseline: Baseline = {
      note: "Accepted high/critical findings by fingerprint. Regenerated with `node scripts/ci/security.ts --update-baseline`; every change to this file is reviewed in its diff.",
      accepted: findings.filter(finding => gated(finding.severity)).map(({ fingerprint, severity }) => ({ fingerprint, severity })).toSorted((a, b) => a.fingerprint.localeCompare(b.fingerprint)),
    };
    writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + "\n");
  }
  const baseline = readJson<Baseline>(baselinePath, { note: "missing", accepted: [] });
  const fresh = newFindings(findings, baseline);
  writeFileSync(join(ctx.dir, "new-findings.json"), JSON.stringify(fresh, null, 2) + "\n");
  const bySeverity = (list: Finding[]) => Object.fromEntries((["critical", "high", "medium", "low", "unknown"] as const).map(s => [s, list.filter(f => f.severity === s).length]));
  for (const finding of fresh) console.error(`[factory] NEW ${finding.severity} ${finding.tool} ${finding.id} at ${finding.location}`);
  return finish(ctx, {
    node: "security", ok: toolFailures.length === 0 && fresh.length === 0,
    gate: "every scanner ran and no high/critical finding is new against scripts/ci/security-baseline.json",
    commands: records,
    details: { baseRef: ctx.baseRef, workingTreeFilesScanned: changed.length, toolFailures, findings: bySeverity(findings), new: bySeverity(fresh), baselineAccepted: baseline.accepted.length, baselineUpdated: update },
  });
}

await runAsMain(import.meta.url, main);
