import { Badge, Button, Loader } from '@cloudflare/kumo'
import { ArrowClockwise, ArrowsOutSimple } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { CanvasProjectBoardWidget } from '@gadgets/workshop-shared/canvas'
import { actionsOnly, awaitingByIssue, combineActivity } from './boardActivity'
import { visibleColumns } from './boardData'
import { BoardActivityLine } from './BoardActivityLine'
import { dispatchRefOf } from './codingRuns'
import { KanbanBoard } from './KanbanBoard'
import { useBoardActivity } from './useBoardActivity'
import { useBoardData } from './useBoardData'
import { useCodingDispatch } from './useCodingDispatch'

export type CanvasBoardWidgetProps = {
  widget: CanvasProjectBoardWidget
  overseer: RpcStub<Overseer>
  /**
   * Offer coding dispatch when the workspace also holds the project's coding-dispatch connection.
   * Only the workspace's own canvas passes it; the Operate session and flows never do, as code is
   * not edited from Operate. Without it the dispatch reference is never even looked up.
   */
  codingDispatch?: boolean
} & (
  /** A card in a view: the board fits its cell and columns scroll sideways. `onOpen` offers the full view. */
  | { presentation: 'card'; onOpen?: () => void }
  /** The widget on its own: the board takes the pane's width and height. */
  | { presentation: 'full' }
)

const proposalCount = (moves: number, changes: number) => {
  const count = moves + changes
  const noun = changes > 0 ? 'change' : 'move'
  return { count, noun: count === 1 ? noun : `${noun}s` }
}

/**
 * A live board: its request served by the scope's shared adapter, so every presentation of one
 * reference shows the same board from one read. Shows the adapter's state explicitly (loading,
 * not connected, InferOps turned off, error, stale, pending moves and changes), the board's
 * activity from the scope's action log, and the Kanban once a board is held. With `codingDispatch`
 * and the project's coding-dispatch connection, the Kanban also offers coding tasks and their runs,
 * and the activity line includes the dispatch and cancel actions.
 */
export const CanvasBoardWidget = (props: CanvasBoardWidgetProps) => {
  const { widget, overseer, presentation } = props
  const { state, refresh, move, create, update } = useBoardData(overseer, widget)
  const dispatchRef = props.codingDispatch ? dispatchRefOf(widget.targetRef) : null
  const coding = useCodingDispatch(overseer, dispatchRef)
  const board = 'board' in state ? state.board : undefined
  // Awaiting actions show only while a board is held: once the connection is revoked or the board
  // cannot be read, nothing here can say what became of them.
  const { activity: boardActivity, now } = useBoardActivity(overseer, widget.targetRef, board !== undefined)
  // Its runs are re-read automatically, so the dispatch connection's reads would crowd the line.
  const { activity: codingActivity } = useBoardActivity(overseer, coding.state.status === 'unavailable' ? null : dispatchRef,
    coding.state.status === 'ready')
  const activity = combineActivity(boardActivity, actionsOnly(codingActivity))
  const columns = board ? visibleColumns(board, widget.params) : []
  const full = presentation === 'full'
  // What this scope proposed and the board does not show decided yet. Creates and edits leave this
  // count once the board shows them, each then marked on its own card.
  const proposals = 'pending' in state ? proposalCount(state.pending.length, state.changes.length) : { count: 0, noun: '' }
  return <article aria-label={`Project board ${widget.targetRef}`} data-presentation={presentation}
    className={`flex min-w-0 flex-col rounded-xl border border-kumo-line bg-kumo-base shadow-md ${full ? 'h-full min-h-0' : ''}`}>
    <header className="flex flex-wrap items-center gap-2 border-b border-kumo-line px-3 py-2">
      <div className="min-w-0 flex-1">
        <h4 className="truncate text-sm font-medium text-kumo-default">{board ? `${board.project.name} (${board.project.identifier})` : 'Project board'}</h4>
      </div>
      {state.status === 'stale' && (state.error
        ? <Badge variant="warning">Refresh failed</Badge>
        : <Badge variant="neutral" icon={<Loader size="sm" aria-label="" />}>Refreshing</Badge>)}
      {proposals.count > 0 && <Badge variant="warning">
        {proposals.count} {proposals.noun} pending approval
      </Badge>}
      <Button size="sm" shape="square" variant="ghost" icon={ArrowClockwise} aria-label="Refresh board"
        disabled={state.status === 'loading'} onClick={() => { refresh(); coding.refresh() }} />
      {presentation === 'card' && props.onOpen && <Button size="sm" variant="ghost" icon={ArrowsOutSimple} onClick={props.onOpen}>Open</Button>}
    </header>
    <BoardActivityLine activity={activity} now={now} compact={!full} />
    <div className={`min-h-0 flex-1 p-3 ${full ? 'flex flex-col' : ''}`}>
      {state.status === 'loading' && <p aria-busy="true" className="flex items-center gap-2 text-sm text-kumo-subtle"><Loader size="sm" /> Loading the board…</p>}
      {state.status === 'unbound' && <p className="text-sm text-kumo-subtle">
        Not connected. This workspace has no connection to this board. Connect it, for example by asking in the chat, to see it live.
      </p>}
      {state.status === 'disabled' && <p role="status" className="text-sm text-kumo-subtle">
        {state.message} The connection to this board is kept; it shows the board again once InferOps is turned back on.
      </p>}
      {state.status === 'error' && <div className="space-y-2">
        <p role="alert" className="text-sm text-kumo-danger">Could not read the board: {state.message}</p>
        <Button size="sm" onClick={refresh}>Try again</Button>
      </div>}
      {state.status === 'stale' && state.error && <p role="alert" className="mb-2 text-xs text-kumo-danger">Showing the last board read; refresh failed: {state.error}</p>}
      {board && (columns.length === 0
        ? <p className="text-sm text-kumo-subtle">No {widget.params.workflow} states to show. {widget.params.showCompleted ? '' : 'Completed and cancelled states are hidden on this card.'}</p>
        : <KanbanBoard board={board} columns={columns} pending={'pending' in state ? state.pending : []} changes={'changes' in state ? state.changes : []}
          awaiting={awaitingByIssue(boardActivity)} layout={full ? 'full' : 'embedded'}
          onMove={(issue, toState) => move(issue.id, toState.id, issue.revision)}
          onCreate={create}
          onUpdate={(issue, changes) => update(issue.id, changes, issue.revision)}
          coding={coding.state.status === 'unavailable' ? undefined : {
            state: coding.state, activity: codingActivity,
            onDispatch: (issue, repoId) => coding.dispatch(issue.identifier, { repoId }, issue.revision),
            onCancel: run => coding.cancel(run.id),
            onRefresh: coding.refresh,
          }} />)}
    </div>
  </article>
}
