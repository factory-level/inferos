// Three-way reconciliation of the files InferOS copied into a wrapper (#75).
//
// The three versions are the original InferOS wrote (base), the wrapper's working copy (customer)
// and the target revision's text (new). The base is not stored in the wrapper: `.inferos/files.json`
// records each copy's upstream `source` path and the sha256 of what was written, and the submodule
// carries InferOS's history, so the base is the blob at that path whose hash matches. When no
// revision in reach has it, the file falls back to needs-review.
//
// Merge eligibility is decided per file (`mergePolicy`):
// - `.inferos/` helpers are operator code; an edited copy is a private core patch and is never merged.
// - `fixtures/` hold the customer's board data; upstream fixture changes are only reported.
// - Binary files (a NUL byte or invalid UTF-8) are replaced only while unedited.
// - JSON (blueprint.json and other .json starters) merges as text, and a merge whose result does not
//   parse is a conflict.
// - Other text (skills, SOPs, blueprint sources, README, .gitignore) merges as text.
//
// Merging runs `git merge-file --diff3` on temporary copies, so nothing here writes into the wrapper:
// callers decide whether a clean result is applied and where a conflicted one is staged.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "./wrapper-files.ts";

/** How an edited file may be reconciled. */
export type MergePolicy =
  | { kind: "text" }
  | { kind: "json" }
  | { kind: "review"; reason: string };

/** Whether content is text the line merge can handle: valid UTF-8 without NUL bytes. */
export function isText(content: Buffer): boolean {
  if (content.includes(0)) return false;
  try { new TextDecoder("utf-8", { fatal: true }).decode(content); return true; } catch { return false; }
}

/** Merge eligibility for one wrapper path; see the module comment. */
export function mergePolicy(path: string, ...contents: Buffer[]): MergePolicy {
  if (path.startsWith(".inferos/")) return { kind: "review", reason: "InferOS operator code is not merged automatically; an edited helper is a private patch" };
  if (path.startsWith("fixtures/")) return { kind: "review", reason: "fixtures hold the customer's board data; upstream fixture changes are reported, never merged" };
  if (!contents.every(isText)) return { kind: "review", reason: "binary content is not merged" };
  return path.endsWith(".json") ? { kind: "json" } : { kind: "text" };
}

const MAX_HISTORY = 200;

const show = (repository: string, revision: string, path: string): Buffer | null => {
  const result = spawnSync("git", ["-C", repository, "show", `${revision}:${path}`], { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
};

/**
 * The original text of a copy: the blob at `source` whose sha256 is `hash`, looked up first at the
 * given revisions (normally the recorded revision and the current pin) and then through the last
 * commits that touched `source` before them. `repository` is the wrapper's submodule, which holds
 * InferOS's history. Returns null when no reachable revision has it.
 */
export function findBase(repository: string, source: string, hash: string, revisions: string[]): Buffer | null {
  const tried = new Set<string>();
  const attempt = (revision: string) => {
    if (tried.has(revision)) return null;
    tried.add(revision);
    const content = show(repository, revision, source);
    return content && sha256(content) === hash ? content : null;
  };
  for (const revision of revisions) {
    const found = attempt(revision);
    if (found) return found;
  }
  for (const revision of revisions) {
    const log = spawnSync("git", ["-C", repository, "log", "--format=%H", `-n${MAX_HISTORY}`, revision, "--", source], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (log.status !== 0) continue;
    for (const commit of log.stdout.split("\n").filter(Boolean)) {
      const found = attempt(commit);
      if (found) return found;
    }
  }
  return null;
}

/** The result of merging one file. */
export type MergeResult =
  | { clean: true; content: Buffer }
  /** `content` is the merge with diff3 conflict markers, for review; never written over the customer's file. */
  | { clean: false; content: Buffer; conflicts: number; reason: string };

/** Labels shown in conflict markers. */
export interface MergeLabels { current: string; base: string; other: string }

/** Three-way merge of `current` (the customer) and `other` (the target) from `base`, by `git merge-file`. */
export function mergeThreeWay(policy: MergePolicy, current: Buffer, base: Buffer, other: Buffer, labels: MergeLabels): MergeResult {
  if (policy.kind === "review") throw new Error("mergeThreeWay called for a review-only file");
  const directory = mkdtempSync(join(tmpdir(), "inferos-merge-"));
  try {
    const paths = ["current", "base", "other"].map(name => join(directory, name));
    [current, base, other].forEach((content, index) => writeFileSync(paths[index]!, content));
    const result = spawnSync("git", ["merge-file", "-p", "--diff3", "-L", labels.current, "-L", labels.base, "-L", labels.other, ...paths],
      { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
    const status = result.status ?? 255;
    if (status > 127 || result.error) throw new Error("git merge-file failed");
    const content = result.stdout;
    if (status > 0) return { clean: false, content, conflicts: status, reason: `${status} conflicting change${status === 1 ? "" : "s"} between the wrapper's edits and the target` };
    if (policy.kind === "json") {
      try { JSON.parse(content.toString("utf8")); }
      catch { return { clean: false, content, conflicts: 1, reason: "the line merge is not valid JSON" }; }
    }
    return { clean: true, content };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Read a file's bytes from a directory, or undefined when it does not exist. */
export function readBytes(path: string): Buffer | undefined {
  try { return readFileSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
