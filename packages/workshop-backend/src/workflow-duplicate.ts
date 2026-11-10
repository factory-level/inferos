// Duplicating a workflow definition (FAC-123): what a duplicate's workflow gadget must have set up
// before it can run, and whether it has. A duplicate copies a definition's code (one commit), never
// its connections: each of the source gadget's bindings becomes a requirement, which only a
// connection from the duplicator's own account or model fills (Overseer.duplicateWorkflowDefinition,
// rebindWorkflowDefinition). Nothing here grants anything; it only names what is missing.
import type { BlueprintBindingAssignment, GatekeeperCreationSpec, WorkpieceId } from "@gadgets/workshop-shared/api";
import {
  WORKFLOW_BINDINGS_NEEDED, WORKFLOW_BINDINGS_NOT_OWNERS, WORKFLOW_BINDINGS_UNATTRIBUTED, type WorkflowRequiredBinding,
} from "@gadgets/workshop-shared/workflow-definition";

/** The refusal of duplicating a workflow whose gadget binds a kind of connection a duplicate can't set up yet. */
export const DUPLICATE_UNSUPPORTED_BINDING =
  "This workflow uses a connection that can't be set up in a copy yet, so it can't be duplicated.";

/** The parts of a binding edge read here (overseer.ts `BindingRecord`). */
type Edge = { target: WorkpieceId; pending?: unknown; blueprintAnnotation?: { title: string } };

/** The parts of a gadget record read here (overseer.ts `GadgetRecord`). */
export type RequiringGadget = {
  bindings: Record<string, Edge>;
  requiredBindings?: WorkflowRequiredBinding[];
  /** The User whose own connections alone fill them: the duplicate's owner (FAC-123). */
  requiredBindingsOwner?: string;
};

/**
 * Whose account or model connection `target` uses (FAC-123): its `connectedBy` user for a vendor
 * connection, the person whose model it is for a model one; undefined when that wasn't recorded.
 */
export type MadeByOf = (target: WorkpieceId) => string | undefined;

/** Looks up a connection's creation spec by id (overseer.ts `GatekeeperRecord.creationSpec`). */
export type SpecOf = (target: WorkpieceId) => GatekeeperCreationSpec | undefined;

/**
 * What a duplicate of a workflow gadget with `bindings` (its mainline edges, `visibleBindings`) must
 * have set up: each one's name, title and what may fill it, never its target, account or resource.
 * A gadget binding anything but a vendor connection or a model is refused, since nothing could set
 * that up from the duplicator's own accounts.
 */
export function requirementsOf(bindings: Iterable<[string, Edge]>, specOf: SpecOf): WorkflowRequiredBinding[] {
  let required: WorkflowRequiredBinding[] = [];
  for (let [name, edge] of bindings) {
    let spec = specOf(edge.target);
    let title = edge.blueprintAnnotation?.title;
    let named = { name, ...(title ? { title } : {}) };
    if (spec?.type === "gatekeeper") {
      required.push({ ...named, type: "gatekeeper", vendorId: spec.vendorId.toLowerCase(), typeUrlPattern: spec.typeUrlPattern });
    } else if (spec?.type === "aiModel") {
      required.push({ ...named, type: "aiModel" });
    } else {
      throw new Error(DUPLICATE_UNSUPPORTED_BINDING);
    }
  }
  return required.toSorted((a, b) => a.name.localeCompare(b.name));
}

/** Whether connection `spec` fills `requirement`: the same kind, and for a vendor the same vendor and resource type. */
export function fills(requirement: WorkflowRequiredBinding, spec: GatekeeperCreationSpec | undefined): boolean {
  if (requirement.type === "aiModel") return spec?.type === "aiModel";
  return spec?.type === "gatekeeper" && spec.vendorId.toLowerCase() === requirement.vendorId &&
    spec.typeUrlPattern === requirement.typeUrlPattern;
}

/**
 * The requirements of `gadget` not set up now: no edge by that name, a provisional one (a chat's,
 * not yet accepted), a missing connection, or one that doesn't fill it. Empty for any gadget that
 * isn't a duplicate's.
 */
