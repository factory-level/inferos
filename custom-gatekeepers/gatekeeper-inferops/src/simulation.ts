// Read-time simulation of transitions that were submitted but not yet applied. Pending moves are
// stored apart from the data source and overlaid on every read, so the caller sees each issue in its
// target state (with the revision the move will produce) until the move is applied or rejected.
// Rejecting a move deletes its record, which is all it takes to undo the simulation.

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

/** The revision a successful transition from `revision` produces. */
export function nextRevision(revision: string): string {
  return (BigInt(revision) + 1n).toString();
}

/**
 * Overlay pending transitions on one issue, oldest first. A move whose expected revision no longer
 * matches is skipped: it will fail when applied, so showing its effect would mislead.
 */
export function simulateIssue(issue: Issue, pending: readonly PendingTransition[]): Issue {
  let simulated = issue;
  for (const move of pending.toSorted((a, b) => a.actionId - b.actionId)) {
    if (move.issueId !== simulated.id || move.expectedRevision !== simulated.revision) continue;
    simulated = { ...simulated, stateId: move.toStateId, revision: nextRevision(move.expectedRevision) };
  }
  return simulated;
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
