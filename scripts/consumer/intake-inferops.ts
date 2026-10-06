/**
 * Apply a reviewed intake to InferOps (`intake apply --inferops`, factory-level/inferos#82 and #87).
 *
 * InferOps stays authoritative: InferOS sends the intake and reads back what InferOps made, and stores
 * only references (ids, the provider's hash) in the wrapper. Three steps, each reported on its own:
 *
 * 1. `POST /project/intake` in the operations workspace: InferOps models the projects and operations
 *    and returns its canonical `intakeSha256`. That hash is the provider's identity of the intake; it
 *    is never compared with the raw-bytes hash InferOS records.
 * 2. `POST /knowledge/wiki/pillars` in the InferMind workspace with that hash: the company root, a
 *    Master per selected pillar, and SOP pages filed under their pillars.
 * 3. `GET /knowledge/wiki/structure`: the readback. A write that succeeded is never reported as failed
 *    because the readback did not.
 *
 * Before anything changes, {@link proveInferOpsBinding} proves both workspaces: a dry run of the
 * intake apply in the operations workspace and a Wiki read in the InferMind one. Both writes are idempotent on InferOps, so a rerun after a
 * partial failure completes without duplicating anything or losing human edits. The token is sent
 * only in the `authorization` header and never appears in a result, an error or the report.
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

/** What applying to InferOps did, step by step. The JSON report carries it as `inferops`. */
export interface InferOpsApplyResult {
  /** The provider's canonical hash of the intake, once step 1 returned it. */
  intakeSha256: string | null;
  intake: StepStatus;
  /** True when InferOps had already applied this exact intake. */
  alreadyApplied: boolean;
  /** Step 1's changes, `kind:key=action`. */
  intakeChanges: string[];
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
  /** The first failure, as `step: status code message`; null when every step succeeded. */
  error: string | null;
}

class StepError extends Error {}

/** A provider change list as `kind:key=action` lines. */
const changeList = (value: unknown) => Array.isArray(value)
  ? value.map(change => `${change?.kind}:${change?.key}=${change?.action}`) : [];

type Call = (step: string, workspace: string, method: "GET" | "POST", path: string, body?: unknown, idempotencyKey?: string) => Promise<Record<string, unknown>>;

/** A provider error as `HTTP status CODE: message`, from either error envelope, without echoing the request. */
async function describe(response: Response): Promise<string> {
  let code = "";
  let message = "";
  try {
    const body = await response.json() as { code?: unknown; message?: unknown; error?: { code?: unknown; message?: unknown } | string };
    const error = typeof body.error === "object" && body.error ? body.error : body;
    code = typeof error.code === "string" ? error.code : "";
    message = typeof error.message === "string" ? error.message.slice(0, 300) : "";
  } catch { /* a non-JSON error body says nothing more than its status */ }
  return `HTTP ${response.status}${code ? ` ${code}` : ""}${message ? `: ${message}` : ""}`;
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
    if (!response.ok) throw new StepError(`${step}: ${await describe(response)}`);
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
export async function proveInferOpsBinding(intake: ConsumerIntake, binding: InferOpsBinding, fetchSeam: FetchSeam = fetch): Promise<void> {
  const call = caller(binding, fetchSeam);
  try {
    await call("operations binding", binding.operationsWorkspaceId, "POST", "/project/intake", { ...intake, dryRun: true });
    await call("knowledge binding", binding.knowledgeWorkspaceId, "GET", "/knowledge/wiki/structure");
  } catch (error) {
    throw new Error(`InferOps binding refused before any write. ${(error as Error).message}`, { cause: error });
  }
}

/**
 * Apply `intake` to InferOps through a binding already proven by {@link proveInferOpsBinding}. Every
 * failure is returned as a step status, never thrown, so a partial result is reported truthfully.
 */
export async function applyIntakeToInferOps(
  intake: ConsumerIntake, binding: InferOpsBinding, fetchSeam: FetchSeam = fetch, options: { pillarsAppliedBefore?: boolean } = {},
): Promise<InferOpsApplyResult> {
  const call = caller(binding, fetchSeam);

  const { members, unlinked } = pillarMembers(intake);
  const result: InferOpsApplyResult = {
    intakeSha256: null, intake: "not-run", alreadyApplied: false, intakeChanges: [], pillars: "not-run", pillarChanges: [],
    readback: "not-run", rootDocumentId: null, masters: [], leftoverPillars: [], sharedPages: [], unlinkedSops: unlinked, error: null,
  };
  // Scoped to tenant, workspace and operation, so one key never replays across scopes or steps.
  const idempotencyKey = (operation: string, workspace: string, hash: string) =>
    `inferos-intake:${intake.inferops.tenant}:${workspace}:${operation}:${hash}`;

  try {
    const applied = await call("intake.apply", binding.operationsWorkspaceId, "POST", "/project/intake", intake);
    if (typeof applied.intakeSha256 !== "string") throw new StepError("intake.apply: response has no intakeSha256");
    result.intakeSha256 = applied.intakeSha256;
    result.alreadyApplied = applied.alreadyApplied === true;
    result.intakeChanges = changeList(applied.changes);
    result.intake = "applied";
  } catch (error) {
    result.intake = "failed";
    result.error = (error as Error).message;
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
