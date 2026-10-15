/**
 * Apply a reviewed intake to InferOps (`intake apply --inferops`, factory-level/inferos#82 and #87).
 *
 * InferOps stays authoritative: InferOS sends the intake and reads back what InferOps made, and stores
 * only references (ids, the provider's hash) in the wrapper. Three steps, each reported on its own:
 *
 * 1. `POST /project/intake` in the operations workspace: InferOps models the projects and operations
 *    and returns its canonical `intakeSha256`. That hash is the provider's identity of the intake; it
 *    is never compared with the raw-bytes hash InferOS records. The same response carries InferOps'
 *    `requirementReport`, checked against the reviewed intake by {@link parseRequirementReport}.
 * 2. `POST /knowledge/wiki/pillars` in the InferMind workspace with that hash: the company root, a
 *    Master per selected pillar, and SOP pages filed under their pillars.
 * 3. `GET /knowledge/wiki/structure`: the readback. A write that succeeded is never reported as failed
 *    because the readback did not.
 *
 * Before anything changes, {@link proveInferOpsBinding} proves both workspaces: a dry run of the
 * intake apply in the operations workspace and a Wiki read in the InferMind one. Both writes are idempotent on InferOps, so a rerun after a
 * partial failure completes without duplicating anything or losing human edits. The token is sent
 * only in the `authorization` header and never appears in a result, an error or the report.
 *
 * Conflicting intake revisions require review (inferops#2324). Every intake call names its base: the
 * provider hash of the intake this wrapper last applied. InferOps reports an operation that both this
 * intake and, since that base, another apply changed as a `conflict` and refuses the whole intake
 * (409 `STALE_REVISION`, nothing written). The dry run surfaces it before the wrapper is derived
 * ({@link IntakeConflictError}); the human's resolution is an explicit rebase onto the current intake.
 */
import type { ConsumerIntake } from "./intake.ts";

/** Where and as whom to reach InferOps. Read from the environment, never from the wrapper's files. */
export interface InferOpsBinding {
  baseUrl: string;
  token: string;
  /** The InferOps (operations) workspace the intake's projects and operations belong to. */
  operationsWorkspaceId: string;
  /** The InferMind workspace that holds the customer's Wiki. */
  knowledgeWorkspaceId: string;
}

