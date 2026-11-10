import type { AiChatAuthorInfo, CollaboratorRole, WorkpieceId } from "@gadgets/workshop-shared/api";
import {
  MAX_WORKFLOW_DEFINITION_REVISIONS, MAX_WORKFLOW_DELIVERIES, MAX_WORKFLOW_INVOCATIONS,
  MAX_WORKSPACE_WORKFLOW_DEFINITIONS, TRIGGER_RUNS_PER_INVOKER, TRIGGER_RUNS_PER_TRIGGER,
  WORKFLOW_INVOCATION_TTL_MS, parseTriggerControlSettings, parseWorkflowDefinitionTitle,
  type TriggerAssignment, type TriggerControl, type WorkflowDefinition, type WorkflowDefinitionDelivery,
  type WorkflowDefinitionRevision, type WorkflowDefinitionSave, type WorkflowInvocation, type WorkflowRunFailure, type WorkflowRunResult,
  type WorkflowTriggerDefinitionRef, isLiveWorkflowDelivery,
  type WorkflowRunRecord, MAX_WORKFLOW_DEFINITION_SHARES, parseWorkflowDefinitionRights,
  type WorkflowDefinitionRights, type WorkflowDefinitionShare,
} from "@gadgets/workshop-shared/workflow-definition";
import type { OverseerStorage } from "./overseer";

/** A workflow definition as stored: every saved revision, whoever is looking. */
export type StoredWorkflowDefinition = Omit<WorkflowDefinition, "revisions"> & {
  revisions: WorkflowDefinitionRevision[];
};

/** New trigger rows record their resolution mode; legacy rows without mode retain explicit pins. */
export type StoredTriggerPin = { hookId: number; definitionId: string; revision: number; mode?: "pinned" | "follow-latest" };

/** A definition shared with one account (FAC-122), keyed by `shareKey`. */
export type StoredWorkflowDefinitionShare = WorkflowDefinitionShare & { key: string };

/** The storage key of definition `definitionId`'s share with `profileId`. */
export const shareKey = (definitionId: string, profileId: string) => JSON.stringify([definitionId, profileId]);

/**
 * Who, beyond its owner and the people it is shared with, may read and run a definition's published
 * revision (FAC-122): one function, so the rule can be switched in one place. `role` is the
 * viewer's in this workspace (null: none).
 */
export type WorkflowDefinitionAudience =
  (stored: StoredWorkflowDefinition, role: CollaboratorRole | null) => { read: boolean; run: boolean };

/**
 * Today's rule, kept until the product decision on FAC-122's audience: a published definition is
 * the whole workspace's to read and run (who may run a trigger is still its run control's).
 */
export const WORKSPACE_AUDIENCE: WorkflowDefinitionAudience = (stored, role) =>
  ({ read: stored.published !== null && role !== null, run: role !== null });

/** The rule under decision: a published definition is only its owner's and the people it's shared with. */
export const SHARED_ONLY_AUDIENCE: WorkflowDefinitionAudience = () => ({ read: false, run: false });

/** What a viewer may do with a definition, and whether that comes from a share by name. */
type ViewerRights = WorkflowDefinitionRights & { shared: boolean };

const NO_RIGHTS: ViewerRights = { read: false, run: false, edit: false, shared: false };

/** A stored delivery, numbered so the oldest can be dropped. */
export type StoredWorkflowDelivery = WorkflowDefinitionDelivery & { id: number };

/**
 * A run a person asked for, queued in the workspace that executes it (FAC-112): the firing's one
 * call (`method`, or the callback itself when null) and its arguments, kept until the run ends. Its
 * scope and authority are its delivery's `run`, never anything here.
 */
export type QueuedWorkflowRun = { deliveryId: number; hookId: number; method: string | null; args: unknown[] };

/** The refusal of a second call on a run that was already queued (FAC-112). */
export const WORKFLOW_RUN_ALREADY_STARTED = "This run already started.";

/** A trigger's control: who may ask it to run now. Its revision is always the trigger's pin. */
export type StoredTriggerControl = Required<Omit<TriggerControl, "definition">>;

/** One admitted on-request run, numbered so the oldest can be dropped; what the run rates count. */
export type StoredWorkflowInvocationRecord = { id: number; hookId: number; requestedBy: string; at: number };

/**
 * An admitted request to run a trigger, kept until the trigger's gatekeeper delivers it (or the
 * request to it fails), so a delivery can name only an invocation this workspace minted.
 */
export type StoredWorkflowInvocation = WorkflowInvocation & {
  requestedBy: string;
  /**
   * The InferOps company the person's `workflow:invoke` was answered in (FAC-111), or null where the
   * deployment names no such authority. Absent on requests admitted before FAC-111: read as null.
   */
  company?: string | null;
};

/** Most admitted requests one trigger may have waiting for delivery. */
const MAX_WAITING_INVOCATIONS = 20;

/**
 * Refused, without saying which check failed, to anyone a trigger's control doesn't admit, or who
 * may not run the definition it is pinned to (FAC-122).
 */
export const CANNOT_RUN = "You can't run this trigger.";

/** Refused, without saying whether the definition exists, to anyone it isn't visible to. */
const NOT_FOUND = "Workflow definition not found.";

