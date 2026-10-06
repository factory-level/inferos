// Agent definitions, deployments and runs: the proposed contract for issues #76, #77 and #78.
//
// PROPOSAL PENDING OWNER REVIEW. Nothing in this module is implemented, stored or reachable over
// RPC yet: no backend code imports it, AgentDeploymentApiProposal is deliberately not a member of
// AuthenticatedApi or AdminApi, and AGENT_DEPLOYMENTS stays unsupported (its capabilitySources
// entry is null). The only runtime code is two pure tables and their helpers, which pin the
// lifecycle and grant carry-forward rules down precisely enough to test. See
// docs/design/agent-deployments.md and docs/adr/0007-agent-deployment-lifecycle.md.
//
// Built on agent-artifact.ts: a definition is a published `agent` artifact revision.

import type { AiChatAuthorInfo, BlueprintBindingAssignment } from "./api";
import {
  canonicalArtifactJson, type ArtifactBindingRequirement, type ArtifactModelRequirement, type ArtifactPin,
  type ArtifactRef,
} from "./agent-artifact";

/**
 * Conventional file paths inside an `agent` artifact. Persona and instructions are files so that the
 * artifact digest covers them; `callTypes` holds the TypeScript declarations a call trigger's
 * callers use, in the shape SpawnCallableOptions.types takes.
 */
export const AGENT_DEFINITION_FILES = {
  persona: "persona.md",
  instructions: "instructions.md",
  callTypes: "call.d.ts",
} as const;

/**
 * Read view of one published `agent` revision. It is behaviour only: it holds no credential, grant,
 * account, resource, trigger or limit, so editing persona, instructions or skills cannot change what
 * a deployment may reach. Those live on AgentDeployment.
 */
export interface AgentDefinitionRevision {
  /** The exact `agent` revision this view was read from. */
  pin: ArtifactPin;
  /** Contents of AGENT_DEFINITION_FILES.persona. */
  persona: string;
  /** Contents of AGENT_DEFINITION_FILES.instructions. */
  instructions: string;
  /** Pinned `skill` revisions, from the manifest's pins. */
  skills: ArtifactPin[];
  /** Model the agent runs on. An agent definition always runs a model. */
  model: ArtifactModelRequirement;
  /** Binding name to the kind of resource required. Satisfied per deployment by grants. */
  bindings: Record<string, ArtifactBindingRequirement>;
  /**
   * Name of the interface in AGENT_DEFINITION_FILES.callTypes that call triggers deliver to (the
   * SpawnCallableOptions.mainType), or null when the definition accepts no calls.
   */
  callMainType: string | null;
}

/** Server-minted deployment identifier, unique within the deployment. */
export type AgentDeploymentId = string;

/**
 * Lifecycle state of a deployment. `planned`: validated and reviewable, nothing registered.
 * `active`: triggers enabled, runs accepted. `draining`: no new runs; in-flight runs finish or are
 * cancelled. `paused`: no in-flight runs, triggers disabled but kept. `retired`: terminal; triggers
 * deleted, grants released, history kept. The AGENT_DEPLOYMENTS flag is not a state: while it is
 * off every state is refused activation and invocation by a per-call guard, and no state changes.
 */
export type AgentDeploymentState = "planned" | "active" | "draining" | "paused" | "retired";

/**
 * Lifecycle events. Every event but `drained` is an operator action with an expected revision;
 * `drained` is raised by the system when a draining deployment's last in-flight run ends.
 */
export type AgentDeploymentEvent = "activate" | "pause" | "drained" | "resume" | "update" | "retire";

/**
 * Allowed transitions: state, then event, to the next state. Anything absent is refused. Update is
 * allowed only where no run is in flight (`planned`, `paused`), so no run straddles two definitions
 * and no approval requested under one definition is applied under another. Retire requires
 * draining first, by pausing.
 */
