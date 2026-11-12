import type { ActionOutcome } from "./action-outcome.js";
import type { AiChatAuthorInfo, BlueprintBindingAssignment, WorkpieceId } from "./api.js";

// A workflow definition: the reusable description of a workflow, stored in one workspace and
// owned by the person who saved it (inferops docs/human/architecture/workflows.md). Saving keeps a
// new revision for its owner and publishes nothing; publishing makes one saved revision available
// to everyone else who can use the workspace. Triggers and runs reference a revision
// (`WorkflowDefinitionRef`); they never copy a definition.

/** Most workflow definitions one workspace stores. */
export const MAX_WORKSPACE_WORKFLOW_DEFINITIONS = 32;

/** ID-only discovery result for a workflow whose retained run history the viewer may read. */
export type WorkflowDefinitionHistoryRef = { definitionId: string };

/** Safe schedule metadata shown beside a workflow definition its viewer may read. */
export type WorkflowScheduleSummary = {
  hookId: number;
  scheduleId: string;
  title: string;
  description: string;
  cadence:
    | { kind: "interval"; everyMs: number; anchorMs: number }
    | { kind: "once"; fireAt: number; timeZone: string }
    | { kind: "calendar"; timeZone: string; rule:
        | { freq: "hourly"; interval: number; minute: number; anchorMs: number }
        | { freq: "daily"; interval: number; hour: number; minute: number; anchorMs: number }
        | { freq: "weekly"; interval: number; byDay: string[]; hour: number; minute: number; anchorMs: number } };
  status: "active" | "dead" | "completed" | "expired";
  nextFire?: number;
};

/** Most saved revisions one workflow definition keeps. */
export const MAX_WORKFLOW_DEFINITION_REVISIONS = 50;

/** Longest workflow definition title, in characters. */
export const MAX_WORKFLOW_DEFINITION_TITLE_LENGTH = 120;

/**
 * How long a dynamic, unsaved workflow definition lasts by default (FAC-124), in hours: 24, a
 * PROPOSED default (inferops docs/human/architecture/workflows.md, Retention rules, says no duration
 * is selected yet). A deployment sets `WORKFLOW_DYNAMIC_DEFINITION_TTL_HOURS` from
 * `MIN_DYNAMIC_DEFINITION_TTL_HOURS` to `MAX_DYNAMIC_DEFINITION_TTL_HOURS`.
 */
export const DEFAULT_DYNAMIC_DEFINITION_TTL_HOURS = 24;

/** Shortest TTL a deployment may set for a dynamic definition, in hours. */
export const MIN_DYNAMIC_DEFINITION_TTL_HOURS = 1;

/** Longest TTL a deployment may set for a dynamic definition, in hours (30 days). */
export const MAX_DYNAMIC_DEFINITION_TTL_HOURS = 720;

/** The refusal of any new use of a dynamic definition past its expiry (FAC-124). */
export const WORKFLOW_DEFINITION_EXPIRED = "This workflow expired. Create it again.";

/**
 * A dynamic definition's TTL in milliseconds from the deployment's
 * `WORKFLOW_DYNAMIC_DEFINITION_TTL_HOURS`: the default when unset, else a whole number of hours in
 * range. Anything else throws, naming the setting, so a misconfigured deployment refuses to create
 * dynamic definitions rather than pick a duration nobody chose.
 */
export function dynamicDefinitionTtlMs(setting: string | undefined): number {
  if (setting === undefined) return DEFAULT_DYNAMIC_DEFINITION_TTL_HOURS * 60 * 60 * 1000;
  let hours = /^\d+$/.test(setting) ? Number(setting) : Number.NaN;
  if (!(hours >= MIN_DYNAMIC_DEFINITION_TTL_HOURS && hours <= MAX_DYNAMIC_DEFINITION_TTL_HOURS)) {
    throw new Error(`WORKFLOW_DYNAMIC_DEFINITION_TTL_HOURS must be a whole number of hours from ${MIN_DYNAMIC_DEFINITION_TTL_HOURS} to ${MAX_DYNAMIC_DEFINITION_TTL_HOURS}.`);
  }
  return hours * 60 * 60 * 1000;
}

