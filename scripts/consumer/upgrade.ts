// Plan or apply moving a wrapper's InferOS pin to a reviewed commit.
//
//   node scripts/consumer/upgrade.ts <wrapper> <full-sha> [--plan|--apply [--branch <name> [--open-pr <owner/repo>]]]
//
// Runs from an InferOS checkout at the target revision, because the target renders its own templates
// and judges its own configuration support. A wrapper's `pnpm inferos upgrade <sha>` creates that
// checkout as a temporary worktree of its submodule and runs this file from it; a wrapper whose
// helpers predate the command runs it from any InferOS checkout at the target revision.
//
// `--plan` (the default) writes nothing. `--apply` refuses a dirty tree, then moves the submodule
// checkout and gitlink, regenerates `generated` files, refreshes unedited copies, merges edited ones
// three-way where `reconcile.ts` allows (a conflicted merge, or an unmergeable edit, leaves the
// wrapper's file in place with the merge or the target's text under `.inferos/state/upgrade/<sha>/`),
// never touches customer-owned files that were not copied from upstream, updates
// `upstream.revision`, `.inferos/bootstrap.json` and `.inferos/files.json`, and stages the result.
// It never deploys, migrates the configuration schema or contacts anything but Git.
//
// `--branch` makes it a reviewed upgrade: the same apply on a new branch, committed with a summary of
// code, configuration, capability, connection, migration and action-kind changes and the
// reconciliation (`upgrade-review.ts`), after a scan that refuses to commit anything non-portable.
// `--open-pr` then pushes the branch to `origin` and opens a PR with `gh`. Nothing is ever merged.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrateConsumerConfig, parseConsumerConfig } from "./config.ts";
import { findBase, isText, mergePolicy, mergeThreeWay, readBytes } from "./reconcile.ts";
import { checkConsumer, inferOpsGatekeeperSelected, unsupportedCapabilities } from "./runtime.ts";
import { localSecretValues, renderReview, reviewUpgrade, scanPortable, type ReconcileLine } from "./upgrade-review.ts";
import {
  FILES_MANIFEST, FILES_SCHEMA_VERSION, managedFiles, readFilesManifest, renderFilesManifest, renderPackageJson, sha256, WRAPPER_LOCKFILE,
  type FileEntry, type FilesManifest,
} from "./wrapper-files.ts";

/** This checkout: the target revision whose templates and parser the upgrade uses. */
const REPO = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** What an upgrade does to one file. */
export type FileAction =
  /** Generated: rewritten from the target. */
  | "regenerate"
  /** Copied template, unedited since InferOS wrote it: replaced with the target's version. */
  | "update"
  /** New in the target (or never written): created. */
  | "add"
  /** Already identical to the target. */
  | "unchanged"
  /** Edited, and the wrapper's edits and the target's changes merged cleanly: the merge is written. */
  | "merge"
  /** Edited, and the three-way merge conflicts: kept as is; the merge with conflict markers is staged for review. */
  | "conflict"
  /** Edited and not mergeable (review-only file, or no original), deleted, or unknown baseline: kept as is; the target's text is staged for review. */
  | "needs-review"
  /** The target no longer ships this template; the wrapper's copy is kept. */
  | "removed-upstream"
  /** A customer-owned starter whose upstream source changed and that is not reconciled (the fixture, a deleted or unmergeable file); kept as is, the target's text staged. */
  | "upstream-changed";

