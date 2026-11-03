#!/usr/bin/env node

// Deploys, inspects or deletes a persistent stage (stages.ts) on the account named by
// CLOUDFLARE_ACCOUNT_ID, using the workspace's pinned Wrangler and its login (`wrangler login`).
//
//   node scripts/stage/stage.ts config <stage>     resolve KV ids (read-only) and write the configs
//   node scripts/stage/stage.ts deploy <stage>     build, provision missing KV, deploy every tier
//   node scripts/stage/stage.ts delete <stage> --confirm <hostname>
//   ... --wrapper <dir> in place of <stage>         a company's own InferOS (wrapper-stage.ts): run from
//                                                  the wrapper's pinned inferos checkout, by
//                                                  `pnpm inferos:deploy` in the wrapper
//   ... --dry-run                                  print the plan, touch no network
//
// Deployment runs in three tiers, as a preview's does (preview/preview.ts): the stage's gatekeepers
// concurrently, then the backend that binds them, then the router that binds everything and owns
// the custom domain. Each worker's version carries its secrets (`--secrets-file`), so no version
// ever runs without them; secret values never reach a config, argv or the log.
//
// Inputs: the shell first, then a gitignored `.stage-<stage>.vars` at the repository root.
//   STAGE_ADMINS                          required, comma-separated admin emails
//   CLOUDFLARE_ACCOUNT_ID                 required
//   CF_AI_GATEWAY*                        optional, see resolveAiGateway
//   CF_ACCESS_CLIENT_ID/_SECRET           optional Access service token for the post-deploy smoke
//   INFEROPS_EDGE_SECRET                  optional, the InferOps gatekeeper's InferLab edge header

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { resolveBinEntry } from "../bin-entry.ts";
import { readCanvasConfig } from "../consumer/canvas.ts";
import { mapConcurrent } from "../map-concurrent.ts";
import { gatekeeperShortName, readDeployablePackages, type DeployablePackage } from "../release/manifest-lib.ts";
import { ROOT, type StagingConfig } from "../preview/staging-config.ts";
import { isAccessRedirect, runSmoke, smokeRequest } from "../preview/smoke.ts";
import {
  buildStageConfigs, destructiveMigrations, formatStagePlan, stageBackendSecrets, stageConfigDigest,
  stageConfigFileName, stageHostnames, stageInferOpsGatekeeperSecrets, stageKvNamespaces, stagePackages,
  stageTiers, stageWorkerHost, stageWorkerName,
} from "./stage-config.ts";
import { INFEROPS_GATEKEEPER } from "../dev-server-config.ts";
import {
  deployTargetProblem, parseDeployTargets, parseKvNamespaceList, retryWhileDnsPending,
} from "./stage-resources.ts";
import { resolveStage, type StageDefinition } from "./stages.ts";
import {
  claimMarkers, conflictingInputs, inputSources, ownershipMarkers, ownershipProblem, parseKvCreateId, parseR2BucketList,
  pinnedRevisionFromLsTree, readWrapperStage, workerProbe, WRAPPER_DEPLOY_VARS_FILE, type AccountResources,
} from "./wrapper-stage.ts";

/** The subcommands this script accepts. */
type Command = "config" | "deploy" | "delete";

/** A parsed command line. */
export interface StageArgs {
  command: Command;
  /** A persistent stage's name; empty when `wrapper` names the deployment instead. */
  stage: string;
  /** A wrapper repository's root, whose `inferos.deploy.json` defines the deployment. */
  wrapper: string | undefined;
  dryRun: boolean;
  allowDirty: boolean;
  allowDestructiveMigrations: boolean;
  skipSmoke: boolean;
  confirm: string | undefined;
}

const USAGE = "Usage: stage.ts <config|deploy|delete> <stage | --wrapper <dir>> [--dry-run] [--allow-dirty] " +
  "[--allow-destructive-migrations] [--skip-smoke] [--confirm <hostname>]";
const GATEKEEPER_CONCURRENCY = 8;