/**
 * A workspace's workflow definitions, the triggers pinned to them and the deliveries those made.
 *
 * Saving and publishing are separate acts. `save` adds a revision for its owner and publishes
 * nothing; `publish` makes one saved revision visible to everyone who can use the workspace. An
 * unpublished definition is its owner's alone: everyone else, the workspace owner included, is told
 * it doesn't exist. New triggers follow a definition's current published revision; explicit legacy
 * or pinned triggers retain their selected revision. Callers gate each act on the session's role and shared-configuration authority first
 * (overseer.ts); this store decides ownership and visibility.
 */
export class WorkspaceWorkflowDefinitionStore {
  constructor(private durableStorage: DurableObjectStorage,
      private storage: Pick<OverseerStorage,
          "workflowDefinitions" | "workflowTriggerPins" | "workflowDeliveries" | "nextWorkflowDeliveryId" |
          "workflowTriggerControls" | "workflowInvocations" | "workflowInvocationLog" |
          "nextWorkflowInvocationLogId" | "workflowTriggerAssignments" | "workflowTriggerAutoRetired" |
          "workflowRunQueue" | "workflowDefinitionShares">,
      private audience: WorkflowDefinitionAudience = WORKSPACE_AUDIENCE) {}

  /**
   * The definitions `viewer` (whose role here is `role`) may see: their own in full, one shared
   * with them to edit with every revision, and otherwise one they may read with its published
   * revision only (FAC-122; `#rights`).
   */
  list(viewer: string, role: CollaboratorRole | null = "build"): WorkflowDefinition[] {
    let shown: WorkflowDefinition[] = [];
    for (let stored of this.storage.workflowDefinitions.list()) {
      let view = this.#viewOf(stored, viewer, role);
      if (view) shown.push(view);
    }
    return shown;
  }

  /** One definition as `viewer` may see it, or null when it doesn't exist for them. */
  get(viewer: string, id: string, role: CollaboratorRole | null = "build"): WorkflowDefinition | null {
    let stored = this.storage.workflowDefinitions.get(id);
    return stored ? this.#viewOf(stored, viewer, role) : null;
  }

