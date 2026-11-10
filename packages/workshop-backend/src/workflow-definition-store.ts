import type { AiChatAuthorInfo, WorkpieceId } from "@gadgets/workshop-shared/api";
import {
  MAX_WORKFLOW_DEFINITION_REVISIONS, MAX_WORKFLOW_DELIVERIES, MAX_WORKFLOW_INVOCATIONS,
  MAX_WORKSPACE_WORKFLOW_DEFINITIONS, TRIGGER_RUNS_PER_INVOKER, TRIGGER_RUNS_PER_TRIGGER,
  WORKFLOW_DEFINITION_EXPIRED, WORKFLOW_INVOCATION_TTL_MS, dynamicDefinitionTtlMs, parseTriggerControlSettings, parseWorkflowDefinitionTitle,
  type TriggerAssignment, type TriggerControl, type WorkflowDefinition, type WorkflowDefinitionDelivery,
  type WorkflowDefinitionRevision, type WorkflowDefinitionSave, type WorkflowInvocation, type WorkflowRunFailure, type WorkflowRunResult,
  type WorkflowTriggerDefinitionRef, isLiveWorkflowDelivery,
  type WorkflowRunRecord,
} from "@gadgets/workshop-shared/workflow-definition";
import type { OverseerStorage } from "./overseer";

/** A workflow definition as stored: every saved revision, whoever is looking. */
export type StoredWorkflowDefinition = Omit<WorkflowDefinition, "revisions"> & {
  revisions: WorkflowDefinitionRevision[];
};

/** New trigger rows record their resolution mode; legacy rows without mode retain explicit pins. */
export type StoredTriggerPin = { hookId: number; definitionId: string; revision: number; mode?: "pinned" | "follow-latest" };

/** A stored delivery, numbered so the oldest can be dropped. */
export type StoredWorkflowDelivery = WorkflowDefinitionDelivery & { id: number };

/**
 * A run a person asked for, queued in the workspace that executes it (FAC-112): the firing's one
 * call (`method`, or the callback itself when null) and its arguments, kept until the run ends. Its
 * scope and authority are its delivery's `run`, never anything here.
 */
export type QueuedWorkflowRun = { deliveryId: number; hookId: number; method: string | null; args: unknown[] };

/**
 * How the store tells time and how long a dynamic definition lasts (FAC-124). `dynamicTtlMs` is read
 * only when a dynamic definition is created, so a misconfigured deployment refuses just that.
 * `onChange` is called after anything that can change what is due to expire (a save, a pin added
 * or removed, a trigger forgotten, a run ended or settled), so the Overseer reschedules its alarm
 * for `nextExpiry`.
 */
export type DefinitionRetention = { now: () => number; dynamicTtlMs: () => number; onChange?: () => void };