/** Parse argv (without the node and script paths). Throws the usage on anything unexpected. */
export function parseStageArgs(argv: readonly string[]): StageArgs {
  const [command, first, ...more] = argv;
  if (!["config", "deploy", "delete"].includes(command ?? "")) throw new Error(USAGE);
  const named = first !== undefined && !first.startsWith("--");
  const rest = named ? more : argv.slice(1);
  const args: StageArgs = {
    command: command as Command, stage: named ? first : "", wrapper: undefined, dryRun: false, allowDirty: false,
    allowDestructiveMigrations: false, skipSmoke: false, confirm: undefined,
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--allow-dirty") args.allowDirty = true;
    else if (arg === "--allow-destructive-migrations") args.allowDestructiveMigrations = true;
    else if (arg === "--skip-smoke") args.skipSmoke = true;
    else if (arg === "--confirm" && rest[i + 1]) args.confirm = rest[++i];
    else if (arg === "--wrapper" && rest[i + 1]) args.wrapper = rest[++i];
    else throw new Error(`unknown argument: ${arg}\n${USAGE}`);
  }
  if (Boolean(args.stage) === Boolean(args.wrapper)) throw new Error(`name a stage or --wrapper <dir>, not both or neither\n${USAGE}`);
  if (args.wrapper && args.allowDirty) throw new Error("a wrapper deploys only from a clean tree; --allow-dirty is for the dev stage");
  return args;
}

/** What a run deploys: a persistent stage, or a wrapper's own. */
interface Target {
  stageName: string;
  stage: StageDefinition;
  /** Set for a wrapper deployment: its root. */
  wrapperRoot?: string;
}

function resolveTarget(args: StageArgs): Target {
  if (!args.wrapper) {
    const { name, stage } = resolveStage(args.stage);
    return { stageName: name, stage };
  }
  const wrapperRoot = resolve(args.wrapper);
  const { name, stage } = readWrapperStage(wrapperRoot);
  assertPinned(wrapperRoot);
  return { stageName: name, stage, wrapperRoot };
}

/**
 * A wrapper deploys exactly the InferOS it pins: this checkout's HEAD must be the wrapper's committed
 * `inferos` gitlink. Checked before anything else, dry run included, so a plan is never of the
 * wrong revision.
 */
function assertPinned(wrapperRoot: string): void {
  const lsTree = execFileSync("git", ["-C", wrapperRoot, "ls-tree", "HEAD", "inferos"], { encoding: "utf8" });
  const pinned = pinnedRevisionFromLsTree(lsTree);
  if (!pinned) throw new Error("the wrapper's last commit pins no inferos submodule; commit the pin first");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  if (head !== pinned) {
    throw new Error(`this InferOS checkout is at ${head.slice(0, 12)}, but the wrapper pins ${pinned.slice(0, 12)}; ` +
        "run the deploy from the wrapper (pnpm inferos:deploy), whose inferos checkout is the pinned one");
  }
  console.log(`InferOS ${pinned.slice(0, 12)}: the revision the wrapper pins`);
}

/** Fill unset variables from the stage's vars file; the shell always wins. */
function loadStageVars(target: Target): void {
  const path = target.wrapperRoot
    ? join(target.wrapperRoot, WRAPPER_DEPLOY_VARS_FILE)
    : join(ROOT, `.stage-${target.stageName}.vars`);
  if (!existsSync(path)) return;
  const values = parseEnv(readFileSync(path, "utf8"));
  if (target.wrapperRoot) {
    // A company's inputs are its file's: another stage's value left in the shell (an account id, an
    // admin list, an edge secret) must not deploy into this company silently. Names only, never values.
    const conflicting = conflictingInputs(values, process.env);
    if (conflicting.length > 0) {
      throw new Error(`the shell and ${WRAPPER_DEPLOY_VARS_FILE} disagree on ${conflicting.join(", ")}; ` +
          "run the deploy from a clean shell, or unset them");
    }
    const sources = inputSources(values, process.env);
    console.log(`inputs: ${sources.length ? sources.join(", ") : "none"}`);
  }
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The pinned Wrangler's JS entry, run with this Node. */
function wranglerEntry(): string {
  const entry = resolveBinEntry(join(ROOT, "packages", "router"), "wrangler");
  if (!entry) throw new Error("wrangler is not installed; run pnpm install");
  return entry;
}

/** One finished Wrangler run. */
interface WranglerResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runWrangler(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<WranglerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wranglerEntry(), ...args], {
      cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (data: string) => { stdout += data; });
    child.stderr.setEncoding("utf8").on("data", (data: string) => { stderr += data; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function runInherited(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  console.log(`running: ${command} ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() :
      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`)));
  });
}

