// The persistent stages `scripts/stage/stage.ts` deploys: one named, long-lived InferOS instance
// per entry, each on its own custom domain behind a Cloudflare Access application, each connected
// to its own InferLab environment (InferOps + InferMind).
//
// Only non-secret, reviewable values live here. The account id comes from CLOUDFLARE_ACCOUNT_ID
// and every secret from the shell or a gitignored `.stage-<name>.vars` (see stage-config.ts).
//
// A stage's `workerPrefix` and `resourcePrefix` are part of its identity, not cosmetics. Durable
// Object namespaces belong to a worker *name*, so renaming a prefix deploys a new, empty instance
// beside the old one and silently abandons every user's data. Treat them as immutable once a stage
// has been deployed.

import { INFEROPS_GATEKEEPER, isInferLabAuthOrigin } from "../dev-server-config.ts";

/** How people sign in to a stage. */
export type StageAuthMode =
  /**
   * Cloudflare Access gates the hostname at the edge only; the Workshop itself signs people in with
   * InferLab (`AUTH_GATEKEEPERS=inferops`, password login off). The backend gets no `CF_ACCESS_*`,
   * because with `CF_ACCESS_AUD` set it takes the Access email as the identity and refuses every
   * other login, which would make "Sign in with InferLab" unreachable.
   */
  | "inferlab";

/** One persistent stage. */
export interface StageDefinition {
  /** The stage's public hostname: the router's custom domain, and the instance's whole origin. */
  hostname: string;
  /** Prepended to every worker name (`<prefix><package>`). Immutable once deployed. */
  workerPrefix: string;
  /** Prepended to every KV namespace title and R2 bucket name. Immutable once deployed. */
  resourcePrefix: string;
  /** How people sign in; see {@link StageAuthMode}. */
  auth: { mode: StageAuthMode };
  /** The InferLab environment the InferOps gatekeeper connects people to. */
  inferops: {
    /** The InferOps API every connected person calls with their own InferLab session. */
    baseUrl: string;
    /** InferLab central-auth (`/authorize`, `/auth/token`), a bare HTTPS origin. */
    authOrigin: string;
    /**
     * The one company this deployment belongs to (inferops ADR 0009 T6): its InferOps tenant id,
     * or `"internal"`, InferLab's own, which admits reserved tenants only (the GrokBot seats).
     * InferOps decides it, from its own `auth.sso.inferosCompanies` entry for this origin, and
     * refuses a session in any other company; the gatekeeper checks a tenant id again
     * (`INFEROPS_COMPANY`). It only refuses: it never grants anything.
     */
    company: "internal" | string;
    /**
     * Optional: a second hostname of this stage, served by the InferOps gatekeeper, that forwards
     * InferLab's sign-in pages (gatekeeper-inferops `auth-proxy.ts`). Set it when InferLab's edge
     * admits only allowlisted addresses, so a browser elsewhere can still sign in. It exposes the
     * persona picker, so it must be covered by the stage's Access application; the deploy checks.
     */
    authorizeOrigin?: string;
    /**
     * The optional InferOps resource kinds this stage's gatekeeper offers, each switched on by its
     * own gatekeeper var (gatekeeper-inferops `connection.json`, `enabledBy`). A kind left out is not
     * offered, so a blueprint that binds to it is refused at Configure. List a kind only once this
     * stage's InferLab environment serves it: custom tables need InferOps `objects.enabled`.
     * Turning a kind on never widens a grant: every call is still the person's own InferOps
     * authority.
     */
    resources?: readonly InferOpsOptionalResource[];
  };
  /**
   * The gatekeepers this stage deploys. A gatekeeper left out is neither deployed nor bound, so it
   * is absent from the Workshop rather than offered and broken: the third-party gatekeepers need an
   * OAuth app (`CLIENT_ID`/`CLIENT_SECRET`) that a stage does not configure.
   */
  gatekeepers: readonly string[];
  /** Refuse to deploy from a dirty or detached working tree. */
  requireCleanTree: boolean;
}

/**
 * The gatekeepers every stage runs today: the InferOps gatekeeper (boards, wiki, InferLab sign-in)
 * and the ones that need no third-party OAuth app (see NO_DEFAULT_CRED_INPUTS in
 * release/manifest-lib.ts). `gatekeeper-mcp-portal` is left out because it needs an
 * admin-configured portal URL, and `gatekeeper-homeassistant` because nothing here uses it.
 */
export const STAGE_GATEKEEPERS = [
  INFEROPS_GATEKEEPER, "gatekeeper-context", "gatekeeper-scheduler", "gatekeeper-mcp",
] as const;

/** The InferOps gatekeeper's optional resource kinds, and the var that switches each on. */
export const INFEROPS_OPTIONAL_RESOURCES = {
  tables: "INFEROPS_TABLES_ENABLED",
  members: "INFEROPS_MEMBERS_ENABLED",
  workflowPolicy: "INFEROPS_WORKFLOW_POLICY_ENABLED",
} as const;

