import type { AiChatAuthorInfo, WorkpieceId } from "./api.js";

// A workflow definition: the reusable description of a workflow, stored in one workspace and
// owned by the person who saved it (inferops docs/human/architecture/workflows.md). Saving keeps a
// new revision for its owner and publishes nothing; publishing makes one saved revision available
// to everyone else who can use the workspace. Triggers and runs reference a revision
// (`WorkflowDefinitionRef`); they never copy a definition.

/** Most workflow definitions one workspace stores. */
export const MAX_WORKSPACE_WORKFLOW_DEFINITIONS = 32;

/** Most saved revisions one workflow definition keeps. */
export const MAX_WORKFLOW_DEFINITION_REVISIONS = 50;

/** Longest workflow definition title, in characters. */
export const MAX_WORKFLOW_DEFINITION_TITLE_LENGTH = 120;

/** Most delivery records one workspace keeps; the oldest is dropped past it. */
export const MAX_WORKFLOW_DELIVERIES = 1000;

/** What a revision runs: a workflow gadget of the workspace at one commit of its code. */
export type WorkflowDefinitionSource = {
  kind: "gadget";
  /** The workspace's gadget whose code the workflow is. */
  gadgetId: WorkpieceId;
  /** The gadget's head commit (40-hex oid) when the revision was saved. */
  commitId: string;
};

/** One saved revision of a workflow definition. */
export type WorkflowDefinitionRevision = {
  /** 1 for the first save, then raised by one on each save that changed the source. */
  revision: number;
  source: WorkflowDefinitionSource;
  savedAt: Date;
};

/** The revision a definition's owner made available to others, and when. */
export type WorkflowDefinitionPublication = {
  revision: number;
  at: Date;
  by: AiChatAuthorInfo;
};

/**
 * A workflow definition as one viewer may see it. Its owner sees every saved revision. Anyone else
 * sees it only once published, with `revisions` holding just the published one; an unpublished
 * definition of another person is not listed at all.
 */
export type WorkflowDefinition = {
  /** Server-minted id, stable for the definition's life. */
  id: string;
  title: string;
  /** The person who first saved it. Only they save new revisions or publish. */
  owner: AiChatAuthorInfo;
  /** Saved revisions visible to this viewer, oldest first. */
  revisions: WorkflowDefinitionRevision[];
  published: WorkflowDefinitionPublication | null;
};

/** What a person saves: a title and the workflow gadget whose current code becomes a revision. */
export type WorkflowDefinitionSave = {
  /** Absent to create a definition; an existing one of the caller's own to save a new revision. */
  id?: string;
  /** 1 to `MAX_WORKFLOW_DEFINITION_TITLE_LENGTH` characters. */
  title: string;
  gadgetId: WorkpieceId;
};

/**
 * A reference to one revision of one definition, as a trigger pins it. It stays on that revision
 * when the definition is republished: moving it is an explicit change to the trigger.
 */
export type WorkflowDefinitionRef = { definitionId: string; revision: number };

/** One firing of a pinned trigger, and the revision and commit it ran. */
export type WorkflowDefinitionDelivery = WorkflowDefinitionRef & {
  /** The bound hook that fired. */
  hookId: number;
  /** The commit the revision named, and the gadget's head at firing (they are equal). */
  commitId: string;
  at: Date;
  /**
   * Present when a person asked for this run through the trigger's control (`invokeTrigger`): the
   * invocation and who asked. Who asked is a record of the request, never authority: the run is
   * the trigger's, with the gadget's own configured bindings.
   */
  invocation?: { id: string; requestedBy: string };
};

/** Most people one trigger control lists as allowed to run it. */
export const MAX_TRIGGER_CONTROL_INVOKERS = 50;

/** Longest trigger control label, in characters. */
export const MAX_TRIGGER_CONTROL_LABEL_LENGTH = 80;