/** Refuse a wrapper deploy whose prefix the account already holds for another deployment. Read-only. */
async function assertOwnership(stage: StageDefinition, packages: readonly DeployablePackage[]): Promise<void> {
  const problem = ownershipProblem(await listAccountResources(stage, packages), stage);
  if (problem) throw new Error(problem);
  console.log(`the prefix ${stage.resourcePrefix} and this deployment's hostnames are free or already its own`);
}

/**
 * What the account holds of every kind a deploy creates (see `AccountResources`): KV titles and R2
 * bucket names by listing, and this deployment's own worker names by probing each one, since Wrangler
 * can't list workers account-wide. Read-only; an answer it can't read refuses rather than passes.
 */
async function listAccountResources(stage: StageDefinition, packages: readonly DeployablePackage[]): Promise<AccountResources> {
  const kv = [...(await listKvNamespaces()).keys()];
  const r2Result = await runWrangler(ROOT, ["r2", "bucket", "list"]);
  if (r2Result.status !== 0) throw new Error(`wrangler r2 bucket list failed:\n${r2Result.stderr}`);
  const r2 = parseR2BucketList(r2Result.stdout);
  if (r2 === null) throw new Error("cannot read the account's R2 buckets from wrangler r2 bucket list; refusing to deploy");
  const names = packages.map((pkg) => stageWorkerName(stage, pkg.name));
  const workers: string[] = [];
  for (const name of names) {
    const probe = await runWrangler(ROOT, ["deployments", "list", "--name", name, "--json"]);
    if (workerProbe(probe.status, probe.stdout, probe.stderr)) workers.push(name);
  }
  return { kv, r2, workers };
}

/**
 * Claim the prefix and hostnames (`claimMarkers`): this run creates its missing markers one by one,
 * keeping the id each create returned, then lists again. On a rival claim it removes only those ids.
 */
async function claim(stage: StageDefinition): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "stage-claim-"));
  try {
    const created = await claimMarkers(stage, {
      list: async () => [...(await listKvNamespaces()).keys()],
      create: async (title) => {
        // From an empty directory, so no Wrangler config can prefix the title.
        const result = await runWrangler(scratch, ["kv", "namespace", "create", title]);
        if (result.status !== 0) {
          if (/already exists/.test(`${result.stdout}\n${result.stderr}`)) return { exists: true };
          throw new Error(`wrangler kv namespace create ${title} failed:\n${result.stderr}`);
        }
        const id = parseKvCreateId(result.stdout);
        if (!id) throw new Error(`wrangler kv namespace create ${title} reported no namespace id`);
        return { id };
      },
      remove: async (id) => {
        const result = await runWrangler(ROOT, ["kv", "namespace", "delete", "--namespace-id", id, "--skip-confirmation"]);
        if (result.status !== 0) throw new Error(`wrangler kv namespace delete failed:\n${result.stderr}`);
      },
    });
    if (created.length) console.log(`claimed ${created.join(", ")}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The account's KV namespaces by title. Read-only. */
async function listKvNamespaces(): Promise<Map<string, string>> {
  const result = await runWrangler(ROOT, ["kv", "namespace", "list"]);
  if (result.status !== 0) throw new Error(`wrangler kv namespace list failed:\n${result.stderr}`);
  return parseKvNamespaceList(result.stdout);
}

/**
 * Every namespace the stage binds, creating the missing ones. Created from an empty directory so no
 * Wrangler config can prefix the title, then found again by title — the only identity a stage has.
 */
async function ensureKvNamespaces(titles: readonly string[]): Promise<Map<string, string>> {
  const existing = await listKvNamespaces();
  const missing = titles.filter((title) => !existing.has(title));
  if (missing.length === 0) return existing;
  const scratch = mkdtempSync(join(tmpdir(), "stage-kv-"));
  try {
    for (const title of missing) {
      console.log(`creating KV namespace ${title}`);
      const result = await runWrangler(scratch, ["kv", "namespace", "create", title]);
      if (result.status !== 0) throw new Error(`wrangler kv namespace create ${title} failed:\n${result.stderr}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const after = await listKvNamespaces();
  const stillMissing = missing.filter((title) => !after.has(title));
  if (stillMissing.length > 0) throw new Error(`created but cannot find KV namespaces: ${stillMissing.join(", ")}`);
  return after;
}

function workingTreeState(wrapperRoot?: string): { sha: string; dirty: boolean } {
  const sha = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const isDirty = (cwd: string) => execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).trim() !== "";
  // A wrapper's own tree counts too: its deploy file and blueprints are part of what's deployed.
  return { sha, dirty: isDirty(ROOT) || (wrapperRoot !== undefined && isDirty(wrapperRoot)) };
}