/** Proposed default maximum number of workflow run records one workspace keeps (FAC-125). */
export const DEFAULT_MAX_WORKFLOW_DELIVERIES = 10_000;
/** Default alias used by storage migrations and callers without deployment-specific settings. */
export const MAX_WORKFLOW_DELIVERIES = DEFAULT_MAX_WORKFLOW_DELIVERIES;
/** Lowest permitted per-workspace workflow run history limit. */
export const MIN_MAX_WORKFLOW_DELIVERIES = 1_000;
/** Highest permitted per-workspace workflow run history limit. */
export const MAX_MAX_WORKFLOW_DELIVERIES = 100_000;
/** Proposed default retention for reconciled terminal workflow runs (FAC-125). */
export const DEFAULT_WORKFLOW_RUN_HISTORY_RETENTION_DAYS = 90;
/** Lowest configured retention, in days. */
export const MIN_WORKFLOW_RUN_HISTORY_RETENTION_DAYS = 1;
/** Highest configured retention, in days. */
export const MAX_WORKFLOW_RUN_HISTORY_RETENTION_DAYS = 3_650;
/** Maximum number of due run-history expiry pointers swept per pass. */
export const WORKFLOW_RUN_HISTORY_SWEEP_BATCH = 100;
/** Maximum bounded history sweep batches allowed in one synchronous admission transaction. */
export const WORKFLOW_RUN_HISTORY_ADMISSION_SWEEP_BATCHES = 2;
/** Delay before retrying a partially drained history backlog from the Durable Object alarm. */
export const WORKFLOW_RUN_HISTORY_SWEEP_RETRY_MS = 60_000;
/** Proposed default terminal run-history retention, in milliseconds. */
export const WORKFLOW_RUN_HISTORY_RETENTION_MS = DEFAULT_WORKFLOW_RUN_HISTORY_RETENTION_DAYS * 24 * 60 * 60_000;
/** Owner-visible refusal when retained run history is at the configured workspace cap. */
export const WORKFLOW_RUN_HISTORY_CAP_REFUSAL = "Workflow run history is at its retention limit. Wait for older completed runs to expire, or ask your workspace administrator to raise the run-history limit.";

/**
 * Resolve a deployment's run-history retention setting to milliseconds, defaulting to the
 * proposed 90 days. Invalid or out-of-range values throw so the deployment never silently changes
 * its retention policy.
 */
export function workflowRunHistoryRetentionMs(setting: string | undefined): number {
  let days = setting === undefined ? DEFAULT_WORKFLOW_RUN_HISTORY_RETENTION_DAYS
    : /^\d+$/.test(setting) ? Number(setting) : Number.NaN;
  if (!(days >= MIN_WORKFLOW_RUN_HISTORY_RETENTION_DAYS && days <= MAX_WORKFLOW_RUN_HISTORY_RETENTION_DAYS)) {
    throw new Error(`WORKFLOW_RUN_HISTORY_RETENTION_DAYS must be a whole number of days from ${MIN_WORKFLOW_RUN_HISTORY_RETENTION_DAYS} to ${MAX_WORKFLOW_RUN_HISTORY_RETENTION_DAYS}.`);
  }
  return days * 24 * 60 * 60_000;
}

/**
 * Resolve a deployment's per-workspace run-history cap, defaulting to the proposed 10,000 records.
 * Invalid or out-of-range values throw rather than silently selecting another cap.
 */
export function maxWorkflowDeliveries(setting: string | undefined): number {
  let count = setting === undefined ? DEFAULT_MAX_WORKFLOW_DELIVERIES
    : /^\d+$/.test(setting) ? Number(setting) : Number.NaN;
  if (!(count >= MIN_MAX_WORKFLOW_DELIVERIES && count <= MAX_MAX_WORKFLOW_DELIVERIES)) {
    throw new Error(`WORKFLOW_MAX_RUN_HISTORY must be a whole number from ${MIN_MAX_WORKFLOW_DELIVERIES} to ${MAX_MAX_WORKFLOW_DELIVERIES}.`);
  }
  return count;
}

