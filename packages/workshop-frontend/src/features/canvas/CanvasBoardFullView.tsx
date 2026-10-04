import { Button } from '@cloudflare/kumo'
import { ArrowLeft } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { CanvasProjectBoardWidget } from '@gadgets/workshop-shared/canvas'
import { CanvasBoardWidget } from './CanvasBoardWidget'
import type { OpenIssueControl } from './KanbanBoard'
import { useDecidedActionInvalidation } from './useBoardData'

/**
 * One board widget of a view opened on its own: the same request as its card, served from the
 * scope's shared adapter, with the whole pane for its columns.
 */
export const CanvasBoardFullView = ({ widget, viewTitle, overseer, onBack, codingDispatch, openIssue }: {
  widget: CanvasProjectBoardWidget
  viewTitle: string
  overseer: RpcStub<Overseer>
  onBack: () => void
  /** See `CanvasBoardWidgetProps.codingDispatch`. */
  codingDispatch?: boolean
  /** See `CanvasBoardWidgetProps.openIssue`. */
  openIssue?: OpenIssueControl
}) => {
  useDecidedActionInvalidation(overseer)
  return <div className="flex h-full min-h-0 flex-col gap-3">
    <div><Button size="sm" variant="ghost" icon={ArrowLeft} onClick={onBack}>Back to {viewTitle}</Button></div>
    <div className="min-h-0 flex-1"><CanvasBoardWidget widget={widget} overseer={overseer} presentation="full" codingDispatch={codingDispatch} openIssue={openIssue} /></div>
  </div>
}
