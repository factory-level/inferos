// Auto-approval drain core: applies the gatekeeper's eligible pending actions (read off the sparse
// pendingByGatekeeper index) in id order, with a per-gatekeeper single-flight guard so two
// concurrent drains (the DO's input gate is open across the apply await) can't double-apply the
// same action. The apply and the workspace's role lookup are injected, keeping this constructible
// over a mock storage in tests.

import type { Collection, NonUniqueIndex, Singleton } from "@gadgets/typed-storage";
import type { AiChatAuthorInfo, CollaboratorRole } from "@gadgets/workshop-shared/api";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import { createWorkshopLogger } from "./observability";
import type { ActionRecord, AutoApproveTagRecord } from "./overseer.js";
import { roleRank } from "./sharing.js";

const logger = createWorkshopLogger("workshop.auto.approval");

export interface AutoApprovalStorage {
  actions: Collection<ActionRecord, number>
      & { pendingByGatekeeper: NonUniqueIndex<ActionRecord, number> };
  autoApproveTags: Collection<AutoApproveTagRecord>;

  /** The restricted-data latch (see makeOverseerStorage). While set, nothing auto-approves. */
  containsRestrictedData: Singleton<boolean>;
}

/**
 * A profile's current effective role in the workspace (`SharingManager.getEffectiveRole`), or
 * undefined if it has none. Synchronous, so a check and the decision it gates share one step.
 */
export type EffectiveRoleLookup = (profileId: string) => CollaboratorRole | undefined;

/** The lookup while the workspace's roles cannot be resolved: nobody has a role, so nothing fires. */
export const NO_ROLES: EffectiveRoleLookup = () => undefined;

/**
 * Whether the rule's enabler currently has Build access, which the rule runs under. Only a user
 * holds a role: a rule attributed to an agent or a gadget fails closed, even though a gadget
 * author's id names the workspace owner (for accounting).
 */
export function enablerHasBuild(rule: AutoApproveTagRecord, roleOf: EffectiveRoleLookup): boolean {
  if (rule.enabledBy.type !== "user") return false;
  let role = roleOf(rule.enabledBy.id);
  return role !== undefined && roleRank(role) >= roleRank("build");
}

/**
 * Whether no auto-approval rule may approve `record` (FAC-102, FAC-112, FAC-14): a write an assigned
 * run proposed, one a requested run proposed on a later attempt, after a restart ran it again, a
 * replay's copy of a write shown to a person to reject, or a command the operate agent requested
 * for a person, which a person always decides.
 */
export function manualOnly(record: {
  caller: { from: string }; workflowRun?: { attempt: number }; replayDuplicateOf?: number;
}): boolean {
  return record.caller.from === "systemRun" || record.caller.from === "operateAgent" ||
      record.replayDuplicateOf !== undefined ||
      (record.workflowRun !== undefined && record.workflowRun.attempt > 1);
}

/**
 * The single authority on whether an action may be applied without a human: the enabling rule if
 * the author marked the action `autoApprovable`, it declares no workflow run (FAC-120), no
 * temporary canvas (FAC-137) and no personal workflow to create or run (FAC-134), a user
 * enabled a rule for its `actionKind` on this gatekeeper and still has Build access, and the
 * workspace has not latched restricted mode; else undefined.
 */
export function autoApprovalRule(
    storage: AutoApprovalStorage, roleOf: EffectiveRoleLookup, gatekeeperId: number,
    description: ActionDescription)
    : AutoApproveTagRecord | undefined {
  if (description.autoApprovable !== true) return undefined;
  // A declared workflow run (FAC-120) starts only on a person's own approval: no rule approves it.
  if (description.workflowRun !== undefined) return undefined;
  // Nor a declared temporary canvas (FAC-137): it is created only on the person's own approval.
  if (description.temporaryCanvas !== undefined) return undefined;
  // Nor a personal workflow to create or run (FAC-134 capability 2).
  if (description.personalWorkflow !== undefined || description.personalWorkflowRun !== undefined) return undefined;
  // Nor a delegate (FAC-134 capability 3, ADR 0020): only the person's own approval launches one.
  if (description.delegate !== undefined) return undefined;
  let tag = description.actionKind?.tag;
  if (tag === undefined) return undefined;
  if (storage.containsRestrictedData.get()) return undefined;
  let rule = storage.autoApproveTags.get(`${gatekeeperId}:${tag}`);
  return rule !== undefined && enablerHasBuild(rule, roleOf) ? rule : undefined;
}

