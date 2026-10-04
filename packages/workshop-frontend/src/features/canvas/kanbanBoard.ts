// Pure Kanban rules over the gatekeeper's board DTO, shared by every presentation of a board.
import type { Board, Issue, IssueChanges, State } from '@inferos/gatekeeper-inferops/src/types'
import type { BoardActivityItem } from './boardActivity'
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

/**
 * A change the board shows waiting for approval whose outcome is announced once decided: a move
 * (this board's own awaiting move, or the gatekeeper's `transition` marker), an edit (`update`
 * marker) or a new issue (a provisional card). An issue has at most one, as the gatekeeper refuses
 * a second.
 */
export type TrackedChange =
  | { kind: 'move'; issueId: string; identifier: string; toStateId: string }
  | { kind: 'update'; issueId: string; identifier: string }
  | { kind: 'create'; title: string }

/** How a tracked change ended, as its action's record in the action log says. */
export type ChangeDecision = { change: TrackedChange; outcome: 'applied' | 'rejected'; actionId: number }

/**
 * What `advanceDecisions` carries between board renders: the changes shown pending last time, the
 * ones the board stopped showing whose action the log has not decided yet (`waiting`), log
 * decisions that arrived before the board stopped showing their change (`early`), and every
 * decided action id already accounted for (`seen`).
 */
export type DecisionTracker = {
  tracked: readonly TrackedChange[]
  waiting: readonly TrackedChange[]
  early: ReadonlyMap<string, readonly BoardActivityItem[]>
  seen: ReadonlySet<number>
}

// Changes and log decisions meet on the issue identifier, or on the title of an issue to create.
const changeKey = (change: TrackedChange) => change.kind === 'create' ? `create:${change.title}` : `issue:${change.identifier}`
const decisionKey = (item: BoardActivityItem) =>
  item.issue !== undefined ? `issue:${item.issue}` : item.creates !== undefined ? `create:${item.creates}` : null

/** The changes `board` (with this board's own `pending` moves) shows waiting for approval. */
export const trackedChanges = (board: Board, pending: readonly PendingMove[]): TrackedChange[] =>
  board.columns.flatMap(column => column.issues.flatMap((issue): TrackedChange[] => {
    if (issue.pending === 'create') return [{ kind: 'create', title: issue.title }]
    const move = pending.find(candidate => candidate.issueId === issue.id && candidate.phase === 'awaiting')
    if (move) return [{ kind: 'move', issueId: issue.id, identifier: issue.identifier, toStateId: move.toStateId }]
    if (issue.pending === 'transition') return [{ kind: 'move', issueId: issue.id, identifier: issue.identifier, toStateId: issue.stateId }]
    if (issue.pending === 'update') return [{ kind: 'update', issueId: issue.id, identifier: issue.identifier }]
    return []
  }))

/** A tracker starting now: decisions the log already holds are history, never announced. */
export const startDecisions = (board: Board, pending: readonly PendingMove[], decided: readonly BoardActivityItem[]): DecisionTracker =>
  ({ tracked: trackedChanges(board, pending), waiting: [], early: new Map(), seen: new Set(decided.map(item => item.id)) })

/**
 * The outcomes of changes the board stopped showing pending, taken from the action log alone. A
 * change the board drops is decided only once its action is decided in the log (`decided`, the
 * board's applied and rejected actions, oldest first), and its outcome is that record's: approved
 * is applied and rejected is rejected. The board itself never says how: a concurrent edit in
 * InferOps also moves an issue's revision, and the gatekeeper stops overlaying a change made stale,
 * while its action stays pending (an approval whose apply failed stays pending too). A drop with
 * no decision yet waits for one; a decision that arrives first is held for the drop. Decisions for
 * changes the board never showed pending are ignored, and each decision is used once.
 */
export const advanceDecisions = (
  tracker: DecisionTracker, board: Board, pending: readonly PendingMove[], decided: readonly BoardActivityItem[],
): { tracker: DecisionTracker; decisions: ChangeDecision[] } => {
  const tracked = trackedChanges(board, pending)
  const still = tracked.map(changeKey)
  const dropped = tracker.tracked.filter(change => {
    const index = still.indexOf(changeKey(change))
    if (index < 0) return true
    still.splice(index, 1)
    return false
  })
  const waiting = [...tracker.waiting]
  const early = new Map(tracker.early)
  const seen = new Set(tracker.seen)
  const decisions: ChangeDecision[] = []
  const decide = (change: TrackedChange, item: BoardActivityItem) =>
    decisions.push({ change, outcome: item.kind === 'applied' ? 'applied' : 'rejected', actionId: item.id })

  for (const change of dropped) {
    const key = changeKey(change)
    const [first, ...rest] = early.get(key) ?? []
    if (!first) { waiting.push(change); continue }
    decide(change, first)
    if (rest.length > 0) early.set(key, rest)
    else early.delete(key)
  }
  for (const item of decided) {
    if (seen.has(item.id) || (item.kind !== 'applied' && item.kind !== 'rejected')) continue
    seen.add(item.id)
    const key = decisionKey(item)
    if (key === null) continue
    const index = waiting.findIndex(change => changeKey(change) === key)
    if (index >= 0) decide(waiting.splice(index, 1)[0]!, item)
    else if (tracked.some(change => changeKey(change) === key)) early.set(key, [...early.get(key) ?? [], item])
  }
  return { tracker: { tracked, waiting, early, seen }, decisions }
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
