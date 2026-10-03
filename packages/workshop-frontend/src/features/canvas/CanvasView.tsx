import type { RpcStub } from 'capnweb'
import type { GadgetSummary, Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'
import type { CanvasDefinition } from '@gadgets/workshop-shared/canvas'
import { CanvasBoardWidget } from './CanvasBoardWidget'
import { CanvasGadgetWidget } from './CanvasGadgetWidget'
import { gadgetIdOf, sectionGridClass, widgetSpanClass } from './canvasLayout'
import { useDecidedActionInvalidation } from './useBoardData'

export const CanvasView = ({ definition, gadgets, overseer, onOpenWidget }: {
  definition: CanvasDefinition
  gadgets: ReadonlyMap<WorkpieceId, GadgetSummary>
  overseer: RpcStub<Overseer>
  /** Opens a board widget's full view. Without it, cards offer no full view. */
  onOpenWidget?: (widgetId: string) => void
}) => {
  useDecidedActionInvalidation(overseer)
  return <div className="space-y-6">
    {definition.sections.length === 0 && <p className="text-sm text-kumo-subtle">This view is empty. Edit the layout to add a section.</p>}
    {definition.sections.map(section => <section key={section.id} aria-labelledby={`canvas-section-${section.id}`} className="@container space-y-3">
      <h2 id={`canvas-section-${section.id}`} className="font-medium text-kumo-default">{section.title}</h2>
      {section.widgets.length === 0 ? <p className="text-sm text-kumo-subtle">No widgets in this section yet.</p>
        : <div className={sectionGridClass(section.columns)}>
          {section.widgets.map(widget => <div key={widget.id} className={`min-w-0 ${widgetSpanClass(widget.size, section.columns)}`}>
            {widget.kind === 'inferos.gadget'
              ? <CanvasGadgetWidget widget={widget} gadget={gadgets.get(gadgetIdOf(widget.targetRef))} overseer={overseer} />
              : <CanvasBoardWidget widget={widget} overseer={overseer} presentation="card" onOpen={onOpenWidget && (() => onOpenWidget(widget.id))} />}
          </div>)}
        </div>}
    </section>)}
  </div>
}