/** Stable error name for a trigger refused because its occurrence tombstones are at capacity. */
export const WORKFLOW_OCCURRENCE_LIMIT_ERROR_NAME = "WorkflowOccurrenceLimitError";

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
  /** Who saved it, when it wasn't the owner: an editor the definition is shared with (FAC-122). */
  savedBy?: AiChatAuthorInfo;
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
  /**
   * The person who first saved it. They save new revisions and publish, and so may anyone they
   * share it with for editing (FAC-122; see `WorkflowDefinitionRights`).
   */
  owner: AiChatAuthorInfo;
  /** Saved revisions visible to this viewer, oldest first. */
  revisions: WorkflowDefinitionRevision[];
  published: WorkflowDefinitionPublication | null;
  /** What this viewer may do with it (FAC-122): all three for its owner. */
  access?: WorkflowDefinitionRights;
  /** True when its owner shared it with this viewer by name ("Shared with me", FAC-122). */
  sharedWithMe?: boolean;
  /**
   * Present only on a dynamic, unsaved definition (FAC-124): when it stops being available for new
   * use, unless saved first or kept by a trigger pinned to it. Saving removes it.
   */
  expiresAt?: Date;
  /**
   * Present on a duplicate (FAC-123): the definition and revision it was copied from, and when. A
   * record only: it grants nothing, and nothing of the source follows it. The source's id, title and
   * revision are shown only to a viewer who can see that source (and that revision); anyone else
   * sees just `at`, "duplicated from a workflow".
   */
  duplicatedFrom?: WorkflowDefinitionProvenance;
  /**
   * For the owner only (FAC-123): the connections this definition's workflow gadget still needs set
   * up before it can run, by binding name. A duplicate starts with all of them; empty or absent once
   * each is bound. `rebindWorkflowDefinition` sets them up.
   */
  bindingsNeeded?: WorkflowRequiredBinding[];
};

/**
 * Where a duplicate came from (FAC-123), as one viewer may see it: `definitionId` and `title` only
 * when they can see the source, `revision` only when they can see that revision too.
 */
export type WorkflowDefinitionProvenance = { at: Date; definitionId?: string; title?: string; revision?: number };

/**
 * A connection a duplicated workflow needs before it can run (FAC-123): the binding name its code
 * uses, and what may fill it. A gatekeeper binding needs a connection of the same vendor and resource
 * type, made from the person's own connected account; a model binding needs one of their own models.
 * Never the source's connection, account or resource.
 */
export type WorkflowRequiredBinding = {
  name: string;
  title?: string;
  /**
   * Why it isn't set up, where `bindingsNeeded` lists it (FAC-123): no connection yet, one made from
   * another person's account or model, or one made before InferOS recorded whose account it uses.
   */
  unmet?: "missing" | "not-owners" | "unattributed";
} & (
  | { type: "gatekeeper"; vendorId: string; typeUrlPattern: string }
  | { type: "aiModel" });

/** Refused at a run's start and at each of its writes while a required connection isn't set up (FAC-123). */
export const WORKFLOW_BINDINGS_NEEDED = "This workflow needs its connections set up before it can run.";

/** Refused when a duplicate's connection was made from another person's account or model (FAC-123). */
export const WORKFLOW_BINDINGS_NOT_OWNERS =
  "This workflow's connections must be set up from its owner's own accounts and models before it can run.";

/** Refused when a duplicate's connection predates recording whose account it uses (FAC-123). */
export const WORKFLOW_BINDINGS_UNATTRIBUTED =
  "One of this workflow's connections was made before InferOS recorded whose account it uses. Set it up again from your own account before it can run.";

/**
 * Duplicating a definition (FAC-123): which one, which of its revisions (the published one unless
 * the caller may edit it), the copy's title, connections for its required bindings (each from the
 * caller's own accounts or models; any left out stay to set up), and `retain` as for
 * `WorkflowDefinitionSave` (a dynamic source makes a dynamic duplicate unless `retain: true`).
 */
export type WorkflowDefinitionDuplicate = {
  sourceId: string;
  revision?: number;
  title: string;
  bindings?: Record<string, BlueprintBindingAssignment>;
  retain?: boolean;
};

