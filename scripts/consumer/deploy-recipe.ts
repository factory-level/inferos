#!/usr/bin/env node
// A disposable deployment recipe and its LOCAL preflight (MVP-35, factory-level/inferos#11).
//
// A recipe names everything a future, explicitly opted-in operator would need to put ONE disposable
// smoke deployment of a customer fork on Cloudflare: who owns it, when it expires, the exact source
// revision and wrapper config, and the account, public origin, OAuth origins, Access, ADMINS and
// bindings -- each either a value or `{"unresolved": "<who decides>"}`. This module only checks the
// recipe and prints a plan. It deploys nothing, calls no provider, reads no secret and opens no
// network connection; there is no apply step. Writing a recipe is not approval to deploy.
//
//   node scripts/consumer/deploy-recipe.ts <recipe.json> --config <inferos.config.json> [--json]
//
// Exit codes: 0 valid (the plan is printed; it may still have unresolved inputs), 1 invalid, 2 usage.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseConsumerConfig, type ConsumerConfig } from "./config.ts";

/** The recipe format this preflight reads. */
export const RECIPE_SCHEMA_VERSION = 1;
/** The one environment a recipe may target. Production and shared targets are not expressible. */
export const DISPOSABLE_ENVIRONMENT = "disposable";
/** Ephemeral naming: `inferos-disposable-<slug>-<yyyymmdd>`; the date is the expiry day. */
export const DISPOSABLE_NAME = /^inferos-disposable-[a-z0-9]+(?:-[a-z0-9]+)*-(\d{8})$/u;
/** The longest a disposable deployment may be planned to live. */
export const MAX_LIFETIME_DAYS = 7;
/** Binding kinds a recipe may declare (those the Workers in this repository use). */
export const BINDING_TYPES = ["kv", "r2", "d1", "durable-object", "service", "secret", "browser", "ai", "worker-loader"] as const;
/** Workers whose cloud deployment the release manifest does not support (local-development.md#wrapper-topology). */
export const UNSUPPORTED_CLOUD_EXTENSIONS = ["wrapperGatekeepers", "customWorkers"] as const;

/** A value an owner has not decided yet. Never guessed, never defaulted. */
export interface Unresolved { unresolved: string }
/** A secret, by name only. Its value is never in a recipe or a plan. */
export interface SecretRef { secretRef: string }
type Maybe<T> = T | Unresolved;

/** The cloud-only steps a recipe plans, each with the evidence a future operator must attach. */
export const CLOUD_ONLY_STEPS = [
  { id: "provision-bindings", evidence: "Created resource ids for every binding, in the disposable account" },
  { id: "register-oauth-origins", evidence: "OAuth app callback origins equal to the public origin" },
  { id: "access-policy", evidence: "Cloudflare Access application and policy for the public origin; ADMINS set" },
  { id: "deploy-workers", evidence: "Deployed Worker names and versions, from the recorded source revision" },
  { id: "smoke", evidence: "scripts/preview/smoke.ts report against the public origin" },
  { id: "deployed-only-checks", evidence: "Owner-selected deployed-only checks (for example the COOP header), run against the deployment" },
  { id: "teardown", evidence: "Every Worker and binding deleted by the expiry date; deletion receipts" },
] as const;

/** One preflight finding: which field, and what rule it broke. Never the rejected value. */
export interface RecipeProblem { field: string; rule: string }

/** The plan a valid recipe yields. Deterministic, and free of secret values. */
export interface DeployPlan {
  status: "NOT DEPLOYED";
  note: string;
  recipeDigest: string;
  recipeSchemaVersion: number;
  source: { repository: string; revision: string };
  wrapperConfig: { schemaVersion: number; revision: string; inferopsMode: string };
  target: {
    environment: string;
    name: string;
    owner: string;
    expires: string;
    account: string;
    publicOrigin: string;
    oauthOrigins: string[];
    access: string;
    admins: string;
    bindings: Array<{ name: string; type: string; resource: string }>;
    secrets: string[];
  };
  inferops: { mode: "mock" | "live"; baseUrl: string | null };
  local: Array<{ id: string; status: "checked" }>;
  cloudOnly: Array<{ id: string; status: "not run"; evidence: string; slot: "pending" }>;
  unresolved: Array<{ field: string; decidedBy: string }>;
  readyToApply: false;
  readyReason: string;
}