export const AGENT_DEPLOYMENT_TRANSITIONS: {
  readonly [S in AgentDeploymentState]: Readonly<Partial<Record<AgentDeploymentEvent, AgentDeploymentState>>>
} = {
  planned: { activate: "active", update: "planned", retire: "retired" },
  active: { pause: "draining" },
  draining: { drained: "paused" },
  paused: { resume: "active", update: "paused", retire: "retired" },
  retired: {},
};

/** The state `event` moves a deployment in `from` to, or null when the transition is refused. */
export function agentDeploymentTransition(
    from: AgentDeploymentState, event: AgentDeploymentEvent): AgentDeploymentState | null {
  return AGENT_DEPLOYMENT_TRANSITIONS[from][event] ?? null;
}

/**
 * The deployment's own identity, minted when it is created and never shared with another
 * deployment, including another deployment of the same definition.
 */
export interface AgentDeploymentIdentity {
  /** Opaque principal its runs act and are attributed as. */
  principal: string;
  /** The workspace created for this deployment alone: its storage, chats and bindings. */
  workspaceId: string;
}

/**
 * A schedule cadence, handed to the Scheduler's `every()`, `calendarAt()` or `runAt()` at
 * activation. `rule` is the Scheduler's CalendarRule; workshop-shared does not depend on
 * gatekeeper-scheduler, so it is carried as data here and validated by the Scheduler.
 */
export type AgentScheduleCadence =
  | { entry: "every"; everyMs: number }
  | { entry: "calendarAt"; rule: Record<string, unknown> }
  | { entry: "runAt"; when: number };

/**
 * What starts a run. Each trigger has an `id` unique within its deployment; (deployment, trigger)
 * is the key the trigger is registered under, so registration is idempotent. Every delivery carries
 * an occurrence key, so a repeated delivery maps to the run it already started.
 *
 * - `schedule`: a Scheduler hook. The occurrence key is the Scheduler's `runId`.
 * - `event`: a hook delivered by the gatekeeper granted under `binding`. The occurrence key is the
 *   hook's delivery identity, which hooks do not carry yet (see the design's open questions).
 * - `call`: a call on a capability the operator hands to a caller. The occurrence key is supplied by
 *   the caller.
 */
export type AgentTrigger =
  | { type: "schedule"; id: string; title: string; cadence: AgentScheduleCadence }
  | { type: "event"; id: string; binding: string; event: string }
  | { type: "call"; id: string };

/** Hard limits on a deployment. All are required: there is no unlimited default. */
export interface AgentDeploymentLimits {
  /** Runs allowed in flight at once. Further deliveries are denied with `limit_exceeded`. */
  maxConcurrentRuns: number;
  /** Runs allowed to start per rolling 24 hours. */
  maxRunsPerDay: number;
  /** Time after which a run with no observed completion fails with `completion_timeout`. */
  maxRunMs: number;
}

/** One lifecycle transition and who caused it. */
export interface AgentDeploymentTransitionRecord {
  /** The event applied. */
  event: AgentDeploymentEvent;
  /** The resulting state. */
  state: AgentDeploymentState;
  /** The operator, or `system` for `drained`. */
  by: (AiChatAuthorInfo & { type: "user" }) | "system";
  /** When it happened. */
  at: Date;
}

/**
 * A definition selected into this deployment, with its own identity, grants, triggers and limits.
 * Grants are references in BlueprintBindingAssignment form (an account ID and resource URL, or a
 * model ID), never credentials. Mutations name `revision`, as canvas and flow edits do.
 */
export interface AgentDeployment {
  /** Deployment identifier. */
  id: AgentDeploymentId;
  /** Operator-facing title. */
  title: string;
  /** The exact `agent` revision runs execute. */
  definition: ArtifactPin;
  /** This deployment's own identity. */
  identity: AgentDeploymentIdentity;
  /** Binding name to the destination resource granted for it. Covers every definition binding. */
  grants: Record<string, BlueprintBindingAssignment>;
  /** What starts runs. */
  triggers: AgentTrigger[];
  /** Hard limits. */
  limits: AgentDeploymentLimits;
  /** Current lifecycle state. */
  state: AgentDeploymentState;
  /** Every transition so far, oldest first. Kept after retirement. */
  history: AgentDeploymentTransitionRecord[];
  /** Optimistic-concurrency revision, a decimal string; every mutation names the expected one. */
  revision: string;
}

