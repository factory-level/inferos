import { Badge, Button, Loader } from '@cloudflare/kumo'
import { ArrowClockwise, ArrowsOutSimple } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { CanvasProjectBoardWidget } from '@gadgets/workshop-shared/canvas'
import { visibleColumns } from './boardData'
import { KanbanBoard } from './KanbanBoard'
import { useBoardData } from './useBoardData'

export type CanvasBoardWidgetProps = {
  widget: CanvasProjectBoardWidget
  overseer: RpcStub<Overseer>
} & (
  /** A card in a view: the board fits its cell and columns scroll sideways. `onOpen` offers the full view. */
  | { presentation: 'card'; onOpen?: () => void }
  /** The widget on its own: the board takes the pane's width and height. */
  | { presentation: 'full' }
)

/**
 * A live board: its request served by the scope's shared adapter, so every presentation of one
 * reference shows the same board from one read. Shows the adapter's state explicitly (loading,
 * not connected, error, stale, pending moves) and the Kanban once a board is held.
 */
export const CanvasBoardWidget = (props: CanvasBoardWidgetProps) => {
  const { widget, overseer, presentation } = props
  const { state, refresh, move } = useBoardData(overseer, widget)
  const board = 'board' in state ? state.board : undefined
  const columns = board ? visibleColumns(board, widget.params) : []
  const full = presentation === 'full'
  return <article aria-label={`Project board ${widget.targetRef}`} data-presentation={presentation}
    className={`flex min-w-0 flex-col rounded-lg border border-kumo-line bg-kumo-base ${full ? 'h-full min-h-0' : ''}`}>
    <header className="flex flex-wrap items-center gap-2 border-b border-kumo-line px-3 py-2">
      <div className="min-w-0 flex-1">
        <h4 className="truncate text-sm font-medium text-kumo-default">{board ? `${board.project.name} (${board.project.identifier})` : 'Project board'}</h4>
        <p className="truncate text-xs text-kumo-subtle" title={widget.targetRef}>{widget.targetRef}</p>
      </div>
      {state.status === 'stale' && (state.error
        ? <Badge variant="warning">Refresh failed</Badge>
        : <Badge variant="neutral" icon={<Loader size="sm" aria-label="" />}>Refreshing</Badge>)}
      {'pending' in state && state.pending.length > 0 && <Badge variant="warning">
        {state.pending.length} {state.pending.length === 1 ? 'move' : 'moves'} pending approval
      </Badge>}
      <Button size="sm" shape="square" variant="ghost" icon={ArrowClockwise} aria-label="Refresh board"
        disabled={state.status === 'loading'} onClick={refresh} />
      {presentation === 'card' && props.onOpen && <Button size="sm" variant="ghost" icon={ArrowsOutSimple} onClick={props.onOpen}>Open</Button>}
    </header>
    <div className={`min-h-0 flex-1 p-3 ${full ? 'flex flex-col' : ''}`}>
      {state.status === 'loading' && <p aria-busy="true" className="flex items-center gap-2 text-sm text-kumo-subtle"><Loader size="sm" /> Loading the board…</p>}
      {state.status === 'unbound' && <p className="text-sm text-kumo-subtle">
        Not connected. This workspace has no connection to this board. Connect it, for example by asking in the chat, to see it live.
      </p>}
      {state.status === 'error' && <div className="space-y-2">
        <p role="alert" className="text-sm text-kumo-danger">Could not read the board: {state.message}</p>
        <Button size="sm" onClick={refresh}>Try again</Button>
      </div>}
      {state.status === 'stale' && state.error && <p role="alert" className="mb-2 text-xs text-kumo-danger">Showing the last board read; refresh failed: {state.error}</p>}
      {board && (columns.length === 0
        ? <p className="text-sm text-kumo-subtle">No {widget.params.workflow} states to show. {widget.params.showCompleted ? '' : 'Completed and cancelled states are hidden on this card.'}</p>
        : <KanbanBoard board={board} columns={columns} pending={'pending' in state ? state.pending : []} layout={full ? 'full' : 'embedded'}
          onMove={(issue, toState) => move(issue.id, toState.id, issue.revision)} />)}
    </div>
  </article>
}
