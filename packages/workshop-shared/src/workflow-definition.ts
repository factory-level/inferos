import type { ActionOutcome } from "./action-outcome.js";
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
  /**
   * Present when the run executed as the trigger's assigned service account (FAC-102,
   * `TriggerAssignment`): the assignment's credential reference. The service records the account
   * as the actor; `invocation.requestedBy` stays a claim beside it.
   */
  executedAs?: { credentialRef: string };
  /**
   * The durable run this firing admitted (FAC-111, ADR 0012's correlation record): written in the
   * same transaction as the delivery, before anything runs. Absent on deliveries recorded before
   * FAC-111.
   */
  run?: WorkflowRunAuthority;
  /**
   * How a run a person asked for is executing (FAC-112): present once its firing queued it in the
   * workspace, and updated there as the workspace runs it, apart from the call that asked. `run`
   * beside it never changes.
   */
  execution?: WorkflowRunExecution;
  /**
   * The run's result (FAC-114; inferos ADR 0012 §3, proposed): its outcome as its completion and
   * its own writes stand, the fixed reason when it failed or is uncertain, and what its code
   * returned. Re-evaluated as the run ends and as each of its writes settles.
   */
  result?: WorkflowRunResult;
  /** Where the result was delivered, by destination (FAC-114). Run history is always one. */
  delivery?: WorkflowRunDelivery;
};

/**
 * A requested run's outcome (FAC-114; inferos ADR 0012 §3, proposed):
 * - `queued`, `running`: admitted, or started; neither is success;
 * - `waiting`: its code finished, and a write it proposed waits for a person;
 * - `succeeded`: its code finished, and none of its writes is waiting or may have happened unseen;
 * - `failed`: it is known to have stopped, with nothing unknown; `reason` says why;
 * - `uncertain`: work may or may not have happened, and nothing available can tell (`reason`).
 *   It stays so, after any reconnect, until reconciled; a person resolving it is FAC-117's.
 */
export type WorkflowRunOutcome = "queued" | "running" | "waiting" | "succeeded" | "failed" | "uncertain";

/**
 * Why a run is uncertain (FAC-114): a write of it whose outcome is unknown (`action-unknown`); it
 * threw after it had proposed a write (`lost-after-write`); or it was admitted and never started
 * within `WORKFLOW_RUN_START_WINDOW_MS` (`not-started`).
 */
export type WorkflowRunUncertainty = "action-unknown" | "lost-after-write" | "not-started";

/** How long an admitted run may take to be queued before it reads `uncertain` (`not-started`). */
export const WORKFLOW_RUN_START_WINDOW_MS = 10 * 60 * 1000;

/** The most text a run's returned report keeps (FAC-114); a larger one is kept as `{ truncated: true }`. */
export const WORKFLOW_RUN_REPORT_MAX_CHARS = 4096;

/**
 * A run's recorded result (FAC-114). `report` is the plain JSON the run's code returned, bounded,
 * for builders only: the code may run as a service account, so a requester never reads it.
 */
export type WorkflowRunResult = {
  outcome: WorkflowRunOutcome;
  reason?: WorkflowRunFailure | WorkflowRunUncertainty;
  report?: unknown;
  settledAt: Date;
};

/**
 * The places a run's result is delivered: run history (FAC-114), and the requester's open page when
 * the published page they were shown wires its result to a navigation (FAC-116, `canvas`).
 */
export type WorkflowRunDestination = "history" | "canvas";

/** Per destination: not yet, done, or given up on. Separate from the outcome (ADR 0012 §2). */
export type WorkflowRunDelivery = Partial<Record<WorkflowRunDestination, "pending" | "delivered" | "undelivered">>;

/** The most runs `listRequestedRuns` returns for one person and one trigger: the newest (FAC-116). */
export const REQUESTED_RUNS_MAX = 20;

/**
 * What the person who asked for a run reads of it (FAC-114, `getRequestedRun`): the run, the
 * revision it ran, its outcome and fixed reason, and each write it proposed, by action id, with that
 * action's own outcome. No report, no write's text, no copy of anything it wrote.
 */
export type RequestedRun = {
  runId: string;
  invocationId: string;
  revision: number;
  requestedAt: Date;
  outcome: WorkflowRunOutcome;
  reason?: WorkflowRunFailure | WorkflowRunUncertainty;
  actions: { actionId: number; outcome: ActionOutcome }[];
};

/**
 * Where a run a person asked for stands in the workspace that executes it (FAC-112). `queued`: the
 * firing recorded it, and nothing of it ran yet. `running`: the workspace started it (`attempts`
 * times; above 1 when a restart interrupted it and it ran again from its start).
 * `finished` or `failed`: it ended, with why it failed as a fixed category, never the words it
 * threw. Only this; a run's results, events and delegates aren't recorded here.
 */
