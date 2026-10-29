#!/usr/bin/env node

// Deploys, inspects or deletes a persistent stage (stages.ts) on the account named by
// CLOUDFLARE_ACCOUNT_ID, using the workspace's pinned Wrangler and its login (`wrangler login`).
//
//   node scripts/stage/stage.ts config <stage>     resolve KV ids (read-only) and write the configs
//   node scripts/stage/stage.ts deploy <stage>     build, provision missing KV, deploy every tier
//   node scripts/stage/stage.ts delete <stage> --confirm <hostname>
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

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  stageConfigFileName, stageKvNamespaces, stagePackages, stageTiers, stageWorkerName,
} from "./stage-config.ts";
import {
  deployTargetProblem, parseDeployTargets, parseKvNamespaceList, retryWhileDnsPending,
} from "./stage-resources.ts";
import { resolveStage, type StageDefinition, type StageName } from "./stages.ts";

/** The subcommands this script accepts. */
type Command = "config" | "deploy" | "delete";

/** A parsed command line. */
export interface StageArgs {
  command: Command;
  stage: string;
  dryRun: boolean;
  allowDirty: boolean;
  allowDestructiveMigrations: boolean;
  skipSmoke: boolean;
  confirm: string | undefined;
}

const USAGE = "Usage: stage.ts <config|deploy|delete> <stage> [--dry-run] [--allow-dirty] " +
  "[--allow-destructive-migrations] [--skip-smoke] [--confirm <hostname>]";
const GATEKEEPER_CONCURRENCY = 8;

/** Parse argv (without the node and script paths). Throws the usage on anything unexpected. */
export function parseStageArgs(argv: readonly string[]): StageArgs {
  const [command, stage, ...rest] = argv;
  if (!["config", "deploy", "delete"].includes(command ?? "") || !stage || stage.startsWith("--")) {
    throw new Error(USAGE);
  }
  const args: StageArgs = {
    command: command as Command, stage, dryRun: false, allowDirty: false,
    allowDestructiveMigrations: false, skipSmoke: false, confirm: undefined,
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--allow-dirty") args.allowDirty = true;
    else if (arg === "--allow-destructive-migrations") args.allowDestructiveMigrations = true;
    else if (arg === "--skip-smoke") args.skipSmoke = true;
    else if (arg === "--confirm" && rest[i + 1]) args.confirm = rest[++i];
    else throw new Error(`unknown argument: ${arg}\n${USAGE}`);
  }
  return args;
}

/** Fill unset variables from `.stage-<stage>.vars`; the shell always wins. */
function loadStageVars(stageName: StageName): void {
  const path = join(ROOT, `.stage-${stageName}.vars`);
  if (!existsSync(path)) return;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(path, "utf8")))) {
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

function workingTreeState(): { sha: string; dirty: boolean } {
  const sha = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim() !== "";
  return { sha, dirty };
}

/** Everything a run needs, resolved before anything touches the network. */
interface Prepared {
  stageName: StageName;
  stage: StageDefinition;
  accountId: string;
  packages: DeployablePackage[];
  secrets: Record<string, string>;
  canvasCatalog: string | undefined;
}

function prepare(args: StageArgs): Prepared {
  const { name: stageName, stage } = resolveStage(args.stage);
  loadStageVars(stageName);
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
  const catalog = readCanvasConfig(ROOT)?.catalog;
  return {
    stageName, stage, accountId, packages, secrets,
    canvasCatalog: catalog === undefined ? undefined : JSON.stringify(catalog),
  };
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
  if (pkg.name === "workshop-backend") {
    const secretsFile = join(secretsDir, "backend.secrets.json");
    writeFileSync(secretsFile, JSON.stringify(prepared.secrets), { mode: 0o600 });
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
      pkg.name === "router" ? prepared.stage.hostname : null);
  if (problem) throw new Error(problem);
}

/** Without credentials the hostname must answer with an Access login, never the app. */
async function assertBehindAccess(stage: StageDefinition): Promise<void> {
  const response = await retryWhileDnsPending(() =>
    smokeRequest(new URL(`https://${stage.hostname}/`), { headers: {}, timeoutMs: 15_000 }));
  if (!isAccessRedirect(response)) {
    throw new Error(`https://${stage.hostname}/ answered ${response.status} without credentials: the ` +
        "stage is deployed but NOT behind Cloudflare Access. Create the Access application now " +
        "(docs/wiki/stage-deploy.md) before anyone else finds the URL.");
  }
  console.log(`https://${stage.hostname}/ redirects to Cloudflare Access without credentials`);
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
      secretNames: Object.keys(secrets), kv })}`);
    return;
  }

  const tree = workingTreeState();
  if (tree.dirty && (stage.requireCleanTree || !args.allowDirty)) {
    throw new Error(stage.requireCleanTree
      ? `stage "${stageName}" deploys only from a clean working tree; commit or stash first`
      : "the working tree is dirty; commit first, or pass --allow-dirty to deploy it anyway");
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
    console.log(formatStagePlan({ stageName, stage, configs, secretNames: Object.keys(prepared.secrets), kv }));
    return;
  }
  const whoami = await runWrangler(ROOT, ["whoami"]);
  if (whoami.status !== 0) throw new Error(`wrangler whoami failed; run pnpm exec wrangler login:\n${whoami.stderr}`);
  if (!whoami.stdout.includes(accountId)) {
    throw new Error(`the Wrangler login cannot see account ${accountId}; check CLOUDFLARE_ACCOUNT_ID or log in as its member`);
  }
  console.log(`Wrangler login reaches account ${accountId}`);
  const existing = await listKvNamespaces();
  for (const ns of kv) console.log(`  KV ${ns.title}: ${existing.has(ns.title) ? "present" : "missing (stage:deploy creates it)"}`);
  if (kv.some((ns) => !existing.has(ns.title))) return;
  writeConfigs(prepared, buildStageConfigs({ stageName, stage, packages, accountId, kvIds: existing,
    canvasCatalog: prepared.canvasCatalog }));
}

async function remove(args: StageArgs): Promise<void> {
  const { name: stageName, stage } = resolveStage(args.stage);
  loadStageVars(stageName);
  if (args.confirm !== stage.hostname) {
    throw new Error(`deleting stage "${stageName}" destroys every Durable Object it holds; ` +
        `confirm with --confirm ${stage.hostname}`);
  }
  const packages = stagePackages(stage, readDeployablePackages(ROOT));
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