export type PreflightResult = { ok: true; plan: DeployPlan } | { ok: false; problems: RecipeProblem[] };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isUnresolved = (v: unknown): v is Unresolved =>
  isObject(v) && Object.keys(v).length === 1 && typeof v.unresolved === "string" && v.unresolved.trim().length > 0;
const isSecretRef = (v: unknown): v is SecretRef =>
  isObject(v) && Object.keys(v).length === 1 && typeof v.secretRef === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(v.secretRef);

/** Keys whose literal value would be a credential. Only `{secretRef}` may stand there. */
const SECRET_KEY = /secret|token|password|passwd|api[-_]?key|private[-_]?key|credential/iu;
/** Credential markers, matched ANYWHERE in a string (not only at its start). */
const SECRET_VALUE = /eyJ[\w-]{10,}\.|gh[opsu]_|github_pat_|\bsk-[A-Za-z0-9]|xox[abpr]-|AKIA[0-9A-Z]{12}|\biex_[a-z]+_|-----BEGIN [A-Z ]*PRIVATE KEY/u;
/** A target that names production or a shared environment, in a name, host or label. */
const PRODUCTION_WORD = /(?:^|[^a-z])(?:prod|production|live|main|shared|primary|customer)(?:[^a-z]|$)/iu;

const ALLOWED_KEYS = new Set(["schemaVersion", "kind", "purpose", "owner", "created", "expires", "source", "wrapperConfig", "target", "inferops", "extensions"]);
const ALLOWED_TARGET_KEYS = new Set(["environment", "name", "account", "publicOrigin", "oauthOrigins", "access", "admins", "bindings", "secrets"]);