/**
 * What a person may do with one owner-maintained definition (FAC-122). `read`: see its published
 * revision. `run`: run triggers pinned to it, as the trigger's run control also allows. `edit`: save
 * new revisions of it, which stay unpublished until published (the owner, or whoever holds the
 * deployment's publish authority in a shared workspace). `run` and `edit` each include `read`.
 * A right concerns the definition only: it never reaches a record, which a run still reads and
 * writes only through its own authority and approvals.
 */
export type WorkflowDefinitionRights = { read: boolean; run: boolean; edit: boolean };

/** A definition shared with one InferOS account (FAC-122): never an email address. */
export type WorkflowDefinitionShare = {
  definitionId: string;
  /** The account's profile id, which an email change keeps (FAC-165). */
  profileId: string;
  rights: WorkflowDefinitionRights;
  sharedBy: AiChatAuthorInfo;
  sharedAt: Date;
};

/** Most people one definition is shared with by name. */
export const MAX_WORKFLOW_DEFINITION_SHARES = 100;

/**
 * Checks rights from a client: three booleans, at least one true, with `read` added when `run` or
 * `edit` is given. To stop sharing, pass null instead.
 */
export function parseWorkflowDefinitionRights(input: unknown): WorkflowDefinitionRights {
  if (typeof input !== "object" || input === null) throw new TypeError("Share a workflow to read, run or edit it.");
  let { read, run, edit } = input as Record<string, unknown>;
  for (let value of [read, run, edit]) {
    if (value !== undefined && typeof value !== "boolean") throw new TypeError("Share a workflow to read, run or edit it.");
  }
  let rights = { read: read === true || run === true || edit === true, run: run === true, edit: edit === true };
  if (!rights.read) throw new TypeError("Share a workflow to read, run or edit it, or stop sharing it.");
  return rights;
}

/** What a person saves: a title and the workflow gadget whose current code becomes a revision. */
export type WorkflowDefinitionSave = {
  /** Absent to create a definition; an existing one of the caller's own to save a new revision. */
  id?: string;
  /** 1 to `MAX_WORKFLOW_DEFINITION_TITLE_LENGTH` characters. */
  title: string;
  gadgetId: WorkpieceId;
  /**
   * `false` creates a dynamic, unsaved definition, which expires at the deployment's TTL
   * (`dynamicDefinitionTtlMs`) unless saved (FAC-124); only for a new definition. Absent or `true`
   * keeps the definition: a new one is saved, and saving an existing dynamic one retains it.
   */
  retain?: boolean;
};

/**
 * A trigger reference. `mode: "pinned"` preserves the requested revision; omitted mode on a newly
 * stored trigger means follow-latest. Legacy stored references without a mode remain pinned.
 */
export type WorkflowDefinitionRef = { definitionId: string; revision: number };

/** How a trigger resolves the selected definition. Omitted mode defaults to follow-latest on new pins. */
export type WorkflowTriggerDefinitionRef = WorkflowDefinitionRef & { mode?: "pinned" | "follow-latest" };

