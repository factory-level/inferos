// A person's delegates (FAC-134, capability 3; ADR 0020), in their own operate session workspace.
// A delegate is launched only by the kernel, for the person's own approval of an action that
// declared it, once per action. Its record keeps the ceiling fixed at that approval (the connections
// and tools it may use, which nothing widens later) and the session's authorization generation then,
// which every call it makes compares: a change ends it. It records only its state and outcome, never
// what its chat said or returned. Nothing here is shared or reachable from another workspace.

import type { DelegateDeclaration } from "@gadgets/workshop-shared/delegate";
import type { WorkpieceId } from "@gadgets/workshop-shared/api";
import type { OverseerStorage } from "./overseer";

/** Why a delegate ended `failed`: the fixed reasons its outcome reports, never its words. */
export type DelegateFailure = "runtime-error" | "cancelled" | "requester-revoked";

/** A delegate as stored. */
export type StoredDelegate = {
  delegateId: string;
  /** The run its outcome is reported as (`ApprovedRunOutcome.runId`). */
  runId: string;
  /** The approved action that launched it, whose gatekeeper is told its outcome. */
  actionId: number;
  /** The InferOps profile of the person who approved it: the session's owner then. */
  starterProfileId: string;
  /** Its agent chat, in this session. */
  chatId: number;
  title: string;
  /** Its ceiling, fixed at approval: the connections (binding name to connection) and tools. */
  ceiling: { connections: Record<string, WorkpieceId>; tools: string[] };
  /** The connection types it declared, as shown to the approver. */
  declared: DelegateDeclaration["connections"];
  /** This session's authorization generation at approval: any other ends it. */
  authzGeneration: number;
  state: "running" | "succeeded" | "failed";
  reason?: DelegateFailure;
  reportOutcome: boolean;
  /** When its outcome is next due to be reported, while it is owed; how many tries so far. */
  reportDue?: number;
  reportTries: number;
  launchedAt: Date;
  endedAt?: Date;
};

/** Ended delegates kept, newest first; older ones are removed when another ends. */
export const DELEGATES_KEPT = 100;

/** The delegates of one operate session workspace; its caller checks whose session it is. */
export class DelegateStore {
  constructor(private storage: Pick<OverseerStorage, "delegates">, private onChange?: () => void) {}

  /** The delegate `delegateId`, or undefined. */
  get(delegateId: string): StoredDelegate | undefined {
    return this.storage.delegates.get(delegateId);
  }

  /** The delegate whose chat is `chatId`, or undefined: how a call from a chat is told it is one. */
  forChat(chatId: number): StoredDelegate | undefined {
    return Array.from(this.storage.delegates.list()).find(delegate => delegate.chatId === chatId);
  }

  /** The delegate action `actionId` launched, or undefined: at most one per action. */
  forAction(actionId: number): StoredDelegate | undefined {
    return Array.from(this.storage.delegates.list()).find(delegate => delegate.actionId === actionId);
  }

  /** Every delegate `starterProfileId` launched here, newest first. */
  listFor(starterProfileId: string): StoredDelegate[] {
    return Array.from(this.storage.delegates.list())
        .filter(delegate => delegate.starterProfileId === starterProfileId)
        .toSorted((a, b) => b.launchedAt.getTime() - a.launchedAt.getTime());
  }

  /** Every delegate still running or owed a report. */
  active(): StoredDelegate[] {
    return Array.from(this.storage.delegates.list())
        .filter(delegate => delegate.state === "running" || delegate.reportDue !== undefined);
  }

  /** Records a newly launched delegate. */
  launch(delegate: StoredDelegate): void {
    this.storage.delegates.put(delegate);
    this.onChange?.();
  }

  /**
   * Ends running delegate `delegateId` with `outcome` (and its fixed reason when `failed`), owing its
   * report when one was asked for. A delegate already ended is left as it is: an outcome is set once.
   */
  end(delegateId: string, outcome: "succeeded" | "failed", reason?: DelegateFailure, now = Date.now())
      : StoredDelegate | undefined {
    let delegate = this.storage.delegates.get(delegateId);
    if (!delegate || delegate.state !== "running") return delegate;
    let ended: StoredDelegate = {...delegate, state: outcome, endedAt: new Date(now),
      ...(outcome === "failed" && reason ? {reason} : {}),
      ...(delegate.reportOutcome ? {reportDue: now} : {})};
    this.storage.delegates.put(ended);
    this.#prune();
    this.onChange?.();
    return ended;
  }

  /** Stores `delegate` as it now is (a report's bookkeeping). */
  put(delegate: StoredDelegate): void {
    this.storage.delegates.put(delegate);
    this.onChange?.();
  }

  #prune(): void {
    let ended = Array.from(this.storage.delegates.list())
        .filter(delegate => delegate.state !== "running" && delegate.reportDue === undefined)
        .toSorted((a, b) => (b.endedAt?.getTime() ?? 0) - (a.endedAt?.getTime() ?? 0));
    for (let delegate of ended.slice(DELEGATES_KEPT)) this.storage.delegates.delete(delegate.delegateId);
  }
}
