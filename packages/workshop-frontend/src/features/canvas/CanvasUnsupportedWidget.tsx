import type { CanvasUnsupportedWidget as Widget } from '@gadgets/workshop-shared/canvas'

/**
 * A widget a newer InferOS stored, shown in its place (FAC-9): it reads nothing, offers nothing,
 * and says what it needs. The canvas holding it can't be changed here.
 */
export const CanvasUnsupportedWidget = ({ widget }: { widget: Widget }) =>
  <div role="note" className="min-w-0 rounded-xl border border-dashed border-kumo-line bg-kumo-base p-4 text-sm text-kumo-subtle">
    This widget needs a newer InferOS (<bdi className="break-all">{widget.storedKind}</bdi>).
  </div>