/** Check a recipe against the wrapper config it names. Pure: no I/O. */
export function validateDeployRecipe(recipe: unknown, wrapperConfig: unknown): PreflightResult {
  const problems: RecipeProblem[] = [];
  const bad = (field: string, rule: string) => problems.push({ field, rule });
  const unresolved: Array<{ field: string; decidedBy: string }> = [];

  // Secret literals anywhere, before anything else reads the recipe.
  const scan = (value: unknown, path: string) => {
    if (typeof value === "string") {
      if (SECRET_VALUE.test(value)) bad(path, "looks like a credential; use {\"secretRef\": \"NAME\"}");
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => scan(item, `${path}[${i}]`));
    } else if (isObject(value)) {
      for (const [key, child] of Object.entries(value)) {
        const childPath = path ? `${path}.${key}` : key;
        if (SECRET_KEY.test(key) && key !== "secrets" && key !== "secretRef" && !isSecretRef(child) && !isUnresolved(child)) {
          bad(childPath, "a credential field must be {\"secretRef\": \"NAME\"}");
          continue;
        }
        scan(child, childPath);
      }
    }
  };
  scan(recipe, "");
  // The wrapper config's values reach the plan too (repository, revision, InferOps mode).
  const configProblems = problems.length;
  scan(wrapperConfig, "(wrapper config)");
  for (const p of problems.slice(configProblems)) p.field = p.field.replace(/^\(wrapper config\)\.?/u, "wrapperConfig:");

  if (!isObject(recipe)) return { ok: false, problems: [{ field: "(recipe)", rule: "must be a JSON object" }] };
  for (const key of Object.keys(recipe)) if (!ALLOWED_KEYS.has(key)) bad(key, "unknown field");
  if (recipe.schemaVersion !== RECIPE_SCHEMA_VERSION) bad("schemaVersion", `must be ${RECIPE_SCHEMA_VERSION}`);
  if (recipe.kind !== "disposable-deploy-recipe") bad("kind", "must be \"disposable-deploy-recipe\"");
  const text = (field: string, value: unknown, max = 200): string | null => {
    if (typeof value !== "string" || value.trim().length === 0) { bad(field, "is required"); return null; }
    if (value.length > max) { bad(field, `is longer than ${max} characters`); return null; }
    return value;
  };
  /** A required input that may be an explicit unresolved marker, but never absent. */
  const decided = <T>(field: string, value: unknown, check: (v: unknown) => T | null): Maybe<T> | null => {
    if (value === undefined) { bad(field, "is required (use {\"unresolved\": \"<who decides>\"} if it is not decided)"); return null; }
    if (isUnresolved(value)) { unresolved.push({ field, decidedBy: value.unresolved }); return value; }
    return check(value);
  };

  text("purpose", recipe.purpose, 500);
  const owner = text("owner", recipe.owner);
  const created = calendarDate(recipe.created);
  if (!created) bad("created", "must be a real calendar date, YYYY-MM-DD");
  const expires = calendarDate(recipe.expires);
  if (!expires) bad("expires", "must be a real calendar date, YYYY-MM-DD");
  if (created && expires) {
    const days = (Date.parse(`${expires}T00:00:00Z`) - Date.parse(`${created}T00:00:00Z`)) / 86_400_000;
    if (!(days >= 0 && days <= MAX_LIFETIME_DAYS)) bad("expires", `must be on or within ${MAX_LIFETIME_DAYS} days after created`);
  }

  // Source and wrapper config: the exact revision and config version being deployed.
  const source = isObject(recipe.source) ? recipe.source : (bad("source", "is required"), {});
  const repository = text("source.repository", source.repository, 500);
  const revision = typeof source.revision === "string" && /^[0-9a-f]{40}$/u.test(source.revision) ? source.revision : null;
  if (!revision) bad("source.revision", "must be a 40-character commit SHA");
  let config: ConsumerConfig | null = null;
  try {
    config = parseConsumerConfig(wrapperConfig);
  } catch (error) {
    bad("wrapperConfig", `the wrapper config is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const wrapper = isObject(recipe.wrapperConfig) ? recipe.wrapperConfig : (bad("wrapperConfig", "is required"), {});
  if (config) {
    if (wrapper.schemaVersion !== config.schemaVersion) bad("wrapperConfig.schemaVersion", "must equal the wrapper config's schemaVersion");
    if (revision && config.upstream.revision !== revision) bad("source.revision", "must equal the wrapper config's upstream.revision");
    if (repository && config.upstream.repository !== repository) bad("source.repository", "must equal the wrapper config's upstream.repository");
  }

  // Target: disposable only, ephemerally named, with explicit (or explicitly unresolved) inputs.
  const target = isObject(recipe.target) ? recipe.target : (bad("target", "is required"), {});
  for (const key of Object.keys(target)) if (!ALLOWED_TARGET_KEYS.has(key)) bad(`target.${key}`, "unknown field");
  if (target.environment !== DISPOSABLE_ENVIRONMENT) bad("target.environment", `must be "${DISPOSABLE_ENVIRONMENT}"; production and shared targets are not supported`);
  const name = typeof target.name === "string" ? target.name : null;
  const nameMatch = name ? DISPOSABLE_NAME.exec(name) : null;
  if (!nameMatch) bad("target.name", "must be inferos-disposable-<slug>-<yyyymmdd>");
  else {
    if (PRODUCTION_WORD.test(name!.replace(/^inferos-disposable-/u, ""))) bad("target.name", "must not name production, live, main, shared or a customer environment");
    const day = nameMatch[1]!;
    if (expires && day !== expires.replaceAll("-", "")) bad("target.name", "its date must be the expiry date");
  }
  const account = decided("target.account", target.account, v => {
    if (typeof v === "string" && /^[0-9a-f]{32}$/u.test(v)) return v;
    bad("target.account", "must be a 32-character Cloudflare account id or unresolved"); return null;
  });
  const originOf = (field: string, v: unknown): string | null => {
    if (typeof v !== "string") { bad(field, "must be an https origin"); return null; }
    let url: URL;
    try { url = new URL(v); } catch { bad(field, "must be an https origin"); return null; }
    if (url.protocol !== "https:") { bad(field, "must use https"); return null; }
    if (url.origin !== v) { bad(field, "must be an origin only: no path, query, fragment, trailing slash or credentials"); return null; }
    if (url.hostname.includes("*")) { bad(field, "must not be a wildcard"); return null; }
    if (/^(?:localhost|127\.|\[?::1\]?$|0\.0\.0\.0)/u.test(url.hostname) || url.hostname.endsWith(".localhost")) {
      bad(field, "must not be a local host"); return null;
    }
    if (PRODUCTION_WORD.test(url.hostname)) { bad(field, "must not name production, live, main, shared or a customer host"); return null; }
    if (nameMatch && url.hostname.split(".")[0] !== name) { bad(field, "its first host label must be the disposable target name"); return null; }
    return v;
  };
  const publicOrigin = decided("target.publicOrigin", target.publicOrigin, v => originOf("target.publicOrigin", v));
  const oauthOrigins = decided("target.oauthOrigins", target.oauthOrigins, v => {
    if (!Array.isArray(v) || v.length === 0) { bad("target.oauthOrigins", "must list at least one origin"); return null; }
    const list = v.map((o, i) => originOf(`target.oauthOrigins[${i}]`, o));
    if (typeof publicOrigin === "string") list.forEach((o, i) => {
      if (o && o !== publicOrigin) bad(`target.oauthOrigins[${i}]`, "must equal the public origin (one public origin per deployment)");
    });
    return list.every(Boolean) ? list as string[] : null;
  });
  const access = decided("target.access", target.access, v => {
    if (isObject(v) && (v.mode === "staff-only" || v.mode === "all-users") && Object.keys(v).length === 1) return v.mode as string;
    bad("target.access", "must be {\"mode\": \"staff-only\" | \"all-users\"} or unresolved"); return null;
  });
  const admins = decided("target.admins", target.admins, v => {
    if (isObject(v) && typeof v.count === "number" && Number.isInteger(v.count) && v.count >= 1 && v.count <= 20 && Object.keys(v).length === 1) {
      return `${v.count} admin(s), named outside the recipe`;
    }
    bad("target.admins", "must be {\"count\": n} (identities stay out of the recipe) or unresolved"); return null;
  });

  // Bindings: known kinds, conventional names, no duplicates; resources are ids or unresolved.
  const bindings: DeployPlan["target"]["bindings"] = [];
  if (!isObject(target.bindings)) bad("target.bindings", "is required (an object of NAME: {type, resource})");
  else {
    const seen = new Set<string>();
    for (const [bindingName, binding] of Object.entries(target.bindings)) {
      const field = `target.bindings.${bindingName}`;
      if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(bindingName)) { bad(field, "a binding name must be UPPER_SNAKE"); continue; }
      if (!isObject(binding) || !(BINDING_TYPES as readonly string[]).includes(binding.type as string)) {
        bad(field, `must be {type: ${BINDING_TYPES.join("|")}, resource}`); continue;
      }
      if (binding.type === "secret") { bad(field, "a secret is listed in target.secrets, not as a binding"); continue; }
      const resource = decided(`${field}.resource`, binding.resource, v => {
        if (typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u.test(v)) return v;
        bad(`${field}.resource`, "must be a resource id or name, or unresolved"); return null;
      });
      if (typeof resource === "string") {
        if (seen.has(resource)) bad(`${field}.resource`, "names a resource another binding already uses");
        if (PRODUCTION_WORD.test(resource)) bad(`${field}.resource`, "must not name a production or shared resource");
        seen.add(resource);
      }
      bindings.push({ name: bindingName, type: binding.type as string, resource: typeof resource === "string" ? resource : "(unresolved)" });
    }
  }
  const secrets: string[] = [];
  if (target.secrets !== undefined) {
    if (!Array.isArray(target.secrets)) bad("target.secrets", "must be a list of {\"secretRef\": \"NAME\"}");
    else target.secrets.forEach((s, i) => {
      if (isSecretRef(s)) secrets.push(s.secretRef);
      else bad(`target.secrets[${i}]`, "must be {\"secretRef\": \"NAME\"}");
    });
  }

  // InferOps: mock unless live is explicit; a live target needs an https base URL.
  const inferopsInput = isObject(recipe.inferops) ? recipe.inferops : (bad("inferops", "is required"), {});
  let inferops: DeployPlan["inferops"] = { mode: "mock", baseUrl: null };
  if (inferopsInput.mode === "live") {
    if (inferopsInput.live !== true) bad("inferops.live", "a live InferOps target must say \"live\": true explicitly");
    const base = decided("inferops.baseUrl", inferopsInput.baseUrl, v => {
      if (typeof v === "string" && v.startsWith("https://")) { try { return new URL(v).origin; } catch { /* fall through */ } }
      bad("inferops.baseUrl", "must be an https URL or unresolved"); return null;
    });
    inferops = { mode: "live", baseUrl: typeof base === "string" ? base : "(unresolved)" };
  } else if (inferopsInput.mode !== "mock") {
    bad("inferops.mode", "must be \"mock\" or \"live\"");
  } else if (inferopsInput.live !== undefined || inferopsInput.baseUrl !== undefined) {
    bad("inferops", "a mock target takes no live or baseUrl");
  }

  // The wrapper config decides where InferOps is read from: a remote wrapper is live, and only an
  // explicit live recipe naming the same base URL may plan it. Never downgraded to mock.
  if (config?.inferops.mode === "remote") {
    const wrapperBase = new URL(config.inferops.baseUrl).origin;
    if (inferops.mode !== "live") {
      bad("inferops.mode", "the wrapper config reads a remote InferOps; the recipe must say \"mode\": \"live\" and \"live\": true");
    } else if (inferops.baseUrl !== wrapperBase) {
      bad("inferops.baseUrl", "must equal the wrapper config's remote InferOps base URL");
    }
  }

  // Extensions the release manifest cannot deploy are refused, not silently dropped.
  if (recipe.extensions !== undefined) {
    if (!isObject(recipe.extensions)) bad("extensions", "must be an object");
    else for (const [key, value] of Object.entries(recipe.extensions)) {
      if ((UNSUPPORTED_CLOUD_EXTENSIONS as readonly string[]).includes(key)) {
        if (value !== false) bad(`extensions.${key}`, "is not supported in a cloud deployment (the release manifest excludes it)");
      } else bad(`extensions.${key}`, "unknown field");
    }
  }

  if (problems.length > 0 || !config || !revision || !repository || !owner || !expires || !name) {
    return { ok: false, problems: problems.length > 0 ? problems : [{ field: "(recipe)", rule: "is incomplete" }] };
  }

  const shown = (v: unknown) => (isUnresolved(v) ? "(unresolved)" : String(v));
  const plan: DeployPlan = {
    status: "NOT DEPLOYED",
    note: "A local preflight only. Nothing was provisioned, deployed or contacted, and no secret was read. " +
      "Cloud-only steps below are not run; a recipe is not approval to deploy.",
    recipeDigest: `sha256:${createHash("sha256").update(canonical(recipe)).digest("hex")}`,
    recipeSchemaVersion: RECIPE_SCHEMA_VERSION,
    source: { repository, revision },
    wrapperConfig: { schemaVersion: config.schemaVersion, revision: config.upstream.revision, inferopsMode: config.inferops.mode },
    target: {
      environment: DISPOSABLE_ENVIRONMENT,
      name,
      owner,
      expires,
      account: shown(account),
      publicOrigin: shown(publicOrigin),
      oauthOrigins: Array.isArray(oauthOrigins) ? oauthOrigins : ["(unresolved)"],
      access: shown(access),
      admins: shown(admins),
      bindings: bindings.toSorted((a, b) => (a.name < b.name ? -1 : 1)),
      secrets: secrets.toSorted(),
    },
    inferops,
    local: [
      "recipe-schema", "secret-literals", "disposable-target", "ephemeral-name-and-expiry", "source-and-config-pin",
      "origins", "bindings", "inferops-mode", "unsupported-extensions",
    ].map(id => ({ id, status: "checked" as const })),
    cloudOnly: CLOUD_ONLY_STEPS.map(step => ({ id: step.id, status: "not run" as const, evidence: step.evidence, slot: "pending" as const })),
    unresolved: unresolved.toSorted((a, b) => (a.field < b.field ? -1 : 1)),
    readyToApply: false,
    readyReason: unresolved.length > 0
      ? `${unresolved.length} input(s) unresolved; and no apply command exists (factory-level/inferos#11)`
      : "No apply command exists (factory-level/inferos#11); an explicit operator decision is still required",
  };
  // Last line of defence: a plan that would print a credential-looking string is not printed.
  if (SECRET_VALUE.test(canonical(plan))) {
    return { ok: false, problems: [{ field: "(plan)", rule: "would contain a credential-looking value; nothing is printed" }] };
  }
  return { ok: true, plan };
}

/** A real calendar date, YYYY-MM-DD (2026-02-30 is not one), or null. */
function calendarDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? null : value;
}