/** The environment variables a binding needs, by role. */
export const INFEROPS_BINDING_VARS = {
  baseUrl: "INFEROPS_BASE_URL",
  token: "INFEROPS_API_TOKEN",
  operationsWorkspaceId: "INFEROPS_WORKSPACE_ID",
  knowledgeWorkspaceId: "INFEROPS_KNOWLEDGE_WORKSPACE_ID",
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read the binding from `env`. Errors name the missing or malformed variable, never its value. */
export function inferOpsBindingFromEnv(env: NodeJS.ProcessEnv = process.env): InferOpsBinding {
  const missing = Object.values(INFEROPS_BINDING_VARS).filter(name => !env[name]?.trim());
  if (missing.length) throw new Error(`--inferops needs ${missing.join(", ")}`);
  const read = (name: string) => env[name]!.trim();
  let base: URL;
  try { base = new URL(read(INFEROPS_BINDING_VARS.baseUrl)); } catch { throw new Error(`${INFEROPS_BINDING_VARS.baseUrl} is not a URL`); }
  const local = base.hostname === "localhost" || base.hostname === "127.0.0.1" || base.hostname === "[::1]";
  if (base.protocol !== "https:" && !(base.protocol === "http:" && local)) {
    throw new Error(`${INFEROPS_BINDING_VARS.baseUrl} must use https (http only for localhost)`);
  }
  if (base.username || base.password || base.search || base.hash) {
    throw new Error(`${INFEROPS_BINDING_VARS.baseUrl} must be a bare origin and path`);
  }
  for (const key of ["operationsWorkspaceId", "knowledgeWorkspaceId"] as const) {
    if (!UUID.test(read(INFEROPS_BINDING_VARS[key]))) throw new Error(`${INFEROPS_BINDING_VARS[key]} must be a workspace UUID`);
  }
  return {
    baseUrl: base.href.replace(/\/+$/, ""),
    token: read(INFEROPS_BINDING_VARS.token),
    operationsWorkspaceId: read(INFEROPS_BINDING_VARS.operationsWorkspaceId),
    knowledgeWorkspaceId: read(INFEROPS_BINDING_VARS.knowledgeWorkspaceId),
  };
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;

/** One operation InferOps reported as conflicting, and the step this intake wanted for it. */
export interface IntakeConflict { key: string; action: string }

/**
 * InferOps refused the intake because some operation changed since this wrapper's base intake. Raised
 * by the binding dry run, before the wrapper is derived, so nothing changed anywhere.
 */
export class IntakeConflictError extends Error {
  readonly conflicts: IntakeConflict[];
  readonly currentIntakeSha256: string | null;
  constructor(conflicts: IntakeConflict[], currentIntakeSha256: string | null) {
    super([
      `InferOps refused the intake before any write: ${conflicts.length} operation(s) changed since the intake this wrapper last applied:`,
      conflicts.map(conflict => `${conflict.key} (${conflict.action})`).join(", ") + ".",
      `The current InferOps intake is ${currentIntakeSha256 ?? "unknown"}.`,
      "The wrapper is unchanged. Resolve each by hand (inventory.list shows the current operations), then rerun with",
      `--rebase-onto ${currentIntakeSha256 ?? "<current intake sha256>"}.`,
    ].join(" "));
    this.conflicts = conflicts;
    this.currentIntakeSha256 = currentIntakeSha256;
  }
}

/** The conflicting operations of a provider change list (dry run), with the step each would have been. */
const conflictsIn = (changes: unknown): IntakeConflict[] => Array.isArray(changes)
  ? changes.filter(change => change?.kind === "operation" && change?.action === "conflict").map(change => ({
    key: String(change.key),
    action: /^this intake would (create|update|retire) it/.exec(typeof change.detail === "string" ? change.detail : "")?.[1] ?? "change",
  }))
  : [];

/** `fetch`, injected in tests so nothing reaches a network. */
export type FetchSeam = (url: string, init: RequestInit) => Promise<Response>;

/** One SOP page filed under a pillar, from an operation whose `sop` is `wiki:<slug>`. */
export interface PillarMember { pillar: string; documentSlug: string }

/**
 * The Wiki memberships an intake asks for: each operation with a pillar and a `wiki:<slug>` SOP. Any
 * other SOP form (a URL, free text) names no Wiki page and is returned as unlinked, never dropped.
 */
export function pillarMembers(intake: ConsumerIntake): { members: PillarMember[]; unlinked: { operation: string; reason: string }[] } {
  const members: PillarMember[] = [];
  const unlinked: { operation: string; reason: string }[] = [];
  for (const operation of intake.operations) {
    if (!operation.sop) continue;
    const slug = /^wiki:(\S.{0,510})$/.exec(operation.sop)?.[1];
    if (!slug) unlinked.push({ operation: operation.id, reason: "SOP is not a wiki:<slug> reference" });
    else if (!operation.pillar) unlinked.push({ operation: operation.id, reason: "operation has no pillar" });
    else if (!members.some(member => member.pillar === operation.pillar && member.documentSlug === slug)) members.push({ pillar: operation.pillar, documentSlug: slug });
  }
  return { members, unlinked };
}

/** A step's outcome. `not-run` means an earlier step stopped the run. */
export type StepStatus = "applied" | "failed" | "not-run";

/** A Master page as read back. */
export interface MasterReadback { key: string; title: string; documentId: string | null; members: number }

/** InferOps' disposition of one requirement, as the provider reported it. */
export interface ProviderRequirement {
  id: string;
  category: string;
  /** Only `unresolved` exists in the provider today (inferops #2380). */
  disposition: "unresolved";
  needsReview: boolean;
  reason: "fulfillment-not-assessed";
  detail: string;
}

/**
 * InferOps' own report of the intake's requirements, from step 1's response. It is the provider's
 * disposition and stays apart from the wrapper's (`supported` here means a wrapper capability, never
 * that InferOps found the requirement met).
 *
 * - `reported`: valid, bound to step 1's hash, and every reviewed requirement appears exactly once.
 * - `unavailable`: the response has no report (a provider before #2380). Nothing is assumed.
 * - `invalid`: present but not trustworthy; `problem` says why and `requirements` is empty.
 * - `not-run`: step 1 did not succeed.
 */
export interface ProviderRequirementReport {
  status: "reported" | "unavailable" | "invalid" | "not-run";
  /** Why the report is `invalid`, by field and rule; never a reported value. */
  problem: string | null;
  intakeSha256: string | null;
  requirements: ProviderRequirement[];
}

const PROVIDER_DISPOSITIONS: readonly string[] = ["unresolved"];
const PROVIDER_REASONS: readonly string[] = ["fulfillment-not-assessed"];
const REPORT_KEYS = ["intakeSha256", "requirements"];
const ENTRY_KEYS = ["id", "category", "text", "disposition", "needsReview", "reason", "detail"];
const HASH = /^[0-9a-f]{64}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hasExactly = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

/**
 * Check step 1's `requirementReport` against the reviewed intake: the provider's strict schema
 * (`IntakeRequirementReportSchema`, inferops `domains/project/shared/intake.dto.ts`), the response's
 * own hash, and each requirement's id, category and text, in intake order, exactly once. Problems
 * name a position and a rule, never a value the provider sent.
 */
export function parseRequirementReport(value: unknown, responseSha256: string, intake: ConsumerIntake): ProviderRequirementReport {
  const invalid = (problem: string): ProviderRequirementReport => ({ status: "invalid", problem, intakeSha256: null, requirements: [] });
  if (value === undefined) return { status: "unavailable", problem: null, intakeSha256: null, requirements: [] };
  if (!isRecord(value) || !hasExactly(value, REPORT_KEYS)) return invalid("requirementReport: expected exactly intakeSha256, requirements");
  if (typeof value.intakeSha256 !== "string" || !HASH.test(value.intakeSha256)) return invalid("requirementReport.intakeSha256: expected a sha-256 hex digest");
  if (value.intakeSha256 !== responseSha256) return invalid("requirementReport.intakeSha256: does not match the apply response's intakeSha256");
  if (!Array.isArray(value.requirements)) return invalid("requirementReport.requirements: expected an array");
  const expected = intake.requirements;
  const ids = value.requirements.map(entry => (isRecord(entry) ? entry.id : undefined));
  if (new Set(ids).size !== ids.length) return invalid("requirementReport.requirements: an id appears more than once");
  if (value.requirements.length !== expected.length) {
    return invalid(`requirementReport.requirements: expected ${expected.length} entries, one per intake requirement, got ${value.requirements.length}`);
  }
  const requirements: ProviderRequirement[] = [];
  for (const [index, entry] of value.requirements.entries()) {
    const at = `requirementReport.requirements[${index}]`;
    const want = expected[index]!;
    if (!isRecord(entry) || !hasExactly(entry, ENTRY_KEYS)) return invalid(`${at}: expected exactly ${ENTRY_KEYS.join(", ")}`);
    if (entry.id !== want.id) {
      return invalid(expected.some(requirement => requirement.id === entry.id)
        ? `${at}.id: out of intake order`
        : `${at}.id: not a requirement of this intake`);
    }
    if (entry.category !== want.category) return invalid(`${at}.category: differs from intake requirement ${want.id}`);
    if (entry.text !== want.text) return invalid(`${at}.text: differs from intake requirement ${want.id}`);
    if (typeof entry.disposition !== "string" || !PROVIDER_DISPOSITIONS.includes(entry.disposition)) return invalid(`${at}.disposition: expected one of ${PROVIDER_DISPOSITIONS.join(", ")}`);
    if (typeof entry.reason !== "string" || !PROVIDER_REASONS.includes(entry.reason)) return invalid(`${at}.reason: expected one of ${PROVIDER_REASONS.join(", ")}`);
    if (typeof entry.needsReview !== "boolean") return invalid(`${at}.needsReview: expected boolean`);
    // The provider's detail is one sentence; a control character or an outsized value is not shown.
    if (typeof entry.detail !== "string" || entry.detail.length > 1000 || [...entry.detail].some(char => char < " " || char === "\u007f")) {
      return invalid(`${at}.detail: expected a single-line string of at most 1000 characters`);
    }
    requirements.push({
      id: want.id, category: want.category, disposition: "unresolved", needsReview: entry.needsReview,
      reason: "fulfillment-not-assessed", detail: entry.detail,
    });
  }
  return { status: "reported", problem: null, intakeSha256: value.intakeSha256, requirements };
}

/** What applying to InferOps did, step by step. The JSON report carries it as `inferops`. */
export interface InferOpsApplyResult {
  /** The provider's canonical hash of the intake, once step 1 returned it. */
  intakeSha256: string | null;
  intake: StepStatus;
  /** True when InferOps had already applied this exact intake. */
  alreadyApplied: boolean;
  /** Step 1's changes, `kind:key=action`. */
  intakeChanges: string[];
  /** InferOps' report of the intake's requirements, from step 1's response. */
  requirementReport: ProviderRequirementReport;
  pillars: StepStatus;
  /** Step 2's changes, `kind:key=action`. */
  pillarChanges: string[];
  /**
   * `complete`: every selected pillar read back with a Master and no other pillar is live. `incomplete`:
   * read, but something selected is missing or a pillar the intake no longer selects is still live.
   */
  readback: "complete" | "incomplete" | "failed" | "not-run";
  rootDocumentId: string | null;
  masters: MasterReadback[];
  /** Live pillars the intake does not select: left over from an earlier selection. */
  leftoverPillars: string[];
  /** Pages filed under two or more of the selected pillars: one page, several pillars. */
  sharedPages: { documentId: string; slug: string; pillars: string[] }[];
  unlinkedSops: { operation: string; reason: string }[];
  /** The base this run sent: the provider hash of the intake applied before (or `--rebase-onto`). */
  baseIntakeSha256: string | null;
  /** Operations InferOps refused as conflicting (409 `STALE_REVISION` on step 1); empty otherwise. */
  conflicts: IntakeConflict[];
  /** The current InferOps intake when step 1 was refused as conflicting: the rebase target. */
  currentIntakeSha256: string | null;
  /** The first failure, as `step: status code message`; null when every step succeeded. */
  error: string | null;
}

class StepError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | null;
  constructor(message: string, code = "", details: Record<string, unknown> | null = null) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** A provider change list as `kind:key=action` lines. */
const changeList = (value: unknown) => Array.isArray(value)
  ? value.map(change => `${change?.kind}:${change?.key}=${change?.action}`) : [];

type Call = (step: string, workspace: string, method: "GET" | "POST", path: string, body?: unknown, idempotencyKey?: string) => Promise<Record<string, unknown>>;

/**
 * A provider error as `HTTP status CODE: message`, from either error envelope, without echoing the
 * request; plus its code and `details` (recovery data, e.g. a conflict's current intake).
 */
async function describe(response: Response): Promise<{ text: string; code: string; details: Record<string, unknown> | null }> {
  let code = "";
  let message = "";
  let details: Record<string, unknown> | null = null;
  try {
    const body = await response.json() as { code?: unknown; message?: unknown; details?: unknown; error?: { code?: unknown; message?: unknown; details?: unknown } | string };
    const error = typeof body.error === "object" && body.error ? body.error : body;
    code = typeof error.code === "string" ? error.code : "";
    message = typeof error.message === "string" ? error.message.slice(0, 300) : "";
    details = isRecord(error.details) ? error.details : null;
  } catch { /* a non-JSON error body says nothing more than its status */ }
  return { text: `HTTP ${response.status}${code ? ` ${code}` : ""}${message ? `: ${message}` : ""}`, code, details };
}

/** A 409 `STALE_REVISION` conflict's recovery data, read strictly; null for any other failure. */
function conflictOf(error: unknown): { conflicts: IntakeConflict[]; currentIntakeSha256: string | null } | null {
  if (!(error instanceof StepError) || error.code !== "STALE_REVISION" || !error.details) return null;
  const { conflicts, currentIntakeSha256 } = error.details;
  if (!Array.isArray(conflicts)) return null;
  return {
    conflicts: conflicts.filter(isRecord).map(conflict => ({ key: String(conflict.key), action: String(conflict.action) })),
    currentIntakeSha256: typeof currentIntakeSha256 === "string" && HASH_PATTERN.test(currentIntakeSha256) ? currentIntakeSha256 : null,
  };
}

function caller(binding: InferOpsBinding, fetchSeam: FetchSeam): Call {
  return async (step, workspace, method, path, body, idempotencyKey) => {
    let response: Response;
    try {
      response = await fetchSeam(`${binding.baseUrl}${path}`, {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
        headers: {
          authorization: `Bearer ${binding.token}`,
          "x-workspace-id": workspace,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(idempotencyKey ? { "x-idempotency-key": idempotencyKey } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new StepError(`${step}: InferOps unreachable (${(error as Error).name})`);
    }
    if (!response.ok) {
      const failure = await describe(response);
      throw new StepError(`${step}: ${failure.text}`, failure.code, failure.details);
    }
    try { return await response.json() as Record<string, unknown>; } catch { throw new StepError(`${step}: response is not JSON`); }
  };
}

/**
 * Prove the binding before anything changes. In the operations workspace, a dry run of the intake
 * apply writes nothing but makes the provider check that the workspace is the one the intake names
 * (tenant and workspace slugs) and that the token may apply it. In the InferMind workspace, a Wiki
 * structure read, which the provider answers only in an InferMind workspace the token may read. A
 * wrong, swapped or unauthorized workspace is refused here, before the wrapper or InferOps changes.
 */
export async function proveInferOpsBinding(
  intake: ConsumerIntake, binding: InferOpsBinding, fetchSeam: FetchSeam = fetch, options: { base?: string | null } = {},
): Promise<{ conflicts: IntakeConflict[]; currentIntakeSha256: string | null }> {
  const call = caller(binding, fetchSeam);
  let plan: Record<string, unknown>;
  try {
    plan = await call("operations binding", binding.operationsWorkspaceId, "POST", "/project/intake", { ...intake, ...withBase(options.base), dryRun: true });
    await call("knowledge binding", binding.knowledgeWorkspaceId, "GET", "/knowledge/wiki/structure");
  } catch (error) {
    throw new Error(`InferOps binding refused before any write. ${(error as Error).message}`, { cause: error });
  }
  // The same dry run is the conflict review's first look: what InferOps would refuse, and its current intake.
  const current = typeof plan.currentIntakeSha256 === "string" && HASH_PATTERN.test(plan.currentIntakeSha256) ? plan.currentIntakeSha256 : null;
  return { conflicts: conflictsIn(plan.changes), currentIntakeSha256: current };
}

/** The request field naming the base intake; omitted when there is none (InferOps then fails closed). */
const withBase = (base: string | null | undefined) => (base ? { baseIntakeSha256: base } : {});

/**
 * The operations workspace's current intake hash, from `inventory.list` (null before any intake). It is
 * what `--rebase-onto` must name: a dry run whose base is already current reports no current hash.
 */
export async function currentInferOpsIntake(binding: InferOpsBinding, fetchSeam: FetchSeam = fetch): Promise<string | null> {
  const inventory = await caller(binding, fetchSeam)("inventory.list", binding.operationsWorkspaceId, "GET", "/project/inventory") as { intake?: { sha256?: unknown } | null };
  const sha = inventory.intake?.sha256;
  if (inventory.intake === null || inventory.intake === undefined) return null;
  if (typeof sha !== "string" || !HASH_PATTERN.test(sha)) throw new Error("inventory.list: the current intake has no sha-256");
  return sha;
}

/**
 * Apply `intake` to InferOps through a binding already proven by {@link proveInferOpsBinding}. Every
 * failure is returned as a step status, never thrown, so a partial result is reported truthfully.
 */
export async function applyIntakeToInferOps(
  intake: ConsumerIntake, binding: InferOpsBinding, fetchSeam: FetchSeam = fetch,
  options: { pillarsAppliedBefore?: boolean; base?: string | null } = {},
): Promise<InferOpsApplyResult> {
  const call = caller(binding, fetchSeam);

  const { members, unlinked } = pillarMembers(intake);
  const result: InferOpsApplyResult = {
    intakeSha256: null, intake: "not-run", alreadyApplied: false, intakeChanges: [],
    requirementReport: { status: "not-run", problem: null, intakeSha256: null, requirements: [] }, pillars: "not-run", pillarChanges: [],
    readback: "not-run", rootDocumentId: null, masters: [], leftoverPillars: [], sharedPages: [], unlinkedSops: unlinked,
    baseIntakeSha256: options.base ?? null, conflicts: [], currentIntakeSha256: null, error: null,
  };
  // Scoped to tenant, workspace and operation, so one key never replays across scopes or steps.
  const idempotencyKey = (operation: string, workspace: string, hash: string) =>
    `inferos-intake:${intake.inferops.tenant}:${workspace}:${operation}:${hash}`;

  try {
    const applied = await call("intake.apply", binding.operationsWorkspaceId, "POST", "/project/intake", { ...intake, ...withBase(options.base) });
    if (typeof applied.intakeSha256 !== "string") throw new StepError("intake.apply: response has no intakeSha256");
    result.intakeSha256 = applied.intakeSha256;
    result.alreadyApplied = applied.alreadyApplied === true;
    result.intakeChanges = changeList(applied.changes);
    result.intake = "applied";
    // Reporting only: an untrustworthy report never changes a step's status, the error or a retry.
    result.requirementReport = parseRequirementReport(applied.requirementReport, applied.intakeSha256, intake);
  } catch (error) {
    result.intake = "failed";
    result.error = (error as Error).message;
    // A race lost after the dry run: another apply landed in between. Same recovery as the dry-run stop.
    const conflict = conflictOf(error);
    if (conflict) Object.assign(result, conflict);
    return result;
  }

  // An empty selection still goes to InferOps when an earlier run applied pillars: that is how the
  // provider retires them. With no pillars ever applied it is skipped, so no company root is created.
  if (intake.wiki.pillars.length || options.pillarsAppliedBefore) {
    try {
      const applied = await call("pillar.apply", binding.knowledgeWorkspaceId, "POST", "/knowledge/wiki/pillars", {
        intakeSha256: result.intakeSha256,
        rootTitle: intake.customer.name,
        pillars: intake.wiki.pillars.map(pillar => ({ key: pillar.id, title: pillar.title })),
        members,
      }, idempotencyKey("pillar.apply", binding.knowledgeWorkspaceId, result.intakeSha256!));
      result.pillarChanges = changeList(applied.changes);
      result.pillars = "applied";
    } catch (error) {
      result.pillars = "failed";
      result.error = (error as Error).message;
      return result;
    }
  }

  try {
    const structure = await call("readback", binding.knowledgeWorkspaceId, "GET", "/knowledge/wiki/structure") as {
      root?: { documentId?: string } | null;
      pillars?: { key: string; title: string; master: { documentId: string } | null; members: { documentId: string; slug: string }[] }[];
    };
    const read = new Map((structure.pillars ?? []).map(pillar => [pillar.key, pillar]));
    result.rootDocumentId = structure.root?.documentId ?? null;
    result.masters = intake.wiki.pillars.map(pillar => {
      const found = read.get(pillar.id);
      return { key: pillar.id, title: found?.title ?? pillar.title, documentId: found?.master?.documentId ?? null, members: found?.members.length ?? 0 };
    });
    const pages = new Map<string, { documentId: string; slug: string; pillars: string[] }>();
    for (const pillar of intake.wiki.pillars) {
      for (const member of read.get(pillar.id)?.members ?? []) {
        const page = pages.get(member.documentId) ?? { documentId: member.documentId, slug: member.slug, pillars: [] };
        page.pillars.push(pillar.id);
        pages.set(member.documentId, page);
      }
    }
    result.sharedPages = [...pages.values()].filter(page => page.pillars.length > 1);
    const selected = new Set(intake.wiki.pillars.map(pillar => pillar.id));
    result.leftoverPillars = (structure.pillars ?? []).map(pillar => pillar.key).filter(key => !selected.has(key));
    const present = intake.wiki.pillars.length === 0
      || (result.rootDocumentId !== null && result.masters.every(master => master.documentId !== null));
    result.readback = present && result.leftoverPillars.length === 0 ? "complete" : "incomplete";
    if (!present) result.error = "readback: the Wiki structure is missing the company root or a selected pillar's Master";
    else if (result.leftoverPillars.length) result.error = `readback: pillars the intake no longer selects are still live: ${result.leftoverPillars.join(", ")}`;
  } catch (error) {
    result.readback = "failed";
    result.error = (error as Error).message;
  }
  return result;
}

/** True when every step succeeded and the readback found everything the intake selected. */
export const inferOpsComplete = (result: InferOpsApplyResult) =>
  result.intake === "applied" && (result.pillars === "applied" || result.pillars === "not-run") && result.readback === "complete";