/** Everything a run needs, resolved before anything touches the network. */
interface Prepared {
  stageName: string;
  stage: StageDefinition;
  wrapperRoot: string | undefined;
  accountId: string;
  packages: DeployablePackage[];
  secrets: Record<string, string>;
  /** Secrets per gatekeeper package; a package with none (or an empty record) uploads none. */
  gatekeeperSecrets: Record<string, Record<string, string>>;
  canvasCatalog: string | undefined;
}

function prepare(args: StageArgs): Prepared {
  const target = resolveTarget(args);
  const { stageName, stage, wrapperRoot } = target;
  loadStageVars(target);
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID must be set to the account the stage deploys to");
  const packages = stagePackages(stage, readDeployablePackages(ROOT));
  const destructive = destructiveMigrations(packages);
  if (destructive.length > 0 && !args.allowDestructiveMigrations) {
    throw new Error("Durable Object migrations that destroy or move state, which wrangler rollback " +
        `never undoes:\n  - ${destructive.join("\n  - ")}\nPass --allow-destructive-migrations to deploy them.`);
  }
  // Only the deploy uploads secrets; the other commands still resolve them, so a missing admin
  // list is reported by the dry run rather than by the deploy it was meant to rehearse.
  const secrets = stageBackendSecrets();
  const gatekeeperSecrets = { [INFEROPS_GATEKEEPER]: stageInferOpsGatekeeperSecrets() };
  // A wrapper's composition is its own inferos.canvas.json, as `pnpm dev` serves it.
  const catalog = readCanvasConfig(wrapperRoot ?? ROOT)?.catalog;
  return {
    stageName, stage, wrapperRoot, accountId, packages, secrets, gatekeeperSecrets,
    canvasCatalog: catalog === undefined ? undefined : JSON.stringify(catalog),
  };
}

/** The names (never values) of each gatekeeper's secrets, for the plan. */
function secretNamesOf(prepared: Prepared): Record<string, string[]> {
  return Object.fromEntries(Object.entries(prepared.gatekeeperSecrets).map(([pkg, secrets]) => [pkg, Object.keys(secrets)]));
}

function writeConfigs(prepared: Prepared, configs: ReadonlyMap<string, StagingConfig>): void {
  for (const pkg of prepared.packages) {
    const config = configs.get(pkg.name);
    if (!config) throw new Error(`no stage config was generated for ${pkg.name}`);
    writeFileSync(join(pkg.dir, stageConfigFileName(prepared.stageName)), JSON.stringify(config, null, 2) + "\n");
  }
  console.log(`wrote ${stageConfigFileName(prepared.stageName)} for ${prepared.packages.length} package(s)`);
}

async function deployWorker(
  prepared: Prepared, pkg: DeployablePackage, config: StagingConfig, message: string, secretsDir: string,
): Promise<void> {
  const outputFile = join(secretsDir, `${pkg.name}.output.ndjson`);
  const args = ["deploy", "-c", stageConfigFileName(prepared.stageName), "--message", message];
  const secrets = pkg.name === "workshop-backend" ? prepared.secrets : prepared.gatekeeperSecrets[pkg.name];
  if (secrets && Object.keys(secrets).length > 0) {
    const secretsFile = join(secretsDir, `${pkg.name}.secrets.json`);
    writeFileSync(secretsFile, JSON.stringify(secrets), { mode: 0o600 });
    args.push("--secrets-file", secretsFile);
  }
  console.log(`deploying ${config.name}`);
  const result = await runWrangler(pkg.dir, args, { WRANGLER_OUTPUT_FILE_PATH: outputFile });
  if (result.stdout) process.stdout.write(`[${config.name}]\n${result.stdout}`);
  if (result.stderr) process.stderr.write(`[${config.name}]\n${result.stderr}`);
  if (result.status !== 0) throw new Error(`wrangler deploy failed for ${config.name} with exit code ${result.status}`);
  const targets = parseDeployTargets(existsSync(outputFile) ? readFileSync(outputFile, "utf8") : "");
  if (targets === null) throw new Error(`wrangler reported no deployment for ${config.name}`);
  const problem = deployTargetProblem(config.name as string, targets,
      stageWorkerHost(prepared.stage, pkg.name));
  if (problem) throw new Error(problem);
}

