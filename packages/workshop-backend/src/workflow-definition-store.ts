import type { AiChatAuthorInfo, WorkpieceId } from "@gadgets/workshop-shared/api";
import {
  MAX_WORKFLOW_DEFINITION_REVISIONS, MAX_WORKFLOW_DELIVERIES, MAX_WORKFLOW_INVOCATIONS,
  MAX_WORKSPACE_WORKFLOW_DEFINITIONS, TRIGGER_RUNS_PER_INVOKER, TRIGGER_RUNS_PER_TRIGGER,
  WORKFLOW_INVOCATION_TTL_MS, parseTriggerControlSettings, parseWorkflowDefinitionTitle,
  type TriggerAssignment, type TriggerControl, type WorkflowDefinition, type WorkflowDefinitionDelivery, type WorkflowDefinitionRef,
  type WorkflowDefinitionRevision, type WorkflowDefinitionSave, type WorkflowInvocation, type WorkflowRunRecord,
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

/** Refused, without saying which check failed, to anyone a trigger's control doesn't admit. */
const CANNOT_RUN = "You can't run this trigger.";

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
          "workflowDefinitions" | "workflowTriggerPins" | "workflowDeliveries" | "nextWorkflowDeliveryId" |
          "workflowTriggerControls" | "workflowInvocations" | "workflowInvocationLog" |
          "nextWorkflowInvocationLogId" | "workflowTriggerAssignments" | "workflowTriggerAutoRetired">) {}

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
       ownerCanBuild: (profileId: string) => boolean,
       invocationId?: string): (WorkflowDefinitionDelivery & { deliveryId: number }) | null {
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
    // A request runs only the revision it was admitted for, never what the pin says now.
    if (invocation && (invocation.definitionId !== pin.definitionId || invocation.revision !== pin.revision)) {
      this.storage.workflowInvocations.delete(invocation.id);
      throw new Error("That run request was for another revision of this workflow. Ask again.");
    }
    let { stored, revision } = this.#pinnedRevision(pin, hookGadgetId, headOf);
    if (stored.published?.revision !== pin.revision && !ownerCanBuild(stored.owner.id)) {
      throw new Error("This trigger runs an unpublished revision whose owner can no longer build here.");
    }
    return this.durableStorage.transactionSync(() => {
      let id = this.storage.nextWorkflowDeliveryId.get();
      this.storage.nextWorkflowDeliveryId.put(id + 1);
      // A request runs as the trigger's assigned service account, when it has one (FAC-102).
      let assignment = invocation ? this.storage.workflowTriggerAssignments.get(hookId) : undefined;
      // The durable run (FAC-111): minted here, in the delivery's own transaction, so a run exists
      // exactly when its delivery does, with the authority it was admitted under.
      let runId = crypto.randomUUID();
      let delivery: StoredWorkflowDelivery = {
        id, hookId, definitionId: pin.definitionId, revision: pin.revision,
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
      if (id >= MAX_WORKFLOW_DELIVERIES) this.storage.workflowDeliveries.delete(id - MAX_WORKFLOW_DELIVERIES);
      let { id: _, ...shown } = delivery;
      return { ...shown, deliveryId: id };
    });
  }

  /**
   * Refuses unless trigger `hookId` is pinned to a revision that still exists and is still the
   * code its gadget runs: the revision's gadget is the hook's, and the gadget's head is exactly the
   * revision's commit (FAC-111: checked at admission, before the trigger's gatekeeper is asked to
   * run anything, and again by `fire`). Same words as `fire`.
   */
  requireCurrentRevision(hookId: number, hookGadgetId: WorkpieceId | null,
      headOf: (gadgetId: WorkpieceId) => string | undefined): void {
    let pin = this.storage.workflowTriggerPins.get(hookId);
    if (!pin) throw new Error(CANNOT_RUN);
    this.#pinnedRevision(pin, hookGadgetId, headOf);
  }

  // The pin's stored definition and revision, refusing a missing revision or one whose code moved.
  #pinnedRevision(pin: StoredTriggerPin, hookGadgetId: WorkpieceId | null,
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
      return { ...stored, definition: { definitionId: pin.definitionId, revision: pin.revision } };
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
        ? { ...control, invokers: [...control.invokers], definition: { definitionId: pin.definitionId, revision: pin.revision } }
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
        id: crypto.randomUUID(), hookId, definitionId: pin.definitionId, revision: pin.revision,
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