/** One file in the plan. */
export interface FilePlan {
  path: string;
  class: FileEntry["class"];
  action: FileAction;
  reason?: string;
  /** The upstream path the target's version comes from, when it is a copy. */
  source?: string;
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** The configuration review: whether the target parses the wrapper's file, and what `config migrate` would do. */
export interface ConfigReview {
  parses: boolean;
  error?: string;
  schemaVersion: 1 | 2 | null;
  /** Capabilities the file enables that the target does not ship. */
  unsupported: string[];
  /** For a version 1 file: whether `pnpm inferos config migrate` would succeed against the target. Apply never runs it. */
  migrate: { applicable: false } | { applicable: true; available: boolean; command: string; blocked: string[]; capabilities: unknown } | null;
}

function reviewConfig(root: string): ConfigReview {
  let input: unknown;
  try { input = JSON.parse(readFileSync(join(root, "inferos.config.json"), "utf8")); }
  catch { return { parses: false, error: "inferos.config.json is not valid JSON", schemaVersion: null, unsupported: [], migrate: null }; }
  let config;
  try { config = parseConsumerConfig(input); }
  catch (error) { return { parses: false, error: (error as Error).message, schemaVersion: null, unsupported: [], migrate: null }; }
  const unsupported = unsupportedCapabilities(config, REPO);
  if (config.schemaVersion === 2) return { parses: true, schemaVersion: 2, unsupported, migrate: { applicable: false } };
  // The same computation `pnpm inferos config migrate` makes, against the target. Advisory: apply never migrates.
  const migrated = parseConsumerConfig(migrateConsumerConfig(input, { inferOpsGatekeeperSelected: inferOpsGatekeeperSelected(root, REPO) }));
  const blocked = unsupportedCapabilities(migrated, REPO);
  return {
    parses: true, schemaVersion: 1, unsupported,
    migrate: { applicable: true, available: blocked.length === 0, command: "pnpm inferos config migrate", blocked,
      capabilities: migrated.schemaVersion === 2 ? migrated.capabilities : null },
  };
}

/** What the planner decided for each file: bytes to write, bytes to stage for review, the new record entry. */
interface FileWork { writes: Map<string, Buffer>; stages: Map<string, Buffer>; baselines: Map<string, FileEntry> }

/** Compare the wrapper's files with what the target would write, reconciling edited copies three-way. */
function planFiles(root: string, record: FilesManifest | null, from: string | null, revision: string) {
  const managed = managedFiles(REPO);
  const plans: FilePlan[] = [];
  const work: FileWork = { writes: new Map(), stages: new Map(), baselines: new Map() };
  const history = join(root, "inferos");
  const revisions = [record?.revision, from].filter((value): value is string => typeof value === "string");
  const labels = { current: "wrapper", base: "original", other: `inferos ${revision.slice(0, 12)}` };
  const add = (plan: FilePlan, effect: { write?: Buffer; stage?: Buffer; baseline?: Buffer } = {}) => {
    plans.push(plan);
    if (effect.write) work.writes.set(plan.path, effect.write);
    if (effect.stage) work.stages.set(plan.path, effect.stage);
    if (effect.baseline) work.baselines.set(plan.path, { class: plan.class, sha256: sha256(effect.baseline), ...(plan.source ? { source: plan.source } : {}) });
  };
  /** An edited copy: merged from its original when policy and history allow, otherwise left for review. */
  const reconcile = (path: string, fileClass: FileEntry["class"], current: Buffer, next: Buffer, entry: FileEntry | undefined, source: string | undefined) => {
    const held: FileAction = fileClass === "customer-owned" ? "upstream-changed" : "needs-review";
    const base = (plan: FilePlan) => ({ ...plan, ...(source ? { source } : {}) });
    const policy = mergePolicy(path, current, next);
    if (policy.kind === "review") return add(base({ path, class: fileClass, action: held, reason: `edited; ${policy.reason}` }), { stage: next });
    const original = entry?.source && entry.sha256 ? findBase(history, entry.source, entry.sha256, revisions) : null;
    if (!original || !isText(original)) {
      return add(base({ path, class: fileClass, action: held, reason: "edited, and the original text is not in the submodule's history, so it cannot be merged" }), { stage: next });
    }
    const merged = mergeThreeWay(policy, current, original, next, labels);
    if (merged.clean) return add(base({ path, class: fileClass, action: "merge", reason: "the wrapper's edits and the target's changes merged cleanly" }), { write: merged.content, baseline: next });
    add(base({ path, class: fileClass, action: "conflict", reason: merged.reason }), { stage: merged.content });
  };

  for (const [path, file] of managed) {
    const current = readBytes(join(root, path));
    const recorded = record?.files[path];
    const source = file.source ? { source: file.source } : {};
    if (file.class === "generated") {
      // package.json: only the managed keys are rewritten; the customer's own keys and scripts stay.
      const next = Buffer.from(renderPackageJson(REPO, current?.toString("utf8")));
      const same = current?.equals(next) ?? false;
      add({ path, class: "generated", action: same ? "unchanged" : "regenerate", ...source }, { ...(same ? {} : { write: next }), baseline: next });
      continue;
    }
    const next = Buffer.from(file.content);
    const plan = (action: FileAction, reason?: string): FilePlan => ({ path, class: "copied-template", action, ...(reason ? { reason } : {}), ...source });
    if (current?.equals(next)) add(plan("unchanged"), { baseline: next });
    else if (current === undefined) {
      if (recorded) add(plan("needs-review", "deleted in the wrapper; not restored"), { stage: next });
      else add(plan("add"), { write: next, baseline: next });
    } else if (!record) add(plan("needs-review", `no ${FILES_MANIFEST} baseline, so a local edit cannot be ruled out`), { stage: next });
    else if (!recorded?.sha256) add(plan("needs-review", "no recorded baseline for this file"), { stage: next });
    else if (sha256(current) === recorded.sha256) add(plan("update"), { write: next, baseline: next });
    else reconcile(path, "copied-template", current, next, recorded, file.source);
  }
  for (const [path, entry] of Object.entries(record?.files ?? {})) {
    if (entry.class === "copied-template" && !managed.has(path)) {
      add({ path, class: "copied-template", action: "removed-upstream", reason: "the target no longer ships this file; the wrapper's copy is kept" });
    }
    if (entry.class !== "customer-owned" || !entry.source || !entry.sha256) continue;
    // A starter copied from upstream: reconciled like a template, except that review-only files are
    // reported `upstream-changed` and a starter the customer deleted stays deleted.
    const upstream = readBytes(join(REPO, entry.source));
    const plan = (action: FileAction, reason?: string): FilePlan => ({ path, class: "customer-owned", action, source: entry.source, ...(reason ? { reason } : {}) });
    if (upstream === undefined) { add(plan("removed-upstream", "upstream no longer ships the starter this file was copied from; the wrapper's file is kept")); continue; }
    if (sha256(upstream) === entry.sha256) continue;
    const current = readBytes(join(root, path));
    if (current === undefined) add(plan("upstream-changed", "deleted in the wrapper; the upstream change is not applied"), { stage: upstream });
    else if (current.equals(upstream)) add(plan("update", "already matches the target"), { baseline: upstream });
    else if (sha256(current) !== entry.sha256) reconcile(path, "customer-owned", current, upstream, entry, entry.source);
    else {
      const policy = mergePolicy(path, current, upstream);
      // Unedited: take the target's version, unless the file is review-only (the fixture).
      if (policy.kind === "review" && path.startsWith("fixtures/")) add(plan("upstream-changed", policy.reason), { stage: upstream });
      else add(plan("update", "unedited starter; replaced with the target's version"), { write: upstream, baseline: upstream });
    }
  }
  return { plans, work };
}

/** The rollback limit every upgrade carries, stated once. */
export const STATE_ROLLBACK =
  "Local Wrangler state (inferos/.wrangler/state) is kept across the upgrade. Durable Object and storage migrations a newer pin applies on its next start are not reversible: to return to an older pin, revert the upgrade commit and reset local state with pnpm inferos recover state --apply. Cloud state is not touched.";

/**
 * The blocker for a dirty wrapper, naming what is dirty. An untracked `pnpm-lock.yaml` gets its own
 * hint: pnpm writes it before running any script in a wrapper bootstrapped without one, and it is
 * meant to be committed, not ignored. Nothing is ignored on the caller's behalf either way.
 */
export function dirtyTreeBlocker(porcelain: string): string {
  const paths = porcelain.split("\n").filter(Boolean).map(line => line.slice(3));
  const shown = paths.length > 10 ? [...paths.slice(0, 10), `and ${paths.length - 10} more`] : paths;
  const lockfile = porcelain.split("\n").includes(`?? ${WRAPPER_LOCKFILE}`)
    ? `; ${WRAPPER_LOCKFILE} is the wrapper's lockfile, which pnpm writes before running a script: commit it (git add ${WRAPPER_LOCKFILE} && git commit)`
    : "";
  return `The wrapper has uncommitted changes (${shown.join(", ")}); commit or discard them before --apply${lockfile}`;
}

/** Read-only plan for moving the wrapper at `root` to `revision`. */
export function planUpgrade(root: string, revision: string) {
  const blockers: string[] = [];
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("The target must be a full 40-character commit SHA");
  const here = git(REPO, "rev-parse", "HEAD");
  if (here !== revision) throw new Error(`Run upgrade.ts from an InferOS checkout at ${revision} (this one is at ${here}); pnpm inferos upgrade does that for you`);
  const upstream = join(root, "inferos");
  let from: string | null = null;
  let repository: string | undefined;
  try {
    const consumer = checkConsumer(root);
    from = consumer.config.upstream.revision;
    repository = consumer.config.upstream.repository;
  } catch (error) {
    blockers.push(`The wrapper does not check at its current pin (${(error as Error).message}); run pnpm inferos recover config first`);
  }
  // Untrimmed: a porcelain line's first column is significant even when it is a space.
  const dirty = execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (dirty) blockers.push(dirtyTreeBlocker(dirty));
  const config = reviewConfig(root);
  if (!config.parses) blockers.push(`The target cannot read inferos.config.json: ${config.error}`);
  if (config.unsupported.length) blockers.push(`The target does not support enabled capabilities: ${config.unsupported.join(", ")}`);
  let relation = "same";
  if (from && from !== revision) {
    try { execFileSync("git", ["-C", upstream, "merge-base", "--is-ancestor", from, revision], { stdio: "ignore" }); relation = "forward"; }
    catch { relation = "not-a-descendant"; }
  }
  let record: FilesManifest | null;
  try { record = readFilesManifest(root); }
  catch (error) { record = null; blockers.push((error as Error).message); }
  const { plans, work } = planFiles(root, record, from, revision);
  const count = (action: FileAction) => plans.filter(plan => plan.action === action).length;
  const review = from ? reviewUpgrade(upstream, from, revision, repository) : null;
  return {
    report: {
      ok: blockers.length === 0, operation: "upgrade", mode: "plan" as "plan" | "apply", from, to: revision, blockers,
      submodule: { path: "inferos", from, to: revision, relation,
        ...(relation === "not-a-descendant" ? { warning: "The target is not a descendant of the current pin (a downgrade or a different branch); review before applying" } : {}) },
      config: { ...config, revisionField: "upstream.revision is rewritten to the target" },
      baseline: record ? FILES_MANIFEST : `missing: this wrapper predates ${FILES_MANIFEST}, so every copied file that differs from the target is needs-review`,
      files: plans.filter(plan => plan.action !== "unchanged"),
      summary: { regenerate: count("regenerate"), update: count("update"), add: count("add"), merge: count("merge"), conflict: count("conflict"),
        unchanged: count("unchanged"), needsReview: count("needs-review"), removedUpstream: count("removed-upstream"), upstreamChanged: count("upstream-changed") },
      review,
      state: STATE_ROLLBACK,
      next: ["Review the plan", "pnpm inferos upgrade <sha> --apply [--branch <name> [--open-pr <owner/repo>]]", "git diff --cached", "pnpm run setup", "pnpm inferos verify", "commit"],
    },
    plans, work, record, from,
  };
}

/** Where apply leaves files for review; `.inferos/state/` is ignored by the wrapper's Git. */
export const reviewDirectory = (revision: string) => `.inferos/state/upgrade/${revision}`;

/** Apply the plan. Throws, having written nothing, when the plan has blockers. */
export function applyUpgrade(root: string, revision: string) {
  const { report, plans, work, record, from } = planUpgrade(root, revision);
  if (report.blockers.length || !from) throw new Error(`Upgrade refused; nothing was changed: ${report.blockers.join("; ")}`);
  const upstream = join(root, "inferos");
  git(upstream, "checkout", "--quiet", "--detach", revision);
  const written: string[] = [];
  const pending: string[] = [];
  const files: Record<string, FileEntry> = { ...record?.files };
  for (const plan of plans) {
    const write = work.writes.get(plan.path);
    if (write) {
      mkdirSync(dirname(join(root, plan.path)), { recursive: true });
      writeFileSync(join(root, plan.path), write);
      written.push(plan.path);
    }
    const stage = work.stages.get(plan.path);
    if (stage) {
      // The target's text, or the conflicted merge, for the reviewer. The baseline stays as it was.
      const staged = join(root, reviewDirectory(revision), plan.path);
      mkdirSync(dirname(staged), { recursive: true });
      writeFileSync(staged, stage);
      pending.push(`${reviewDirectory(revision)}/${plan.path}`);
    }
    const baseline = work.baselines.get(plan.path);
    if (baseline) files[plan.path] = baseline;
  }
  // upstream.revision is the one InferOS-managed field of the customer's configuration.
  const configPath = join(root, "inferos.config.json");
  const configText = readFileSync(configPath, "utf8");
  const parsed = JSON.parse(configText);
  parsed.upstream.revision = revision;
  writeFileSync(configPath, configText.split(from).length === 2 ? configText.replace(from, revision) : JSON.stringify(parsed, null, 2) + "\n");
  const bootstrap = JSON.stringify({ version: 1, repository: parsed.upstream.repository, revision }, null, 2) + "\n";
  writeFileSync(join(root, ".inferos/bootstrap.json"), bootstrap);
  files[".inferos/bootstrap.json"] = { class: "generated", sha256: sha256(bootstrap) };
  const manifest: FilesManifest = { schemaVersion: FILES_SCHEMA_VERSION, revision, shared: ["inferos"],
    files: Object.fromEntries(Object.entries(files).toSorted(([a], [b]) => a < b ? -1 : 1)) };
  writeFileSync(join(root, FILES_MANIFEST), renderFilesManifest(manifest));
  git(root, "add", "--", "inferos", "inferos.config.json", ".inferos/bootstrap.json", FILES_MANIFEST, ...written);
  let check: { ok: boolean; error?: string };
  try { checkConsumer(root); check = { ok: true }; }
  catch (error) { check = { ok: false, error: (error as Error).message }; }
  return {
    ...report, ok: check.ok, mode: "apply" as const, applied: { written, needsReview: pending, staged: true, committed: false }, check,
  };
}

/** Options for a reviewed upgrade: a branch to commit to and, optionally, a GitHub repository to open a PR on. */
export interface ReviewedUpgradeOptions { branch: string; openPr?: string }

const GITHUB_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * `--apply --branch <name> [--open-pr <owner/repo>]`: create the branch from the current HEAD, apply,
 * scan the staged result for anything non-portable, and commit it with the review summary as its
 * message. The summary is also written to `.inferos/state/upgrade/<sha>/UPGRADE.md`, the PR body.
 * With `openPr`, push the branch to `origin` and open the PR with `gh`. Never merges.
 */
export function reviewedUpgrade(root: string, revision: string, { branch, openPr }: ReviewedUpgradeOptions) {
  if (spawnSync("git", ["check-ref-format", "--branch", branch], { stdio: "ignore" }).status !== 0) throw new Error(`Not a valid branch name: ${branch}`);
  if (spawnSync("git", ["-C", root, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { stdio: "ignore" }).status === 0) throw new Error(`Branch ${branch} already exists`);
  if (openPr !== undefined && !GITHUB_REPOSITORY.test(openPr)) throw new Error("--open-pr takes a GitHub repository as owner/repo");
  const planned = planUpgrade(root, revision).report;
  if (planned.blockers.length) throw new Error(`Upgrade refused; nothing was changed: ${planned.blockers.join("; ")}`);
  const base = git(root, "rev-parse", "--abbrev-ref", "HEAD");
  if (openPr !== undefined && base === "HEAD") throw new Error("--open-pr needs a branch checked out to open the PR against");
  git(root, "checkout", "--quiet", "-b", branch);
  const applied = applyUpgrade(root, revision);

  const staged = git(root, "diff", "--cached", "--name-only").split("\n").filter(Boolean);
  const diff = execFileSync("git", ["-C", root, "diff", "--cached", "--no-ext-diff", "--text"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const secrets = localSecretValues(root);
  const files: ReconcileLine[] = applied.files;
  const render = (scan: string[]) => renderReview(applied.review!, {
    relation: applied.submodule.relation, config: applied.config, check: applied.check, files, needsReview: applied.applied.needsReview, scan, rollback: STATE_ROLLBACK,
  });
  let findings = scanPortable(staged, diff, secrets);
  let body = render(findings);
  findings = [...findings, ...scanPortable([], body, secrets).map(finding => `${finding} in the summary`)];
  if (findings.length) body = render(findings);
  const title = `Upgrade InferOS to ${revision.slice(0, 12)}`;
  const directory = join(root, reviewDirectory(revision));
  mkdirSync(directory, { recursive: true });
  const summary = `${reviewDirectory(revision)}/UPGRADE.md`;
  writeFileSync(join(root, summary), `# ${title}\n\n${body}`);
  const result = { ...applied, reviewed: { branch, base, summary, committed: false as boolean, findings, commit: null as string | null, pr: null as null | { repository: string; url?: string; error?: string } } };
  if (findings.length) return { ...result, ok: false };

  const message = join(directory, "COMMIT_MESSAGE");
  writeFileSync(message, `${title}\n\n${body}`);
  git(root, "commit", "--quiet", "-F", message);
  result.reviewed.committed = true;
  result.reviewed.commit = git(root, "rev-parse", "HEAD");
  if (openPr !== undefined) {
    const push = spawnSync("git", ["-C", root, "push", "--quiet", "-u", "origin", branch], { stdio: ["ignore", "ignore", "ignore"] });
    if (push.status !== 0) {
      result.reviewed.pr = { repository: openPr, error: "git push to origin failed; push the branch and open the PR by hand" };
    } else {
      const pr = spawnSync("gh", ["pr", "create", "-R", openPr, "--base", base, "--head", branch, "--title", title, "--body-file", join(root, summary)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      result.reviewed.pr = pr.status === 0 ? { repository: openPr, url: pr.stdout.trim().split("\n").at(-1) } : { repository: openPr, error: "gh pr create failed; the branch is pushed, open the PR by hand" };
    }
  }
  return { ...result, ok: applied.ok && !result.reviewed.pr?.error };
}

const USAGE = "Usage: node scripts/consumer/upgrade.ts WRAPPER FULL_SHA [--plan|--apply [--branch NAME [--open-pr OWNER/REPO]]]";

/** Parse the flags after WRAPPER and FULL_SHA, or null on a usage error. */
export function parseUpgradeFlags(flags: string[]): { mode: "--plan" | "--apply"; branch?: string; openPr?: string } | null {
  let mode: "--plan" | "--apply" | undefined;
  let branch: string | undefined;
  let openPr: string | undefined;
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    const value = () => { const next = flags[++index]; return next === undefined || next.startsWith("--") ? null : next; };
    if ((flag === "--plan" || flag === "--apply") && mode === undefined) mode = flag;
    else if (flag === "--branch" && branch === undefined) { const next = value(); if (next === null) return null; branch = next; }
    else if (flag === "--open-pr" && openPr === undefined) { const next = value(); if (next === null) return null; openPr = next; }
    else return null;
  }
  mode ??= "--plan";
  if (branch !== undefined && mode !== "--apply") return null;
  if (openPr !== undefined && branch === undefined) return null;
  return { mode, ...(branch !== undefined ? { branch } : {}), ...(openPr !== undefined ? { openPr } : {}) };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [target, revision, ...rest] = process.argv.slice(2);
  const flags = parseUpgradeFlags(rest);
  if (!target || !revision || !flags) {
    console.error(USAGE);
    process.exitCode = 2;
  } else {
    try {
      const root = resolve(target);
      const report = flags.branch !== undefined ? reviewedUpgrade(root, revision, { branch: flags.branch, ...(flags.openPr ? { openPr: flags.openPr } : {}) })
        : flags.mode === "--apply" ? applyUpgrade(root, revision) : planUpgrade(root, revision).report;
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.ok ? 0 : 1;
    } catch (error) {
      // Git errors may echo credential-bearing remotes; report only our own messages.
      console.error(error instanceof Error && !("status" in error) ? error.message : "Git operation failed during upgrade");
      process.exitCode = 1;
    }
  }
}
