import type { AiChatAuthorInfo, WorkpieceId } from "@gadgets/workshop-shared/api";
import {
  MAX_WORKFLOW_DEFINITION_REVISIONS, MAX_WORKFLOW_DELIVERIES, MAX_WORKSPACE_WORKFLOW_DEFINITIONS,
  parseWorkflowDefinitionTitle,
  type WorkflowDefinition, type WorkflowDefinitionDelivery, type WorkflowDefinitionRef,
  type WorkflowDefinitionRevision, type WorkflowDefinitionSave,
} from "@gadgets/workshop-shared/workflow-definition";
import type { OverseerStorage } from "./overseer";

/** A workflow definition as stored: every saved revision, whoever is looking. */
export type StoredWorkflowDefinition = Omit<WorkflowDefinition, "revisions"> & {
  revisions: WorkflowDefinitionRevision[];
};

/** A trigger's pin: the bound hook and the one definition revision it runs. */
export type StoredTriggerPin = WorkflowDefinitionRef & { hookId: number };

/** A stored delivery, numbered so the oldest can be dropped. */
export type StoredWorkflowDelivery = WorkflowDefinitionDelivery & { id: number };

/** Refused, without saying whether the definition exists, to anyone it isn't visible to. */
const NOT_FOUND = "Workflow definition not found.";

/**
 * A workspace's workflow definitions, the triggers pinned to them and the deliveries those made.
 *
 * Saving and publishing are separate acts. `save` adds a revision for its owner and publishes
 * nothing; `publish` makes one saved revision visible to everyone who can use the workspace. An
 * unpublished definition is its owner's alone: everyone else, the workspace owner included, is told
 * it doesn't exist. A trigger pins `{definitionId, revision}` and stays on it when the definition is
 * republished. Callers gate each act on the session's role and shared-configuration authority first
 * (overseer.ts); this store decides ownership and visibility.
 */
export class WorkspaceWorkflowDefinitionStore {
  constructor(private durableStorage: DurableObjectStorage,
      private storage: Pick<OverseerStorage,
          "workflowDefinitions" | "workflowTriggerPins" | "workflowDeliveries" | "nextWorkflowDeliveryId">) {}

  /** The definitions `viewer` may see: their own in full, and others' published revision only. */
  list(viewer: string): WorkflowDefinition[] {
    let shown: WorkflowDefinition[] = [];
    for (let stored of this.storage.workflowDefinitions.list()) {
      let view = viewOf(stored, viewer);
      if (view) shown.push(view);
    }
    return shown;
  }

  /** One definition as `viewer` may see it, or null when it doesn't exist for them. */
  get(viewer: string, id: string): WorkflowDefinition | null {
    let stored = this.storage.workflowDefinitions.get(id);
    return stored ? viewOf(stored, viewer) : null;
  }

  /**
   * Saves `input` as a new revision for `caller`: a new definition when `input.id` is absent, or
   * the caller's own definition otherwise. The revision's source is the gadget's head commit now
   * (`headOf`); a gadget with none, still pending or not a gadget, is refused. Saving the same
   * commit again changes only the title. Publishes nothing.
   */
  save(caller: AiChatAuthorInfo, input: WorkflowDefinitionSave,
       headOf: (gadgetId: WorkpieceId) => string | undefined): WorkflowDefinition {
    let title = parseWorkflowDefinitionTitle(input.title);
    let commitId = headOf(input.gadgetId);
    if (!commitId) throw new Error("A workflow definition is saved from a workflow gadget with committed code.");
    return this.durableStorage.transactionSync(() => {
      let now = new Date();
      let source = { kind: "gadget" as const, gadgetId: input.gadgetId, commitId };
      if (input.id === undefined) {
        if (Array.from(this.storage.workflowDefinitions.list({ limit: MAX_WORKSPACE_WORKFLOW_DEFINITIONS })).length
            >= MAX_WORKSPACE_WORKFLOW_DEFINITIONS) {
          throw new Error("Workspace workflow definition limit reached.");
        }
        let created: StoredWorkflowDefinition = {
          id: crypto.randomUUID(), title, owner: caller,
          revisions: [{ revision: 1, source, savedAt: now }], published: null,
        };
        this.storage.workflowDefinitions.put(created);
        return created;
      }
      let stored = this.#owned(caller.id, input.id);
      let latest = stored.revisions[stored.revisions.length - 1]!;
      let unchanged = latest.source.gadgetId === source.gadgetId && latest.source.commitId === commitId;
      if (!unchanged && stored.revisions.length >= MAX_WORKFLOW_DEFINITION_REVISIONS) {
        throw new Error("This workflow definition has reached its revision limit. Save it as a new definition.");
      }
      let next: StoredWorkflowDefinition = {
        ...stored, title,
        revisions: unchanged
            ? stored.revisions
            : [...stored.revisions, { revision: latest.revision + 1, source, savedAt: now }],
      };
      this.storage.workflowDefinitions.put(next);
      return next;
    });
  }

