// The pure half of the stage deploy (scripts/stage): the stage definitions, and the shape of the
// configs built from the repo's REAL wrangler.jsonc files. Deploying them needs an account and is
// not covered here.

import assert from "node:assert/strict";
import { test } from "node:test";
import { gatekeeperShortName, isGatekeeperPackage, readDeployablePackages } from "../release/manifest-lib.ts";
import { ROOT, gatekeeperBindingName, type StagingConfig } from "../preview/staging-config.ts";
import {
  buildStageConfigs, destructiveMigrations, formatStagePlan, stageBackendSecrets, stageBucketName,
  stageKvNamespaces, stagePackages, stageTiers, stageWorkerName, resolveStageAdmins,
} from "./stage-config.ts";
import { STAGES, resolveStage, stageDefinitionProblems, type StageDefinition } from "./stages.ts";
import { parseStageArgs } from "./stage.ts";

const ACCOUNT_ID = "0".repeat(32);
const ALL_PACKAGES = readDeployablePackages(ROOT);

function build(stageName: "dev" | "prod", canvasCatalog?: string): Map<string, StagingConfig> {
  const stage = STAGES[stageName];
  const kvIds = new Map(stageKvNamespaces(stage, ALL_PACKAGES).map((ns, i) => [ns.title, `kv-${i}`]));
  return buildStageConfigs({ stageName, stage, packages: ALL_PACKAGES, accountId: ACCOUNT_ID, kvIds, canvasCatalog });
}

test("every committed stage definition is valid", () => {
  for (const name of Object.keys(STAGES)) assert.equal(resolveStage(name).name, name);
  assert.throws(() => resolveStage("staging"), /unknown stage "staging"/);
});

test("a malformed stage definition is refused before anything is generated", () => {
  const bad: StageDefinition = {
    ...STAGES.dev,
    hostname: "Dev-OS.example",
    workerPrefix: "inferos-dev",
    inferops: { baseUrl: "http://localhost:8080", authOrigin: "https://auth.example/path" },
    gatekeepers: ["gatekeeper-context", "gatekeeper-context"],
  };
  const problems = stageDefinitionProblems(bad).join("\n");
  for (const fragment of ["hostname", "workerPrefix", "inferops.baseUrl", "inferops.authOrigin",
    "must include gatekeeper-inferops", "twice"]) {
    assert.match(problems, new RegExp(fragment));
  }
});

/** Every worker, bucket and namespace name a stage owns. */
function ownedNames(stageName: "dev" | "prod"): Set<string> {
  return new Set([...build(stageName).values()].flatMap((config) => [
    config.name as string,
    ...(config.r2_buckets ?? []).map((b) => (b as { bucket_name?: string }).bucket_name as string),
  ]).concat(stageKvNamespaces(STAGES[stageName], ALL_PACKAGES).map((ns) => ns.title)));
}

test("dev and prod are separate instances: no worker, namespace or bucket is shared", () => {
  const dev = ownedNames("dev");
  for (const name of ownedNames("prod")) assert.ok(!dev.has(name), `${name} is in both stages`);
});

test("only the stage's gatekeepers are deployed and bound", () => {
  for (const stageName of ["dev", "prod"] as const) {
    const stage = STAGES[stageName];
    const configs = build(stageName);
    const deployedGatekeepers = [...configs.keys()].filter(isGatekeeperPackage).toSorted();
    assert.deepEqual(deployedGatekeepers, [...stage.gatekeepers].toSorted());
    assert.ok(configs.has("workshop-backend") && configs.has("router"));
    const backend = configs.get("workshop-backend") as StagingConfig;
    const router = configs.get("router") as StagingConfig;
    assert.deepEqual(backend.services?.map((s) => s.binding).toSorted(),
        deployedGatekeepers.map(gatekeeperBindingName).toSorted());
    assert.deepEqual(router.services?.map((s) => s.binding).toSorted(),
        ["WORKSHOP_BACKEND", ...deployedGatekeepers.map(gatekeeperBindingName)].toSorted());
  }
});

