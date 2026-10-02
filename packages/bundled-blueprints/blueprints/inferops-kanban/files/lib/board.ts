// Pure board rules shared by the client and the Durable Object.

import type { Board, Issue, MoveFailureCode, Priority, State } from "./protocol.ts";

const FAILURE_CODES: readonly MoveFailureCode[] = [
  "STALE_REVISION", "WORKFLOW_MISMATCH", "INVALID_STATE", "NOT_FOUND",
];

/**
 * The code a gatekeeper error carries. The InferOps gatekeeper leads its messages with the code
 * (`STALE_REVISION: ...`), the only part of an error that survives RPC reliably.
 */
export function failureCode(error: unknown): MoveFailureCode {
  const message = error instanceof Error ? error.message : String(error);
  return FAILURE_CODES.find(code => message.includes(code)) ?? "ERROR";
}

/** The message of a caught value, without the code prefix the gatekeeper adds. */
export function failureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^(?:\w*Error: )?[A-Z_]+: /, "");
}

/** States an issue may move to: same workflow, not its current state, in board order. */
export function moveTargets(board: Board, issue: Issue): State[] {
  return board.columns
    .map(column => column.state)
    .filter(state => state.workflow === issue.workflow && state.id !== issue.stateId);
}

/** Find an issue on the board, with the state it is in. */
export function findIssue(board: Board, issueId: string): { issue: Issue; state: State } | null {
  for (const column of board.columns) {
    const issue = column.issues.find(i => i.id === issueId);
    if (issue) return { issue, state: column.state };
  }
  return null;
}

/** Move an issue between columns locally, so the board shows the move while it is submitted. */
export function withIssueMoved(board: Board, issueId: string, toStateId: string): Board {
  const found = findIssue(board, issueId);
  if (!found) return board;
  return {
    project: board.project,
    columns: board.columns.map(column => ({
      state: column.state,
      issues: column.state.id === toStateId
        ? [...column.issues.filter(i => i.id !== issueId), { ...found.issue, stateId: toStateId }]
        : column.issues.filter(i => i.id !== issueId),
    })),
  };
}

export const PRIORITY_LABELS: Record<Priority, string> = {
  urgent: "Urgent", high: "High", medium: "Medium", low: "Low", none: "No priority",
};

/** Sort cards: most urgent first, then by identifier number. */
export function sortIssues(issues: readonly Issue[]): Issue[] {
  const rank: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
  const number = (issue: Issue) => Number(/-(\d+)$/.exec(issue.identifier)?.[1] ?? 0);
  return issues.toSorted((a, b) => rank[a.priority] - rank[b.priority] || number(a) - number(b));
}
