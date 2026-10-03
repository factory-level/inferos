// Pure Kanban rules over the gatekeeper's board DTO, shared by every presentation of a board.
import type { Board, Issue, IssueChanges, State } from '@inferos/gatekeeper-inferops/src/types'
import type { PendingMove, ProposalResult } from './boardData'

export const PRIORITY_LABELS: Record<Issue['priority'], string> = {
  urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low', none: 'No priority',
}

const PRIORITY_RANK: Record<Issue['priority'], number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 }
const identifierNumber = (issue: Issue) => Number(/-(\d+)$/.exec(issue.identifier)?.[1] ?? 0)

const provisional = (issue: Issue) => issue.pending === 'create' ? 1 : 0

/** Cards in a column: most urgent first, then by identifier number; issues not created yet come last. */
export const sortIssues = (issues: readonly Issue[]): Issue[] =>
  issues.toSorted((a, b) => provisional(a) - provisional(b) || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
    identifierNumber(a) - identifierNumber(b))

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

/** How the authoritative board decided a pending create or edit, read from its `pending` markers. */
export type ChangeDecision =
  | { kind: 'update'; issueId: string; identifier: string; outcome: 'applied' | 'rejected'; revision: string }
  | { kind: 'create'; title: string; outcome: 'applied' | 'rejected'; identifier?: string }

/**
 * The creates and edits `previous` showed pending that `current` no longer does. An edit is
 * pending at the issue's unchanged revision, so the same revision without the marker means it was
 * rejected (the old values are back) and a new one that it was applied; an issue gone from the
 * board counts as neither. A provisional card that disappeared was created if an issue with its
 * title is now on the board that was not before, and rejected otherwise.
 *
 * The gatekeeper also stops overlaying a change made stale by an outside change; that reads as
 * applied here, as a stale move does.
 */
export const decidedChanges = (previous: Board, current: Board): ChangeDecision[] => {
  const before = new Map(previous.columns.flatMap(column => column.issues.map(issue => [issue.id, issue] as const)))
  const after = new Map(current.columns.flatMap(column => column.issues.map(issue => [issue.id, issue] as const)))
  const created = [...after.values()].filter(issue => !before.has(issue.id) && issue.pending !== 'create')
  const decisions: ChangeDecision[] = []
  for (const issue of before.values()) {
    const now = after.get(issue.id)
    if (issue.pending === 'update' && now && now.pending !== 'update') {
      decisions.push({ kind: 'update', issueId: issue.id, identifier: now.identifier,
        outcome: now.revision === issue.revision ? 'rejected' : 'applied', revision: now.revision })
    } else if (issue.pending === 'create' && !now) {
      const index = created.findIndex(candidate => candidate.title === issue.title)
      const [match] = index >= 0 ? created.splice(index, 1) : []
      decisions.push(match
        ? { kind: 'create', title: issue.title, outcome: 'applied', identifier: match.identifier }
        : { kind: 'create', title: issue.title, outcome: 'rejected' })
    }
  }
  return decisions
}

/** What a create or edit form holds. The description is free text; empty means none given. */
export type IssueFields = { title: string; description: string; priority: Issue['priority'] }

/**
 * The changes an edit form asks for: a title or priority that differs from the issue's, and a
 * description only when one was entered, since the board does not carry the current one.
 */
export const changedFields = (issue: Issue, fields: IssueFields): IssueChanges => {
  const title = fields.title.trim()
  return {
    ...title !== issue.title ? { title } : {},
    ...fields.priority !== issue.priority ? { priority: fields.priority } : {},
    ...fields.description.trim() !== '' ? { description: fields.description } : {},
  }
}

/** What a refused create or edit tells the user: the gatekeeper's own message, except for a stale revision. */
export const proposalErrorText = (result: Extract<ProposalResult, { ok: false }>): string =>
  result.code === 'STALE_REVISION' ? 'This issue changed; refresh and try again.' : result.message

/** A date as the board shows it, in UTC so the planned day does not shift with the viewer's zone. */
export const formatTargetDate = (date: string): string => {
  const parsed = new Date(`${date}T00:00:00Z`)
  return Number.isNaN(parsed.valueOf()) ? date : parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

export const isOverdue = (issue: Issue, state: State, today: string): boolean =>
  issue.targetDate !== null && state.group !== 'completed' && state.group !== 'cancelled' && issue.targetDate < today