/**
 * Applies a single eligible pending action: invoke the gatekeeper, mark it approved, persist. The
 * caller has already validated that the record is still pending.
 */
export type ApplyPendingActionFn = (
    record: ActionRecord & {type: "action"},
    resolvedBy: AiChatAuthorInfo,
    autoApproved: boolean) => Promise<void>;

export class AutoApprovalDrainer {
  // Per-gatekeeper single-flight state: the running drain, and whether another was requested while
  // it ran, so work submitted during a drain isn't lost. Coalesced callers share the running
  // drain's promise, so it settles only after the rerun they requested.
  #draining = new Map<number, Promise<void>>();
  #rerun = new Set<number>();

  /**
   * `resolveRoles` gives the role lookup for each pass. Resolving it may need an RPC on a cold
   * instance, so a promise is awaited before the pass's synchronous checks; a lookup already in
   * hand is used at once, so a warm pass snapshots and applies exactly as it would without it.
   */
  constructor(
      private storage: AutoApprovalStorage,
      private resolveRoles: () => EffectiveRoleLookup | Promise<EffectiveRoleLookup>,
      private applyPendingAction: ApplyPendingActionFn) {}

  drain(gatekeeperId: number): Promise<void> {
    let running = this.#draining.get(gatekeeperId);
    if (running) {
      this.#rerun.add(gatekeeperId);
      return running;
    }
    running = this.#drainWhileRequested(gatekeeperId);
    this.#draining.set(gatekeeperId, running);
    return running;
  }

  async #drainWhileRequested(gatekeeperId: number): Promise<void> {
    try {
      do {
        this.#rerun.delete(gatekeeperId);
        await this.#drainOnce(gatekeeperId);
      } while (this.#rerun.has(gatekeeperId));
    } finally {
      this.#draining.delete(gatekeeperId);
    }
  }

  // Apply all currently-eligible pending actions of the gatekeeper, in ascending id order. Stops
  // at the first pending action that is NOT auto-eligible (a manual gate) or that throws while
  // applying -- it is never skipped ahead of. This preserves in-order application and the
  // invariant that nothing is silently applied past a human gate.
  //
  // Eligibility is `autoApprovalRule()`: the author's `autoApprovable` verdict, a rule for the
  // action's kind enabled by a user who still has Build access, and no restricted-data latch. The
  // lookup reads roles live, so an enabler who loses access mid-drain stops it at the next action.
  async #drainOnce(gatekeeperId: number): Promise<void> {
    let roleOf: EffectiveRoleLookup;
    try {
      let roles = this.resolveRoles();
      roleOf = roles instanceof Promise ? await roles : roles;
    } catch (err) {
      // Nobody's authority can be established, so nothing applies; the actions stay pending.
      logger.error("auto-approval could not resolve workspace roles", {
        event: "auto.approval.roles.unresolved", gatekeeperId, error: err,
      });
      return;
    }

    // Materialize before applying: the index yields lazily in ascending id order, and applying
    // mutates it mid-iteration. Actions created after this snapshot trigger their own drain(),
    // which drain()'s rerun flag folds into this run if it's still in flight.
    let pending = [...this.storage.actions.pendingByGatekeeper.get(gatekeeperId)];

    for (let record of pending) {
      if (record.type !== "action") continue;

      // A person approves every write an assigned workflow run proposes (FAC-102), and every write
      // a requested run proposes again on a later attempt (FAC-112): a manual gate.
      let rule = manualOnly(record) ? undefined
          : autoApprovalRule(this.storage, roleOf, gatekeeperId, record.description);
      if (rule === undefined) {
        // A manual gate. Stop rather than skipping ahead to any later auto-eligible action.
        return;
      }

      // Re-check immediately before applying, to guard against a concurrent drain having already
      // taken this one.
      let fresh = this.storage.actions.get(record.id);
      if (!fresh || fresh.type !== "action" || fresh.state !== "pending") {
        continue;
      }

      try {
        // Attribute the auto-approval to the user who enabled the rule -- it runs under their
        // authority.
        await this.applyPendingAction(fresh, rule.enabledBy, true);
      } catch (err) {
        // Leave the action pending for manual handling and stop the drain (never skip ahead).
        logger.error("auto-approval failed", {
          event: "auto.approval.failed", actionId: fresh.id, error: err,
        });
        return;
      }
    }
  }
}