/** Without credentials every stage hostname must answer with an Access login, never the app. */
async function assertBehindAccess(stage: StageDefinition): Promise<void> {
  for (const hostname of stageHostnames(stage)) {
    const response = await retryWhileDnsPending(() =>
      smokeRequest(new URL(`https://${hostname}/`), { headers: {}, timeoutMs: 15_000 }));
    if (!isAccessRedirect(response)) {
      throw new Error(`https://${hostname}/ answered ${response.status} without credentials: the ` +
          "stage is deployed but NOT behind Cloudflare Access. Add the hostname to the Access " +
          "application now (docs/wiki/stage-deploy.md) before anyone else finds the URL.");
    }
    console.log(`https://${hostname}/ redirects to Cloudflare Access without credentials`);
  }
}

async function smoke(prepared: Prepared): Promise<void> {
  const clientId = process.env.CF_ACCESS_CLIENT_ID;
  const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.log("CF_ACCESS_CLIENT_ID/CF_ACCESS_CLIENT_SECRET unset: skipping the authenticated smoke");
    return;
  }
  const report = await runSmoke({
    baseUrl: new URL(`https://${prepared.stage.hostname}/`),
    gatekeepers: prepared.packages.map((pkg) => pkg.name).filter((name) => name.startsWith("gatekeeper-"))
        .map(gatekeeperShortName),
    connectUrls: [],
    accessToken: { clientId, clientSecret },
    timeoutMs: 15_000,
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) throw new Error("the post-deploy smoke failed");
}