const DEFAULT_RETENTION: DefinitionRetention = { now: () => Date.now(), dynamicTtlMs: () => dynamicDefinitionTtlMs(undefined) };

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
          "workflowRunQueue">,
      private retention: DefinitionRetention = DEFAULT_RETENTION) {}

  // FAC-124: whether `stored` is available for new use at `now`: retained, not yet expired, or
  // scheduled (a trigger is pinned to it, which keeps it while the pin exists).
  // `pinned` is `#pinnedIds()`, read once per operation rather than per definition.
  #available(stored: StoredWorkflowDefinition, now: number, pinned = this.#pinnedIds()): boolean {
    return stored.expiresAt === undefined || now < stored.expiresAt.getTime() || pinned.has(stored.id);
  }

  // The definitions a trigger is pinned to: each is scheduled, and kept while its pin exists.
  #pinnedIds(): Set<string> {
    return new Set(Array.from(this.storage.workflowTriggerPins.list(), pin => pin.definitionId));
  }

  // The definitions a live run names (FAC-108's `isLiveWorkflowDelivery`): kept until it ends.
  #liveIds(): Set<string> {
    let live = new Set<string>();
    for (let delivery of Array.from(this.storage.workflowDeliveries.list())) {
      if (isLiveWorkflowDelivery(delivery)) live.add(delivery.definitionId);
    }
    return live;
  }

  /**
   * Deletes every dynamic definition past its expiry that nothing keeps (FAC-124): no trigger pinned
   * to it, and no live run naming it (FAC-108's `isLiveWorkflowDelivery`). Retained definitions are never touched, nor
   * any delivery, run or result record. One transaction, reading the clock inside it, so a save
   * either ran before it (and retained the definition) or is refused after it. Returns how many.
   */
  sweepExpired(): number {
    return this.durableStorage.transactionSync(() => this.#sweepAt(this.retention.now()));
  }

  // The sweep's body, for a caller already in a transaction: deletes what expired by `now` and
  // nothing keeps, and returns how many.
  #sweepAt(now: number): number {
    let pinned = this.#pinnedIds();
    let live = this.#liveIds();
    let swept = 0;
    for (let stored of Array.from(this.storage.workflowDefinitions.list())) {
      if (this.#available(stored, now, pinned) || live.has(stored.id)) continue;
      this.storage.workflowDefinitions.delete(stored.id);
      swept++;
    }
    return swept;
  }

  /**
   * When to wake to sweep (FAC-124), or undefined: the earliest expiry among dynamic definitions no
   * trigger is pinned to. One already past counts (it is due now) unless a live run keeps it, whose
   * end is followed by a sweep anyway; so unpinning an expired definition wakes for it at once.
   */
  nextExpiry(): number | undefined {
    let now = this.retention.now();
    let pinned = this.#pinnedIds();
    let live = this.#liveIds();
    let next: number | undefined;
    for (let stored of Array.from(this.storage.workflowDefinitions.list())) {
      let at = stored.expiresAt?.getTime();
      if (at === undefined || pinned.has(stored.id) || (at <= now && live.has(stored.id))) continue;
      if (next === undefined || at < next) next = at;
    }
    return next;
  }

  #changed(): void {
    this.retention.onChange?.();
  }

  /** The definitions `viewer` may see: their own in full, and others' published revision only. */
  list(viewer: string): WorkflowDefinition[] {
    let now = this.retention.now();
    let pinned = this.#pinnedIds();
    let shown: WorkflowDefinition[] = [];
    for (let stored of Array.from(this.storage.workflowDefinitions.list())) {
      if (!this.#available(stored, now, pinned)) continue;
      let view = viewOf(stored, viewer);
      if (view) shown.push(view);
    }
    return shown;
  }

  /** One definition as `viewer` may see it, or null when it doesn't exist for them. */
  get(viewer: string, id: string): WorkflowDefinition | null {
    let stored = this.storage.workflowDefinitions.get(id);
    return stored && this.#available(stored, this.retention.now()) ? viewOf(stored, viewer) : null;
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
    if (input.retain !== undefined && typeof input.retain !== "boolean") throw new TypeError("retain is true, false or absent.");
    let commitId = headOf(input.gadgetId);
    if (!commitId) throw new Error("A workflow definition is saved from a workflow gadget with committed code.");
    // Read before the transaction: a misconfigured TTL refuses only creating a dynamic definition.
    let ttl = input.id === undefined && input.retain === false ? this.retention.dynamicTtlMs() : undefined;
    let result = this.durableStorage.transactionSync(() => {
      let now = new Date(this.retention.now());
      let source = { kind: "gadget" as const, gadgetId: input.gadgetId, commitId };
      if (input.id === undefined) {
        // Expired definitions nothing keeps no longer count toward the limit: sweep them first, in
        // this transaction, at this clock (FAC-124, #416 round 1).
        this.#sweepAt(now.getTime());
        if (Array.from(this.storage.workflowDefinitions.list({ limit: MAX_WORKSPACE_WORKFLOW_DEFINITIONS })).length
            >= MAX_WORKSPACE_WORKFLOW_DEFINITIONS) {
          throw new Error("Workspace workflow definition limit reached.");
        }
        let created: StoredWorkflowDefinition = {
          id: crypto.randomUUID(), title, owner: caller,
          revisions: [{ revision: 1, source, savedAt: now }], published: null,
          ...(ttl === undefined ? {} : { expiresAt: new Date(now.getTime() + ttl) }),
        };
        this.storage.workflowDefinitions.put(created);
        return created;
      }
      let stored = this.#owned(caller.id, input.id);
      // FAC-124: saving retains a dynamic definition, but only while it is still available, by the
      // clock read in this transaction; at or after its expiry it is refused, swept or not.
      if (!this.#available(stored, now.getTime())) throw new Error(WORKFLOW_DEFINITION_EXPIRED);
      if (input.retain === false) {
        if (stored.expiresAt === undefined) throw new Error("A saved workflow can't be made temporary.");
        throw new Error("This workflow is already temporary; save it without retain to keep it.");
      }
      let latest = stored.revisions[stored.revisions.length - 1]!;
      let unchanged = latest.source.gadgetId === source.gadgetId && latest.source.commitId === commitId;
      if (!unchanged && stored.revisions.length >= MAX_WORKFLOW_DEFINITION_REVISIONS) {
        throw new Error("This workflow definition has reached its revision limit. Save it as a new definition.");
      }
      let { expiresAt: _retained, ...kept } = stored;
      let next: StoredWorkflowDefinition = {
        ...kept, title,
        revisions: unchanged
            ? stored.revisions
            : [...stored.revisions, { revision: latest.revision + 1, source, savedAt: now }],
      };
      this.storage.workflowDefinitions.put(next);
      return next;
    });
    this.#changed();
    return result;
  }

  /**
   * Makes saved `revision` of `caller`'s own definition the published one. Triggers already pinned
   * to another revision stay on it.
   */
  publish(caller: AiChatAuthorInfo, id: string, revision: number): WorkflowDefinition {
    return this.durableStorage.transactionSync(() => {
      let stored = this.#owned(caller.id, id);
      if (!this.#available(stored, this.retention.now())) throw new Error(WORKFLOW_DEFINITION_EXPIRED);
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
      if (hookGadgetId === null || revision.source.gadgetId !== hookGadgetId) {
        throw new Error("That revision is for another gadget than the one this trigger wakes.");
      }
      this.storage.workflowTriggerPins.put({ hookId, definitionId: ref.definitionId,
        revision: ref.revision, mode: ref.mode ?? "follow-latest" });
    });
    this.#changed();
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
    // Follow-latest accepts a newer publication; an explicit revision pin keeps its old behavior.
    if (invocation && (invocation.definitionId !== pin.definitionId ||
        (pin.mode !== "follow-latest" && invocation.revision !== pin.revision))) {
      this.storage.workflowInvocations.delete(invocation.id);
      throw new Error("That run request was for another revision of this workflow. Ask again.");
    }
    let { stored, revision: currentPublished } = pin.mode === "follow-latest"
      ? this.#currentPublishedRevision(pin, hookGadgetId, headOf)
      : this.#explicitRevision(pin, hookGadgetId, headOf);
    // An invocation records the publication current when the person was admitted. A newer
    // publication may land while it waits for the delivery callback; run its admitted revision.
    let revision = invocation && pin.mode === "follow-latest"
      ? stored.revisions.find(candidate => candidate.revision === invocation.revision)
      : currentPublished;
    if (!revision || (invocation && pin.mode === "follow-latest" && revision.source.gadgetId !== hookGadgetId)) {
      throw new Error("That run request was for another revision of this workflow. Ask again.");
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
    this.#changed();
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
    this.#changed();
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
    this.#changed();
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
