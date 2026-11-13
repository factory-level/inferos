import { wikiDisagreement, type WikiPageText } from "./stage-smoke-wiki.ts";

/** Required evidence for the owner/operate contract; historical operator/viewer results cannot pass. */
export const STAGE_SMOKE_ORACLES = [
  "owner.signIn", "owner.wikiReads", "owner.boardRenders", "owner.simulated", "owner.applied", "owner.restored",
  "operate.signIn", "operate.wikiReads", "operate.knowledgeWriteRefused",
] as const;

/** The stage writes Wiki bodies; pin their current policy so `unknown` is never accepted by guesswork. */
export const WIKI_BODY_APPLY_KIND = "RECONCILE_ONLY" as const;

/** Fail closed on incomplete, duplicate or failed oracle evidence, even when its summary says ok. */
export function smokeOraclesPass(oracles: readonly { name: string; ok: boolean }[]): boolean {
  return oracles.every(oracle => oracle.ok === true)
    && STAGE_SMOKE_ORACLES.every(name => oracles.filter(oracle => oracle.name === name).length === 1);
}

/** Authoritative page identity and version, alongside the content checked by the read oracle. */
export interface WikiSnapshot extends WikiPageText { id: string; version: number }

/** The structured apply result recorded in Workshop action history. */
export interface KnowledgeWriteOutcome {
  state?: string;
  historyKind?: string;
  /** Semantic policy of the attempted operation, not the generic action-history type. */
  applyKind?: string;
  lastAttempt?: { code?: string; outcome?: string };
}

/** Run an operation and restore the observed state even when later evidence collection throws. */
export async function withStateRestoration<T>(readState: () => Promise<string>, originalState: string, restore: () => Promise<void>, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } finally {
    if (await readState() !== originalState) await restore();
  }
}

/** Fail closed: an unavailable, missing, stale or unauthenticated write is not an authorization proof. */
export function knowledgeWriteRefused(outcome: KnowledgeWriteOutcome): boolean {
  return (outcome.state === "pending" || outcome.state === "failed")
    && outcome.lastAttempt?.code === "FORBIDDEN"
    && (outcome.lastAttempt.outcome === "notApplied"
      || (outcome.lastAttempt.outcome === "unknown" && outcome.applyKind === "RECONCILE_ONLY"));
}

/** A proposal may be rejected before queuing, but only an explicit FORBIDDEN proves authorization. */
export function forbiddenProposal(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; message?: unknown };
  return value.code === "FORBIDDEN"
    || (value.code === undefined && typeof value.message === "string" && /^FORBIDDEN(?::|\s|$)/.test(value.message));
}

/** Compare the owner's authoritative reads; a version-only change must fail too. */
export function sameWikiSnapshot(before: WikiSnapshot, after: WikiSnapshot | null): boolean {
  return after !== null && before.id === after.id && before.version === after.version
    && wikiDisagreement(before, after) === null;
}

/** Exercise the negative write and clean up its pending request, with an independent owner read. */
export async function checkKnowledgeWrite(before: WikiSnapshot, steps: {
  read(): Promise<WikiSnapshot | null>;
  propose(): Promise<void>;
  pending(): Promise<number | undefined>;
  approve(id: number): Promise<KnowledgeWriteOutcome>;
  reject(id: number): Promise<void>;
}): Promise<{ ok: boolean; detail: string }> {
  if (!before.id || !Number.isSafeInteger(before.version) || before.version < 1) {
    return { ok: false, detail: "no authoritative document identity/version; write not attempted" };
  }
  let refused = false;
  let reason = "no FORBIDDEN authorization result";
  let ownerReadUnchanged = false;
  try {
    try {
      await steps.propose();
    } catch (error) {
      if (!forbiddenProposal(error)) throw error;
      refused = true;
      reason = "knowledge write proposal refused FORBIDDEN";
    }
    if (!refused) {
      const pendingId = await steps.pending();
      if (pendingId !== undefined) {
        if (!sameWikiSnapshot(before, await steps.read())) {
          reason = "knowledge document changed or missing before approval";
        } else {
          const outcome = await steps.approve(pendingId);
          refused = knowledgeWriteRefused(outcome);
          reason = refused
            ? `knowledge write apply refused status=${outcome.state ?? "missing"} kind=${outcome.historyKind ?? "missing"} code=FORBIDDEN outcome=${outcome.lastAttempt?.outcome}${outcome.lastAttempt?.outcome === "unknown" ? ` applyKind=${outcome.applyKind} acceptanceBranch=RECONCILE_ONLY_unknown_with_unchanged_owner_snapshot` : " acceptanceBranch=FORBIDDEN_notApplied"}`
            : `knowledge write not refused status=${outcome.state ?? "missing"} kind=${outcome.historyKind ?? "missing"} code=${outcome.lastAttempt?.code ?? "missing"} outcome=${outcome.lastAttempt?.outcome ?? "missing"} applyKind=${outcome.applyKind ?? "missing"}`;
        }
      }
    }
    ownerReadUnchanged = sameWikiSnapshot(before, await steps.read());
    if (!ownerReadUnchanged) reason = `${reason}; owner's document read CHANGED or missing`;
  } catch (error) {
    // Network, HTTP, auth, stale-revision and missing-page failures are not authorization proof.
    // Keep the failure in the oracle result so the smoke records FAIL rather than aborting silently.
    reason = `${reason}; check failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
  } finally {
    try {
      const pending = await steps.pending();
      if (pending !== undefined) {
        await steps.reject(pending);
      }
    } catch (error) {
      refused = false;
      reason = `${reason}; pending-action cleanup failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
    }
  }
  return { ok: refused && ownerReadUnchanged, detail: `${reason}; owner's document read ${ownerReadUnchanged ? "unchanged (content and version)" : "CHANGED or missing"}` };
}

/** Only the two reserved seats specified by InferOps #2460 can exercise these smoke roles. */
export function smokePersonaProblem(env: NodeJS.ProcessEnv): string | null {
  if (env.GROKBOT_VIEWER_USER !== undefined) return "GROKBOT_VIEWER_USER is obsolete; use GROKBOT_OPERATE_USER=grokbot-operate";
  if (env.GROKBOT_PERSONA_USER !== "grokbot-owner") return "GROKBOT_PERSONA_USER must select grokbot-owner";
  if (env.GROKBOT_OPERATE_USER !== "grokbot-operate") return "GROKBOT_OPERATE_USER must select grokbot-operate";
  return null;
}
