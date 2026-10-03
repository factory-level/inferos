// Read-time simulation of actions that were submitted but not yet applied. Pending actions are
// stored apart from the data source and overlaid on every read, so the caller sees each change
// until it is applied or rejected. Rejecting an action deletes its record, which is all it takes
// to undo the simulation.
//
// - A pending transition shows the issue in its target state; a pending update shows its new
//   title and priority (the description is not part of `Issue`). Both keep the revision the data
//   source reported: an InferOps revision is a position in a ledger shared by all issues, so the
//   revision a change will produce cannot be computed. An issue therefore carries at most one live
//   pending change (`livePendingChange`), and a second is refused.
// - A pending create shows as a provisional card at the end of its target column, marked
//   `pending: "create"`, with id `pending-<actionId>`, identifier `<KEY>-new` and revision "0".

import type { ProjectSnapshot } from "./inferops-client";
import type { CreateAction, PendingIssueChange } from "./actions";
import type { Board, Issue, State, StateGroup } from "./types";

/** The pending actions a read overlays. */
export type Pending = { changes: readonly PendingIssueChange[]; creates: readonly CreateAction[] };

/** No pending actions. */
export const NOTHING_PENDING: Pending = { changes: [], creates: [] };

const GROUP_ORDER: readonly StateGroup[] = ["backlog", "unstarted", "started", "completed", "cancelled"];

/** States in board order: group, then position, then name. */
export function orderStates(states: readonly State[]): State[] {
  return states.toSorted((a, b) =>
    GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) ||
    a.position - b.position || a.name.localeCompare(b.name));
}

/**
 * The pending change that would still apply to `issue`, oldest first, if there is one. A change
 * whose expected revision no longer matches is not live: it will fail when applied.
 */
export function livePendingChange(
  issue: Issue, changes: readonly PendingIssueChange[],
): PendingIssueChange | undefined {
  return changes.toSorted((a, b) => a.actionId - b.actionId)
    .find(change => change.issueId === issue.id && change.expectedRevision === issue.revision);
}

/**
 * Overlay the issue's live pending change at its unchanged revision. A stale change is skipped:
 * showing its effect would mislead.
 */
export function simulateIssue(issue: Issue, changes: readonly PendingIssueChange[]): Issue {
  const change = livePendingChange(issue, changes);
  if (!change) return issue;
  if (change.kind === "transition") {
    return { ...issue, stateId: change.toStateId, pending: "transition" };
  }
  const { title, priority } = change.changes;
  return {
    ...issue,
    ...(title === undefined ? {} : { title }),
    ...(priority === undefined ? {} : { priority }),
    pending: "update",
  };
}

/** The provisional card of a pending create. */
function provisionalIssue(projectKey: string, create: CreateAction, state: State): Issue {
  return {
    id: `pending-${create.actionId}`,
    identifier: `${projectKey}-new`,
    title: create.issue.title,
    priority: create.issue.priority ?? "none",
    stateId: state.id,
    targetDate: null,
    workflow: state.workflow,
    revision: "0",
    assigneeId: null,
    blockedReason: null,
    pending: "create",
  };
}

/** The board for a project snapshot: states in board order, each with its (simulated) issues. */
export function buildBoard(snapshot: ProjectSnapshot, pending: Pending): Board {
  const columns = orderStates(snapshot.states).map(state => ({ state, issues: [] as Issue[] }));
  const byState = new Map(columns.map(column => [column.state.id, column]));
  for (const issue of snapshot.issues) {
    const simulated = simulateIssue(issue, pending.changes);
    byState.get(simulated.stateId)?.issues.push(simulated);
  }
  // A create whose state has since left the project is not shown: it will fail when applied.
  for (const create of pending.creates.toSorted((a, b) => a.actionId - b.actionId)) {
    const column = byState.get(create.issue.stateId);
    column?.issues.push(provisionalIssue(snapshot.project.identifier, create, column.state));
  }
  return { project: snapshot.project, columns };
}
