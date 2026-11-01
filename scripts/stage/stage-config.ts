// Generates the `wrangler.stage-<name>.jsonc` each deployable package is deployed from when
// `scripts/stage/stage.ts` deploys a persistent stage (see stages.ts). Everything here is pure:
// packages, account id, KV namespace ids and secret inputs are all passed in, so the tests can
// build every config without a network or a Cloudflare account.
//
// A stage is a real `wrangler deploy` of stage-prefixed workers, not a Worker Preview. A preview
// is a per-PR branch of a baseline worker, reachable only at a public workers.dev URL and swept
// when its PR closes; a stage is long-lived, served from a custom domain behind Cloudflare Access,
// and keeps its Durable Objects, which belong to the worker *name*. So this mirrors
// preview/staging-config.ts's topology (the same service bindings, `BASE_URL`s and
// `sharingDomain`) but resolves every worker and resource to a stable, prefixed name instead.

import { createHash } from "node:crypto";
import {
  gatekeeperShortName, isGatekeeperPackage,
  type DeployablePackage, type ObservabilityConfig,
} from "../release/manifest-lib.ts";
import {
  R2_MAX_BUCKET_NAME_LENGTH, backendGatekeeperServices, resolveAiGateway, routerGatekeeperServices,
  type StagingConfig,
} from "../preview/staging-config.ts";
import {
  INFEROPS_GATEKEEPER, INFERLAB_LOGIN_VENDOR, inferLabLoginStartupError,
} from "../dev-server-config.ts";
import type { StageDefinition, StageName } from "./stages.ts";

type PackageConfig = Pick<DeployablePackage, "name" | "config">;

/** The generated per-package config a stage deploys from (gitignored — it is build output). */
export function stageConfigFileName(stageName: StageName): string {
  return `wrangler.stage-${stageName}.jsonc`;
}

/** The worker a package is deployed as in a stage: `<workerPrefix><package>`. */
export function stageWorkerName(stage: StageDefinition, pkgName: string): string {
  return `${stage.workerPrefix}${pkgName}`;
}

/** `BLUEPRINT_CONTENT` -> `blueprint-content`. */
function kebab(binding: string): string {
  return binding.toLowerCase().replaceAll("_", "-");
}

/**
 * The title of the KV namespace a stage binds as `binding` on `pkgName`. Titles are how a stage
 * finds its namespaces again on the next deploy, so they are a pure function of the stage.
 */
export function stageKvTitle(stage: StageDefinition, pkgName: string, binding: string): string {
  return `${stage.resourcePrefix}${pkgName}-${kebab(binding)}`;
}

/** The R2 bucket a stage binds as `binding`. Wrangler creates it on first deploy if it is missing. */
export function stageBucketName(stage: StageDefinition, binding: string): string {
  return `${stage.resourcePrefix}${kebab(binding)}`;
}

/** One KV namespace a stage needs, before its id is known. */
export interface StageKvNamespace {
  /** The package that binds it. */
  pkgName: string;
  /** The binding name the worker reads. */
  binding: string;
  /** The namespace title, see {@link stageKvTitle}. */
  title: string;
}

/** The packages a stage deploys: the backend, the router and the stage's own gatekeepers. */
export function stagePackages<T extends PackageConfig>(stage: StageDefinition, packages: readonly T[]): T[] {
  const names = new Set(packages.map((pkg) => pkg.name));
  const missing = stage.gatekeepers.filter((name) => !names.has(name));
  if (missing.length > 0) throw new Error(`stage gatekeepers are not deployable packages: ${missing.join(", ")}`);
  return packages.filter((pkg) =>
    !isGatekeeperPackage(pkg.name) || stage.gatekeepers.includes(pkg.name));
}

