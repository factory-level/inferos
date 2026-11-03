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
const RESERVED_COMPANIES: ReadonlySet<string> = new Set([...Object.keys(STAGES), "staging", "preview", "test", "local"]);

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
    const theirs = [persistent.hostname, persistent.inferops.authorizeOrigin && new URL(persistent.inferops.authorizeOrigin).hostname];
    if (theirs.includes(stage.hostname)) problems.push(`hostname ${stage.hostname} is the "${name}" stage's`);
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
 * The KV namespace whose existence marks `stage`'s prefix as its own on the account. Its title
 * names the hostname, so a second wrapper that took the same company slug for another hostname
 * finds the first one's marker and is refused before anything is created.
 */
export const ownershipMarker = (stage: StageDefinition) => `${stage.resourcePrefix}owner.${stage.hostname}`;

/**
 * Whether the account's existing KV titles let `stage` deploy, or why not. Read-only: the deploy
 * creates the marker with the stage's other namespaces when this says the prefix is free.
 */
export function ownershipProblem(titles: readonly string[], stage: StageDefinition): string | null {
  const mine = ownershipMarker(stage);
  const underPrefix = titles.filter((title) => title.startsWith(stage.resourcePrefix));
  const markers = underPrefix.filter((title) => title.startsWith(`${stage.resourcePrefix}owner.`));
  if (markers.includes(mine)) return null;
  if (markers.length > 0) {
    return `the prefix ${stage.resourcePrefix} already belongs to another deployment ` +
        `(${markers.map((m) => m.slice(`${stage.resourcePrefix}owner.`.length)).join(", ")}); ` +
        "choose another company slug";
  }
  if (underPrefix.length > 0) {
    return `the account already has ${underPrefix.length} resource(s) under ${stage.resourcePrefix} ` +
        "with no owner record, so they aren't known to be this deployment's; refusing to adopt them";
  }
  return null;
}

/**
 * The commit a wrapper pins InferOS at: its `inferos` gitlink, from `git ls-tree HEAD inferos`
 * output (`160000 commit <sha>\tinferos`). Null when the line is not a gitlink.
 */
export function pinnedRevisionFromLsTree(output: string): string | null {
  const match = /^160000 commit ([0-9a-f]{40})\tinferos$/m.exec(output.trim());
  return match ? match[1]! : null;
}
