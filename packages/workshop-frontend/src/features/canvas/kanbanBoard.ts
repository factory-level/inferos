// Pure Kanban rules over the gatekeeper's board DTO, shared by every presentation of a board.
import type { Board, Issue, State } from '@inferos/gatekeeper-inferops/src/types'
import type { PendingMove } from './boardData'

export const PRIORITY_LABELS: Record<Issue['priority'], string> = {
  urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low', none: 'No priority',
}

const PRIORITY_RANK: Record<Issue['priority'], number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 }
const identifierNumber = (issue: Issue) => Number(/-(\d+)$/.exec(issue.identifier)?.[1] ?? 0)

/** Cards in a column: most urgent first, then by identifier number. */
export const sortIssues = (issues: readonly Issue[]): Issue[] =>
  issues.toSorted((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || identifierNumber(a) - identifierNumber(b))

/**
 * States an issue may move to: the whole board's states of its workflow, except the one it is
 * in, in board order. A card may offer a state its own params hide (completed, say); the move
 * is still valid and the issue simply leaves this card's columns.
 */
export const moveTargets = (board: Board, issue: Issue): State[] =>
  board.columns.map(column => column.state).filter(state => state.workflow === issue.workflow && state.id !== issue.stateId)

export const stateOf = (board: Board, stateId: string): State | undefined =>
  board.columns.find(column => column.state.id === stateId)?.state

/** The issue's undecided move, if it has one. The adapter refuses a second, so there is at most one. */
export const pendingMoveOf = (issue: Issue, pending: readonly PendingMove[]): PendingMove | undefined =>
  pending.find(move => move.issueId === issue.id)

/** How the authoritative board decided a move that was awaiting approval. */
export type MoveDecision = {
  issueId: string
  toStateId: string
  outcome: 'applied' | 'rejected'
  /** The issue's revision when the decision was seen; a newer one supersedes the decision. */
  revision: string
}

/**
 * The awaiting moves that `previous` listed and `current` no longer does, read against the
 * board that decided them: an issue back in a state other than the target at the revision the
 * move was proposed against was rejected, anything else (a new revision, or the issue gone from
 * the board) was applied. A move dropped while still `proposing` failed on submission, which its
 * caller reports, so it is not a decision.
 */
export const decidedMoves = (previous: readonly PendingMove[], current: readonly PendingMove[], board: Board): MoveDecision[] => {
  const issues = new Map(board.columns.flatMap(column => column.issues.map(issue => [issue.id, issue] as const)))
  const still = (move: PendingMove) => current.some(other => other.issueId === move.issueId && other.toStateId === move.toStateId && other.expectedRevision === move.expectedRevision)
  return previous.filter(move => move.phase === 'awaiting' && !still(move)).map(move => {
    const issue = issues.get(move.issueId)
    const rejected = issue !== undefined && issue.revision === move.expectedRevision && issue.stateId !== move.toStateId
    return { issueId: move.issueId, toStateId: move.toStateId, outcome: rejected ? 'rejected' : 'applied', revision: issue?.revision ?? move.expectedRevision }
  })
}

/** A date as the board shows it, in UTC so the planned day does not shift with the viewer's zone. */
export const formatTargetDate = (date: string): string => {
  const parsed = new Date(`${date}T00:00:00Z`)
  return Number.isNaN(parsed.valueOf()) ? date : parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

export const isOverdue = (issue: Issue, state: State, today: string): boolean =>
  issue.targetDate !== null && state.group !== 'completed' && state.group !== 'cancelled' && issue.targetDate < today
