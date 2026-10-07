import { useEffect, useId, useLayoutEffect, useRef, useState, type DragEvent } from 'react'
import type { Board, Issue, IssueChanges, NewIssue, Run, State } from '@inferos/gatekeeper-inferops/src/types'
import type { BoardActivityItem } from './boardActivity'
import type { PendingChange, PendingMove, ProposalResult } from './boardData'
import { describeRun, finishedRuns, latestRunOf } from './codingRuns'
import { KanbanCard } from './KanbanCard'
import type { CodingControl } from './KanbanCodingForm'
import { KanbanColumn } from './KanbanColumn'
import { advanceDecisions, moveTargets, pendingMoveOf, startDecisions, stateOf, type ChangeDecision } from './kanbanBoard'

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
  /**
   * The board's decided actions from the action log, oldest first (`BoardActivity.decided`): the
   * only source of how a move, edit or new issue ended.
   */
  decided: readonly BoardActivityItem[]
  layout: KanbanLayout
  /** Proposes the move through the approval path with the issue's revision; the result is announced. */
  onMove: (issue: Issue, toState: State) => Promise<ProposalResult>
  /** Proposes a new issue (in a column's state) through the approval path. */
  onCreate: (issue: NewIssue) => Promise<ProposalResult>
  /** Proposes an edit of the issue at its revision through the approval path. */
  onUpdate: (issue: Issue, changes: IssueChanges) => Promise<ProposalResult>
  /** Coding dispatch for the board's project; absent, no card offers it. */
  coding?: CodingControl
  /** Which issue's edit form is open, held by the caller; absent, each card holds its own. */
  openIssue?: OpenIssueControl
}

/** The issue whose form is open (an issue id), held outside the board, and how to change it. */
export type OpenIssueControl = { issueId: string | null; onChange: (issueId: string | null) => void }

type Announcement = { text: string; tone: 'info' | 'error' }

/** How long an applied move stays marked on its card. A rejection stays until the issue moves again. */
export const APPLIED_MARK_MS = 6000

const today = () => new Date().toISOString().slice(0, 10)

const NO_RUNS: readonly Run[] = []

const issueCard = (root: HTMLElement, issueId: string) =>
  [...root.querySelectorAll<HTMLElement>('[data-issue-id]')].find(card => card.dataset.issueId === issueId)

/** A decision marked on its card while the issue is still at the revision it was seen at; a newer one supersedes it. */
type CardDecision = { outcome: ChangeDecision['outcome']; revision: string; toStateId?: string }

const decisionText = (board: Board, { change, outcome }: ChangeDecision): string => {
  // A failed decision was approved but the provider refused it: nothing changed, like a rejection.
  const notDone = outcome === 'failed' ? 'was approved but not applied' : 'was rejected'
  switch (change.kind) {
    case 'move': {
      const target = stateOf(board, change.toStateId)?.name ?? 'another state'
      return outcome === 'applied' ? `${change.identifier} moved to ${target}.` : `Move of ${change.identifier} to ${target} ${notDone}; it stays where it was.`
    }
    case 'update':
      return outcome === 'applied' ? `Edit of ${change.identifier} applied.` : `Edit of ${change.identifier} ${notDone}; it keeps its previous values.`
    case 'create':
      return outcome === 'applied' ? `New issue "${change.title}" created.` : `New issue "${change.title}" ${notDone}.`
  }
}

/**
 * The board: a column per state with its issue cards. Moves go through `onMove` only. A card
 * stays where the authoritative board puts it, showing its pending move; once the gatekeeper
 * simulates the move the board re-read places it in the target column. Focus follows a card
 * across columns.
 *
 * Each column offers a new issue in its state, and each card an edit, both through `onCreate` and
 * `onUpdate`. Once queued they show as the gatekeeper's provisional card or overlaid values,
 * marked waiting for approval.
 *
 * Once the board stops showing a move, edit or new issue pending, its outcome is announced (and
 * marked on the card) as the action log records it in `decided`, whoever proposed it; the board's
 * own reads never decide it, since a revision moves for outside edits too.
 *
 * With `coding`, each card shows its issue's latest coding run, and a run that finishes is announced.
 */
