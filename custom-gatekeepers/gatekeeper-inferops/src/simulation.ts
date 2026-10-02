// Read-time simulation of transitions that were submitted but not yet applied. Pending moves are
// stored apart from the data source and overlaid on every read, so the caller sees each issue in its
// target state until the move is applied or rejected. Rejecting a move deletes its record, which is
// all it takes to undo the simulation.
//
// The revision is left as the data source reported it. An InferOps revision is a position in a
// ledger shared by all issues, so the revision a move will produce cannot be computed; an issue
// therefore carries at most one live pending move (`livePendingMove`), and a second is refused.

import type { ProjectSnapshot } from "./inferops-client";
import type { Board, Issue, StateGroup } from "./types";

/** A submitted transition awaiting its approval decision. */
export type PendingTransition = {
  actionId: number;
  issueId: string;
  identifier: string;
  fromStateId: string;
  toStateId: string;
  expectedRevision: string;
};

const GROUP_ORDER: readonly StateGroup[] = ["backlog", "unstarted", "started", "completed", "cancelled"];

/**
 * The pending move that would still apply to `issue`, oldest first, if there is one. A move whose
 * expected revision no longer matches is not live: it will fail when applied.
 */
export function livePendingMove(
  issue: Issue, pending: readonly PendingTransition[],
): PendingTransition | undefined {
  return pending.toSorted((a, b) => a.actionId - b.actionId)
    .find(move => move.issueId === issue.id && move.expectedRevision === issue.revision);
}

/**
 * Overlay the issue's live pending move, showing it in the target state at its unchanged revision.
 * A stale move is skipped: showing its effect would mislead.
 */
export function simulateIssue(issue: Issue, pending: readonly PendingTransition[]): Issue {
  const move = livePendingMove(issue, pending);
  return move ? { ...issue, stateId: move.toStateId } : issue;
}

/** The board for a project snapshot: states in group then position order, each with its issues. */
export function buildBoard(snapshot: ProjectSnapshot, pending: readonly PendingTransition[]): Board {
  const states = snapshot.states.toSorted((a, b) =>
    GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) ||
    a.position - b.position || a.name.localeCompare(b.name));
  const columns = states.map(state => ({ state, issues: [] as Issue[] }));
  const byState = new Map(columns.map(column => [column.state.id, column]));
  for (const issue of snapshot.issues) {
    const simulated = simulateIssue(issue, pending);
    byState.get(simulated.stateId)?.issues.push(simulated);
  }
  return { project: snapshot.project, columns };
}
