// A workspace's deployment readiness (FAC-144): whether this InferOS workspace has what a company's
// people need to reach their InferOps data and a published experience. Each item is computed from
// what the workspace holds at read time (its connections, its gadgets' bindings and its consoles)
// and from what the deployment's InferOps gatekeeper offers now, never from what a page hides. It
// reads and decides only: it changes nothing, so asking again answers the same while nothing
// changed. It makes no call to InferOps: whether a person's own InferOps authority still reaches a
// bound resource is that person's to find, when they open it.

import { matchesResourceUrlPattern } from "@gadgets/workshop-shared/gatekeeper";
import type { WorkspaceReadiness, WorkspaceReadinessItem } from "@gadgets/workshop-shared/api";

/** The InferOps gatekeeper's vendor id, as connections record it (lowercase). */
export const INFEROPS_VENDOR = "inferops";
/** The custom-table (InferOps Records) resource kind's pattern (gatekeeper-inferops resources.ts). */
export const RECORDS_PATTERN = "inferops://*/object/table/*";
/** The workflow-policy resource kind's pattern (gatekeeper-inferops resources.ts). */
export const WORKFLOW_POLICY_PATTERN = "inferops://*/project/workflow/*";

/** One connection as readiness needs it: its id, vendor, resource and whether a person's account backs it. */
export type ReadinessConnection = {
  id: number;
  vendorId: string | undefined;
  resourceUrl: string | undefined;
  /**
   * Made from a person's connected account (GatekeeperRecord.connectedBy), when it was made: whether
   * that account is still signed in is not read here.
   */
  connected: boolean;
};

/** What `workspaceReadiness` decides from, all read from the workspace and deployment now. */
export type ReadinessInputs = {
  connections: readonly ReadinessConnection[];
  /** Every connection id some gadget here binds, provisional edges excluded. */
  boundConnectionIds: ReadonlySet<number>;
  /** How many consoles here have a published revision, or null while consoles are turned off. */
  publishedConsoles: number | null;
  /**
   * The URL patterns the deployment's InferOps gatekeeper offers now, or null when it has none
   * (no InferOps gatekeeper, or it could not be asked).
   */
  inferopsPatterns: readonly string[] | null;
};

const item = (name: WorkspaceReadinessItem["name"], ready: boolean, detail: string, action: string | null,
    blocked = false): WorkspaceReadinessItem =>
  ({ name, status: ready ? "ready" : blocked ? "blocked" : "attention", detail, action: ready ? null : action });

/**
 * The gatekeeper-inferops demo data's host (`resources.ts`, `DEMO_HOST`): its mock boards, tables
 * and workflow policy match every resource pattern but reach no person's data, so a binding to them
 * never counts as ready.
 */
export const INFEROPS_DEMO_HOST = "demo.local";

// The gatekeeper's own URL grammar (custom-gatekeepers/gatekeeper-inferops/src/resources.ts:
// `SLUG`, `parseHost`, `PROJECT_KEY`, `TABLE_ID`, `parseTableUrl`, `parseProjectWorkflowUrl`),
// reimplemented because gatekeeper-inferops isn't a dependency of the kernel. A URL it would refuse
// can never reach company data, so readiness never counts it. `workspace-readiness.test.ts` runs
// the same inputs through both, so the two can't drift apart unseen.
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PROJECT_KEY = /^[A-Z][A-Z0-9]{0,15}$/;
const TABLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `<tenant>.<workspace>`: exactly two slug labels, as the gatekeeper's `parseHost` takes them, or null. */
function canonicalHost(host: string): string | null {
  let labels = host.split(".");
  return labels.length === 2 && labels.every(label => SLUG.test(label)) ? host : null;
}

/**
 * The host of `url` when the gatekeeper would accept it as a resource of the kind `pattern` names
 * (a custom table or a workflow policy), or null when it would refuse it. Exported for the test
 * that pins it to the gatekeeper's own parsers.
 */
