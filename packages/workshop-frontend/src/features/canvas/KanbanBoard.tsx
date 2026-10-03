import { useEffect, useId, useLayoutEffect, useRef, useState, type DragEvent } from 'react'
import { Button } from '@cloudflare/kumo'
import { Plus } from '@phosphor-icons/react'
import type { Board, Issue, IssueChanges, NewIssue, Run, State } from '@inferos/gatekeeper-inferops/src/types'
import type { BoardActivityItem } from './boardActivity'
import type { PendingChange, PendingMove, ProposalResult } from './boardData'
import { describeRun, finishedRuns, latestRunOf } from './codingRuns'
import { KanbanCard } from './KanbanCard'
import type { CodingControl } from './KanbanCodingForm'
import { KanbanIssueDialog } from './KanbanIssueDialog'
import { decidedChanges, decidedMoves, moveTargets, pendingMoveOf, sortIssues, stateOf, type ChangeDecision, type MoveDecision } from './kanbanBoard'

/** `embedded`: fixed-width columns that scroll sideways in the card's cell. `full`: columns share the width and the height. */
export type KanbanLayout = 'embedded' | 'full'

export type KanbanBoardProps = {
  board: Board
  /** The columns this presentation shows; moves may still target any state of the board. */
  columns: Board['columns']
  pending: readonly PendingMove[]
  /** Creates and edits this scope proposed that the board does not show as pending yet. */
  changes: readonly PendingChange[]
  /**
   * Actions in the action log awaiting approval, by the identifier of the issue they move: the
   * agent's, a gadget's, or a person's from another surface, which this board did not propose.
   */
  awaiting: ReadonlyMap<string, BoardActivityItem>
  layout: KanbanLayout
  /** Proposes the move through the approval path with the issue's revision; the result is announced. */
  onMove: (issue: Issue, toState: State) => Promise<ProposalResult>
  /** Proposes a new issue (in a column's state) through the approval path. */
  onCreate: (issue: NewIssue) => Promise<ProposalResult>
  /** Proposes an edit of the issue at its revision through the approval path. */
  onUpdate: (issue: Issue, changes: IssueChanges) => Promise<ProposalResult>
  /** Coding dispatch for the board's project; absent, no card offers it. */
  coding?: CodingControl
}

type Announcement = { text: string; tone: 'info' | 'error' }

/** How long an applied move stays marked on its card. A rejection stays until the issue moves again. */
export const APPLIED_MARK_MS = 6000

const today = () => new Date().toISOString().slice(0, 10)

const NO_RUNS: readonly Run[] = []

const issueCard = (root: HTMLElement, issueId: string) =>
  [...root.querySelectorAll<HTMLElement>('[data-issue-id]')].find(card => card.dataset.issueId === issueId)

const changeAnnouncement = (decision: ChangeDecision): string => decision.kind === 'update'
  ? decision.outcome === 'applied' ? `Edit of ${decision.identifier} applied.` : `Edit of ${decision.identifier} was rejected; it keeps its previous values.`
  : decision.outcome === 'applied' ? `New issue ${decision.identifier} created: ${decision.title}.` : `New issue "${decision.title}" was rejected.`

/**
 * The board: a column per state with its issue cards. Moves go through `onMove` only. A card
 * stays where the authoritative board puts it, showing its pending move; once the gatekeeper
 * simulates the move the board re-read places it in the target column, and a decision (applied
 * or rejected) is announced and marked on the card. Focus follows a card across columns.
 *
 * Each column offers a new issue in its state, and each card an edit, both through `onCreate` and
 * `onUpdate`. Once queued they show as the gatekeeper's provisional card or overlaid values,
 * marked waiting for approval; the board read that drops the marker decides them, which is
 * announced too (whoever proposed them, as the board alone cannot tell).
 *
 * With `coding`, each card shows its issue's latest coding run, and a run that finishes is announced.
 */
