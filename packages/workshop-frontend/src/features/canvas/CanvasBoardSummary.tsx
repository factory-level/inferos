import type { CanvasProjectBoardWidget } from '@gadgets/workshop-shared/canvas'

export const CanvasBoardSummary = ({ widget }: { widget: CanvasProjectBoardWidget }) => <>
  <div>
    <h4 className="font-medium text-kumo-default">Project board</h4>
    <p className="break-all text-sm text-kumo-subtle">{widget.targetRef}</p>
  </div>
  <p className="text-sm text-kumo-subtle">
    Not connected. This card only stores a reference to the board. To see the board live, add an
    InferOps Kanban widget for it: Edit layout, then InferOps Kanban, or ask in the chat.
  </p>
</>
