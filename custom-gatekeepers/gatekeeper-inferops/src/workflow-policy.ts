// Workflow policy (MVP-18): what a workflow-policy binding may show of one project's published
// content-workflow policy, how strictly InferOps' answer is read, and the deployment switch for it.
//
// - Source. InferOps' `workflow.get` (`GET /project/projects/:id/workflow?workflow=content`, under
//   the reader's own `project:read`) answers `{ head }`: the head of the project's policy, with the
//   v2 policy document or null. The parse below is the provider's own schema at inferops b0189cc2
//   (`domains/project/shared/workflow-policy-v2.ts`, `workflow-policy.dto.ts`), kept here on purpose:
//   every object must have exactly its source keys, every enum, pattern, length and array cap is the
//   source's, and the guard refinement is the source's. A field InferOps adds later is therefore
//   refused (UNAVAILABLE) until this file is updated. It checks the document's shape only: lane
//   references, duplicate ids and fragment cycles are the provider compiler's, not repeated here.
// - Projection. Exactly three things are left out: the head's `publishedBy`, the policy's `agents`,
//   and the free-text `reason` of every rule (top-level, fragment, lane binding and transition
//   rules). Each is validated against its source schema first, so a malformed one fails the read as
//   any other malformed field does, and is then dropped: no value, no marker that it was there.
//   Everything else is copied as InferOps sent it, keys and arrays in InferOps' order; nothing is
//   added or renamed. Principal ids in subjects stay: they are personal information, and this is a
//   narrower view, not an anonymous one. `compiledHash` is InferOps' hash of the compiled source
//   policy; nothing here hashes the projection or claims the two match.
// - Consistency. A head is refused when it is not about the project asked for, when its workflow
//   or the policy's is not `content`, or when `configured` disagrees with the rest of the head: an
//   unconfigured head has no policy, revision '0', no compiledHash and no publisher or publish time;
//   a configured one has a policy and a compiledHash (`backend/workflow-policy.ts` at b0189cc2).
// - Refusal. A policy the reader cannot open (InferOps' 403 or 404 on either read, or a key that is
//   not in the bound workspace's project list) is one NOT_FOUND, so a URL cannot probe which. A
//   malformed or ambiguous answer is UNAVAILABLE with a message that never repeats a value.
// - The switch (`INFEROPS_WORKFLOW_POLICY_ENABLED`) is off unless set to "true", and needs InferOps
//   itself on. Like the other switches it is checked on every call, so a binding or session that
//   exists when it is turned off is refused from its next call and resumes when it is turned back on.

import { InferOpsError, type InferOpsClient } from "./inferops-client";
import { assertInferOpsEnabled, guarded, inferOpsEnabled } from "./enablement";
import type {
  WorkflowPolicyFragment, WorkflowPolicyHead, WorkflowPolicyLaneBinding, WorkflowPolicyRule,
  WorkflowPolicyTransition, WorkflowPolicyV2,
} from "./types";

/** The message every call refused by the workflow-policy switch carries after its `DISABLED: ` code. */
export const WORKFLOW_POLICY_DISABLED_MESSAGE = "InferOps workflow policies are turned off for this deployment.";

/** The message of every malformed or ambiguous answer. It never names a value. */
export const WORKFLOW_POLICY_UNREADABLE_MESSAGE =
  "InferOps returned a workflow policy this gatekeeper cannot read. Try again later.";

type WorkflowPolicyEnv = Pick<Cloudflare.Env, "INFEROPS_ENABLED" | "INFEROPS_WORKFLOW_POLICY_ENABLED">;

/** Whether workflow-policy bindings are on: only `"true"`, and only while InferOps itself is on. */
export function workflowPolicyEnabled(env: WorkflowPolicyEnv): boolean {
  return env.INFEROPS_WORKFLOW_POLICY_ENABLED === "true" && inferOpsEnabled(env);
}

/** Throw `DISABLED` while InferOps or workflow policies are off, naming whichever is. */
export function assertWorkflowPolicyEnabled(env: WorkflowPolicyEnv): void {
  assertInferOpsEnabled(env);
  if (!workflowPolicyEnabled(env)) {
    throw new InferOpsError("DISABLED", WORKFLOW_POLICY_DISABLED_MESSAGE);
  }
}

/** A client for a workflow-policy binding: every call (`forget` aside) is refused while either switch is off. */
export function whileWorkflowPolicyEnabled(env: WorkflowPolicyEnv, open: () => InferOpsClient): InferOpsClient {
  return guarded(() => assertWorkflowPolicyEnabled(env), open);
}

