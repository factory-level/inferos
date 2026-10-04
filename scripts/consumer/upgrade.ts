// Plan or apply moving a wrapper's InferOS pin to a reviewed commit.
//
//   node scripts/consumer/upgrade.ts <wrapper> <full-sha> [--plan|--apply]
//
// Runs from an InferOS checkout at the target revision, because the target renders its own templates
// and judges its own configuration support. A wrapper's `pnpm inferos upgrade <sha>` creates that
// checkout as a temporary worktree of its submodule and runs this file from it; a wrapper whose
// helpers predate the command runs it from any InferOS checkout at the target revision.
//
// `--plan` (the default) writes nothing. `--apply` refuses a dirty tree, then moves the submodule
// checkout and gitlink, regenerates `generated` files, refreshes unedited `copied-template` files,
// leaves edited ones in place (`needs-review`, with the new upstream text under
// `.inferos/state/upgrade/<sha>/`), never touches `customer-owned` files, updates
// `upstream.revision`, `.inferos/bootstrap.json` and `.inferos/files.json`, and stages the result.
// It never commits, deploys, migrates the configuration schema or contacts anything but Git.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrateConsumerConfig, parseConsumerConfig } from "./config.ts";
import { checkConsumer, inferOpsGatekeeperSelected, unsupportedCapabilities } from "./runtime.ts";
import {
  FILES_MANIFEST, FILES_SCHEMA_VERSION, managedFiles, readFilesManifest, renderFilesManifest, renderPackageJson, sha256,
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
  /** Edited, deleted, or unknown baseline: kept as is; the target's text is staged for review. */
  | "needs-review"
  /** The target no longer ships this template; the wrapper's copy is kept. */
  | "removed-upstream"
  /** A customer-owned starter whose upstream source changed; never rewritten, reported for review. */
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

const read = (path: string) => existsSync(path) ? readFileSync(path, "utf8") : undefined;

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

/** Compare the wrapper's files with what the target would write. */
function planFiles(root: string, record: FilesManifest | null) {
  const managed = managedFiles(REPO);
  const plans: FilePlan[] = [];
  const content = new Map<string, string>();
  for (const [path, file] of managed) {
    const current = read(join(root, path));
    const recorded = record?.files[path];
    const source = file.source ? { source: file.source } : {};
    if (file.class === "generated") {
      // package.json: only the managed keys are rewritten; the customer's own keys and scripts stay.
      const next = renderPackageJson(REPO, current);
      content.set(path, next);
      plans.push({ path, class: "generated", action: current === next ? "unchanged" : "regenerate", ...source });
      continue;
    }
    content.set(path, file.content);
    let action: FileAction;
    let reason: string | undefined;
    if (current === file.content) action = "unchanged";
    else if (current === undefined) {
      if (recorded) { action = "needs-review"; reason = "deleted in the wrapper; not restored"; }
      else action = "add";
    } else if (!record) { action = "needs-review"; reason = `no ${FILES_MANIFEST} baseline, so a local edit cannot be ruled out`; }
    else if (!recorded?.sha256) { action = "needs-review"; reason = "no recorded baseline for this file"; }
    else if (sha256(current) === recorded.sha256) action = "update";
    else { action = "needs-review"; reason = "edited since InferOS wrote it"; }
    plans.push({ path, class: "copied-template", action, ...(reason ? { reason } : {}), ...source });
  }
  for (const [path, entry] of Object.entries(record?.files ?? {})) {
    if (entry.class === "copied-template" && !managed.has(path)) {
      plans.push({ path, class: "copied-template", action: "removed-upstream", reason: "the target no longer ships this file; the wrapper's copy is kept" });
    }
    if (entry.class === "customer-owned" && entry.source) {
      const upstream = read(join(REPO, entry.source));
      if (upstream !== undefined && entry.sha256 && sha256(upstream) !== entry.sha256) {
        plans.push({ path, class: "customer-owned", action: "upstream-changed", source: entry.source,
          reason: "upstream changed the starter this file was copied from; the wrapper's file is never rewritten" });
      }
    }
  }
  return { plans, content };
}

/** The rollback limit every upgrade carries, stated once. */
export const STATE_ROLLBACK =
  "Local Wrangler state (inferos/.wrangler/state) is kept across the upgrade. Durable Object and storage migrations a newer pin applies on its next start are not reversible: to return to an older pin, revert the upgrade commit and reset local state with pnpm inferos recover state --apply. Cloud state is not touched.";

/** Read-only plan for moving the wrapper at `root` to `revision`. */
export function planUpgrade(root: string, revision: string) {
  const blockers: string[] = [];
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("The target must be a full 40-character commit SHA");
  const here = git(REPO, "rev-parse", "HEAD");
  if (here !== revision) throw new Error(`Run upgrade.ts from an InferOS checkout at ${revision} (this one is at ${here}); pnpm inferos upgrade does that for you`);
  const upstream = join(root, "inferos");
  let from: string | null = null;
  try {
    from = checkConsumer(root).config.upstream.revision;
  } catch (error) {
    blockers.push(`The wrapper does not check at its current pin (${(error as Error).message}); run pnpm inferos recover config first`);
  }
  const dirty = git(root, "status", "--porcelain");
  if (dirty) blockers.push("The wrapper has uncommitted changes (git status is not clean); commit or discard them before --apply");
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
  const { plans, content } = planFiles(root, record);
  const count = (action: FileAction) => plans.filter(plan => plan.action === action).length;
  return {
    report: {
      ok: blockers.length === 0, operation: "upgrade", mode: "plan" as "plan" | "apply", from, to: revision, blockers,
      submodule: { path: "inferos", from, to: revision, relation,
        ...(relation === "not-a-descendant" ? { warning: "The target is not a descendant of the current pin (a downgrade or a different branch); review before applying" } : {}) },
      config: { ...config, revisionField: "upstream.revision is rewritten to the target" },
      baseline: record ? FILES_MANIFEST : `missing: this wrapper predates ${FILES_MANIFEST}, so every copied file that differs from the target is needs-review`,
      files: plans.filter(plan => plan.action !== "unchanged"),
      summary: { regenerate: count("regenerate"), update: count("update"), add: count("add"), unchanged: count("unchanged"),
        needsReview: count("needs-review"), removedUpstream: count("removed-upstream"), upstreamChanged: count("upstream-changed") },
      state: STATE_ROLLBACK,
      next: ["Review the plan", "pnpm inferos upgrade <sha> --apply", "git diff --cached", "pnpm run setup", "pnpm inferos verify", "commit"],
    },
    plans, content, record, from,
  };
}

/** Apply the plan. Throws, having written nothing, when the plan has blockers. */
export function applyUpgrade(root: string, revision: string) {
  const { report, plans, content, record, from } = planUpgrade(root, revision);
  if (report.blockers.length || !from) throw new Error(`Upgrade refused; nothing was changed: ${report.blockers.join("; ")}`);
  const upstream = join(root, "inferos");
  git(upstream, "checkout", "--quiet", "--detach", revision);
  const written: string[] = [];
  const pending: string[] = [];
  const files: Record<string, FileEntry> = { ...record?.files };
  for (const plan of plans) {
    const next = content.get(plan.path);
    if (next === undefined) continue;
    const target = join(root, plan.path);
    if (plan.action === "regenerate" || plan.action === "update" || plan.action === "add") {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, next);
      written.push(plan.path);
    }
    if (plan.action === "needs-review") {
      // The target's text, for the reviewer; .inferos/state is gitignored. The baseline stays as it was.
      const staged = join(root, ".inferos/state/upgrade", revision, plan.path);
      mkdirSync(dirname(staged), { recursive: true });
      writeFileSync(staged, next);
      pending.push(`.inferos/state/upgrade/${revision}/${plan.path}`);
      continue;
    }
    files[plan.path] = { class: plan.class, sha256: sha256(next), ...(plan.source ? { source: plan.source } : {}) };
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

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const usage = "Usage: node scripts/consumer/upgrade.ts WRAPPER FULL_SHA [--plan|--apply]";
  const [target, revision, mode, extra] = process.argv.slice(2);
  if (!target || !revision || extra || (mode !== undefined && mode !== "--plan" && mode !== "--apply")) {
    console.error(usage);
    process.exitCode = 2;
  } else {
    try {
      const root = resolve(target);
      const report = mode === "--apply" ? applyUpgrade(root, revision) : planUpgrade(root, revision).report;
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.ok ? 0 : 1;
    } catch (error) {
      // Git errors may echo credential-bearing remotes; report only our own messages.
      console.error(error instanceof Error && !("status" in error) ? error.message : "Git operation failed during upgrade");
      process.exitCode = 1;
    }
  }
}