export function reachableHost(url: string, pattern: string): string | null {
  let trimmed = url.trim();
  let match = pattern === RECORDS_PATTERN
    ? /^inferops:\/\/([^/?#]+)\/object\/table\/([^/?#]+)\/?$/.exec(trimmed)
    : pattern === WORKFLOW_POLICY_PATTERN
      ? /^inferops:\/\/([^/?#]+)\/project\/workflow\/([^/?#]+)\/?$/.exec(trimmed)
      : null;
  if (!match) return null;
  let id = pattern === RECORDS_PATTERN ? TABLE_ID : PROJECT_KEY;
  return id.test(match[2]!) ? canonicalHost(match[1]!) : null;
}

/**
 * The authority of any `inferops://` URL in a form the gatekeeper accepts: a canonical
 * `<tenant>.<workspace>` host, or the lone tenant slug of an account URL (`parseAccountUrl`), or null.
 */
function anyCanonicalHost(url: string): string | null {
  let match = /^inferops:\/\/([^/?#]+)\//.exec(url.trim());
  if (!match) return null;
  return canonicalHost(match[1]!) ?? (SLUG.test(match[1]!) ? match[1]! : null);
}

/**
 * How the gadgets here bind the kind `pattern`: to a person's real resource; only to the demo data;
 * only through connections no person's account backs; only to URLs the gatekeeper would refuse; or
 * not at all.
 */
function binding(inputs: ReadinessInputs, pattern: string): "real" | "demo" | "unbacked" | "unreachable" | "none" {
  let bound = inputs.connections.filter(connection =>
    connection.vendorId === INFEROPS_VENDOR && connection.resourceUrl !== undefined &&
    matchesResourceUrlPattern(pattern, connection.resourceUrl) && inputs.boundConnectionIds.has(connection.id))
    .map(connection => ({ ...connection, host: reachableHost(connection.resourceUrl!, pattern) }));
  if (bound.some(c => c.connected && c.host !== null && c.host !== INFEROPS_DEMO_HOST)) return "real";
  if (bound.some(c => c.host === INFEROPS_DEMO_HOST)) return "demo";
  if (bound.some(c => c.host !== null)) return "unbacked";
  return bound.length > 0 ? "unreachable" : "none";
}

/**
 * The kind's own item: blocked while the deployment doesn't offer it, and ready only once a gadget
 * here is bound to one through a person's account and not to the demo data.
 */
function bindingItem(inputs: ReadinessInputs, name: "records-binding" | "workflow-policy-binding",
    pattern: string, noun: string, plural: string): WorkspaceReadinessItem {
  if (!inputs.inferopsPatterns?.includes(pattern)) {
    return item(name, false, `InferOps ${plural} are turned off for this deployment, so nothing can bind them.`,
        `Turn on InferOps ${plural} for this deployment.`, true);
  }
  let configure = `Configure the gadget's InferOps ${noun} connection with your company's own ${noun}.`;
  switch (binding(inputs, pattern)) {
    case "real":
      return item(name, true, `A gadget here is bound to an InferOps ${noun} through a person's account.`, null);
    case "demo":
      return item(name, false, `A gadget here is bound only to the InferOps demo ${noun}, which holds no company data.`,
          configure);
    case "unbacked":
      return item(name, false, `A gadget here is bound to an InferOps ${noun} no person's account backs.`, configure);
    case "unreachable":
      return item(name, false, `A gadget here is bound to an address that isn't an InferOps ${noun} InferOS can reach.`,
          configure);
    case "none":
      return item(name, false, `No gadget here is bound to an InferOps ${noun} yet.`,
          `Install the gadget and configure its InferOps ${noun} connection.`);
  }
}

/**
 * This workspace's readiness from `inputs`: four items, and `deploymentReady` only when every one is
 * ready. A switched-off kind is `blocked`, never ready, whatever is bound.
 */
export function workspaceReadiness(inputs: ReadinessInputs): WorkspaceReadiness {
  let items: WorkspaceReadinessItem[] = [
    inputs.inferopsPatterns === null
      ? item("inferops-connection", false, "This deployment has no InferOps gatekeeper to connect.",
          "Set up the InferOps gatekeeper for this deployment.", true)
      : inputs.connections.some(c => c.vendorId === INFEROPS_VENDOR && c.connected && c.resourceUrl !== undefined &&
          ![null, INFEROPS_DEMO_HOST].includes(anyCanonicalHost(c.resourceUrl)))
        ? item("inferops-connection", true, "A person's InferOps account was connected here.", null)
        : item("inferops-connection", false, "No InferOps connection here is backed by a person's account.",
            "Connect your InferOps account."),
    bindingItem(inputs, "records-binding", RECORDS_PATTERN, "custom table", "custom tables"),
    bindingItem(inputs, "workflow-policy-binding", WORKFLOW_POLICY_PATTERN, "workflow policy", "workflow policies"),
    inputs.publishedConsoles === null
      ? item("published-console", false, "Consoles are turned off for this deployment.",
          "Turn on composable and durable views for this deployment.", true)
      : inputs.publishedConsoles > 0
        ? item("published-console", true, `${inputs.publishedConsoles} published console(s).`, null)
        : item("published-console", false, "No console here is published yet.", "Publish a console."),
  ];
  return { deploymentReady: items.every(i => i.status === "ready"), items };
}
