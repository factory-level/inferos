// A company's own InferOS, defined by its wrapper repository (FAC-161) and deployed with the same
// machinery as the persistent stages (`stages.ts`, `stage-config.ts`, `stage.ts`).
//
// The wrapper commits `inferos.deploy.json`: which company, which hostname, which InferLab
// environment. Everything that makes the instance an *identity* is derived from the company slug
// rather than chosen, so two companies can't pick colliding names:
//
//   workerPrefix = resourcePrefix = `inferos-<company>-`
//
// The slug is lowercase letters and digits only, so no company's prefix is a prefix of another's
// (`inferos-acme-` can't be extended into `inferos-acme-eu-`), and the persistent stages' names
// (`dev`, `prod`) are refused. On a real deploy, `ownershipProblem` also checks the account: a KV
// namespace named for this stage's hostname marks the prefix as this stage's, and resources under
// the prefix with another hostname's marker, or with no marker, are refused.
//
// Nothing here touches the network; the deploy passes the account's KV titles in.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stageHostnames } from "./stage-config.ts";
import {
  INFEROPS_OPTIONAL_RESOURCES, STAGE_GATEKEEPERS, STAGES, stageDefinitionProblems,
  type InferOpsOptionalResource, type StageDefinition,
} from "./stages.ts";

/** The file a wrapper commits at its root to describe its deployment. */
export const WRAPPER_DEPLOY_FILE = "inferos.deploy.json";

/** Gitignored inputs at the wrapper root (`KEY=value` lines; the shell wins). */
export const WRAPPER_DEPLOY_VARS_FILE = ".inferos-deploy.vars";

/** A company slug: what the deployment's names are derived from. */
const COMPANY = /^[a-z][a-z0-9]{1,30}$/;

/** Slugs that would shadow a persistent stage or read as one. */
const RESERVED_COMPANIES: ReadonlySet<string> = new Set([
  ...Object.keys(STAGES), "staging", "preview", "test", "local",
  // `inferos-disposable-<slug>-<date>` names the deploy recipe's ephemeral instances.
  "disposable",
]);

/** The parsed deploy file. */
export interface WrapperDeployment {
  company: string;
  hostname: string;
  inferops: {
    baseUrl: string;
    authOrigin: string;
    authorizeOrigin?: string;
    resources: InferOpsOptionalResource[];
  };
}

/** A wrapper stage, ready for the stage machinery. */
export interface WrapperStage {
  /** `company-<slug>`: the config file and plan name, never one of the persistent stages'. */
  name: string;
  company: string;
  stage: StageDefinition;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Keys outside `allowed`, so a typo is an error rather than a silently ignored setting. */
const extraKeys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).filter((key) => !allowed.includes(key));

/**
 * Parse `inferos.deploy.json` strictly. Every problem is collected and named by field; no value
 * is echoed except the company slug and hostname, which are the file's public identity.
 */
export function parseWrapperDeployment(raw: unknown): { deployment: WrapperDeployment } | { problems: string[] } {
  const problems: string[] = [];
  if (!isObject(raw)) return { problems: ["the file must be a JSON object"] };
  for (const key of extraKeys(raw, ["$comment", "schemaVersion", "company", "hostname", "inferops"])) {
    problems.push(`unknown field "${key}"`);
  }
  if (raw.schemaVersion !== 1) problems.push("schemaVersion must be 1");
  const company = typeof raw.company === "string" ? raw.company : "";
  if (!COMPANY.test(company)) {
    problems.push("company must be 2 to 31 lowercase letters and digits, starting with a letter (no hyphens)");
  } else if (RESERVED_COMPANIES.has(company)) {
    problems.push(`company "${company}" is reserved`);
  }
  const hostname = typeof raw.hostname === "string" ? raw.hostname : "";
  if (!hostname) problems.push("hostname is required");
  const inferops = isObject(raw.inferops) ? raw.inferops : null;
  if (!inferops) {
    problems.push("inferops must be an object with baseUrl and authOrigin");
    return { problems };
  }
  for (const key of extraKeys(inferops, ["baseUrl", "authOrigin", "authorizeOrigin", "resources"])) {
    problems.push(`unknown field "inferops.${key}"`);
  }
  for (const key of ["baseUrl", "authOrigin"] as const) {
    if (typeof inferops[key] !== "string") problems.push(`inferops.${key} is required`);
  }
  if (inferops.authorizeOrigin !== undefined && typeof inferops.authorizeOrigin !== "string") {
    problems.push("inferops.authorizeOrigin must be a string");
  }
  const resources = inferops.resources ?? [];
  const known = Object.keys(INFEROPS_OPTIONAL_RESOURCES);
  if (!Array.isArray(resources) || resources.some((r) => typeof r !== "string" || !known.includes(r))) {
    problems.push(`inferops.resources must list only ${known.join(", ")}`);
  } else if (new Set(resources).size !== resources.length) {
    problems.push("inferops.resources lists a kind twice");
  }
  if (problems.length > 0) return { problems };
  return {
    deployment: {
      company,
      hostname,
      inferops: {
        baseUrl: inferops.baseUrl as string,
        authOrigin: inferops.authOrigin as string,
        ...(inferops.authorizeOrigin === undefined ? {} : { authorizeOrigin: inferops.authorizeOrigin as string }),
        resources: resources as InferOpsOptionalResource[],
      },
    },
  };
}