/** One optional InferOps resource kind a stage can offer. */
export type InferOpsOptionalResource = keyof typeof INFEROPS_OPTIONAL_RESOURCES;

/** Every stage `pnpm stage:*` accepts, by name. */
export const STAGES = {
  dev: {
    hostname: "dev-os.factorylevel.dev",
    workerPrefix: "inferos-dev-",
    resourcePrefix: "inferos-dev-",
    auth: { mode: "inferlab" },
    inferops: {
      baseUrl: "https://api.dev.inferlab.io",
      authOrigin: "https://auth.dev.inferlab.io",
      // InferLab's own QA stage: the GrokBot seats only.
      company: "internal",
      // Dev InferLab's Cloud Armor admits only allowlisted addresses; external test agents sign in here.
      authorizeOrigin: "https://auth.dev-os.factorylevel.dev",
      // Workflow policy (`project/workflow`) reads InferOps `workflow.get`, which dev serves. Custom
      // tables (`object/table`) read InferOps `table.*`/`object.*`, which dev serves since its
      // `objects.enabled` went on (inferops#2535, FAC-149); prod's InferOps keeps them off.
      resources: ["tables", "workflowPolicy"],
    },
    gatekeepers: STAGE_GATEKEEPERS,
    requireCleanTree: false,
  },
  prod: {
    hostname: "os.factorylevel.dev",
    workerPrefix: "inferos-prod-",
    resourcePrefix: "inferos-prod-",
    auth: { mode: "inferlab" },
    // InferLab's own until a person names the company it serves (inferops `config/production.js`).
    inferops: { baseUrl: "https://api.inferlab.io", authOrigin: "https://auth.inferlab.io", company: "internal" },
    gatekeepers: STAGE_GATEKEEPERS,
    requireCleanTree: true,
  },
} as const satisfies Record<string, StageDefinition>;

/** A stage name `pnpm stage:*` accepts. */
export type StageName = keyof typeof STAGES;

const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether `value` names a deployment's company: `"internal"`, or a lowercase tenant id. */
export function isDeploymentCompany(value: string): boolean {
  return value === "internal" || TENANT_ID.test(value);
}

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const PREFIX = /^[a-z][a-z0-9-]*-$/;

/**
 * The problems with one stage definition, or none. Checked before anything is generated, so a
 * malformed origin fails the run rather than a sign-in on the deployed instance.
 */
export function stageDefinitionProblems(stage: StageDefinition): string[] {
  const problems: string[] = [];
  if (!HOSTNAME.test(stage.hostname)) problems.push(`hostname "${stage.hostname}" is not a lowercase DNS name`);
  for (const [field, value] of [["workerPrefix", stage.workerPrefix], ["resourcePrefix", stage.resourcePrefix]]) {
    if (!PREFIX.test(value)) problems.push(`${field} "${value}" must be lowercase, start with a letter and end with "-"`);
  }
  // Exactly the origin form the gatekeeper accepts, and HTTPS only: a deployed stage never talks to
  // a loopback InferLab, which isInferLabAuthOrigin would otherwise allow.
  for (const [field, value] of [["inferops.baseUrl", stage.inferops.baseUrl], ["inferops.authOrigin", stage.inferops.authOrigin]]) {
    if (!isInferLabAuthOrigin(value) || !value.startsWith("https://")) {
      problems.push(`${field} "${value}" must be a bare https:// origin`);
    }
  }
  if (!isDeploymentCompany(stage.inferops.company)) {
    problems.push(`inferops.company "${stage.inferops.company}" must be "internal" or an InferOps tenant id`);
  }
  const authorize = stage.inferops.authorizeOrigin;
  if (authorize !== undefined) {
    if (!isInferLabAuthOrigin(authorize) || !authorize.startsWith("https://")) {
      problems.push(`inferops.authorizeOrigin "${authorize}" must be a bare https:// origin`);
    } else if ([stage.hostname, new URL(stage.inferops.authOrigin).hostname].includes(new URL(authorize).hostname)) {
      problems.push("inferops.authorizeOrigin must be a hostname of its own, not the stage's or InferLab's");
    }
  }
  if (!stage.gatekeepers.includes(INFEROPS_GATEKEEPER)) {
    problems.push(`gatekeepers must include ${INFEROPS_GATEKEEPER}: it serves InferLab sign-in`);
  }
  if (new Set(stage.gatekeepers).size !== stage.gatekeepers.length) problems.push("gatekeepers lists a package twice");
  return problems;
}

/** The named stage, validated. Throws on an unknown name or a malformed definition. */
export function resolveStage(name: string | undefined): { name: StageName; stage: StageDefinition } {
  if (!name || !Object.hasOwn(STAGES, name)) {
    throw new Error(`unknown stage "${name ?? ""}"; expected one of: ${Object.keys(STAGES).join(", ")}`);
  }
  const stage: StageDefinition = STAGES[name as StageName];
  const problems = stageDefinitionProblems(stage);
  if (problems.length > 0) throw new Error(`stage "${name}" is invalid:\n  - ${problems.join("\n  - ")}`);
  return { name: name as StageName, stage };
}
