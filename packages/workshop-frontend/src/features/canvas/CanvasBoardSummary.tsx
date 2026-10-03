import type { CanvasProjectBoardWidget } from '@gadgets/workshop-shared/canvas'

/** A board card's reference, for edit mode, where nothing is read. The live board is `CanvasBoardWidget`. */
export const CanvasBoardSummary = ({ widget }: { widget: CanvasProjectBoardWidget }) => <div>
  <h4 className="font-medium text-kumo-default">Project board</h4>
  <p className="break-all text-sm text-kumo-subtle">{widget.targetRef}</p>
</div>