/**
 * Status of one run. `queued` means durably enqueued (spawnCallable resolved), which is not
 * completion. `succeeded` is set only when the run's persistent completion callback is called;
 * nothing else implies it. `denied` runs never started (see AgentRunDenial).
 */
export type AgentRunStatus =
  | "queued" | "running" | "waitingApproval" | "succeeded" | "failed" | "cancelled" | "denied";

/** Why a delivery was refused before any work started. A denied delivery is still recorded. */
export type AgentRunDenial =
  | "flag_disabled"
  | "not_active"
  | "limit_exceeded"
  | "grant_revoked"
  | "policy_denied";

/** Why a started run ended without success. */
export type AgentRunFailure =
  | "completion_timeout"
  | "agent_error"
  | "cancelled_by_operator"
  | "flag_disabled"
  | "grant_revoked";

/**
 * One invocation. Observations and approval waits are not copied here: they stay in the native
 * chat and action log of the deployment's workspace, and the run refers to them.
 */
export interface AgentRun {
  /** Run identifier. */
  id: string;
  /** The deployment that ran it. */
  deploymentId: AgentDeploymentId;
  /** The exact definition it executed, copied at start; later updates never change it. */
  definition: ArtifactPin;
  /** The trigger and occurrence that started it. (deploymentId, triggerId, occurrenceKey) is unique. */
  trigger: { triggerId: string; occurrenceKey: string };
  /** The deployment identity it ran as. */
  principal: string;
  /** The native chat holding its turns and observations, once spawned. */
  chatId: number | null;
  /** IDs of actions it is waiting on in the deployment workspace's approval queue. */
  waitingOn: number[];
  /** Current status. */
  status: AgentRunStatus;
  /** Set when `status` is `denied`. */
  denial?: AgentRunDenial;
  /** Set when `status` is `failed` or `cancelled`. */
  failure?: AgentRunFailure;
  /** Sanitised summary passed to the completion callback, at most 1,024 characters. */
  resultSummary?: string;
  /** When the delivery was recorded. */
  queuedAt: Date;
  /** When the run reached a terminal status. */
  endedAt?: Date;
}

/**
 * Grants that carry into an update, decided per binding name: a grant carries only when the new
 * definition requires exactly the same kind of resource under that name (canonical equality).
 * Every other binding the new definition requires is listed in `needsGrant` and must be granted
 * explicitly in the reviewed update; grants for names the new definition drops are released. A
 * persona, instruction or skill change leaves every requirement equal, so it carries the same
 * grants and adds none.
 */
export function carryForwardGrants(
    from: Record<string, ArtifactBindingRequirement>,
    to: Record<string, ArtifactBindingRequirement>,
    grants: Record<string, BlueprintBindingAssignment>,
): { carried: Record<string, BlueprintBindingAssignment>; needsGrant: string[] } {
  let carried: Record<string, BlueprintBindingAssignment> = {};
  let needsGrant: string[] = [];
  for (let [name, requirement] of Object.entries(to)) {
    let previous = Object.hasOwn(from, name) ? from[name] : undefined;
    let grant = Object.hasOwn(grants, name) ? grants[name] : undefined;
    if (previous && grant && canonicalArtifactJson(previous) === canonicalArtifactJson(requirement)) {
      carried[name] = grant;
    } else {
      needsGrant.push(name);
    }
  }
  return { carried, needsGrant: needsGrant.toSorted() };
}

/**
 * What an operator reviews before creating, activating or updating: the definition's requirements
 * beside the grants that would satisfy them, and every reason the deployment cannot proceed.
 */
