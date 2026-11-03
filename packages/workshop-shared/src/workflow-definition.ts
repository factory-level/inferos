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
};

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