/** Every KV namespace the stage's packages bind, in package order. */
export function stageKvNamespaces(stage: StageDefinition, packages: readonly PackageConfig[]): StageKvNamespace[] {
  return stagePackages(stage, packages).flatMap((pkg) =>
    (pkg.config.kv_namespaces ?? []).map(({ binding }) =>
      ({ pkgName: pkg.name, binding, title: stageKvTitle(stage, pkg.name, binding) })));
}

/**
 * Refuse Durable Object migrations that destroy or move state. A stage is persistent, `wrangler
 * rollback` never undoes a migration, and a deleted class takes every user's objects with it, so
 * such a step is deployed only when the caller says so explicitly.
 */
export function destructiveMigrations(packages: readonly PackageConfig[]): string[] {
  const found: string[] = [];
  for (const pkg of packages) {
    for (const migration of pkg.config.migrations ?? []) {
      for (const key of ["deleted_classes", "renamed_classes", "transferred_classes"]) {
        const value = migration[key];
        if (Array.isArray(value) && value.length > 0) found.push(`${pkg.name} migration ${migration.tag}: ${key}`);
      }
    }
  }
  return found;
}

// Persistent instances keep the committed observability settings, except that invocation logs are
// on: a stage is where acceptance runs, and they are the only record of a failed request.
function stageObservability(config: StagingConfig): ObservabilityConfig {
  return {
    ...config.observability,
    enabled: true,
    logs: { ...config.observability?.logs, invocation_logs: true },
  };
}

/** The vars the InferOps gatekeeper gets: the stage's InferLab environment and its switches. */
export function inferOpsGatekeeperVars(stage: StageDefinition): Record<string, string> {
  return {
    INFEROPS_BASE_URL: stage.inferops.baseUrl,
    INFERLAB_AUTH_ORIGIN: stage.inferops.authOrigin,
    ...(stage.inferops.authorizeOrigin ? { INFERLAB_AUTHORIZE_ORIGIN: stage.inferops.authorizeOrigin } : {}),
    INFEROPS_ENABLED: "true",
    // Every optional switch is stated rather than left to the gatekeeper's "unset" default, so a
    // stage's behaviour never depends on a default changing. Coding dispatch stays off: it needs a
    // separate `project/dispatch` grant and a local runner a stage does not have.
    CODING_WORKBENCH_ENABLED: "false",
    INFEROPS_TABLES_ENABLED: "false",
    INFEROPS_MEMBERS_ENABLED: "false",
    INFEROPS_WORKFLOW_POLICY_ENABLED: "false",
    INFEROPS_HOST_BOARDS: "false",
  };
}

/**
 * The hostname a stage package is reachable at, or null when it must have no URL at all: the
 * router at the stage's hostname, and the InferOps gatekeeper at the authorize origin's when the
 * stage has one (the sign-in proxy). Every hostname here must be behind the Access application.
 */
export function stageWorkerHost(stage: StageDefinition, pkgName: string): string | null {
  if (pkgName === "router") return stage.hostname;
  if (pkgName === INFEROPS_GATEKEEPER && stage.inferops.authorizeOrigin) {
    return new URL(stage.inferops.authorizeOrigin).hostname;
  }
  return null;
}

/** Every hostname a stage serves, each of which must answer with an Access login without credentials. */
export function stageHostnames(stage: StageDefinition): string[] {
  return [stage.hostname,
    ...(stage.inferops.authorizeOrigin ? [new URL(stage.inferops.authorizeOrigin).hostname] : [])];
}

