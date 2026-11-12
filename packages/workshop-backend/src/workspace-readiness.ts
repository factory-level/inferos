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
  /** Made from a person's connected account (GatekeeperRecord.connectedBy). */
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

/** Whether a connection serves `pattern` from the InferOps gatekeeper and some gadget binds it. */
function bound(inputs: ReadinessInputs, pattern: string): boolean {
  return inputs.connections.some(connection =>
    connection.vendorId === INFEROPS_VENDOR && connection.resourceUrl !== undefined &&
    matchesResourceUrlPattern(pattern, connection.resourceUrl) && inputs.boundConnectionIds.has(connection.id));
}

/** The kind's own item: blocked while the deployment doesn't offer it, otherwise ready once bound. */
function bindingItem(inputs: ReadinessInputs, name: "records-binding" | "workflow-policy-binding",
    pattern: string, noun: string, plural: string): WorkspaceReadinessItem {
  if (!inputs.inferopsPatterns?.includes(pattern)) {
    return item(name, false, `InferOps ${plural} are turned off for this deployment, so nothing can bind them.`,
        `Turn on InferOps ${plural} for this deployment.`, true);
  }
  return bound(inputs, pattern)
    ? item(name, true, `A gadget here is bound to an InferOps ${noun}.`, null)
    : item(name, false, `No gadget here is bound to an InferOps ${noun} yet.`,
        `Install the gadget and configure its InferOps ${noun} connection.`);
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
      : inputs.connections.some(c => c.vendorId === INFEROPS_VENDOR && c.connected)
        ? item("inferops-connection", true, "A person's InferOps account is connected here.", null)
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