  /**
   * What `viewer`, whose role in this workspace is `role`, may do with `stored` (FAC-122). The owner
   * may do everything. Anyone else needs a role here (a share outlives a removed collaborator but
   * grants them nothing) and gets the union of their share by name and the audience rule. `edit`
   * needs the build role too, since saving reads the workflow gadget's code. Which revision a run
   * executes is its trigger's pin's (`fire`), not the right's.
   */
  #rights(stored: StoredWorkflowDefinition, viewer: string, role: CollaboratorRole | null): ViewerRights {
    if (stored.owner.id === viewer) return { read: true, run: true, edit: true, shared: false };
    if (role === null) return NO_RIGHTS;
    let given = this.storage.workflowDefinitionShares.get(shareKey(stored.id, viewer))?.rights;
    let open = this.audience(stored, role);
    let edit = given?.edit === true && role === "build";
    let run = given?.run === true || open.run;
    return { read: edit || run || given?.read === true || open.read, run, edit, shared: given !== undefined };
  }

  /** `stored` as `viewer` may see it: every revision to edit it, else its published one to read it. */
  #viewOf(stored: StoredWorkflowDefinition, viewer: string, role: CollaboratorRole | null): WorkflowDefinition | null {
    let rights = this.#rights(stored, viewer, role);
    let access = { read: rights.read, run: rights.run, edit: rights.edit };
    let marks = { access, ...(rights.shared ? { sharedWithMe: true } : {}) };
    if (rights.edit) return { ...stored, revisions: [...stored.revisions], ...marks };
    if (!rights.read || !stored.published) return null;
    let revision = stored.revisions.find(r => r.revision === stored.published!.revision);
    return revision ? { ...stored, revisions: [revision], ...marks } : null;
  }

  /**
   * Refuses, in the words every run refusal uses, unless `profileId` (role `role` here) may run the
   * definition trigger `hookId` is pinned to (FAC-122): checked at admission, at fire, and at each
   * protected point of a run, so a revoked share or right stops the next one. A trigger with no
   * pin is refused too. The trigger's run control is checked beside this, never instead of it.
   */
  requireRunRight(profileId: string, hookId: number, role: CollaboratorRole | null): void {
    let pin = this.storage.workflowTriggerPins.get(hookId);
    let stored = pin ? this.storage.workflowDefinitions.get(pin.definitionId) : undefined;
    if (!stored || !this.#rights(stored, profileId, role).run) throw new Error(CANNOT_RUN);
  }

  /**
   * Shares `caller`'s own definition `id` with the account `profileId` (role `recipientRole` in
   * this workspace) with `rights`, or stops sharing it with null (FAC-122). Only the owner shares.
   * The recipient must be a collaborator here, never the owner, and edit needs their build role. A
   * share names the account (its profile id), never an email address.
   */
  share(caller: AiChatAuthorInfo, id: string, profileId: string, rights: unknown,
        recipientRole: CollaboratorRole | null): WorkflowDefinitionShare[] {
    return this.durableStorage.transactionSync(() => {
      let stored = this.#owned(caller.id, id);
      if (typeof profileId !== "string" || profileId.length === 0 || profileId.length > 256 || profileId.includes("@")) {
        throw new Error("Share a workflow with a person's account, not an address.");
      }
      if (profileId === caller.id) throw new Error("You already own this workflow.");
      let key = shareKey(id, profileId);
      if (rights === null) {
        this.storage.workflowDefinitionShares.delete(key);
        return this.#sharesOf(id);
      }
      let parsed = parseWorkflowDefinitionRights(rights);
      if (recipientRole === undefined || recipientRole === null) {
        throw new Error("Share a workflow only with someone who can open this workspace.");
      }
      if (parsed.edit && recipientRole !== "build") {
        throw new Error("Only someone who can build in this workspace can edit a workflow.");
      }
      let existing = this.storage.workflowDefinitionShares.get(key);
      if (!existing && this.#sharesOf(id).length >= MAX_WORKFLOW_DEFINITION_SHARES) {
        throw new Error(`A workflow is shared with at most ${MAX_WORKFLOW_DEFINITION_SHARES} people.`);
      }
      this.storage.workflowDefinitionShares.put({ key, definitionId: stored.id, profileId, rights: parsed,
        sharedBy: caller, sharedAt: new Date() });
      return this.#sharesOf(id);
    });
  }

  /** Who `caller`'s own definition `id` is shared with by name, and how (FAC-122). The owner only. */
  shares(caller: AiChatAuthorInfo, id: string): WorkflowDefinitionShare[] {
    this.#owned(caller.id, id);
    return this.#sharesOf(id);
  }

  #sharesOf(id: string): WorkflowDefinitionShare[] {
    let shown: WorkflowDefinitionShare[] = [];
    for (let { key: _, ...share } of this.storage.workflowDefinitionShares.list()) {
      if (share.definitionId === id) shown.push(share);
    }
    return shown.toSorted((a, b) => a.profileId.localeCompare(b.profileId));
  }

  /**
   * Saves `input` as a new revision for `caller`: a new definition when `input.id` is absent, or
   * an existing one the caller owns or may edit (FAC-122; `role` is theirs here) otherwise, whose
   * revision records them when they aren't the owner. The revision's source is the gadget's head
   * commit now (`headOf`); a gadget with none, still pending or not a gadget, is refused. Saving the
   * same commit again changes only the title. Publishes nothing.
   */
  save(caller: AiChatAuthorInfo, input: WorkflowDefinitionSave,
       headOf: (gadgetId: WorkpieceId) => string | undefined, role: CollaboratorRole | null = "build"): WorkflowDefinition {
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
      let stored = this.#editable(caller.id, input.id, role);
      let latest = stored.revisions[stored.revisions.length - 1]!;
      let unchanged = latest.source.gadgetId === source.gadgetId && latest.source.commitId === commitId;
      if (!unchanged && stored.revisions.length >= MAX_WORKFLOW_DEFINITION_REVISIONS) {
        throw new Error("This workflow definition has reached its revision limit. Save it as a new definition.");
      }
      let next: StoredWorkflowDefinition = {
        ...stored, title,
        revisions: unchanged
            ? stored.revisions
            : [...stored.revisions, { revision: latest.revision + 1, source, savedAt: now,
                ...(caller.id === stored.owner.id ? {} : { savedBy: caller }) }],
      };
      this.storage.workflowDefinitions.put(next);
      return this.#viewOf(next, caller.id, role)!;
    });
  }

  /**
   * Makes saved `revision` of definition `id` the published one. Its owner may; so may someone it
   * is shared with to edit, only where `editorsMayPublish` (the deployment's shared configuration
   * is in force here and the caller holds its publish authority, which the caller checked first;
   * FAC-122). Triggers already pinned to another revision stay on it.
   */
  publish(caller: AiChatAuthorInfo, id: string, revision: number,
          { editorsMayPublish = false, role = "build" }: { editorsMayPublish?: boolean; role?: CollaboratorRole | null } = {})
      : WorkflowDefinition {
    return this.durableStorage.transactionSync(() => {
      let stored = editorsMayPublish ? this.#editable(caller.id, id, role) : this.#owned(caller.id, id);
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
             ref: WorkflowTriggerDefinitionRef | null): void {
    this.durableStorage.transactionSync(() => {
      // A waiting request was admitted for the revision pinned then: any pin change drops it.
      this.#dropInvocations(hookId);
      if (ref === null) {
        // A control and an assignment run the pinned revision, so they go with the pin.
        this.storage.workflowTriggerPins.delete(hookId);
        this.storage.workflowTriggerControls.delete(hookId);
        this.storage.workflowTriggerAssignments.delete(hookId);
        return;
      }
      let view = this.get(viewer, ref.definitionId);
      let revision = view?.revisions.find(r => r.revision === ref.revision);
      if (!view || !revision) throw new Error(NOT_FOUND);
      // An editor sees unpublished revisions, but only the owner may run one (FAC-122).
      if (view.owner.id !== viewer && view.published?.revision !== ref.revision) throw new Error(NOT_FOUND);
      if (hookGadgetId === null || revision.source.gadgetId !== hookGadgetId) {
        throw new Error("That revision is for another gadget than the one this trigger wakes.");
      }
      this.storage.workflowTriggerPins.put({ hookId, definitionId: ref.definitionId,
        revision: ref.revision, mode: ref.mode ?? "follow-latest" });
    });
  }

  /** The pin of bound hook `hookId`, or null. */
  pinOf(hookId: number): WorkflowTriggerDefinitionRef | null {
    let pin = this.storage.workflowTriggerPins.get(hookId);
    if (!pin) return null;
    let stored = this.storage.workflowDefinitions.get(pin.definitionId);
    return { definitionId: pin.definitionId,
      revision: pin.mode === "follow-latest" ? stored?.published?.revision ?? pin.revision : pin.revision,
      mode: pin.mode ?? "pinned" };
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
       ownerCanBuild: (profileId: string) => boolean,
       invocationId?: string,
       roleOf: (profileId: string) => CollaboratorRole | null = () => "build"): (WorkflowDefinitionDelivery & { deliveryId: number }) | null {
    // A delivery a person asked for names an invocation minted here for this trigger, not yet run;
    // anything else starts nothing.
    let invocation = invocationId === undefined ? undefined : this.storage.workflowInvocations.get(invocationId);
    if (invocationId !== undefined && invocation?.hookId !== hookId) {
      throw new Error("That run request is unknown or already ran.");
    }
    if (invocation && Date.now() - invocation.requestedAt.getTime() > WORKFLOW_INVOCATION_TTL_MS) {
      this.storage.workflowInvocations.delete(invocation.id);
      throw new Error("That run request expired. Ask again.");
    }
    let pin = this.storage.workflowTriggerPins.get(hookId);
    if (!pin) {
      if (invocation) throw new Error(CANNOT_RUN);
      return null;
    }
    // The person who asked must still be allowed to run the definition (FAC-122), as at admission.
    if (invocation) {
      try {
        this.requireRunRight(invocation.requestedBy, hookId, roleOf(invocation.requestedBy));
      } catch (error) {
        this.storage.workflowInvocations.delete(invocation.id);
        throw error;
      }
    }
    // Follow-latest accepts a newer publication; an explicit revision pin keeps its old behavior.
    if (invocation && (invocation.definitionId !== pin.definitionId ||
        (pin.mode !== "follow-latest" && invocation.revision !== pin.revision))) {
      this.storage.workflowInvocations.delete(invocation.id);
      throw new Error("That run request was for another revision of this workflow. Ask again.");
    }
    let { stored, revision: currentPublished } = pin.mode === "follow-latest"
      ? this.#currentPublishedRevision(pin, hookGadgetId, headOf)
      : this.#explicitRevision(pin, hookGadgetId, headOf);
    // Follow-latest invocations may wait while the gadget changes. Never record a run against an
    // older commit while the trigger would execute the newer gadget head.
    let revision = invocation && pin.mode === "follow-latest"
      ? stored.revisions.find(candidate => candidate.revision === invocation.revision)
      : currentPublished;
    if (!revision || (invocation && pin.mode === "follow-latest" && revision.source.gadgetId !== hookGadgetId)) {
      throw new Error("That run request was for another revision of this workflow. Ask again.");
    }
    if (invocation && pin.mode === "follow-latest" &&
        headOf(hookGadgetId!) !== revision.source.commitId) {
      this.storage.workflowInvocations.delete(invocation.id);
      throw new Error("The workflow changed; ask again");
    }
    if (pin.mode !== "follow-latest" && stored.published?.revision !== pin.revision &&
        !ownerCanBuild(stored.owner.id)) {
      throw new Error("This trigger runs an unpublished revision whose owner can no longer build here.");
    }
    return this.durableStorage.transactionSync(() => {
      let deliveries = Array.from(this.storage.workflowDeliveries.list()).toSorted((a, b) => a.id - b.id);
      if (deliveries.length >= MAX_WORKFLOW_DELIVERIES) {
        let now = Date.now();
        let isLive = (candidate: StoredWorkflowDelivery) => isLiveWorkflowDelivery(candidate, now);
        let terminal = deliveries.find(candidate => !isLive(candidate));
        if (!terminal) {
          let needsReconciliation = deliveries.filter(isLive).length;
          throw new Error(`Too many workflow runs are in progress; ${needsReconciliation} are waiting for reconciliation.`);
        }
        this.storage.workflowDeliveries.delete(terminal.id);
      }
      let id = this.storage.nextWorkflowDeliveryId.get();
      this.storage.nextWorkflowDeliveryId.put(id + 1);
      // A request runs as the trigger's assigned service account, when it has one (FAC-102).
      let assignment = invocation ? this.storage.workflowTriggerAssignments.get(hookId) : undefined;
      // The durable run (FAC-111): minted here, in the delivery's own transaction, so a run exists
      // exactly when its delivery does, with the authority it was admitted under.
      let runId = crypto.randomUUID();
      let delivery: StoredWorkflowDelivery = {
        id, hookId, definitionId: pin.definitionId, revision: revision.revision,
        commitId: revision.source.commitId, at: new Date(),
        ...(invocation ? { invocation: { id: invocation.id, requestedBy: invocation.requestedBy } } : {}),
        ...(assignment ? { executedAs: { credentialRef: assignment.credentialRef } } : {}),
        run: {
          runId,
          correlationId: invocation ? invocation.id : runId,
          company: invocation?.company ?? null,
          requester: invocation ? { kind: "person", profileId: invocation.requestedBy } : { kind: "trigger" },
          executor: assignment
            ? { kind: "service_account", gatekeeperId: assignment.gatekeeperId, credentialRef: assignment.credentialRef }
            : { kind: "gadget_bindings" },
        },
      };
      if (invocation) this.storage.workflowInvocations.delete(invocation.id);
      this.storage.workflowDeliveries.put(delivery);
      let { id: _, ...shown } = delivery;
      return { ...shown, deliveryId: id };
    });
  }

  /**
   * Refuses unless the trigger resolves to a publishable source for its hook: follow-latest resolves
   * the published revision, while an explicit pin also requires its commit to remain the gadget head.
   * Checked at admission and again by `fire`.
   */
  requireCurrentRevision(hookId: number, hookGadgetId: WorkpieceId | null,
      headOf: (gadgetId: WorkpieceId) => string | undefined): void {
    let pin = this.storage.workflowTriggerPins.get(hookId);
    if (!pin) throw new Error(CANNOT_RUN);
    if (pin.mode === "follow-latest") this.#currentPublishedRevision(pin, hookGadgetId, headOf);
    else this.#explicitRevision(pin, hookGadgetId, headOf);
  }

  // Resolve the selected definition's current published source; saves never publish implicitly.
  #currentPublishedRevision(pin: StoredTriggerPin, hookGadgetId: WorkpieceId | null,
      headOf: (gadgetId: WorkpieceId) => string | undefined) {
    let stored = this.storage.workflowDefinitions.get(pin.definitionId);
    if (!stored?.published) throw new Error("This workflow has no published revision.");
    let revision = stored.revisions.find(r => r.revision === stored!.published!.revision);
    if (!revision) throw new Error("This workflow has no published revision.");
    if (hookGadgetId === null || revision.source.gadgetId !== hookGadgetId)
      throw new Error("This workflow is not available for this trigger.");
    if (headOf(hookGadgetId) !== revision.source.commitId) {
      throw new Error(`The workflow changed since revision ${revision.revision} was saved. Save it, then move the trigger.`);
    }
    return { stored, revision };
  }

  #explicitRevision(pin: StoredTriggerPin, hookGadgetId: WorkpieceId | null,
      headOf: (gadgetId: WorkpieceId) => string | undefined) {
    let stored = this.storage.workflowDefinitions.get(pin.definitionId);
    let revision = stored?.revisions.find(r => r.revision === pin.revision);
    if (!stored || !revision) throw new Error("This trigger's workflow definition revision no longer exists.");
    if (hookGadgetId === null || revision.source.gadgetId !== hookGadgetId ||
        headOf(hookGadgetId) !== revision.source.commitId) {
      throw new Error(
          `The workflow changed since revision ${pin.revision} was saved. Save it, then move the trigger.`);
    }
    return { stored, revision };
  }

  /**
   * Assigns trigger `hookId`'s on-request runs to the service account provisioned for a fresh
   * credential reference in connection `gatekeeperId`, or removes the assignment with null. Only a
   * pinned trigger can have one. Requests waiting were admitted for the assignment as it was, so
   * any change drops them. The caller checks the connection (overseer.ts); this keeps the record.
   */
  setAssignment(caller: AiChatAuthorInfo, hookId: number, gatekeeperId: number | null): TriggerAssignment | null {
    return this.durableStorage.transactionSync(() => {
      this.#dropInvocations(hookId);
      // An Admin re-assigning or removing it is the action an automatic retirement waits for.
      this.storage.workflowTriggerAutoRetired.delete(hookId);
      if (gatekeeperId === null) {
        this.storage.workflowTriggerAssignments.delete(hookId);
        return null;
      }
      if (!this.storage.workflowTriggerPins.get(hookId)) {
        throw new Error("Only a trigger pinned to a workflow definition revision can be assigned.");
      }
      let stored: TriggerAssignment = {
        hookId, gatekeeperId, credentialRef: crypto.randomUUID(), assignedBy: caller, assignedAt: new Date(),
      };
      this.storage.workflowTriggerAssignments.put(stored);
      return { ...stored };
    });
  }

  /**
   * Records that `by` gave the service account's key for trigger `hookId`'s assignment, if the
   * assignment still has `credentialRef` (one changed meanwhile isn't touched). Never the key.
   */
  markProvisioned(hookId: number, credentialRef: string, by: AiChatAuthorInfo): TriggerAssignment | null {
    return this.durableStorage.transactionSync(() => {
      let stored = this.storage.workflowTriggerAssignments.get(hookId);
      if (!stored || stored.credentialRef !== credentialRef) return null;
      let updated: TriggerAssignment = { ...stored, provisionedBy: by, provisionedAt: new Date() };
      this.storage.workflowTriggerAssignments.put(updated);
      return { ...updated };
    });
  }

  /**
   * Marks trigger `hookId` as having had its assignment retired automatically (FAC-102 follow-up B,
   * a refused key that couldn't be forgotten): runs on request are refused while the mark stands,
   * rather than falling back to the gadget's own connections, until an Admin re-assigns the trigger
   * or removes its assignment (`setAssignment`, which clears it). A retirement a person chose leaves
   * no mark.
   */
  markAutoRetired(hookId: number): void {
    this.storage.workflowTriggerAutoRetired.put({ hookId, retiredAt: new Date() });
  }

  /** Trigger `hookId`'s automatic-retirement mark, or null (see `markAutoRetired`). */
  autoRetiredOf(hookId: number): { hookId: number; retiredAt: Date } | null {
    let stored = this.storage.workflowTriggerAutoRetired.get(hookId);
    return stored ? { ...stored } : null;
  }

  /** Every assignment. */
  assignments(): TriggerAssignment[] {
    return Array.from(this.storage.workflowTriggerAssignments.list(), stored => ({ ...stored }));
  }

  /** The assignments whose runs use connection `gatekeeperId`. */
  assignmentsUsing(gatekeeperId: number): TriggerAssignment[] {
    let found: TriggerAssignment[] = [];
    for (let stored of this.storage.workflowTriggerAssignments.list()) {
      if (stored.gatekeeperId === gatekeeperId) found.push({ ...stored });
    }
    return found;
  }

  /** Removes trigger `hookId`'s assignment, dropping runs waiting to start on it. */
  removeAssignment(hookId: number): void {
    this.durableStorage.transactionSync(() => {
      this.#dropInvocations(hookId);
      this.storage.workflowTriggerAssignments.delete(hookId);
    });
  }

  /** The assignment of trigger `hookId`, or null. */
  assignmentOf(hookId: number): TriggerAssignment | null {
    let stored = this.storage.workflowTriggerAssignments.get(hookId);
    return stored ? { ...stored } : null;
  }

  /**
   * Sets who may ask trigger `hookId` to run now, or removes its control with null. Only a pinned
   * trigger can have one. `settings` is checked here and nothing else of it is kept.
   */
  setControl(caller: AiChatAuthorInfo, hookId: number, settings: unknown): TriggerControl | null {
    return this.durableStorage.transactionSync(() => {
      // Requests waiting were admitted by the control as it was: changing it drops them.
      this.#dropInvocations(hookId);
      if (settings === null) {
        this.storage.workflowTriggerControls.delete(hookId);
        return null;
      }
      let pin = this.storage.workflowTriggerPins.get(hookId);
      if (!pin) throw new Error("Only a trigger pinned to a workflow definition revision can have a control.");
      let { label, invokers } = parseTriggerControlSettings(settings);
      let stored: StoredTriggerControl = { hookId, label, invokers, configuredBy: caller, configuredAt: new Date() };
      this.storage.workflowTriggerControls.put(stored);
      return { ...stored, definition: { definitionId: pin.definitionId,
        revision: pin.mode === "follow-latest"
          ? this.storage.workflowDefinitions.get(pin.definitionId)?.published?.revision ?? pin.revision
          : pin.revision } };
    });
  }

  /**
   * The controls of pinned triggers: every one for a builder (`viewer` null), or only those listing
   * `viewer`, each showing `viewer` as its only invoker.
   */
  controls(viewer: string | null): TriggerControl[] {
    let shown: TriggerControl[] = [];
    for (let control of this.storage.workflowTriggerControls.list()) {
      let pin = this.storage.workflowTriggerPins.get(control.hookId);
      if (!pin || (viewer !== null && !control.invokers.includes(viewer))) continue;
      shown.push(viewer === null
        ? { ...control, invokers: [...control.invokers], definition: {
          definitionId: pin.definitionId,
          revision: pin.mode === "follow-latest"
            ? this.storage.workflowDefinitions.get(pin.definitionId)?.published?.revision ?? pin.revision
            : pin.revision,
        } }
        : { hookId: control.hookId, label: control.label });
    }
    return shown;
  }

  /**
   * Admits `profileId`'s request to run trigger `hookId` now: its control must list them and the
   * trigger must still be pinned. Mints the invocation, which the trigger's delivery must name
   * (`fire`). Every refusal reads the same, whether there's no control, no pin or no listing.
   */
  beginInvocation(profileId: string, hookId: number, company: string | null = null): WorkflowInvocation {
    return this.durableStorage.transactionSync(() => {
      let control = this.storage.workflowTriggerControls.get(hookId);
      let pin = this.storage.workflowTriggerPins.get(hookId);
      if (!control || !pin || !control.invokers.includes(profileId)) throw new Error(CANNOT_RUN);
      let waiting = 0;
      for (let invocation of this.storage.workflowInvocations.list()) if (invocation.hookId === hookId) waiting++;
      if (waiting >= MAX_WAITING_INVOCATIONS) throw new Error("This trigger already has too many runs waiting to start.");
      let now = Date.now();
      this.#checkRate(hookId, profileId, now);
      let logId = this.storage.nextWorkflowInvocationLogId.get();
      this.storage.nextWorkflowInvocationLogId.put(logId + 1);
      this.storage.workflowInvocationLog.put({ id: logId, hookId, requestedBy: profileId, at: now });
      if (logId >= MAX_WORKFLOW_INVOCATIONS) this.storage.workflowInvocationLog.delete(logId - MAX_WORKFLOW_INVOCATIONS);
      let invocation: StoredWorkflowInvocation = {
        id: crypto.randomUUID(), hookId, definitionId: pin.definitionId,
        revision: pin.mode === "follow-latest"
          ? this.storage.workflowDefinitions.get(pin.definitionId)?.published?.revision ?? pin.revision
          : pin.revision,
        requestedAt: new Date(now), requestedBy: profileId, company,
      };
      this.storage.workflowInvocations.put(invocation);
      let { requestedBy: _, company: __, ...shown } = invocation;
      return shown;
    });
  }

  /** Refuses a run past the per-person or per-trigger rate, saying when one may run again. */
  #checkRate(hookId: number, profileId: string, now: number): void {
    let byInvoker: number[] = [];
    let byTrigger: number[] = [];
    for (let record of this.storage.workflowInvocationLog.list()) {
      if (record.hookId !== hookId) continue;
      if (now - record.at < TRIGGER_RUNS_PER_TRIGGER.windowMs) byTrigger.push(record.at);
      if (record.requestedBy === profileId && now - record.at < TRIGGER_RUNS_PER_INVOKER.windowMs) byInvoker.push(record.at);
    }
    let retry = (times: number[], windowMs: number) => {
      let minutes = Math.max(1, Math.ceil((Math.min(...times) + windowMs - now) / 60_000));
      return `Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
    };
    if (byInvoker.length >= TRIGGER_RUNS_PER_INVOKER.runs) {
      throw new Error(`You've run this trigger ${TRIGGER_RUNS_PER_INVOKER.runs} times in the last 10 minutes. ` +
          retry(byInvoker, TRIGGER_RUNS_PER_INVOKER.windowMs));
    }
    if (byTrigger.length >= TRIGGER_RUNS_PER_TRIGGER.runs) {
      throw new Error(`This trigger has run on request ${TRIGGER_RUNS_PER_TRIGGER.runs} times in the last hour. ` +
          retry(byTrigger, TRIGGER_RUNS_PER_TRIGGER.windowMs));
    }
  }

  #dropInvocations(hookId: number): void {
    for (let invocation of this.storage.workflowInvocations.list()) {
      if (invocation.hookId === hookId) this.storage.workflowInvocations.delete(invocation.id);
    }
  }

  /**
   * Whether invocation `id` is still waiting: minted, and neither consumed by a delivery nor dropped
   * by a pin, control or assignment change, nor cancelled. It doesn't say which of those happened.
   */
  isWaiting(id: string): boolean {
    return this.storage.workflowInvocations.get(id) !== undefined;
  }

  /** Forgets an invocation the trigger's gatekeeper didn't take, so it can never start a run. */
  cancelInvocation(id: string): void {
    this.storage.workflowInvocations.delete(id);
  }

  /** Forgets trigger `hookId`'s pin, control, assignment and waiting invocations (its hook is gone). */
  forgetTrigger(hookId: number): void {
    this.durableStorage.transactionSync(() => {
      this.storage.workflowTriggerPins.delete(hookId);
      this.storage.workflowTriggerControls.delete(hookId);
      this.storage.workflowTriggerAssignments.delete(hookId);
      this.storage.workflowTriggerAutoRetired.delete(hookId);
      for (let invocation of this.storage.workflowInvocations.list()) {
        if (invocation.hookId === hookId) this.storage.workflowInvocations.delete(invocation.id);
      }
    });
  }

  /**
   * One admitted run, as stored at admission (FAC-111): its authority, and the revision and commit
   * it started on. Read from the delivery record alone, never from a pin, a definition's current
   * revisions or a chat, so it reads the same after a restart. Null for an unknown run, or one whose
   * delivery is older than FAC-111 or was dropped past `MAX_WORKFLOW_DELIVERIES`.
   */
  run(runId: string): WorkflowRunRecord | null {
    for (let delivery of this.storage.workflowDeliveries.list()) {
      if (delivery.run?.runId !== runId) continue;
      return {
        ...delivery.run, hookId: delivery.hookId, definitionId: delivery.definitionId,
        revision: delivery.revision, commitId: delivery.commitId, admittedAt: delivery.at,
      };
    }
    return null;
  }

  /**
   * What delivery `deliveryId` recorded about who asked for it (FAC-104): its admitted run, and
   * whether a person asked through an invocation. Null when the delivery is unknown or was dropped
   * past `MAX_WORKFLOW_DELIVERIES`. `run` is absent on a delivery recorded before FAC-111.
   */
  deliveryRun(deliveryId: number): { invoked: boolean; run?: WorkflowRunRecord } | null {
    let delivery = this.storage.workflowDeliveries.get(deliveryId);
    if (!delivery) return null;
    return {
      invoked: delivery.invocation !== undefined,
      ...(delivery.run ? { run: this.run(delivery.run.runId) ?? undefined } : {}),
    };
  }

  /**
   * Queue the run delivery `deliveryId` admitted for a person (FAC-112), with the firing's one call:
   * recorded together with its `execution` (`queued`) in one step, so the run is queued exactly when
   * its record says so. Refuses a delivery no person asked for, a run already queued or ended
   * (`WORKFLOW_RUN_ALREADY_STARTED`), and arguments storage can't hold (a function or a stub).
   */
  queueRun(hookId: number, deliveryId: number, method: string | null, args: unknown[]): void {
    let delivery = this.storage.workflowDeliveries.get(deliveryId);
    if (!delivery?.invocation || !delivery.run || delivery.hookId !== hookId) throw new Error(CANNOT_RUN);
    if (delivery.execution || this.storage.workflowRunQueue.get(deliveryId)) {
      throw new Error(WORKFLOW_RUN_ALREADY_STARTED);
    }
    try {
      structuredClone(args);
    } catch {
      throw new Error("This run's arguments can't be stored, so it can't run.");
    }
    this.durableStorage.transactionSync(() => {
      this.storage.workflowRunQueue.put({ deliveryId, hookId, method, args });
      this.storage.workflowDeliveries.put({ ...delivery, execution: { state: "queued", attempts: 0, queuedAt: new Date() } });
    });
  }

  /** Every queued run, by delivery (FAC-112): what the workspace still has to run, or to run again. */
  queuedRuns(): QueuedWorkflowRun[] {
    return [...this.storage.workflowRunQueue.list()];
  }

  /**
   * Mark queued run `deliveryId` started (FAC-112), counting the attempt, and return its delivery,
   * the run's only starting context. Null, and the run unqueued, when its delivery is gone (dropped
   * past `MAX_WORKFLOW_DELIVERIES`). A run a restart interrupted runs again from its start: its
   * writes name it, so the ones it repeats are matched to those it made (`OverseerImpl.submitActionNow`).
   */
  startRun(deliveryId: number): StoredWorkflowDelivery | null {
    let delivery = this.storage.workflowDeliveries.get(deliveryId);
    if (!delivery?.execution) {
      this.storage.workflowRunQueue.delete(deliveryId);
      return null;
    }
    let started: StoredWorkflowDelivery = {
      ...delivery,
      execution: { ...delivery.execution, state: "running", attempts: delivery.execution.attempts + 1, startedAt: new Date() },
    };
    this.storage.workflowDeliveries.put(started);
    return started;
  }

  /** Record queued run `deliveryId` ended (FAC-112), failed for `failure` when given, and unqueue it. */
  endRun(deliveryId: number, failure?: WorkflowRunFailure): void {
    this.durableStorage.transactionSync(() => {
      this.storage.workflowRunQueue.delete(deliveryId);
      let delivery = this.storage.workflowDeliveries.get(deliveryId);
      if (!delivery?.execution) return;
      this.storage.workflowDeliveries.put({
        ...delivery,
        execution: {
          ...delivery.execution, state: failure === undefined ? "finished" : "failed", endedAt: new Date(),
          ...(failure === undefined ? {} : { failure }),
        },
      });
    });
  }

  /** The delivery a person's request `invocationId` made, or null (FAC-114): at most one, ever. */
  deliveryOfInvocation(invocationId: string): StoredWorkflowDelivery | null {
    for (let delivery of this.storage.workflowDeliveries.list()) {
      if (delivery.invocation?.id === invocationId) return delivery;
    }
    return null;
  }

  /**
   * The deliveries `profileId` asked trigger `hookId` for (FAC-116), newest first, at most `limit`:
   * only requests that admitted a run.
   */
  requestedDeliveries(profileId: string, hookId: number, limit: number): StoredWorkflowDelivery[] {
    let mine: StoredWorkflowDelivery[] = [];
    for (let delivery of this.storage.workflowDeliveries.list()) {
      if (delivery.hookId === hookId && delivery.run && delivery.invocation?.requestedBy === profileId) mine.push(delivery);
    }
    return mine.toSorted((a, b) => b.at.getTime() - a.at.getTime() || b.id - a.id).slice(0, limit);
  }

  /**
   * Record where delivery `deliveryId`'s result stands on the requester's page (FAC-116), or, with
   * `state` undefined, that it has nowhere there to go (run history only).
   */
  setCanvasDelivery(deliveryId: number, state: "pending" | "delivered" | "undelivered" | undefined): void {
    let delivery = this.storage.workflowDeliveries.get(deliveryId);
    if (!delivery) return;
    let { canvas: _, ...rest } = delivery.delivery ?? {};
    this.storage.workflowDeliveries.put({ ...delivery, delivery: { ...rest, ...(state === undefined ? {} : { canvas: state }) } });
  }

  /** Record delivery `deliveryId`'s result (FAC-114), with run history delivered; unchanged if it's the same. */
  recordResult(deliveryId: number, result: Omit<WorkflowRunResult, "settledAt">): void {
    let delivery = this.storage.workflowDeliveries.get(deliveryId);
    if (!delivery) return;
    let same = delivery.result && delivery.result.outcome === result.outcome && delivery.result.reason === result.reason &&
        JSON.stringify(delivery.result.report) === JSON.stringify(result.report);
    if (same && delivery.delivery?.history === "delivered") return;
    this.storage.workflowDeliveries.put({
      ...delivery,
      result: {
        outcome: result.outcome,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.report !== undefined ? { report: result.report } : {}),
        settledAt: same ? delivery.result!.settledAt : new Date(),
      },
      delivery: { ...delivery.delivery, history: "delivered" },
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

  // The owner's, or one shared with `profileId` to edit (FAC-122); as not found otherwise.
  #editable(profileId: string, id: string, role: CollaboratorRole | null): StoredWorkflowDefinition {
    let stored = this.storage.workflowDefinitions.get(id);
    if (!stored || !this.#rights(stored, profileId, role).edit) throw new Error(NOT_FOUND);
    return stored;
  }
}