export interface AgentDeploymentPlan {
  /** The exact definition. */
  definition: ArtifactPin;
  /** Requirements, each with the grant that would satisfy it, or null when one is still needed. */
  capabilities: { binding: string; requirement: ArtifactBindingRequirement;
      grant: BlueprintBindingAssignment | null; carried: boolean }[];
  /** Triggers that activation would register and enable. */
  triggers: AgentTrigger[];
  /** Limits that would apply. */
  limits: AgentDeploymentLimits;
  /** Human-readable reasons the plan cannot be applied; empty when it can. */
  problems: string[];
}

/**
 * PROPOSAL PENDING OWNER REVIEW: the deployment operator's capability. Not implemented and not a
 * member of any RPC interface. On acceptance it is minted by a new AuthenticatedApi method that
 * returns null for anyone who is not a deployment operator, and every method runs behind a per-call
 * AGENT_DEPLOYMENTS guard, so a capability obtained while the flag was on is refused from its next
 * call after the flag goes off. Only AGENT_DEPLOYMENT_METHODS_ALLOWED_WHILE_DISABLED pass the guard.
 */
export interface AgentDeploymentApiProposal {
  /** Validate a definition against proposed grants, triggers and limits. Stores nothing. */
  planDeployment(definition: ArtifactRef, grants: Record<string, BlueprintBindingAssignment>,
      triggers: AgentTrigger[], limits: AgentDeploymentLimits): Promise<AgentDeploymentPlan>;
  /** Create a `planned` deployment with a fresh identity and workspace. Registers no trigger. */
  createDeployment(title: string, definition: ArtifactRef,
      grants: Record<string, BlueprintBindingAssignment>, triggers: AgentTrigger[],
      limits: AgentDeploymentLimits): Promise<AgentDeployment>;
  /**
   * The reviewed activation: register each trigger once under (deployment, trigger) and enable it.
   * This act is the person's enablement of those hooks.
   */
  activateDeployment(id: AgentDeploymentId, expectedRevision: string): Promise<AgentDeployment>;
  /** Stop new runs and disable triggers; the deployment drains, then becomes `paused`. */
  pauseDeployment(id: AgentDeploymentId, expectedRevision: string): Promise<AgentDeployment>;
  /** Re-enable the existing triggers of a paused deployment. Replays nothing. */
  resumeDeployment(id: AgentDeploymentId, expectedRevision: string): Promise<AgentDeployment>;
  /** Move a `planned` or `paused` deployment to another exact revision with reviewed grants. */
  updateDeployment(id: AgentDeploymentId, expectedRevision: string, definition: ArtifactRef,
      grants: Record<string, BlueprintBindingAssignment>, triggers: AgentTrigger[],
      limits: AgentDeploymentLimits): Promise<AgentDeployment>;
  /** Delete triggers and release grants. History, runs and the workspace's records are kept. */
  retireDeployment(id: AgentDeploymentId, expectedRevision: string): Promise<AgentDeployment>;
  /** Every deployment the operator can see, retired ones included. */
  listDeployments(): Promise<AgentDeployment[]>;
  /** One deployment, or null. */
  getDeployment(id: AgentDeploymentId): Promise<AgentDeployment | null>;
  /** A deployment's runs, newest first, paged by `beforeId`. */
  listRuns(id: AgentDeploymentId, beforeId?: string): Promise<AgentRun[]>;
  /** Cancel one in-flight run. Its pending actions are rejected, not applied. */
  cancelRun(runId: string): Promise<AgentRun>;
}

/**
 * Methods that still work while AGENT_DEPLOYMENTS is off: restricted diagnostic reads, and the
 * actions that only reduce capability. Everything else, and every trigger delivery, is refused
 * with `flag_disabled`.
 */
export const AGENT_DEPLOYMENT_METHODS_ALLOWED_WHILE_DISABLED = [
  "listDeployments", "getDeployment", "listRuns", "pauseDeployment", "retireDeployment", "cancelRun",
] as const satisfies readonly (keyof AgentDeploymentApiProposal)[];
