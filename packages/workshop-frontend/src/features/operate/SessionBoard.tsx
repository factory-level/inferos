import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { CanvasProjectBoardWidget } from '@gadgets/workshop-shared/canvas'
import type { OperateBoardView, OperateEvent } from '@gadgets/workshop-shared/operate-session'
import { CanvasBoardFullView } from '../canvas/CanvasBoardFullView'

/** How a board the session shows is presented when no console widget names it (the agent opened it). */
const sessionBoardWidget = (boardRef: string): CanvasProjectBoardWidget => ({
  id: 'session-board', kind: 'inferops.project-board', version: 1, targetRef: boardRef, size: 'full',
  params: { workflow: 'software', showCompleted: false },
})

/**
 * The board the operate session shows, and the issue opened over it, both held in session state:
 * opening an issue's form, closing it and Back are session events, so another tab, a reload or a
 * reconnect shows the same board and issue, and the browser's Back mirrors them. The board is read
 * through `overseer`, the workspace the session names for it, keyed so a switch to another board
 * or workspace starts from nothing rather than showing the last board's reads.
 */
export const SessionBoard = ({ board, overseer, widget, backLabel, onEvent }: {
  board: OperateBoardView
  overseer: RpcStub<Overseer>
  /** The console widget it was opened from, for its presentation params. */
  widget?: CanvasProjectBoardWidget
  backLabel: string
  onEvent: (event: OperateEvent) => void
}) => <CanvasBoardFullView key={`${board.workspaceId} ${board.boardRef}`}
  widget={widget ?? sessionBoardWidget(board.boardRef)} viewTitle={backLabel} overseer={overseer}
  onBack={() => onEvent({ type: 'closeBoard' })}
  openIssue={{
    issueId: board.issueId,
    onChange: issueId => {
      if (issueId !== null) onEvent({ type: 'openIssue', issueId })
      else if (board.issueId !== null) onEvent({ type: 'closeIssue' })
    },
  }} />