/** Most on-request runs one workspace remembers for its run rates; the oldest is dropped past it. */
export const MAX_WORKFLOW_INVOCATIONS = 1000;

/**
 * Run rates on request. Each run spends the builders' connections and model budget, and a person
 * asks for one by hand, so a few in ten minutes per person and twenty an hour per trigger leave
 * room for real use while a stuck button or a loop stops quickly.
 */
export const TRIGGER_RUNS_PER_INVOKER = { runs: 3, windowMs: 10 * 60_000 } as const;
export const TRIGGER_RUNS_PER_TRIGGER = { runs: 20, windowMs: 60 * 60_000 } as const;

/** How long an admitted request may wait for its trigger's gatekeeper to deliver it. */
export const WORKFLOW_INVOCATION_TTL_MS = 5 * 60_000;

/**
 * What a builder sets on a pinned trigger so named people can ask it to run now: a label, and the
 * profile ids of the people allowed to. Being listed lets a person start that trigger's run and
 * nothing else (inferops ADR 0011 S6): they gain no access to the workflow, its bindings or its
 * configuration, and supply nothing the run reads.
 */
export type TriggerControlSettings = {
  /** 1 to `MAX_TRIGGER_CONTROL_LABEL_LENGTH` characters. */
  label: string;
  /** Profile ids, 1 to `MAX_TRIGGER_CONTROL_INVOKERS` of them. */
  invokers: string[];
};

/**
 * A trigger's control. A builder sees all of it; one of its invokers sees only `hookId` and
 * `label`, enough to run it, and nothing of who configured it, who else may, or what it runs.
 */
export type TriggerControl = {
  hookId: number;
  label: string;
  /** The revision the trigger runs. Builders only. */
  definition?: WorkflowDefinitionRef;
  /** Who may run it. Builders only. */
  invokers?: string[];
  configuredBy?: AiChatAuthorInfo;
  configuredAt?: Date;
};

/**
 * A person's accepted request to run a trigger now. Server-minted: its id, the trigger and revision
 * come from the control, never from the request.
 */
export type WorkflowInvocation = WorkflowDefinitionRef & {
  id: string;
  hookId: number;
  requestedAt: Date;
};

/**
 * Checks control settings and returns them normalized: the label trimmed, invokers deduplicated.
 * Throws a `TypeError` naming the problem; nothing else is read from `settings`.
 */
export function parseTriggerControlSettings(settings: unknown): TriggerControlSettings {
  if (typeof settings !== "object" || settings === null) throw new TypeError("A control needs a label and invokers.");
  let { label, invokers } = settings as Record<string, unknown>;
  if (typeof label !== "string" || !label.trim() || label.trim().length > MAX_TRIGGER_CONTROL_LABEL_LENGTH) {
    throw new TypeError(`A control label is 1 to ${MAX_TRIGGER_CONTROL_LABEL_LENGTH} characters.`);
  }
  if (!Array.isArray(invokers) || invokers.some(id => typeof id !== "string" || !id || id.length > 128)) {
    throw new TypeError("A control's invokers are profile ids.");
  }
  let unique = [...new Set(invokers as string[])];
  if (unique.length === 0 || unique.length > MAX_TRIGGER_CONTROL_INVOKERS) {
    throw new TypeError(`A control lists 1 to ${MAX_TRIGGER_CONTROL_INVOKERS} people who may run it.`);
  }
  return { label: label.trim(), invokers: unique };
}

/**
 * Checks a save's title and returns it trimmed. Throws a `TypeError` naming the problem.
 */
export function parseWorkflowDefinitionTitle(title: unknown): string {
  if (typeof title !== "string") throw new TypeError("A workflow definition needs a title.");
  let trimmed = title.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_WORKFLOW_DEFINITION_TITLE_LENGTH) {
    throw new TypeError(
        `A workflow definition title is 1 to ${MAX_WORKFLOW_DEFINITION_TITLE_LENGTH} characters.`);
  }
  return trimmed;
}