/** The one answer for a workflow policy that is missing or not readable, whatever the reason. */
export function workflowPolicyNotFound(): InferOpsError {
  return new InferOpsError("NOT_FOUND", "No such workflow policy is available to you.");
}

// ---------------------------------------------------------------------------
// The source record: InferOps' head as it answered, validated, with nothing yet left out.

/** A rule as InferOps sends it: the projected fields and its optional free-text `reason`. */
export type WorkflowRuleRecord = WorkflowPolicyRule & { reason?: string };
/** Non-authoritative agent notes InferOps keeps beside the policy (excluded from its hash). */
export type WorkflowAgentRecord = { principalId: string; responsibility: string };
export type WorkflowFragmentRecord = Omit<WorkflowPolicyFragment, "rules"> & { rules: WorkflowRuleRecord[] };
export type WorkflowLaneBindingRecord = Omit<WorkflowPolicyLaneBinding, "rules"> & { rules?: WorkflowRuleRecord[] };
export type WorkflowTransitionRecord = Omit<WorkflowPolicyTransition, "rules"> & { rules?: WorkflowRuleRecord[] };
export type WorkflowPolicyRecord =
  Omit<WorkflowPolicyV2, "fragments" | "laneBindings" | "rules" | "transitions"> & {
    fragments?: WorkflowFragmentRecord[];
    laneBindings?: WorkflowLaneBindingRecord[];
    rules?: WorkflowRuleRecord[];
    transitions?: WorkflowTransitionRecord[];
    agents?: WorkflowAgentRecord[];
  };
/** One `workflow.get` head exactly as InferOps answered it, after the strict parse. */
export type WorkflowHeadRecord = Omit<WorkflowPolicyHead, "policy"> & {
  policy: WorkflowPolicyRecord | null;
  publishedBy?: string;
};

// ---------------------------------------------------------------------------
// Parse. Every check copies the provider's schema; a failure names nothing about the value.

/** A shape mismatch. Its message is fixed: neither a value nor a field ever leaves this file. */
class Unreadable extends Error {
  constructor() {
    super("workflow policy answer does not match the provider schema");
  }
}

// Zod 4.4.3's `z.uuid()` (RFC 9562/4122, any version, plus the nil and max ids), the pin's version.
const UUID =
  /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
// Zod 4.4.3's `z.iso.datetime()`: a calendar date, `T`, hh:mm with optional seconds and fraction, `Z`.
const DATETIME = new RegExp(
  "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|" +
  "\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|" +
  "(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$");
/** `RevisionSchema`: a decimal bigint string. */
const REVISION = /^\d+$/;
/** `CompiledHashSchema`: sha-256, lowercase hex. */
const COMPILED_HASH = /^[0-9a-f]{64}$/;
/** `WORKFLOW_SLUG_PATTERN`: rule, fragment, transition and `use` ids. */
const SLUG = /^[a-z][a-z0-9-]{0,63}$/;

const ACTIONS = [
  "read", "create", "edit", "comment", "assign", "reprioritize", "move-out", "move-in", "claim",
  "delegate", "execute", "approve", "publish",
] as const;
const EFFECTS = ["allow", "deny"] as const;
const PRINCIPAL_KINDS = ["user", "service_account", "system"] as const;
const REQUIRED_FIELDS = ["title", "description", "acceptanceCriteria", "assigneeId", "targetDate", "refs"] as const;
const GUARD_KINDS = ["required-field", "lease-holder", "actor-kind", "not-blocked", "approval-ref"] as const;
const LANE_GROUPS = ["backlog", "unstarted", "started", "completed", "cancelled"] as const;
const WORKFLOWS = ["content", "software"] as const;

type Value = Record<string, unknown>;

/** `value` as a plain object whose keys are all in `required` or `optional`, with every required one. */
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Value {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Unreadable();
  const record = value as Value;
  for (const key of Object.keys(record)) {
    if (!required.includes(key) && !optional.includes(key)) throw new Unreadable();
  }
  for (const key of required) if (!Object.hasOwn(record, key)) throw new Unreadable();
  return record;
}

/** An array of `min` to `max` entries, each checked by `item`. */
function array(value: unknown, min: number, max: number, item: (entry: unknown) => void): void {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Unreadable();
  value.forEach(item);
}

/** An optional key: absent is fine; present is checked like a required one (null is not absent). */
function optionalArray(record: Value, key: string, max: number, item: (entry: unknown) => void): void {
  if (Object.hasOwn(record, key)) array(record[key], 0, max, item);
}

