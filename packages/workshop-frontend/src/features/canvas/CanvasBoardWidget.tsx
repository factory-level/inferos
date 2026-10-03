import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { CanvasProjectBoardWidget } from '@gadgets/workshop-shared/canvas'
import { CanvasBoardSummary } from './CanvasBoardSummary'
import { useBoardData } from './useBoardData'

/** A live board card: its request served by the scope's shared adapter. */
export const CanvasBoardWidget = ({ widget, overseer }: { widget: CanvasProjectBoardWidget; overseer: RpcStub<Overseer> }) => {
  const { state } = useBoardData(overseer, widget)
  return <article aria-label={`Project board ${widget.targetRef}`} className="space-y-3 rounded-lg border border-kumo-line bg-kumo-base p-4">
    <CanvasBoardSummary widget={widget} state={state} />
  </article>
}