/** One firing of a trigger, and the published revision and commit it ran. */
export type WorkflowDefinitionDelivery = WorkflowDefinitionRef & {
  /** The bound hook that fired. */
  hookId: number;
  /** The commit named by the published revision at admission. */
  commitId: string;
  at: Date;
  /**
   * When this record is eligible for history expiry, computed by the server's configured retention
   * policy. Null means it is still retained while live or its legacy expiry cannot be determined.
   * Present on `listWorkflowDeliveries` responses; omitted on stored legacy records.
   */
  historyExpiresAt?: Date | null;
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

/** Whether a delivery still represents work whose durable record must be retained. */
export function isLiveWorkflowDelivery(delivery: {
  run?: unknown;
  at?: Date;
  execution?: Pick<WorkflowRunExecution, "state">;
  result?: Pick<WorkflowRunResult, "outcome" | "reason">;
}, now = Date.now()): boolean {
  let outcome = delivery.result?.outcome;
  if (outcome !== undefined) {
    if (outcome === "uncertain" && delivery.result?.reason === "not-started") return false;
    return outcome === "queued" || outcome === "running" || outcome === "waiting" || outcome === "uncertain";
  }
  // An admitted run that never started wrote nothing; once FAC-114's start window expires, its
  // uncertain/not-started history is terminal for retention. Any execution state remains live
  // unless it is known terminal; uncertain writes have a result reason and stay live above.
  if (!delivery.execution && delivery.run !== undefined && delivery.at &&
      now - delivery.at.getTime() > WORKFLOW_RUN_START_WINDOW_MS) return false;
  // Older runs may predate result records. Keep any run without a known terminal execution state.
  return delivery.run !== undefined && delivery.execution?.state !== "finished" && delivery.execution?.state !== "failed";
}

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
 * within `WORKFLOW_RUN_START_WINDOW_MS` (`not-started`). A personal workflow (FAC-134, capability 2)
 * is uncertain when a step's request may or may not have been placed (`step-unknown`).
 */
export type WorkflowRunUncertainty = "action-unknown" | "lost-after-write" | "not-started" | "step-unknown";

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
 * The places a run's result is delivered: run history (FAC-114); the requester's open page when
 * the published page they were shown wires its result to a navigation (FAC-116, `canvas`); and,
 * for a run a person started by approving an action that asked for its outcome, that action's
 * gatekeeper, which shows it where the action came from (FAC-134, `chat`: the Dot's conversation).
 */
export type WorkflowRunDestination = "history" | "canvas" | "chat";

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
  /**
   * Set when a person cancelled the run (FAC-117): who and when. A queued run ends at once; a running
   * one ends at its next guarded call. Its pending writes are rejected, never applied.
   */
  cancelled?: { by: AiChatAuthorInfo; at: Date };
  /**
   * Each manual retry of it (FAC-117 K2): the person who asked for the run, by their profile, and
   * when. A retry is another attempt of this run, so `attempts` carries on counting.
   */
  retries?: { by: AiChatAuthorInfo; at: Date }[];
};

/**
 * Why a run failed (FAC-112), a fixed category whatever the run threw, whose words can carry what
 * only its executor may see and stay in the server's log:
 * - `requester-revoked`: the person who asked may no longer run it;
 * - `assignment-changed`: the trigger's assignment changed, ended or is off;
 * - `trigger-gone`: the trigger was disabled or deleted;
 * - `bindings-needed`: a connection its workflow needs isn't set up (FAC-123);
 * - `cancelled`: a person cancelled it (FAC-117; who and when are on its execution);
 * - `timed-out`: an attempt of it ran past the deployment's time per attempt (FAC-117);
 * - `attempts-exhausted`: it was interrupted more times than the deployment's attempts allow (FAC-117);
 * - `runtime-error`: anything else the run threw;
 * - `step-refused`: a personal workflow's step was refused (FAC-134, capability 2), with nothing
 *   after it sent; which check refused it is kept only in its owner's own record.
 * A run whose write may have landed reads `uncertain`, never failed, whatever stopped it.
 */
export type WorkflowRunFailure =
  "requester-revoked" | "assignment-changed" | "trigger-gone" | "bindings-needed" | "cancelled" | "timed-out" |
  "attempts-exhausted" | "runtime-error" | "step-refused";

/**
 * A trigger's lifecycle (FAC-117): `active` (no record), `draining` (paused: no new start, while the
 * runs admitted before `pausedAt` finish or are cancelled), `paused` (none left), `retired` (deleted,
 * from paused only). Pausing and activating are the hook's disable and enable.
 */
export type TriggerLifecycleState = "active" | "draining" | "paused" | "retired";

/** A trigger's lifecycle as recorded: its state, and who last changed it and when. */
export type TriggerLifecycle = {
  hookId: number;
  state: TriggerLifecycleState;
  /** When it was paused: only runs admitted before this may still finish while it drains. */
  pausedAt?: Date;
  changedBy: AiChatAuthorInfo;
  changedAt: Date;
};

/**
 * The run limits (FAC-117), PROPOSED defaults: no number is agreed yet (inferops docs/human
 * proposal). A deployment overrides each with a whole-number setting.
 */
export const DEFAULT_WORKFLOW_RUN_LIMITS = {
  /** Runs of one trigger executing at once; more wait queued. */
  perTrigger: 1,
  /** Runs executing at once in one workspace; more wait queued. */
  perWorkspace: 5,
  /** Wall-clock time one attempt of a run may take, in minutes; each re-execution starts its own. */
  runMinutes: 15,
  /** Times a run may start in all, the first included: 3 is the first start and two re-executions after resets. */
  attempts: 3,
  /** The first re-execution's wait, in seconds, doubling each time. */
  backoffSeconds: 30,
} as const;
export type WorkflowRunLimits = { -readonly [K in keyof typeof DEFAULT_WORKFLOW_RUN_LIMITS]: number };

/** The deployment settings that override `DEFAULT_WORKFLOW_RUN_LIMITS`, by limit. */
export const WORKFLOW_RUN_LIMIT_SETTINGS: Record<keyof WorkflowRunLimits, string> = {
  perTrigger: "WORKFLOW_RUNS_PER_TRIGGER",
  perWorkspace: "WORKFLOW_RUNS_PER_WORKSPACE",
  runMinutes: "WORKFLOW_RUN_MAX_MINUTES",
  attempts: "WORKFLOW_RUN_MAX_ATTEMPTS",
  backoffSeconds: "WORKFLOW_RUN_BACKOFF_SECONDS",
};

/**
 * The run limits from a deployment's settings: each unset one is its default, each set one a whole
 * number from 1 to 1000. Anything else throws, naming the setting, so a misconfigured deployment
 * refuses to start runs rather than run them under a limit nobody chose.
 */
export function workflowRunLimits(settings: Partial<Record<string, string | undefined>>): WorkflowRunLimits {
  let limits = { ...DEFAULT_WORKFLOW_RUN_LIMITS } as WorkflowRunLimits;
  for (let key of Object.keys(limits) as (keyof WorkflowRunLimits)[]) {
    let name = WORKFLOW_RUN_LIMIT_SETTINGS[key];
    let value = settings[name];
    if (value === undefined) continue;
    let n = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    if (!(n >= 1 && n <= 1000)) throw new Error(`${name} must be a whole number from 1 to 1000.`);
    limits[key] = n;
  }
  return limits;
}

/**
 * Why a run can't be retried (FAC-117 K2), in the words the person who asked is told. A run anyone
 * else names, or one that doesn't exist, is "No such run." instead.
 */
export const WORKFLOW_RUN_RETRY_REFUSED = {
  notFailed: "Only a run that failed can be retried.",
  cancelled: "This run was cancelled. Start a new run instead.",
  exhausted: "This run has used all its attempts. Start a new run instead.",
  unmatchable: "This run proposed a write that can't be matched if it runs again. Start a new run instead.",
  noCall: "This run can't be retried. Start a new run instead.",
  repinned: "This trigger now runs another revision of its workflow. Start a new run instead.",
  tooOld: "This run is too old to retry. Start a new run instead.",
} as const;

/**
 * How long after it was admitted a failed run may still be retried (FAC-117 K2): a retry repeats
 * the person's request, so it is bounded as a fresh one would be stale, not by history retention.
 */
export const WORKFLOW_RUN_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Why a run's write can't be settled (FAC-117 K2): only a workflow run's write whose outcome is
 * still unknown can be.
 */
export const WORKFLOW_WRITE_SETTLE_REFUSED = "Only a workflow run's write whose outcome is unknown can be settled.";

/** Refused when a trigger isn't in the state a lifecycle change needs (FAC-117). */
export const TRIGGER_LIFECYCLE_REFUSED = {
  retire: "Pause this trigger, and let its runs finish, before retiring it.",
  activate: "This trigger was retired; it can't be activated again.",
  paused: "This trigger is paused, so it starts no new runs.",
} as const;

/** Returned when a workflow trigger is paused but still draining an admitted run. */
export const TRIGGER_DRAINING = "TRIGGER_DRAINING";

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