test("every worker is prefixed and every service binding names a sibling in the stage", () => {
  const stage = STAGES.dev;
  const configs = build("dev");
  const workers = new Set([...configs.values()].map((config) => config.name));
  for (const [pkgName, config] of configs) {
    assert.equal(config.name, stageWorkerName(stage, pkgName));
    assert.equal(config.account_id, ACCOUNT_ID);
    assert.equal(config.previews, undefined, `${pkgName} keeps a previews block`);
    for (const service of config.services ?? []) {
      assert.ok(workers.has(service.service), `${pkgName} binds ${service.service}, which the stage does not deploy`);
    }
  }
  const backend = configs.get("workshop-backend") as StagingConfig;
  for (const service of backend.services ?? []) assert.equal(service.entrypoint, "GatekeeperVendor");
  const context = backend.services?.find((s) => s.binding === "GATEKEEPER_CONTEXT");
  assert.deepEqual(context?.props, { sharingDomain: "https://dev-os.factorylevel.dev" });
});

test("only the router is reachable, and only at the stage's custom domain", () => {
  for (const stageName of ["dev", "prod"] as const) {
    for (const [pkgName, config] of build(stageName)) {
      assert.equal(config.workers_dev, false, `${pkgName} workers_dev`);
      assert.equal(config.preview_urls, false, `${pkgName} preview_urls`);
      if (pkgName === "router") {
        assert.deepEqual(config.routes, [{ pattern: STAGES[stageName].hostname, custom_domain: true }]);
        assert.ok(config.assets?.directory, "the router still serves the frontend");
      } else {
        assert.equal(config.routes, undefined, `${pkgName} has routes`);
      }
    }
  }
});

test("resources are the stage's own, named stably and bound by id", () => {
  const stage = STAGES.prod;
  const configs = build("prod");
  const backend = configs.get("workshop-backend") as StagingConfig;
  for (const ns of backend.kv_namespaces ?? []) {
    assert.match(String((ns as { id?: string }).id), /^kv-\d+$/);
    assert.equal((ns as { preview_id?: string }).preview_id, undefined);
  }
  assert.deepEqual(backend.r2_buckets, [{ binding: "BLUEPRINT_CONTENT", bucket_name: "inferos-prod-blueprint-content" }]);
  assert.equal(stageBucketName(stage, "BLUEPRINT_CONTENT"), "inferos-prod-blueprint-content");
  assert.deepEqual(stageKvNamespaces(stage, ALL_PACKAGES).map((ns) => ns.title).toSorted(), [
    "inferos-prod-gatekeeper-context-context-collections",
    "inferos-prod-workshop-backend-avatars",
    "inferos-prod-workshop-backend-blueprints",
  ]);
  assert.throws(() => buildStageConfigs({ stageName: "prod", stage, packages: ALL_PACKAGES,
    accountId: ACCOUNT_ID, kvIds: new Map() }), /no KV namespace id/);
});

test("gatekeepers live under the stage origin; InferOps points at the stage's InferLab", () => {
  for (const stageName of ["dev", "prod"] as const) {
    const stage = STAGES[stageName];
    for (const [pkgName, config] of build(stageName)) {
      if (!isGatekeeperPackage(pkgName)) continue;
      assert.equal(config.vars?.BASE_URL, `https://${stage.hostname}/gatekeeper/${gatekeeperShortName(pkgName)}`);
    }
    const inferops = build(stageName).get("gatekeeper-inferops") as StagingConfig;
    assert.equal(inferops.vars?.INFEROPS_BASE_URL, stage.inferops.baseUrl);
    assert.equal(inferops.vars?.INFERLAB_AUTH_ORIGIN, stage.inferops.authOrigin);
    assert.equal(inferops.vars?.INFEROPS_ENABLED, "true");
    assert.equal(inferops.vars?.CODING_WORKBENCH_ENABLED, "false");
    for (const name of ["INFEROPS_API_TOKEN", "INFEROPS_WORKSPACE_ID", "INFEROPS_WORKSPACE_SLUG", "MOCK_INFEROPS_SYNTHETIC_ISSUES"]) {
      assert.equal(inferops.vars?.[name], undefined, `${name} reached a stage`);
    }
  }
  assert.equal(STAGES.dev.inferops.baseUrl, "https://api.dev.inferlab.io");
  assert.equal(STAGES.prod.inferops.authOrigin, "https://auth.inferlab.io");
});