/** Key-order-independent JSON, so the digest names the recipe's content, not its formatting. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).toSorted().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The human-readable plan: a header that cannot be mistaken for a deployment report. */
export function formatPlan(plan: DeployPlan): string {
  const lines = [
    `${plan.status} -- local preflight of ${plan.target.name} (${plan.target.environment}), recipe ${plan.recipeDigest}`,
    plan.note,
    `Source ${plan.source.repository} @ ${plan.source.revision}; wrapper config v${plan.wrapperConfig.schemaVersion}; InferOps ${plan.inferops.mode}.`,
    `Owner ${plan.target.owner}; expires ${plan.target.expires}.`,
    `Account ${plan.target.account}; origin ${plan.target.publicOrigin}; Access ${plan.target.access}; ADMINS ${plan.target.admins}.`,
    ...plan.target.bindings.map(b => `  binding ${b.name} (${b.type}) -> ${b.resource}`),
    ...plan.target.secrets.map(s => `  secret ${s} (by reference; value not read)`),
    "Checked locally:", ...plan.local.map(s => `  [x] ${s.id}`),
    "Cloud-only, NOT RUN:", ...plan.cloudOnly.map(s => `  [ ] ${s.id} -- evidence: ${s.evidence} (pending)`),
    ...(plan.unresolved.length > 0 ? ["Unresolved:", ...plan.unresolved.map(u => `  ${u.field} -- decided by ${u.decidedBy}`)] : []),
    `Ready to apply: no. ${plan.readyReason}.`,
  ];
  return `${lines.join("\n")}\n`;
}