/** The prefix every worker and resource of `company` carries. */
export const companyPrefix = (company: string) => `inferos-${company}-`;

/**
 * The stage a deployment describes, checked by the persistent stages' own rules
 * (`stageDefinitionProblems`) and against them: no shared hostname and no overlapping prefix.
 * Wrapper stages always deploy from a clean tree.
 */
export function wrapperStage(deployment: WrapperDeployment): { stage: WrapperStage } | { problems: string[] } {
  const prefix = companyPrefix(deployment.company);
  const stage: StageDefinition = {
    hostname: deployment.hostname,
    workerPrefix: prefix,
    resourcePrefix: prefix,
    auth: { mode: "inferlab" },
    inferops: {
      baseUrl: deployment.inferops.baseUrl,
      authOrigin: deployment.inferops.authOrigin,
      ...(deployment.inferops.authorizeOrigin === undefined ? {} : { authorizeOrigin: deployment.inferops.authorizeOrigin }),
      resources: deployment.inferops.resources,
    },
    gatekeepers: STAGE_GATEKEEPERS,
    requireCleanTree: true,
  };
  const problems = stageDefinitionProblems(stage);
  for (const [name, persistent] of Object.entries(STAGES) as [string, StageDefinition][]) {
    // Every hostname either side serves: the router's and a sign-in proxy's custom domain.
    const theirs = new Set(stageHostnames(persistent));
    for (const host of stageHostnames(stage)) {
      if (theirs.has(host)) problems.push(`hostname ${host} is the "${name}" stage's`);
    }
    for (const other of [persistent.workerPrefix, persistent.resourcePrefix]) {
      if (other.startsWith(prefix) || prefix.startsWith(other)) {
        problems.push(`prefix ${prefix} overlaps the "${name}" stage's ${other}`);
      }
    }
  }
  if (problems.length > 0) return { problems: [...new Set(problems)] };
  return { stage: { name: `company-${deployment.company}`, company: deployment.company, stage } };
}