/** The backend's plain vars. Nothing in here is a secret: Wrangler prints every var it deploys. */
export function backendVars(stage: StageDefinition, origin: string, canvasCatalog: string | undefined): Record<string, string> {
  return {
    PUBLIC_BASE_URL: origin,
    // InferLab is the only way in. auth/config.ts keeps password login on if no sign-in gatekeeper
    // is allowlisted, so the pair is checked together (inferLabLoginStartupError) before deploying.
    AUTH_GATEKEEPERS: INFERLAB_LOGIN_VENDOR,
    DISABLE_PASSWORD_AUTH: "true",
    // Composition with saved views, as a wrapper with `composableViews` + `durableViews` gets it
    // from `pnpm dev-server`: the InferOps board is shown on a canvas.
    COMPOSABLE_VIEWS: "true",
    DURABLE_VIEWS: "true",
    ...(canvasCatalog ? { CANVAS_CATALOG: canvasCatalog } : {}),
    INFEROPS_ENABLED: "true",
    INFEROPS_HOST_BOARDS: "false",
    INFEROPS_BOUND_VIEWS: "false",
    PUBLISH_CLOUDFLAREOS_WIDGET: "false",
    PUBLISH_CLOUDFLAREOS_APP: "false",
  };
}

// The InferOps gatekeeper's local-development stopgap (one shared token for every account with no
// identity) and its mock seed must never reach a stage: there, every account is a person's own
// InferLab session.
const FORBIDDEN_GATEKEEPER_VARS = [
  "INFEROPS_API_TOKEN", "INFEROPS_WORKSPACE_ID", "INFEROPS_WORKSPACE_SLUG", "MOCK_INFEROPS_SYNTHETIC_ISSUES",
];

/**
 * Build every config a stage deploys, keyed by package name. `kvIds` maps each
 * {@link stageKvTitle} to its namespace id; a namespace with no id is an error rather than a
 * binding Wrangler would provision afresh, because a fresh namespace is an empty instance.
 */
export function buildStageConfigs({
  stageName, stage, packages, accountId, kvIds, canvasCatalog,
}: {
  stageName: StageName;
  stage: StageDefinition;
  packages: readonly PackageConfig[];
  accountId: string;
  kvIds: ReadonlyMap<string, string>;
  canvasCatalog?: string;
}): Map<string, StagingConfig> {
  if (!accountId) throw new Error("buildStageConfigs needs an accountId");
  const origin = `https://${stage.hostname}`;
  const deployed = stagePackages(stage, packages);
  const gatekeepers = deployed.map((pkg) => pkg.name).filter(isGatekeeperPackage).toSorted();
  const workerName = (pkgName: string) => stageWorkerName(stage, pkgName);
  const configs = new Map<string, StagingConfig>();

  for (const pkg of deployed) {
    const config: StagingConfig = structuredClone(pkg.config);
    if (config.name !== pkg.name) {
      throw new Error(`${pkg.name}/wrangler.jsonc declares worker name "${config.name}"; the ` +
          `stage generator requires them to match`);
    }
    Object.assign(config, {
      name: workerName(pkg.name),
      account_id: accountId,
      // Only the router (and the sign-in proxy, see stageWorkerHost) is reachable, and only at a
      // custom domain behind Access: a workers.dev or preview URL would be a way around Access.
      workers_dev: false,
      preview_urls: false,
      observability: stageObservability(config),
    });
    delete config.routes;
    delete config.previews;

    if (config.kv_namespaces) {
      config.kv_namespaces = config.kv_namespaces.map(({ binding }) => {
        const title = stageKvTitle(stage, pkg.name, binding);
        const id = kvIds.get(title);
        if (!id) throw new Error(`no KV namespace id for "${title}" (${pkg.name} ${binding})`);
        return { binding, id };
      });
    }
    if (config.r2_buckets) {
      config.r2_buckets = config.r2_buckets.map(({ binding }) => {
        const bucket_name = stageBucketName(stage, binding);
        if (bucket_name.length > R2_MAX_BUCKET_NAME_LENGTH) {
          throw new Error(`R2 bucket name "${bucket_name}" is longer than ${R2_MAX_BUCKET_NAME_LENGTH}`);
        }
        return { binding, bucket_name };
      });
    }

    if (isGatekeeperPackage(pkg.name)) {
      config.vars = {
        ...config.vars,
        BASE_URL: `${origin}/gatekeeper/${gatekeeperShortName(pkg.name)}`,
        ...(pkg.name === INFEROPS_GATEKEEPER ? inferOpsGatekeeperVars(stage) : {}),
      };
      const host = stageWorkerHost(stage, pkg.name);
      if (host) config.routes = [{ pattern: host, custom_domain: true }];
      for (const name of FORBIDDEN_GATEKEEPER_VARS) {
        if (config.vars[name] !== undefined) throw new Error(`${pkg.name} must not carry ${name} in a stage`);
      }
    } else if (pkg.name === "workshop-backend") {
      // Injected rather than read from wrangler.jsonc, as manifest-lib.ts and the preview do.
      config.ai = { binding: "WORKERS_AI" };
      config.services = backendGatekeeperServices(gatekeepers, origin, workerName);
      config.vars = { ...config.vars, ...backendVars(stage, origin, canvasCatalog) };
    } else if (pkg.name === "router") {
      config.services = [
        { binding: "WORKSHOP_BACKEND", service: workerName("workshop-backend") },
        ...routerGatekeeperServices(gatekeepers, workerName),
      ];
      config.routes = [{ pattern: stage.hostname, custom_domain: true }];
    } else {
      throw new Error(`cannot build a stage config for package: ${pkg.name}`);
    }
    configs.set(pkg.name, config);
  }

  const backend = configs.get("workshop-backend");
  const inferops = configs.get(INFEROPS_GATEKEEPER);
  const loginError = inferLabLoginStartupError({
    AUTH_GATEKEEPERS: backend?.vars?.AUTH_GATEKEEPERS as string | undefined,
    DISABLE_PASSWORD_AUTH: backend?.vars?.DISABLE_PASSWORD_AUTH as string | undefined,
    INFERLAB_AUTH_ORIGIN: inferops?.vars?.INFERLAB_AUTH_ORIGIN as string | undefined,
  }, inferops !== undefined);
  if (loginError) throw new Error(`stage "${stageName}": ${loginError}`);
  return configs;
}