  /**
   * Makes saved `revision` of `caller`'s own definition the published one. Triggers already pinned
   * to another revision stay on it.
   */
  publish(caller: AiChatAuthorInfo, id: string, revision: number): WorkflowDefinition {
    return this.durableStorage.transactionSync(() => {
      let stored = this.#owned(caller.id, id);
      if (!stored.revisions.some(r => r.revision === revision)) throw new Error("No such revision.");
      let next = { ...stored, published: { revision, at: new Date(), by: caller } };
      this.storage.workflowDefinitions.put(next);
      return next;
    });
  }

  /**
   * Pins the bound hook `hookId`, which wakes `hookGadgetId` (null: none), to `ref`, or clears its pin. `ref`
   * must be visible to `viewer` at that revision (its published revision, or one of the viewer's own
   * saved ones), and name the gadget the hook wakes.
   */
  pinTrigger(viewer: string, hookId: number, hookGadgetId: WorkpieceId | null,
             ref: WorkflowDefinitionRef | null): void {
    this.durableStorage.transactionSync(() => {
      if (ref === null) {
        this.storage.workflowTriggerPins.delete(hookId);
        return;
      }
      let view = this.get(viewer, ref.definitionId);
      let revision = view?.revisions.find(r => r.revision === ref.revision);
      if (!view || !revision) throw new Error(NOT_FOUND);
      if (hookGadgetId === null || revision.source.gadgetId !== hookGadgetId) {
        throw new Error("That revision is for another gadget than the one this trigger wakes.");
      }
      this.storage.workflowTriggerPins.put({ hookId, definitionId: ref.definitionId, revision: ref.revision });
    });
  }

  /** The pin of bound hook `hookId`, or null. */
  pinOf(hookId: number): WorkflowDefinitionRef | null {
    let pin = this.storage.workflowTriggerPins.get(hookId);
    return pin ? { definitionId: pin.definitionId, revision: pin.revision } : null;
  }

  /**
   * Decides a firing of bound hook `hookId`, which wakes `hookGadgetId`. With no pin, there's
   * nothing to decide (null). With one, it refuses unless the pinned revision still exists, its
   * gadget's head is exactly the revision's commit (so what runs is what the revision names), and,
   * for a revision that isn't the published one, its owner can still build here (`ownerCanBuild`).
   * It never falls back to another revision or another person. Otherwise it records the delivery
   * and returns it.
   */
  fire(hookId: number, hookGadgetId: WorkpieceId | null,
       headOf: (gadgetId: WorkpieceId) => string | undefined,
       ownerCanBuild: (profileId: string) => boolean): WorkflowDefinitionDelivery | null {
    let pin = this.storage.workflowTriggerPins.get(hookId);
    if (!pin) return null;
    let stored = this.storage.workflowDefinitions.get(pin.definitionId);
    let revision = stored?.revisions.find(r => r.revision === pin.revision);
    if (!stored || !revision) throw new Error("This trigger's workflow definition revision no longer exists.");
    if (stored.published?.revision !== pin.revision && !ownerCanBuild(stored.owner.id)) {
      throw new Error("This trigger runs an unpublished revision whose owner can no longer build here.");
    }
    if (hookGadgetId === null || revision.source.gadgetId !== hookGadgetId ||
        headOf(hookGadgetId) !== revision.source.commitId) {
      throw new Error(
          `The workflow changed since revision ${pin.revision} was saved. Save it, then move the trigger.`);
    }
    return this.durableStorage.transactionSync(() => {
      let id = this.storage.nextWorkflowDeliveryId.get();
      this.storage.nextWorkflowDeliveryId.put(id + 1);
      let delivery: StoredWorkflowDelivery = {
        id, hookId, definitionId: pin.definitionId, revision: pin.revision,
        commitId: revision.source.commitId, at: new Date(),
      };
      this.storage.workflowDeliveries.put(delivery);
      if (id >= MAX_WORKFLOW_DELIVERIES) this.storage.workflowDeliveries.delete(id - MAX_WORKFLOW_DELIVERIES);
      let { id: _, ...shown } = delivery;
      return shown;
    });
  }

  /** The recorded deliveries of a definition visible to `viewer`, oldest first. */
  deliveries(viewer: string, definitionId: string): WorkflowDefinitionDelivery[] {
    if (!this.get(viewer, definitionId)) throw new Error(NOT_FOUND);
    let shown: WorkflowDefinitionDelivery[] = [];
    for (let { id: _, ...delivery } of this.storage.workflowDeliveries.list()) {
      if (delivery.definitionId === definitionId) shown.push(delivery);
    }
    return shown;
  }

  #owned(profileId: string, id: string): StoredWorkflowDefinition {
    let stored = this.storage.workflowDefinitions.get(id);
    if (!stored || stored.owner.id !== profileId) throw new Error(NOT_FOUND);
    return stored;
  }
}

/** `stored` as `viewer` may see it: all of it for its owner, the published revision for others. */
function viewOf(stored: StoredWorkflowDefinition, viewer: string): WorkflowDefinition | null {
  if (stored.owner.id === viewer) return { ...stored, revisions: [...stored.revisions] };
  if (!stored.published) return null;
  let revision = stored.revisions.find(r => r.revision === stored.published!.revision);
  return revision ? { ...stored, revisions: [revision] } : null;
}