/** Read and check `<wrapperRoot>/inferos.deploy.json`. Throws with every problem listed. */
export function readWrapperStage(wrapperRoot: string): WrapperStage {
  const path = join(wrapperRoot, WRAPPER_DEPLOY_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${WRAPPER_DEPLOY_FILE} at the wrapper root: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const parsed = parseWrapperDeployment(raw);
  if ("problems" in parsed) throw new Error(`${WRAPPER_DEPLOY_FILE} is invalid:\n  - ${parsed.problems.join("\n  - ")}`);
  const built = wrapperStage(parsed.deployment);
  if ("problems" in built) throw new Error(`${WRAPPER_DEPLOY_FILE} is invalid:\n  - ${built.problems.join("\n  - ")}`);
  return built.stage;
}

/**
 * The KV namespaces whose existence marks `stage`'s prefix and hostnames as its own on the account:
 * one per hostname it serves (`<prefix>owner.<hostname>`). A second wrapper that took the same slug
 * for another hostname, or another slug for one of these hostnames, finds them and is refused
 * before anything is created.
 */
export const ownershipMarkers = (stage: StageDefinition) =>
  stageHostnames(stage).map((host) => `${stage.resourcePrefix}owner.${host}`);

/** Any wrapper deployment's marker: `inferos-<company>-owner.<hostname>`. */
const MARKER = /^(inferos-[a-z][a-z0-9]{1,30}-)owner\.(.+)$/;

/**
 * What the account already holds, of every kind a wrapper deploy creates: KV namespace titles, R2
 * bucket names, and which of the deployment's own worker names exist (Durable Objects live in those
 * workers, so they count through them). Workers can't be listed account-wide here, so the deploy
 * probes each name it would deploy.
 */
export interface AccountResources {
  kv: readonly string[];
  r2: readonly string[];
  workers: readonly string[];
}

/**
 * The claims that conflict with `stage`'s: a marker under its prefix for another hostname, or a
 * marker under another prefix for one of its hostnames.
 */
function rivalClaims(kvTitles: readonly string[], stage: StageDefinition): string[] {
  const mine = new Set(ownershipMarkers(stage));
  const hosts = new Set(stageHostnames(stage));
  return kvTitles.filter((title) => {
    if (mine.has(title)) return false;
    const match = MARKER.exec(title);
    if (!match) return false;
    return match[1] === stage.resourcePrefix || hosts.has(match[2]!);
  });
}

/**
 * Whether the account lets `stage` deploy, or why not. Read-only. A rival claim refuses, even beside
 * this one's own: two claims on one prefix or one hostname mean neither is trusted. With no claim of
 * its own, any Worker, KV namespace or R2 bucket under the prefix refuses too: it isn't known to be
 * this deployment's, so it is never adopted.
 */
export function ownershipProblem(resources: AccountResources, stage: StageDefinition): string | null {
  const rivals = rivalClaims(resources.kv, stage);
  if (rivals.length > 0) {
    return `the prefix ${stage.resourcePrefix} or a hostname of this deployment is claimed by another one ` +
        `(${rivals.join(", ")}); choose another company slug or hostname, or remove the other claim if it is stale`;
  }
  const mine = new Set(ownershipMarkers(stage));
  if (resources.kv.some((title) => mine.has(title))) return null;
  const underPrefix = [
    ...resources.kv.map((name) => `KV namespace ${name}`),
    ...resources.r2.map((name) => `R2 bucket ${name}`),
    ...resources.workers.map((name) => `Worker ${name}`),
  ].filter((label) => label.split(" ").at(-1)!.startsWith(stage.resourcePrefix));
  if (underPrefix.length > 0) {
    return `the account already has ${underPrefix.length} resource(s) under ${stage.resourcePrefix} with no owner ` +
        `record (${underPrefix.slice(0, 5).join(", ")}${underPrefix.length > 5 ? ", …" : ""}), so they aren't known ` +
        "to be this deployment's; refusing to adopt them";
  }
  return null;
}

/**
 * After creating this deployment's markers, the claim holds only if all of them are listed and no
 * rival claim is. Two first deploys that raced past `ownershipProblem` each find the other's marker
 * here, so both refuse (each removing only its own) rather than both deploying.
 */
export function claimProblem(kvTitles: readonly string[], stage: StageDefinition): string | null {
  const missing = ownershipMarkers(stage).filter((marker) => !kvTitles.includes(marker));
  if (missing.length > 0) return `the claim ${missing.join(", ")} was created but isn't listed; refusing to deploy`;
  const rivals = rivalClaims(kvTitles, stage);
  if (rivals.length === 0) return null;
  return `another deployment claimed this prefix or hostname at the same time (${rivals.join(", ")}); ` +
      "this deployment's claim is withdrawn and nothing else was created";
}

/**
 * The names a wrapper's vars file and the shell both set, to different values. A company's inputs
 * are its file's, so another stage's value left exported (an account id, an admin list, an edge
 * secret) must refuse rather than deploy into this company. Names only, never values.
 */
export function conflictingInputs(file: Readonly<Record<string, string | undefined>>, env: NodeJS.ProcessEnv): string[] {
  return Object.entries(file)
    .filter(([key, value]) => env[key] !== undefined && env[key] !== value)
    .map(([key]) => key);
}

/** R2 bucket names from `wrangler r2 bucket list`, or null when the output isn't that listing. */
export function parseR2BucketList(stdout: string): string[] | null {
  if (!stdout.includes("Listing buckets...")) return null;
  return [...stdout.matchAll(/^name:\s+(\S+)\s*$/gm)].map((match) => match[1]!);
}

/**
 * Whether a worker exists, from `wrangler deployments list --name <worker>`: listed (exit 0), not
 * found (Cloudflare's code 10007), or neither, which is an error so the guard fails closed.
 */
export function workerProbe(status: number | null, output: string): boolean {
  if (status === 0) return true;
  if (/\b10007\b/.test(output)) return false;
  throw new Error(`cannot tell whether the worker exists (wrangler exited ${status}); refusing to deploy`);
}

/**
 * The commit a wrapper pins InferOS at: its `inferos` gitlink, from `git ls-tree HEAD inferos`
 * output (`160000 commit <sha>\tinferos`). Null when the line is not a gitlink.
 */
export function pinnedRevisionFromLsTree(output: string): string | null {
  const match = /^160000 commit ([0-9a-f]{40})\tinferos$/m.exec(output.trim());
  return match ? match[1]! : null;
}
