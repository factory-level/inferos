// The actions a project binding records between proposal and decision: a transition, an issue
// create, or an issue update. Each is stored in the facet's KV under `action:<n>` (inferops.ts)
// and carries the exact request it will send when applied, plus a fingerprint of that request.
//
// - Records written before creates and updates existed have no `kind`; `readAction` reads them as
//   transitions, and they carry no fingerprint, so none is checked for them.
// - The fingerprint is a SHA-256 over the binding's project key and the normalized request. Apply
//   recomputes it from the request it is about to send and refuses a mismatch. InferOps does not
//   fingerprint idempotency keys (a reused key with another body returns the first result), so
//   this is the check that one action's key is only ever sent with the one request approved for it.

import type { NewIssueRequest, IssueChanges } from "./inferops-client";
import type { Revision } from "./types";

/** Where a recorded action stands. */
export type ActionStatus = "pending" | "applied" | "reverted";

type ActionBase = {
  actionId: number;
  status: ActionStatus;
  /** Fingerprint of the request staged with the action; absent on records from before creates. */
  fingerprint?: string;
};

/** A proposed move of an issue to another state. */
export type TransitionAction = ActionBase & {
  kind: "transition";
  issueId: string;
  identifier: string;
  fromStateId: string;
  toStateId: string;
  toStateName: string;
  expectedRevision: Revision;
};

/** A proposed new issue, with the state it lands in already resolved. */
export type CreateAction = ActionBase & {
  kind: "create";
  issue: NewIssueRequest;
  /** Name of the state it lands in, for messages. */
  stateName: string;
  /** The created issue's identifier, once applied. */
  createdIdentifier?: string;
};

/** A proposed change of an issue's fields, and their values before it, for revert. */
export type UpdateAction = ActionBase & {
  kind: "update";
  issueId: string;
  identifier: string;
  expectedRevision: Revision;
  changes: IssueChanges;
  /** The changed title and priority as they were when the change was proposed. */
  previous: Pick<IssueChanges, "title" | "priority">;
  /** The revision InferOps reported for the applied change; a revert requires it unchanged. */
  appliedRevision?: Revision;
};

/** Any recorded action. */
export type ActionRecord = TransitionAction | CreateAction | UpdateAction;

/** A pending change to an existing issue: what simulation overlays and what blocks another. */
export type PendingIssueChange = TransitionAction | UpdateAction;

/** What the caller supplies to stage an action; the binding assigns the id and status. */
export type StagedAction =
  | Omit<TransitionAction, "actionId" | "status">
  | Omit<CreateAction, "actionId" | "status">
  | Omit<UpdateAction, "actionId" | "status">;

/** A stored record, with legacy records (no `kind`) read as the transitions they are. */
export function readAction(raw: unknown): ActionRecord | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Partial<ActionRecord>;
  return record.kind ? record as ActionRecord : { ...record, kind: "transition" } as TransitionAction;
}

/** Whether an action changes an existing issue (rather than creating one). */
export function isIssueChange(record: ActionRecord): record is PendingIssueChange {
  return record.kind === "transition" || record.kind === "update";
}

/** The request an action sends when applied, normalized for fingerprinting. */
export function requestOf(record: StagedAction | ActionRecord): unknown {
  switch (record.kind) {
    case "transition":
      return { kind: record.kind, issueId: record.issueId, toStateId: record.toStateId,
               expectedRevision: record.expectedRevision };
    case "create":
      return { kind: record.kind, issue: record.issue };
    case "update":
      return { kind: record.kind, issueId: record.issueId, changes: record.changes,
               expectedRevision: record.expectedRevision };
  }
}

/** JSON with object keys sorted and undefined members dropped, so equal requests hash equally. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonical(member)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The fingerprint of an action's request within the bound project. */
export async function fingerprintOf(projectKey: string, record: StagedAction | ActionRecord):
    Promise<string> {
  const bytes = new TextEncoder().encode(canonical({ projectKey, request: requestOf(record) }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Whether the request `record` would send now is the one staged with it. A legacy record has no
 * fingerprint and passes.
 */
export async function matchesFingerprint(projectKey: string, record: ActionRecord):
    Promise<boolean> {
  if (record.fingerprint === undefined) return true;
  return record.fingerprint === await fingerprintOf(projectKey, record);
}