export const KanbanBoard = ({ board, columns, pending, changes, awaiting, layout, onMove, onCreate, onUpdate, coding }: KanbanBoardProps) => {
  const instructionsId = useId()
  const root = useRef<HTMLDivElement>(null)
  // The issue whose card has focus; restored when its card re-mounts in another column.
  const focused = useRef<string | null>(null)
  const seen = useRef<readonly PendingMove[]>(pending)
  const seenBoard = useRef<Board>(board)
  const runs: readonly Run[] = coding?.state.status === 'ready' ? coding.state.runs : NO_RUNS
  const seenRuns = useRef<readonly Run[]>(runs)
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const [dragging, setDragging] = useState<Issue | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState<Announcement | null>(null)
  const [decisions, setDecisions] = useState<ReadonlyMap<string, MoveDecision>>(new Map())
  const [editDecisions, setEditDecisions] = useState<ReadonlyMap<string, Extract<ChangeDecision, { kind: 'update' }>>>(new Map())

  const forget = (issueIds: string[]) => {
    const without = <T,>(previous: ReadonlyMap<string, T>) => {
      const next = new Map(previous)
      for (const id of issueIds) next.delete(id)
      return next
    }
    setDecisions(without)
    setEditDecisions(without)
  }
  const later = (issueIds: string[]) => {
    if (issueIds.length === 0) return
    const timer = setTimeout(() => { timers.current.delete(timer); forget(issueIds) }, APPLIED_MARK_MS)
    timers.current.add(timer)
  }

  // The adapter drops an awaiting move once the authoritative board decided it; what the board
  // then shows for the issue says how. Creates and edits are decided by the board alone: the read
  // that no longer marks them pending.
  useEffect(() => {
    const decided = decidedMoves(seen.current, pending, board)
    const changed = decidedChanges(seenBoard.current, board)
    seen.current = pending
    seenBoard.current = board
    if (decided.length === 0 && changed.length === 0) return
    setDecisions(previous => new Map([...previous, ...decided.map(decision => [decision.issueId, decision] as const)]))
    const edits = changed.filter(decision => decision.kind === 'update')
    setEditDecisions(previous => new Map([...previous, ...edits.map(decision => [decision.issueId, decision] as const)]))
    later([...decided, ...edits].filter(decision => decision.outcome === 'applied').map(decision => decision.issueId))
    const issues = new Map(board.columns.flatMap(column => column.issues.map(issue => [issue.id, issue] as const)))
    setAnnouncement({
      tone: [...decided, ...changed].some(decision => decision.outcome === 'rejected') ? 'error' : 'info',
      text: [...decided.map(decision => {
        const label = issues.get(decision.issueId)?.identifier ?? 'An issue'
        const target = stateOf(board, decision.toStateId)?.name ?? 'another state'
        return decision.outcome === 'applied' ? `${label} moved to ${target}.` : `Move of ${label} to ${target} was rejected; it stays where it was.`
      }), ...changed.map(changeAnnouncement)].join(' '),
    })
  }, [pending, board])
  useEffect(() => () => { for (const timer of timers.current) clearTimeout(timer) }, [])

  // The runner finishes runs on its own; say so, as a card's badge changing is otherwise silent.
  useEffect(() => {
    const finished = finishedRuns(seenRuns.current, runs)
    seenRuns.current = runs
    if (finished.length === 0) return
    setAnnouncement({
      tone: finished.some(run => run.status !== 'succeeded') ? 'error' : 'info',
      text: finished.map(run => describeRun(run.issueIdentifier, run)).join(' '),
    })
  }, [runs])

  useLayoutEffect(() => {
    const id = focused.current
    if (!id || !root.current || root.current.contains(document.activeElement)) return
    issueCard(root.current, id)?.focus()
  }, [columns, pending])

  const create = (state: State) => async (issue: NewIssue) => {
    setAnnouncement({ tone: 'info', text: `Proposing a new issue in ${state.name}…` })
    const result = await onCreate(issue)
    // A refusal is shown in the form, which stays open.
    setAnnouncement(result.ok ? { tone: 'info', text: `New issue "${issue.title}" proposed in ${state.name}. Waiting for approval.` } : null)
    return result
  }

  const update = (issue: Issue) => async (fields: IssueChanges) => {
    // The card loses its edit control once the edit is pending; focus then stays with the card.
    focused.current = issue.id
    forget([issue.id])
    setAnnouncement({ tone: 'info', text: `Proposing changes to ${issue.identifier}…` })
    const result = await onUpdate(issue, fields)
    setAnnouncement(result.ok ? { tone: 'info', text: `Changes to ${issue.identifier} proposed. Waiting for approval.` } : null)
    return result
  }

  const move = async (issue: Issue, toState: State) => {
    forget([issue.id])
    setAnnouncement({ tone: 'info', text: `Proposing to move ${issue.identifier} to ${toState.name}…` })
    const result = await onMove(issue, toState)
    setAnnouncement(result.ok
      ? { tone: 'info', text: `${issue.identifier} → ${toState.name} proposed. It is applied in InferOps once approved.` }
      : { tone: 'error', text: result.code === 'STALE_REVISION'
        ? `${issue.identifier} changed in InferOps since the board loaded. The board was re-read; try the move again.`
        : `${issue.identifier} was not moved: ${result.message}` })
  }

  const allowedDrop = (stateId: string) => dragging !== null && moveTargets(board, dragging).some(state => state.id === stateId)
  const onDragOver = (stateId: string) => (event: DragEvent) => {
    if (!allowedDrop(stateId)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if (dropTarget !== stateId) setDropTarget(stateId)
  }
  // Drag end, which follows every drop, clears the dragged issue.
  const onDrop = (toState: State) => (event: DragEvent) => {
    if (!dragging || !allowedDrop(toState.id)) return
    event.preventDefault()
    setDropTarget(null)
    void move(dragging, toState)
  }

  const day = today()
  return <div ref={root} data-layout={layout}
    className={`flex gap-3 overflow-x-auto ${layout === 'full' ? 'h-full min-h-0 items-stretch' : 'max-h-[32rem] items-start pb-1'}`}
    onFocus={event => { focused.current = event.target.closest<HTMLElement>('[data-issue-id]')?.dataset.issueId ?? focused.current }}
    onBlur={event => { if (!(event.relatedTarget instanceof Node) || !root.current?.contains(event.relatedTarget)) focused.current = null }}>
    <p id={instructionsId} className="sr-only">Issue card. Press the right or left arrow key to choose a column, Enter to propose the move, Escape to cancel. The move is applied once approved.</p>
    <p role="status" aria-live="polite" className="sr-only">{announcement?.text}</p>
    {columns.map(({ state, issues }) => {
      const headingId = `${instructionsId}-${state.id}`
      const dropOk = dropTarget === state.id
      const dropNo = dragging !== null && !allowedDrop(state.id) && dragging.stateId !== state.id
      return <section key={state.id} data-state-id={state.id} aria-labelledby={headingId}
        className={`flex max-h-full flex-col rounded-lg border bg-kumo-tint ${layout === 'full' ? 'min-w-64 flex-1' : 'w-64 shrink-0'} ${dropOk ? 'border-kumo-brand' : 'border-kumo-line'} ${dropNo ? 'opacity-60' : ''}`}
        onDragOver={onDragOver(state.id)} onDragLeave={() => { if (dropTarget === state.id) setDropTarget(null) }} onDrop={onDrop(state)}>
        <div className="flex items-center gap-2 px-3 py-2">
          <h3 id={headingId} className="flex min-w-0 flex-1 items-baseline gap-2 text-sm font-medium text-kumo-default">
            <span className="truncate">{state.name}</span>
            <span className="text-xs text-kumo-subtle" aria-label={`${issues.length} ${issues.length === 1 ? 'issue' : 'issues'}`}>{issues.length}</span>
          </h3>
          <KanbanIssueDialog kind="create" state={state} onCreate={create(state)}
            trigger={<Button size="xs" shape="square" variant="ghost" aria-label={`New issue in ${state.name}`} icon={Plus} />} />
        </div>
        <ul aria-labelledby={headingId} className="flex min-h-12 flex-col gap-2 overflow-y-auto px-2 pb-2">
          {issues.length === 0 && <li className="px-1 text-xs text-kumo-subtle">No issues</li>}
          {sortIssues(issues).map(issue => {
            const pendingMove = pendingMoveOf(issue, pending)
            const edit = changes.find((change): change is Extract<PendingChange, { kind: 'update' }> => change.kind === 'update' && change.issueId === issue.id)
            const decision = decisions.get(issue.id)
            const editDecision = editDecisions.get(issue.id)
            const proposed = pendingMove ? undefined : awaiting.get(issue.identifier)
            // The gatekeeper refuses a second change of an issue whose change awaits approval, and
            // a provisional card has no issue behind it yet.
            const locked = pendingMove !== undefined || edit !== undefined || proposed !== undefined || issue.pending !== undefined
            return <KanbanCard key={issue.id} issue={issue} state={state} today={day} instructionsId={instructionsId}
              targets={locked ? [] : moveTargets(board, issue)}
              edit={edit}
              editDecision={editDecision && editDecision.revision === issue.revision ? editDecision.outcome : undefined}
              onUpdate={locked ? undefined : update(issue)}
              coding={coding && { control: coding, run: latestRunOf(runs, issue.id) }}
              pending={pendingMove && { move: pendingMove, toState: stateOf(board, pendingMove.toStateId) }}
              proposed={proposed}
              decision={decision && decision.revision === issue.revision ? { outcome: decision.outcome, toState: stateOf(board, decision.toStateId) } : undefined}
              // A keyboard or menu move keeps focus with the card wherever the board places it next.
              onMove={toState => { focused.current = issue.id; void move(issue, toState) }}
              onDragStart={() => setDragging(issue)} onDragEnd={() => { setDragging(null); setDropTarget(null) }} />
          })}
        </ul>
      </section>
    })}
  </div>
}