function main(argv: string[]): number {
  const json = argv.includes("--json");
  const args = argv.filter(a => a !== "--json");
  const configAt = args.indexOf("--config");
  const recipePath = args.find((_arg, i) => i !== configAt && i !== configAt + 1);
  const configPath = configAt >= 0 ? args[configAt + 1] : undefined;
  if (!recipePath || !configPath) {
    process.stderr.write("usage: deploy-recipe <recipe.json> --config <inferos.config.json> [--json]\n");
    return 2;
  }
  // A parse error quotes the input, which may hold a secret: report only which file failed.
  const read = (label: string, path: string): { value: unknown } | null => {
    let text: string;
    try { text = readFileSync(path, "utf8"); } catch {
      process.stderr.write(`NOT DEPLOYED -- deploy-recipe: cannot read the ${label} file\n`);
      return null;
    }
    try { return { value: JSON.parse(text) }; } catch {
      process.stderr.write(`NOT DEPLOYED -- deploy-recipe: the ${label} file is not valid JSON\n`);
      return null;
    }
  };
  const recipeInput = read("recipe", recipePath);
  const configInput = recipeInput && read("wrapper config", configPath);
  if (!recipeInput || !configInput) return 2;
  const recipe = recipeInput.value;
  const config = configInput.value;
  const result = validateDeployRecipe(recipe, config);
  if (!result.ok) {
    if (json) process.stdout.write(`${JSON.stringify({ status: "NOT DEPLOYED", ok: false, problems: result.problems }, null, 2)}\n`);
    else process.stderr.write(`NOT DEPLOYED -- the recipe is invalid:\n${result.problems.map(p => `  ${p.field}: ${p.rule}`).join("\n")}\n`);
    return 1;
  }
  process.stdout.write(json ? `${JSON.stringify(result.plan, null, 2)}\n` : formatPlan(result.plan));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)));