/** The deployment admins, a comma-separated list of emails. Required: a stage with none has no /admin. */
export function resolveStageAdmins({ list = process.env.STAGE_ADMINS }: { list?: string } = {}): string[] {
  const admins = (list ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (admins.length === 0) {
    throw new Error("STAGE_ADMINS must list at least one admin email: a stage deployed without one " +
        "has no reachable /admin panel");
  }
  return admins;
}

/**
 * The backend's secrets: the admins and, optionally, the AI Gateway (resolveAiGateway). Uploaded
 * with the version via `--secrets-file`, never written into a config, because Wrangler prints
 * config values. No `CF_ACCESS_*`: see the `inferlab` auth mode in stages.ts.
 */
export function stageBackendSecrets({
  admins = resolveStageAdmins(),
  aiGateway = resolveAiGateway(),
}: { admins?: string[]; aiGateway?: Record<string, string> } = {}): Record<string, string> {
  return { ADMINS: JSON.stringify(admins), ...aiGateway };
}

/**
 * The shape InferLab's edge allow rule accepts for the shared secret (inferops `infra/waf`,
 * `waf:inferosEdgeSecret`): long, and free of anything that could leave its CEL string literal.
 */
const INFEROPS_EDGE_SECRET_PATTERN = /^[A-Za-z0-9_-]{32,}$/;

/**
 * The InferOps gatekeeper's secrets: optionally `INFEROPS_EDGE_SECRET`, the value the gatekeeper
 * sends to InferLab in the `x-inferos-edge` header so InferLab's IP-allowlisting edge lets the
 * stage through. Uploaded with the gatekeeper's version via `--secrets-file`, like the backend's.
 * Unset, nothing is uploaded and the deploy keeps whatever the previous version held. A malformed
 * value is refused before anything deploys, without being printed.
 */
export function stageInferOpsGatekeeperSecrets({
  edgeSecret = process.env.INFEROPS_EDGE_SECRET,
}: { edgeSecret?: string } = {}): Record<string, string> {
  const value = edgeSecret?.trim();
  if (!value) return {};
  if (!INFEROPS_EDGE_SECRET_PATTERN.test(value)) {
    throw new Error("INFEROPS_EDGE_SECRET must be at least 32 characters of [A-Za-z0-9_-], the " +
        "same value as InferLab's waf:inferosEdgeSecret (its value is not shown)");
  }
  return { INFEROPS_EDGE_SECRET: value };
}

/** A tier of the deploy: workers that can go out together because nothing in it binds to another. */
export interface StageTier {
  /** What the tier is, for the plan. */
  label: string;
  /** Package names, in deploy order. */
  packages: string[];
}

/**
 * The deploy order. Each tier's service bindings name workers the tier before it produced, so
 * gatekeepers go first, then the backend that binds them, then the router that binds everything.
 */
export function stageTiers(configs: ReadonlyMap<string, StagingConfig>): StageTier[] {
  const names = [...configs.keys()];
  return [
    { label: "gatekeepers (concurrently)", packages: names.filter(isGatekeeperPackage).toSorted() },
    { label: "backend", packages: names.filter((name) => name === "workshop-backend") },
    { label: "router", packages: names.filter((name) => name === "router") },
  ];
}

/**
 * The human-readable plan `--dry-run` prints. It names every secret but never shows a value: the
 * plan is meant to be pasted into a PR or a log. `secretNames` are the backend's;
 * `gatekeeperSecretNames` the secrets a gatekeeper package is uploaded with, by package name.
 */
export function formatStagePlan({ stageName, stage, configs, secretNames, gatekeeperSecretNames = {}, kv }: {
  stageName: StageName;
  stage: StageDefinition;
  configs: ReadonlyMap<string, StagingConfig>;
  secretNames: string[];
  gatekeeperSecretNames?: Readonly<Record<string, readonly string[]>>;
  kv: readonly StageKvNamespace[];
}): string {
  const lines = [`stage "${stageName}" -> https://${stage.hostname} (InferLab ${stage.inferops.baseUrl})`];
  for (const tier of stageTiers(configs)) {
    lines.push(`  ${tier.label}:`);
    for (const pkgName of tier.packages) {
      const config = configs.get(pkgName) as StagingConfig;
      const vars = Object.keys(config.vars ?? {}).toSorted().join(", ");
      const gatekeeperSecrets = gatekeeperSecretNames[pkgName] ?? [];
      const host = stageWorkerHost(stage, pkgName);
      const extra = (host ? ` at ${host} (custom domain)` : "") +
        (pkgName === "workshop-backend" ? `, secrets: ${secretNames.join(", ")}` :
         gatekeeperSecrets.length > 0 ? `, secrets: ${gatekeeperSecrets.join(", ")}` : "");
      lines.push(`    ${config.name}${extra}${vars ? ` [vars: ${vars}]` : ""}`);
    }
  }
  lines.push("  KV namespaces:", ...kv.map((ns) => `    ${ns.title} (${ns.pkgName} ${ns.binding})`));
  const buckets = [...configs.values()].flatMap((config) =>
    (config.r2_buckets ?? []).map((bucket) => (bucket as { bucket_name?: string }).bucket_name));
  lines.push("  R2 buckets:", ...buckets.map((name) => `    ${name}`));
  return lines.join("\n");
}

/** A short digest of a stage's configs, recorded in each version's message to tie it to a plan. */
export function stageConfigDigest(configs: ReadonlyMap<string, StagingConfig>): string {
  const hash = createHash("sha256");
  for (const [name, config] of [...configs].toSorted(([a], [b]) => a.localeCompare(b))) {
    hash.update(name).update(JSON.stringify(config));
  }
  return hash.digest("hex").slice(0, 12);
}