function matching(value: unknown, pattern: RegExp): void {
  if (typeof value !== "string" || !pattern.test(value)) throw new Unreadable();
}

function among(value: unknown, allowed: readonly string[]): void {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Unreadable();
}

function boolean(value: unknown): void {
  if (typeof value !== "boolean") throw new Unreadable();
}

/** A string of `min` to `max` UTF-16 code units, measured after trimming when `trimmed` (zod `.trim()`). */
function string(value: unknown, min: number, max: number, trimmed: boolean): void {
  if (typeof value !== "string") throw new Unreadable();
  const length = (trimmed ? value.trim() : value).length;
  if (length < min || length > max) throw new Unreadable();
}

/** `RuleSubjectSchema`: exactly one of `{principalId}`, `{kind}` or `{role}`. */
function subject(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Unreadable();
  const keys = Object.keys(value);
  if (keys.length !== 1) throw new Unreadable();
  const record = value as Value;
  if (keys[0] === "principalId") return matching(record.principalId, UUID);
  if (keys[0] === "kind") return among(record.kind, PRINCIPAL_KINDS);
  if (keys[0] === "role") return string(record.role, 1, 40, false);
  throw new Unreadable();
}

/** `RuleSchema`, including its optional `reason`, which is validated here and dropped by the projection. */
function rule(value: unknown): void {
  const record = object(value, ["id", "effect", "subjects", "actions"], ["reason"]);
  matching(record.id, SLUG);
  among(record.effect, EFFECTS);
  array(record.subjects, 1, 50, subject);
  array(record.actions, 1, ACTIONS.length, action => among(action, ACTIONS));
  if (Object.hasOwn(record, "reason")) string(record.reason, 1, 500, true);
}

/** `GuardSchema`, with its refinement: `field` exactly for required-field, `actorKind` exactly for actor-kind. */
function guard(value: unknown): void {
  const record = object(value, ["kind"], ["field", "actorKind"]);
  among(record.kind, GUARD_KINDS);
  const hasField = Object.hasOwn(record, "field");
  const hasActorKind = Object.hasOwn(record, "actorKind");
  if (hasField) among(record.field, REQUIRED_FIELDS);
  if (hasActorKind) among(record.actorKind, PRINCIPAL_KINDS);
  if ((record.kind === "required-field") !== hasField) throw new Unreadable();
  if ((record.kind === "actor-kind") !== hasActorKind) throw new Unreadable();
}

/** `UseSchema`: up to 20 slugs. */
function use(record: Value): void {
  optionalArray(record, "use", 20, id => matching(id, SLUG));
}

function lane(value: unknown): void {
  const record = object(value, ["id", "name", "group"]);
  matching(record.id, UUID);
  string(record.name, 1, 80, true);
  among(record.group, LANE_GROUPS);
}

function fragment(value: unknown): void {
  const record = object(value, ["id", "version", "rules"], ["use"]);
  matching(record.id, SLUG);
  // zod 4's `.int()` is a safe integer.
  if (typeof record.version !== "number" || !Number.isSafeInteger(record.version) || record.version < 1) {
    throw new Unreadable();
  }
  use(record);
  array(record.rules, 0, 100, rule);
}

function laneBinding(value: unknown): void {
  const record = object(value, ["laneId"], ["use", "rules", "guards"]);
  matching(record.laneId, UUID);
  use(record);
  optionalArray(record, "rules", 100, rule);
  optionalArray(record, "guards", 20, guard);
}

/** `LaneRefSchema`: a lane id or `'*'`. */
function laneRef(value: unknown): void {
  if (value === "*") return;
  matching(value, UUID);
}

function transition(value: unknown): void {
  const record = object(value, ["id", "from", "to", "subjects"], ["guards", "rules"]);
  matching(record.id, SLUG);
  laneRef(record.from);
  laneRef(record.to);
  array(record.subjects, 0, 50, subject);
  optionalArray(record, "guards", 20, guard);
  optionalArray(record, "rules", 50, rule);
}

/** `WorkflowAgentSchema`: validated here, then dropped whole by the projection. */
function agent(value: unknown): void {
  const record = object(value, ["principalId", "responsibility"]);
  matching(record.principalId, UUID);
  string(record.responsibility, 1, 4000, true);
}