test("the backend signs in with InferLab only and carries no secret in its vars", () => {
  const backend = build("dev", JSON.stringify({ widgets: [] })).get("workshop-backend") as StagingConfig;
  assert.equal(backend.vars?.PUBLIC_BASE_URL, "https://dev-os.factorylevel.dev");
  assert.equal(backend.vars?.AUTH_GATEKEEPERS, "inferops");
  assert.equal(backend.vars?.DISABLE_PASSWORD_AUTH, "true");
  assert.equal(backend.vars?.COMPOSABLE_VIEWS, "true");
  assert.equal(backend.vars?.DURABLE_VIEWS, "true");
  assert.equal(backend.vars?.CANVAS_CATALOG, JSON.stringify({ widgets: [] }));
  assert.deepEqual(backend.ai, { binding: "WORKERS_AI" });
  for (const name of ["ADMINS", "CF_ACCESS_AUD", "CF_ACCESS_ISS", "CF_AI_GATEWAY_API_TOKEN"]) {
    assert.equal(backend.vars?.[name], undefined, `${name} is a var`);
  }
  assert.equal(build("dev").get("workshop-backend")?.vars?.CANVAS_CATALOG, undefined);
});

test("secrets: admins are required, and the plan names secrets without their values", () => {
  assert.throws(() => resolveStageAdmins({ list: " , " }), /STAGE_ADMINS/);
  const sentinel = "sentinel-secret-value-9f2c";
  const secrets = stageBackendSecrets({ admins: ["admin@example.com"], aiGateway: { CF_AI_GATEWAY_API_TOKEN: sentinel } });
  assert.deepEqual(Object.keys(secrets), ["ADMINS", "CF_AI_GATEWAY_API_TOKEN"]);
  assert.equal(secrets.ADMINS, JSON.stringify(["admin@example.com"]));
  const plan = formatStagePlan({ stageName: "dev", stage: STAGES.dev, configs: build("dev"),
    secretNames: Object.keys(secrets), kv: stageKvNamespaces(STAGES.dev, ALL_PACKAGES) });
  assert.ok(!plan.includes(sentinel), "a secret value reached the plan");
  assert.ok(!plan.includes("admin@example.com"), "an admin email reached the plan");
  assert.match(plan, /secrets: ADMINS, CF_AI_GATEWAY_API_TOKEN/);
  assert.match(plan, /inferos-dev-router at dev-os\.factorylevel\.dev \(custom domain\)/);
});

test("tiers deploy gatekeepers, then the backend, then the router", () => {
  const tiers = stageTiers(build("dev"));
  assert.deepEqual(tiers.map((tier) => tier.packages.length > 0), [true, true, true]);
  assert.deepEqual(tiers[1].packages, ["workshop-backend"]);
  assert.deepEqual(tiers[2].packages, ["router"]);
});

test("destructive Durable Object migrations are found; the committed ones have none", () => {
  assert.deepEqual(destructiveMigrations(stagePackages(STAGES.dev, ALL_PACKAGES)), []);
  const found = destructiveMigrations([{ name: "workshop-backend", config: {
    migrations: [{ tag: "v9", deleted_classes: ["Gone"] }, { tag: "v10", renamed_classes: [{ from: "A", to: "B" }] }],
  } }]);
  assert.deepEqual(found, ["workshop-backend migration v9: deleted_classes", "workshop-backend migration v10: renamed_classes"]);
});

test("the CLI parses its flags and refuses anything else", () => {
  assert.deepEqual(parseStageArgs(["deploy", "dev", "--dry-run", "--allow-dirty"]), {
    command: "deploy", stage: "dev", dryRun: true, allowDirty: true,
    allowDestructiveMigrations: false, skipSmoke: false, confirm: undefined,
  });
  assert.equal(parseStageArgs(["delete", "prod", "--confirm", "os.factorylevel.dev"]).confirm, "os.factorylevel.dev");
  assert.throws(() => parseStageArgs(["deploy"]), /Usage/);
  assert.throws(() => parseStageArgs(["deploy", "dev", "--force"]), /unknown argument: --force/);
});
