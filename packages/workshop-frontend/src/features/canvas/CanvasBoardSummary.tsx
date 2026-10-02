import type { CanvasProjectBoardWidget } from '@gadgets/workshop-shared/canvas'

export const CanvasBoardSummary = ({ widget }: { widget: CanvasProjectBoardWidget }) => <>
  <div>
    <h4 className="font-medium text-kumo-default">Project board</h4>
    <p className="break-all text-sm text-kumo-subtle">{widget.targetRef}</p>
  </div>
  <p className="text-sm text-kumo-subtle">Not connected. This view stores a reference; an authorized InferOps connection is required to load its board.</p>
</>