export const KanbanBoard = ({ board, columns, pending, changes, awaiting, decided: decidedActions, layout, onMove, onCreate, onUpdate, coding, openIssue }: KanbanBoardProps) => {
  const instructionsId = useId()
  const root = useRef<HTMLDivElement>(null)
  // The issue whose card has focus; restored when its card re-mounts in another column.
  const focused = useRef<string | null>(null)
  const [initialTracker] = useState(() => startDecisions(board, pending, decidedActions))
  const tracker = useRef(initialTracker)
  const runs: readonly Run[] = coding?.state.status === 'ready' ? coding.state.runs : NO_RUNS
  const seenRuns = useRef<readonly Run[]>(runs)
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const [dragging, setDragging] = useState<Issue | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState<Announcement | null>(null)
  const [decisions, setDecisions] = useState<ReadonlyMap<string, CardDecision>>(new Map())
  const [editDecisions, setEditDecisions] = useState<ReadonlyMap<string, CardDecision>>(new Map())

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

  // A change the board stops showing pending is announced, and marked on its card, only with the
  // outcome its action's record in the log gives (`advanceDecisions`), whoever proposed it.
  useEffect(() => {
    const { tracker: next, decisions: decided } = advanceDecisions(tracker.current, board, pending, decidedActions)
    tracker.current = next
    if (decided.length === 0) return
    const revisions = new Map(board.columns.flatMap(column => column.issues.map(issue => [issue.id, issue.revision] as const)))
    const marks = (kind: 'move' | 'update') => decided.flatMap(({ change, outcome }) => change.kind === kind
      ? [[change.issueId, { outcome, revision: revisions.get(change.issueId) ?? '', ...change.kind === 'move' ? { toStateId: change.toStateId } : {} }] as const] : [])
    const moves = marks('move')
    const edits = marks('update')
    setDecisions(previous => new Map([...previous, ...moves]))
    setEditDecisions(previous => new Map([...previous, ...edits]))
    later([...moves, ...edits].filter(([, mark]) => mark.outcome === 'applied').map(([issueId]) => issueId))
    setAnnouncement({
      tone: decided.some(decision => decision.outcome !== 'applied') ? 'error' : 'info',
      text: decided.map(decision => decisionText(board, decision)).join(' '),
    })
  }, [pending, board, decidedActions])
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
    <p id={instructionsId} className="sr-only">Issue card. Press up or down to navigate cards, Home or End for the first or last card. Press the right or left arrow key to choose a column, Enter to propose the move, Escape to cancel. The move is applied once approved.</p>
    <p role="status" aria-live="polite" className="sr-only">{announcement?.text}</p>
    {columns.map(({ state, issues }) => {
      const headingId = `${instructionsId}-${state.id}`
      const dropOk = dropTarget === state.id
      const dropNo = dragging !== null && !allowedDrop(state.id) && dragging.stateId !== state.id
      const retained = new Set(issues.filter(issue => issue.pending !== undefined || pendingMoveOf(issue, pending)
        || changes.some(change => change.kind === 'update' && change.issueId === issue.id) || awaiting.has(issue.identifier)
        || openIssue?.issueId === issue.id || dragging?.id === issue.id || latestRunOf(runs, issue.id)?.pending).map(issue => issue.id))
      return <KanbanColumn key={state.id} state={state} issues={issues} headingId={headingId} layout={layout}
        dropOk={dropOk} dropNo={dropNo} retained={retained} focusedIssueId={focused.current} onCreate={create(state)}
        onDragOver={onDragOver(state.id)} onDragLeave={() => { if (dropTarget === state.id) setDropTarget(null) }} onDrop={onDrop(state)}
        renderCard={(issue, position, onDialogOpenChange) => {
          const pendingMove = pendingMoveOf(issue, pending)
          const edit = changes.find((change): change is Extract<PendingChange, { kind: 'update' }> => change.kind === 'update' && change.issueId === issue.id)
          const decision = decisions.get(issue.id)
          const editDecision = editDecisions.get(issue.id)
          const proposed = pendingMove ? undefined : awaiting.get(issue.identifier)
          // The gatekeeper refuses a second change of an issue whose change awaits approval, and
          // a provisional card has no issue behind it yet.
          const locked = pendingMove !== undefined || edit !== undefined || proposed !== undefined || issue.pending !== undefined
          return <KanbanCard key={issue.id} position={position} onDialogOpenChange={onDialogOpenChange} issue={issue} state={state} today={day} instructionsId={instructionsId}
            targets={locked ? [] : moveTargets(board, issue)}
            edit={edit}
            editDecision={editDecision && editDecision.revision === issue.revision ? editDecision.outcome : undefined}
            onUpdate={locked ? undefined : update(issue)}
            editControl={openIssue && {
              open: openIssue.issueId === issue.id,
              onOpenChange: open => openIssue.onChange(open ? issue.id : null),
            }}
            coding={coding && { control: coding, run: latestRunOf(runs, issue.id) }}
            pending={pendingMove && { move: pendingMove, toState: stateOf(board, pendingMove.toStateId) }}
            proposed={proposed}
            decision={decision && decision.revision === issue.revision ? { outcome: decision.outcome, toState: decision.toStateId === undefined ? undefined : stateOf(board, decision.toStateId) } : undefined}
            // A keyboard or menu move keeps focus with the card wherever the board places it next.
            onMove={toState => { focused.current = issue.id; void move(issue, toState) }}
            onDragStart={() => setDragging(issue)} onDragEnd={() => { setDragging(null); setDropTarget(null) }} />
        }} />
    })}
  </div>
}