export function unmetBindings(gadget: RequiringGadget, specOf: SpecOf, madeByOf: MadeByOf = () => undefined)
    : WorkflowRequiredBinding[] {
  let unmet: WorkflowRequiredBinding[] = [];
  for (let requirement of gadget.requiredBindings ?? []) {
    let edge = gadget.bindings[requirement.name];
    if (!edge || edge.pending !== undefined || !fills(requirement, specOf(edge.target))) {
      unmet.push({ ...requirement, unmet: "missing" });
      continue;
    }
    // Filled only from the duplicate's owner's own account or model, by whatever route (a chat
    // included); a connection that doesn't record whose it is fills nothing.
    let madeBy = madeByOf(edge.target);
    if (madeBy === undefined || gadget.requiredBindingsOwner === undefined) {
      unmet.push({ ...requirement, unmet: "unattributed" });
    } else if (madeBy !== gadget.requiredBindingsOwner) {
      unmet.push({ ...requirement, unmet: "not-owners" });
    }
  }
  return unmet;
}

/** The refusal for `unmet`, in the words that say why: older connections first, then others'. */
export function bindingsRefusal(unmet: readonly WorkflowRequiredBinding[]): string {
  if (unmet.some(r => r.unmet === "unattributed")) return WORKFLOW_BINDINGS_UNATTRIBUTED;
  if (unmet.some(r => r.unmet === "not-owners")) return WORKFLOW_BINDINGS_NOT_OWNERS;
  return WORKFLOW_BINDINGS_NEEDED;
}

/**
 * Refuses while `gadget` (absent: nothing to check) has a requirement not set up, in the words that
 * name why (`bindingsRefusal`): not set up at all (`WORKFLOW_BINDINGS_NEEDED`), set up from another
 * person's connection (`WORKFLOW_BINDINGS_NOT_OWNERS`), or from one that doesn't record whose it is
 * (`WORKFLOW_BINDINGS_UNATTRIBUTED`). Checked at a run's admission, at its firing, as it starts and
 * before each of its writes, so a connection removed or replaced later stops the next one.
 */
export function requireBound(gadget: RequiringGadget | undefined, specOf: SpecOf, madeByOf?: MadeByOf): void {
  let unmet = gadget ? unmetBindings(gadget, specOf, madeByOf) : [];
  if (unmet.length > 0) throw new Error(bindingsRefusal(unmet));
}

/**
 * Checks connections offered for `required` before anything is made: each name must be required, and
 * of the kind it needs. Returns them by name. An agent spawner is never accepted.
 */
export function checkAssignments(required: WorkflowRequiredBinding[], bindings: unknown)
    : Map<string, { requirement: WorkflowRequiredBinding; assignment: BlueprintBindingAssignment }> {
  if (bindings === undefined) return new Map();
  if (typeof bindings !== "object" || bindings === null || Array.isArray(bindings)) {
    throw new TypeError("Connections are given by binding name.");
  }
  let byName = new Map(required.map(requirement => [requirement.name, requirement]));
  let checked = new Map<string, { requirement: WorkflowRequiredBinding; assignment: BlueprintBindingAssignment }>();
  for (let [name, assignment] of Object.entries(bindings as Record<string, unknown>)) {
    let requirement = byName.get(name);
    if (!requirement) throw new Error(`This workflow has no connection named "${name}" to set up.`);
    let a = assignment as Partial<BlueprintBindingAssignment> | null;
    let ok = requirement.type === "gatekeeper"
      ? a?.type === "gatekeeper" && Number.isSafeInteger((a as { accountId?: unknown }).accountId) &&
        typeof (a as { resourceUrl?: unknown }).resourceUrl === "string"
      : a?.type === "aiModel" && typeof (a as { modelId?: unknown }).modelId === "string";
    if (!ok) throw new Error(`The connection "${name}" needs ${requirement.type === "aiModel" ? "one of your models" : "one of your connected accounts and a resource"}.`);
    checked.set(name, { requirement, assignment: a as BlueprintBindingAssignment });
  }
  return checked;
}