export type WorkflowRunExecution = {
  state: "queued" | "running" | "finished" | "failed";
  attempts: number;
  queuedAt: Date;
  startedAt?: Date;
  endedAt?: Date;
  failure?: WorkflowRunFailure;
};

/**
 * Why a run failed (FAC-112), a fixed category whatever the run threw, whose words can carry what
 * only its executor may see and stay in the server's log:
 * - `requester-revoked`: the person who asked may no longer run it;
 * - `assignment-changed`: the trigger's assignment changed, ended or is off;
 * - `trigger-gone`: the trigger was disabled or deleted;
 * - `runtime-error`: anything else the run threw.
 */
export type WorkflowRunFailure =
  "requester-revoked" | "assignment-changed" | "trigger-gone" | "runtime-error";

/**
 * Who asked for a run (FAC-111, inferops ADR 0011's requester): the person whose control press
 * admitted it, or the trigger itself for a firing no person asked for. A record, never authority.
 */
export type WorkflowRunRequester = { kind: "person"; profileId: string } | { kind: "trigger" };

/**
 * Who a run executes as (FAC-111, inferops ADR 0011's execution principal): the trigger's assigned
 * service account (FAC-102), named by its connection and credential reference, or the gadget's own
 * configured bindings when the trigger has no assignment.
 */
export type WorkflowRunExecutor =
  | { kind: "service_account"; gatekeeperId: number; credentialRef: string }
  | { kind: "gadget_bindings" };

/**
 * A run's identity and authority, fixed at admission and stored with its delivery (FAC-111). It is
 * what a run is reloaded from after a restart: never an editable page, a chat or the current pin.
 */
export type WorkflowRunAuthority = {
  /** Server-minted, opaque, never reused (ADR 0012 `runId`). */
  runId: string;
  /**
   * What ties the run to what asked for it: the person's invocation id for an on-request run (the
   * id their request and the trigger's gatekeeper already carry), else the run id. Sent to a service
   * it is a correlation claim and authorizes nothing (ADR 0012).
   */
  correlationId: string;
  /**
   * The InferOps company (tenant id) the person's `workflow:invoke` was answered in at admission,
   * or null when no person asked (a firing the trigger made itself) or the deployment names no
   * such authority.
   */
  company: string | null;
  requester: WorkflowRunRequester;
  executor: WorkflowRunExecutor;
};

/**
 * One admitted run as reloaded (FAC-111): its authority, the definition revision and commit it
 * started on, and when it was admitted. Read from the stored delivery only.
 */
export type WorkflowRunRecord = WorkflowRunAuthority & WorkflowDefinitionRef & {
  hookId: number;
  commitId: string;
  admittedAt: Date;
};

/**
 * Who a pinned trigger's on-request runs execute as (FAC-102, inferops ADR 0011 S1): the service
 * account provisioned in one of the gadget's connections for `credentialRef`, never the invoker,
 * the builder or any person. Stored apart from the definition, so a new revision can't change it
 * and it can't change a revision. Builders only.
 */
export type TriggerAssignment = {
  hookId: number;
  /** The connection (a gatekeeper the trigger's gadget binds) whose system credential runs it. */
  gatekeeperId: number;
  /**
   * The Workshop-minted reference the connection's vendor keys the service account's credential
   * by. Provisioning names it; it isn't a secret and grants nothing.
   */
  credentialRef: string;
  assignedBy: AiChatAuthorInfo;
  assignedAt: Date;
  /**
   * Who last gave the connection the service account's key for this assignment, and when
   * (`provisionTriggerCredential`); absent until then. A record only: the key itself is never kept
   * or shown by the Workshop.
   */
  provisionedBy?: AiChatAuthorInfo;
  provisionedAt?: Date;
};

/** What a builder sets to assign a trigger's runs: the connection whose system credential runs it. */
export type TriggerAssignmentSettings = { gatekeeperId: number };

/**
 * What `getTriggerAssignment` reads (FAC-102): whether assignments are enabled on this instance
 * (`WORKFLOW_ASSIGNMENTS_ENABLED`, off by default), and the trigger's assignment, which may be one
 * made before they were turned off and can still be removed.
 */
export type TriggerAssignmentState = {
  enabled: boolean;
  assignment: TriggerAssignment | null;
  /**
   * The trigger's assignment was retired automatically (its key was refused and couldn't be
   * forgotten): runs on request are refused until an Admin assigns it again or removes it.
   */
  retiredAutomatically?: boolean;
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