async function deploy(args: StageArgs): Promise<void> {
  const prepared = prepare(args);
  const { stageName, stage, accountId, packages, secrets } = prepared;
  const kv = stageKvNamespaces(stage, packages);

  if (args.dryRun) {
    const placeholderIds = new Map(kv.map((ns) => [ns.title, "<resolved at deploy>"]));
    const configs = buildStageConfigs({ stageName, stage, packages, accountId, kvIds: placeholderIds,
      canvasCatalog: prepared.canvasCatalog });
    console.log(`dry-run plan (no network):\n${formatStagePlan({ stageName, stage, configs,
      secretNames: Object.keys(secrets), gatekeeperSecretNames: secretNamesOf(prepared), kv })}`);
    if (prepared.wrapperRoot) {
      console.log(`ownership: checked against the account before anything is created; ` +
          `the prefix ${stage.resourcePrefix} and its hostnames are this deployment's by the KV namespace(s) ` +
          `${ownershipMarkers(stage).join(", ")}; existing Workers, KV namespaces and R2 buckets under the prefix are checked too`);
    }
    return;
  }

  const tree = workingTreeState(prepared.wrapperRoot);
  if (tree.dirty && (stage.requireCleanTree || !args.allowDirty)) {
    throw new Error(stage.requireCleanTree
      ? `stage "${stageName}" deploys only from a clean working tree; commit or stash first`
      : "the working tree is dirty; commit first, or pass --allow-dirty to deploy it anyway");
  }

  if (prepared.wrapperRoot) {
    await assertOwnership(stage, packages);
    await claim(stage);
  }
  const [kvIds] = await Promise.all([
    ensureKvNamespaces(kv.map((ns) => ns.title)),
    runInherited("pnpm", ["run", "build"], { VITE_CF_ACCESS_MODE: "false" }),
  ]);
  const configs = buildStageConfigs({ stageName, stage, packages, accountId, kvIds,
    canvasCatalog: prepared.canvasCatalog });
  writeConfigs(prepared, configs);
  const message = `stage ${stageName} @ ${tree.sha}${tree.dirty ? "-dirty" : ""} (${stageConfigDigest(configs)})`;

  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const scratch = mkdtempSync(join(tmpdir(), "stage-deploy-"));
  try {
    for (const tier of stageTiers(configs)) {
      console.log(`\n== ${tier.label}`);
      await mapConcurrent(tier.packages, GATEKEEPER_CONCURRENCY, (name) =>
        deployWorker(prepared, byName.get(name) as DeployablePackage, configs.get(name) as StagingConfig, message, scratch));
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  console.log(`\nstage "${stageName}" is deployed at https://${stage.hostname}`);
  await assertBehindAccess(stage);
  if (!args.skipSmoke) await smoke(prepared);
}

/**
 * Read-only check against the real account: the Wrangler login can reach CLOUDFLARE_ACCOUNT_ID,
 * and which of the stage's KV namespaces exist. When all do, the configs are written so they can
 * be inspected; a missing one is reported, since `deploy` creates it.
 */
async function configure(args: StageArgs): Promise<void> {
  const prepared = prepare(args);
  const { stageName, stage, accountId, packages } = prepared;
  const kv = stageKvNamespaces(stage, packages);
  if (args.dryRun) {
    const placeholderIds = new Map(kv.map((ns) => [ns.title, "<resolved at deploy>"]));
    const configs = buildStageConfigs({ stageName, stage, packages, accountId, kvIds: placeholderIds,
      canvasCatalog: prepared.canvasCatalog });
    console.log(formatStagePlan({ stageName, stage, configs, secretNames: Object.keys(prepared.secrets),
      gatekeeperSecretNames: secretNamesOf(prepared), kv }));
    return;
  }
  const whoami = await runWrangler(ROOT, ["whoami"]);
  if (whoami.status !== 0) throw new Error(`wrangler whoami failed; run pnpm exec wrangler login:\n${whoami.stderr}`);
  if (!whoami.stdout.includes(accountId)) {
    throw new Error(`the Wrangler login cannot see account ${accountId}; check CLOUDFLARE_ACCOUNT_ID or log in as its member`);
  }
  console.log(`Wrangler login reaches account ${accountId}`);
  const existing = await listKvNamespaces();
  if (prepared.wrapperRoot) {
    const problem = ownershipProblem(await listAccountResources(stage, packages), stage);
    console.log(problem ? `  ownership: ${problem}` : `  ownership: the prefix ${stage.resourcePrefix} is free or this deployment's`);
    if (problem) return;
  }
  for (const ns of kv) console.log(`  KV ${ns.title}: ${existing.has(ns.title) ? "present" : "missing (stage:deploy creates it)"}`);
  if (kv.some((ns) => !existing.has(ns.title))) return;
  writeConfigs(prepared, buildStageConfigs({ stageName, stage, packages, accountId, kvIds: existing,
    canvasCatalog: prepared.canvasCatalog }));
}

async function remove(args: StageArgs): Promise<void> {
  const target = resolveTarget(args);
  const { stageName, stage } = target;
  loadStageVars(target);
  if (args.confirm !== stage.hostname) {
    throw new Error(`deleting stage "${stageName}" destroys every Durable Object it holds; ` +
        `confirm with --confirm ${stage.hostname}`);
  }
  // A wrapper deletes only workers its own prefix holds on this account.
  const packages = stagePackages(stage, readDeployablePackages(ROOT));
  if (target.wrapperRoot && !args.dryRun) await assertOwnership(stage, packages);
  // Router first so the hostname stops answering before anything behind it disappears.
  const order = ["router", "workshop-backend", ...packages.map((pkg) => pkg.name).filter((n) => n.startsWith("gatekeeper-"))];
  for (const pkgName of order) {
    const worker = stageWorkerName(stage, pkgName);
    if (args.dryRun) { console.log(`would delete ${worker}`); continue; }
    const result = await runWrangler(ROOT, ["delete", worker, "--force"]);
    if (result.status !== 0) console.error(`could not delete ${worker}:\n${result.stderr}`);
    else console.log(`deleted ${worker}`);
  }
  console.log("KV namespaces and the R2 bucket are kept; delete them in the dashboard if intended.");
}

async function main(argv: readonly string[]): Promise<void> {
  const args = parseStageArgs(argv);
  if (args.command === "deploy") await deploy(args);
  else if (args.command === "config") await configure(args);
  else await remove(args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(describe(error));
    process.exit(1);
  });
}
