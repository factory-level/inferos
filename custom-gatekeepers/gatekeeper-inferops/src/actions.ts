// The actions a binding records between proposal and decision: on a board binding a transition, an
// issue create or an issue update; on a coding-dispatch binding a dispatch or a run cancel; on a
// Wiki binding a section update. Each is
// stored in the facet's KV under `action:<n>` (inferops.ts)
// and carries the exact request it will send when applied, plus a fingerprint of that request.
//
// - Records written before creates and updates existed have no `kind`; `readAction` reads them as
//   transitions, and they carry no fingerprint, so none is checked for them.
// - The fingerprint is a SHA-256 over the binding's scope (its project key, or `knowledge/wiki`)
//   and the normalized request. Apply
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

/** A proposed hand-off of a software issue to the coding runner. */
export type DispatchAction = ActionBase & {
  kind: "dispatch";
  issueId: string;
  identifier: string;
  repoId: string;
  /** The repository's slug, for messages. */
  repoSlug: string;
  baseRef?: string;
  expectedRevision: Revision;
  /** When it was proposed (ISO), for the provisional run shown until it is decided. */
  proposedAt: string;
  /** The queued run's id, once applied. */
  runId?: string;
};

/** A proposed stop of a queued or running run. */
export type CancelRunAction = ActionBase & {
  kind: "cancel";
  runId: string;
  /** The run's issue key, for messages. */
  identifier: string;
};

/** A proposed replacement of a Wiki section's body, and the body before it, for revert. */
export type SectionUpdateAction = ActionBase & {
  kind: "section-update";
  sectionId: string;
  /** The section's page and tag, for messages. */
  documentTitle: string;
  tag: string;
  body: string;
  /** The section version the edit was proposed at; apply sends nothing if it has changed. */
  expectedVersion: number;
  /** The body the edit replaces. */
  previousBody: string;
  /** The version InferOps reported for the applied edit; a revert requires it unchanged. */
  appliedVersion?: number;
};

/** Any recorded action. */
export type ActionRecord =
  | TransitionAction | CreateAction | UpdateAction | DispatchAction | CancelRunAction
  | SectionUpdateAction;

/** An action a board binding records. */
export type BoardAction = TransitionAction | CreateAction | UpdateAction;

/** An action a coding-dispatch binding records. */
export type CodingAction = DispatchAction | CancelRunAction;

/** A pending change to an existing issue: what simulation overlays and what blocks another. */
export type PendingIssueChange = TransitionAction | UpdateAction;

/** What the caller supplies to stage an action; the binding assigns the id and status. */
export type StagedAction =
  | Omit<TransitionAction, "actionId" | "status">
  | Omit<CreateAction, "actionId" | "status">
  | Omit<UpdateAction, "actionId" | "status">
  | Omit<DispatchAction, "actionId" | "status">
  | Omit<CancelRunAction, "actionId" | "status">
  | Omit<SectionUpdateAction, "actionId" | "status">;

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
    case "dispatch":
      return { kind: record.kind, issueId: record.issueId, action: "code", repoId: record.repoId,
               baseRef: record.baseRef, expectedRevision: record.expectedRevision };
    case "cancel":
      return { kind: record.kind, runId: record.runId };
    case "section-update":
      return { kind: record.kind, sectionId: record.sectionId, body: record.body,
               expectedVersion: record.expectedVersion };
  }
}

/** Whether an action belongs to a coding-dispatch binding. */
export function isCodingAction(record: ActionRecord): record is CodingAction {
  return record.kind === "dispatch" || record.kind === "cancel";
}

/** Whether an action belongs to a Wiki binding. */
export function isWikiAction(record: ActionRecord): record is SectionUpdateAction {
  return record.kind === "section-update";
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

/**
 * The fingerprint of an action's request within the binding's scope: the bound project's key, or
 * `knowledge/wiki` for a Wiki binding (whose facet is one workspace's).
 */
export async function fingerprintOf(scope: string, record: StagedAction | ActionRecord):
    Promise<string> {
  const bytes = new TextEncoder().encode(canonical({ projectKey: scope, request: requestOf(record) }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Whether the request `record` would send now is the one staged with it. A legacy record has no
 * fingerprint and passes.
 */
export async function matchesFingerprint(scope: string, record: ActionRecord):
    Promise<boolean> {
  if (record.fingerprint === undefined) return true;
  return record.fingerprint === await fingerprintOf(scope, record);
}
