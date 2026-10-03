import type { CanvasProjectBoardWidget } from '@gadgets/workshop-shared/canvas'
import { visibleColumns, type BoardState } from './boardData'

/**
 * A board card's reference and, when the card is live, what the adapter holds for it: the
 * states and their card counts, or why there is nothing to show. Without a state (edit mode)
 * only the reference is shown. Kanban rendering and issue operations are separate work.
 */
export const CanvasBoardSummary = ({ widget, state }: { widget: CanvasProjectBoardWidget; state?: BoardState }) => <>
  <div>
    <h4 className="font-medium text-kumo-default">Project board</h4>
    <p className="break-all text-sm text-kumo-subtle">{widget.targetRef}</p>
  </div>
  {state?.status === 'loading' && <p className="text-sm text-kumo-subtle" aria-busy="true">Loading the board…</p>}
  {state?.status === 'unbound' && <p className="text-sm text-kumo-subtle">
    Not connected. This workspace has no connection to this board. Connect it, for example by asking in the chat, to see it live.
  </p>}
  {state?.status === 'error' && <p role="alert" className="text-sm text-kumo-danger">Could not read the board: {state.message}</p>}
  {(state?.status === 'ready' || state?.status === 'stale') && <>
    <p className="text-sm text-kumo-subtle">{state.board.project.name} ({state.board.project.identifier})
      {state.status === 'stale' && <> · {state.error ? `refresh failed: ${state.error}` : 'refreshing…'}</>}
      {state.pending.length > 0 && <> · {state.pending.length} move{state.pending.length === 1 ? '' : 's'} pending approval</>}
    </p>
    <ul className="flex flex-wrap gap-2 text-sm" aria-label="States">
      {visibleColumns(state.board, widget.params).map(({ state: column, issues }) =>
        <li key={column.id} className="rounded border border-kumo-line px-2 py-1 text-kumo-default">{column.name} <span className="text-kumo-subtle">{issues.length}</span></li>)}
    </ul>
  </>}
</>
