import { Button } from '@cloudflare/kumo'
import type { GadgetSummary, WorkpieceId } from '@gadgets/workshop-shared/api'
import type { CanvasOperation, CanvasSection, CanvasWidget } from '@gadgets/workshop-shared/canvas'
import { CanvasBoardSummary } from './CanvasBoardSummary'
import { gadgetIdOf, widgetSpanClass } from './canvasLayout'

export const CanvasWidgetCard = ({ widget, section, index, busy, gadgets, onEdit }: {
  widget: CanvasWidget
  section: CanvasSection
  index: number
  busy: boolean
  gadgets: ReadonlyMap<WorkpieceId, GadgetSummary>
  onEdit: (operations: CanvasOperation[]) => Promise<boolean>
}) => {
  const configure = (widget: CanvasWidget) => void onEdit([{ type: 'configureWidget', widget }])
  const noun = widget.kind === 'inferos.gadget' ? 'gadget' : widget.kind === 'inferops.wiki' ? 'Wiki' : 'board'
  const label = widget.kind === 'inferos.gadget' ? `Gadget ${gadgets.get(gadgetIdOf(widget.targetRef))?.title ?? widget.targetRef}`
    : widget.kind === 'inferops.wiki' ? `InferMind Wiki ${widget.targetRef}` : `Project board ${widget.targetRef}`
  return <article className={`min-w-0 space-y-3 rounded-lg border border-kumo-line bg-kumo-base p-4 ${widgetSpanClass(widget.size, section.columns)}`} aria-label={label}>
    {widget.kind === 'inferos.gadget'
      ? <div><h4 className="font-medium text-kumo-default">{label}</h4><p className="text-sm text-kumo-subtle">Shows the gadget's live interface outside edit mode.</p></div>
      : widget.kind === 'inferops.wiki'
        ? <div><h4 className="font-medium text-kumo-default">InferMind Wiki</h4><p className="break-all text-sm text-kumo-subtle">{widget.targetRef}</p>
          <p className="text-sm text-kumo-subtle">Opens {widget.params.page === null ? 'its first page' : `the page ${widget.params.page}`}.</p></div>
        : <CanvasBoardSummary widget={widget} />}
    <div role="group" aria-label={`${noun[0]!.toUpperCase()}${noun.slice(1)} width`} className="flex flex-wrap gap-1">
      {(['normal', 'wide', 'full'] as const).map(size => <Button size="sm" key={size} disabled={busy}
        aria-pressed={widget.size === size} onClick={() => configure({ ...widget, size })}>{size}</Button>)}
    </div>
    <div className="flex flex-wrap gap-2">
      {widget.kind === 'inferops.project-board' && <>
        <Button size="sm" disabled={busy} onClick={() => configure({ ...widget, params: { ...widget.params, workflow: widget.params.workflow === 'software' ? 'content' : 'software' } })}>
          Workflow: {widget.params.workflow}
        </Button>
        <Button size="sm" disabled={busy} aria-pressed={widget.params.showCompleted}
          onClick={() => configure({ ...widget, params: { ...widget.params, showCompleted: !widget.params.showCompleted } })}>Show completed</Button>
      </>}
      <Button size="sm" disabled={busy || index === 0} onClick={() => void onEdit([{ type: 'moveWidget', widgetId: widget.id, sectionId: section.id, index: index - 1 }])}>Move {noun} up</Button>
      <Button size="sm" disabled={busy} onClick={() => void onEdit([{ type: 'removeWidget', widgetId: widget.id }])}>Remove {noun}</Button>
    </div>
  </article>
}
