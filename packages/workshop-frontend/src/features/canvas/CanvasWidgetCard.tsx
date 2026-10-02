import { Button } from '@cloudflare/kumo'
import type { CanvasOperation, CanvasSection, CanvasWidget } from '@gadgets/workshop-shared/canvas'

export const CanvasWidgetCard = ({ widget, section, index, busy, onEdit }: {
  widget: CanvasWidget
  section: CanvasSection
  index: number
  busy: boolean
  onEdit: (operations: CanvasOperation[]) => Promise<boolean>
}) => {
  const span = widget.size === 'full' ? 'lg:col-span-full' : widget.size === 'wide' && section.columns > 1 ? 'lg:col-span-2' : ''
  const configure = (widget: CanvasWidget) => void onEdit([{ type: 'configureWidget', widget }])
  return <article className={`min-w-0 space-y-3 rounded-lg border border-kumo-line bg-kumo-base p-4 ${span}`} aria-label={`Project board ${widget.targetRef}`}>
    <div><h4 className="font-medium text-kumo-default">Project board</h4><p className="break-all text-sm text-kumo-subtle">{widget.targetRef}</p></div>
    <p className="text-sm text-kumo-subtle">Not connected. This view stores a reference; an authorized InferOps connection is required to load its board.</p>
    <div role="group" aria-label="Board width" className="flex flex-wrap gap-1">
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
      <Button size="sm" disabled={busy || index === 0} onClick={() => void onEdit([{ type: 'moveWidget', widgetId: widget.id, sectionId: section.id, index: index - 1 }])}>Move board up</Button>
      <Button size="sm" disabled={busy} onClick={() => void onEdit([{ type: 'removeWidget', widgetId: widget.id }])}>Remove board</Button>
    </div>
  </article>
}