/** `WorkflowPolicyV2ShapeSchema`, governed `content` workflow only. */
function policy(value: unknown): void {
  const record = object(value, ["schemaVersion", "workflow", "entryLaneId", "lanes"],
    ["fragments", "laneBindings", "rules", "transitions", "agents"]);
  if (record.schemaVersion !== 2) throw new Unreadable();
  among(record.workflow, WORKFLOWS);
  if (record.workflow !== "content") throw new Unreadable();
  matching(record.entryLaneId, UUID);
  array(record.lanes, 2, 40, lane);
  optionalArray(record, "fragments", 50, fragment);
  optionalArray(record, "laneBindings", 40, laneBinding);
  optionalArray(record, "rules", 200, rule);
  optionalArray(record, "transitions", 400, transition);
  optionalArray(record, "agents", 50, agent);
}

/** `WorkflowHeadSchema`, about `projectId`, consistent with `configured`. */
function head(value: unknown, projectId: string): WorkflowHeadRecord {
  const record = object(value,
    ["projectId", "workflow", "configured", "revision", "policy", "compiledHash", "legacyUpgraded"],
    ["publishedBy", "publishedAt"]);
  matching(record.projectId, UUID);
  if ((record.projectId as string).toLowerCase() !== projectId.toLowerCase()) throw new Unreadable();
  among(record.workflow, WORKFLOWS);
  if (record.workflow !== "content") throw new Unreadable();
  boolean(record.configured);
  matching(record.revision, REVISION);
  if (record.policy !== null) policy(record.policy);
  if (record.compiledHash !== null) matching(record.compiledHash, COMPILED_HASH);
  boolean(record.legacyUpgraded);
  if (Object.hasOwn(record, "publishedBy")) matching(record.publishedBy, UUID);
  if (Object.hasOwn(record, "publishedAt")) matching(record.publishedAt, DATETIME);
  if (record.configured) {
    if (record.policy === null || record.compiledHash === null) throw new Unreadable();
  } else if (record.policy !== null || record.revision !== "0" || record.compiledHash !== null ||
             Object.hasOwn(record, "publishedBy") || Object.hasOwn(record, "publishedAt")) {
    throw new Unreadable();
  }
  return record as WorkflowHeadRecord;
}

/**
 * The head of one `workflow.get` answer (`{ head }`) about `projectId`, strictly as the provider's
 * schema allows, or UNAVAILABLE with a fixed message. `onUnreadable` is told only that it happened.
 */
export function readWorkflowPolicyAnswer(
  body: unknown, projectId: string, onUnreadable?: () => void,
): WorkflowHeadRecord {
  try {
    return head(object(body, ["head"]).head, projectId);
  } catch (error) {
    if (!(error instanceof Unreadable)) throw error;
    onUnreadable?.();
    throw new InferOpsError("UNAVAILABLE", WORKFLOW_POLICY_UNREADABLE_MESSAGE);
  }
}

// ---------------------------------------------------------------------------
// Projection

/** `value` without `drop`, every other key in its own order; values are copied by the caller. */
function without<T extends object>(value: T, drop: string): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) if (key !== drop) copy[key] = entry;
  return copy;
}

/** A rule without its `reason`; subjects and actions as sent. */
function projectRule(source: WorkflowRuleRecord): WorkflowPolicyRule {
  return without(source, "reason") as unknown as WorkflowPolicyRule;
}

/** `record` with its `rules` key, when present, projected; every other key unchanged and in place. */
function withRules<T extends { rules?: WorkflowRuleRecord[] }>(record: T): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    copy[key] = key === "rules" ? (entry as WorkflowRuleRecord[]).map(projectRule) : entry;
  }
  return copy;
}

function projectPolicy(source: WorkflowPolicyRecord): WorkflowPolicyV2 {
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (key === "agents") continue;
    if (key === "rules") copy[key] = (entry as WorkflowRuleRecord[]).map(projectRule);
    else if (key === "fragments" || key === "laneBindings" || key === "transitions") {
      copy[key] = (entry as { rules?: WorkflowRuleRecord[] }[]).map(withRules);
    } else copy[key] = entry;
  }
  return copy as unknown as WorkflowPolicyV2;
}

/**
 * What a caller may see of one head: everything InferOps sent except `publishedBy`, `agents` and
 * every rule's `reason`, in InferOps' order, as a fresh copy that shares nothing with the source.
 */
export function projectWorkflowHead(record: WorkflowHeadRecord): WorkflowPolicyHead {
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (key === "publishedBy") continue;
    copy[key] = key === "policy" && entry !== null ? projectPolicy(entry as WorkflowPolicyRecord) : entry;
  }
  return structuredClone(copy) as unknown as WorkflowPolicyHead;
}
