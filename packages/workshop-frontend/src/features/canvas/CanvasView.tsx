import type { ReactNode, RefObject } from 'react'
import type { RpcStub } from 'capnweb'
import type { GadgetSummary, Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'
import type { CanvasDefinition } from '@gadgets/workshop-shared/canvas'
import { CanvasBoardWidget } from './CanvasBoardWidget'
import { CanvasGadgetWidget } from './CanvasGadgetWidget'
import { CanvasWikiWidget } from './CanvasWikiWidget'
import { gadgetIdOf, sectionGridClass, widgetSpanClass } from './canvasLayout'
import { useDecidedActionInvalidation } from './useBoardData'

/**
 * Where a view's board and Wiki references resolve when it is not the view's own workspace: a
 * use-role operator's own session workspace, whose connections are made from their own account.
 * `unboundAction` is what a board offers when it is not connected there.
 */
export type CanvasResourceScope = {
  overseer: RpcStub<Overseer>
  unboundAction: (targetRef: string, retry: () => void) => ReactNode
}

export const CanvasView = ({ definition, gadgets, overseer, resourceScope, onOpenWidget, codingDispatch, wikiEditable, scrollRoot }: {
  definition: CanvasDefinition
  /** The pane that clips and scrolls this canvas, for widget preloading. */
  scrollRoot?: RefObject<HTMLElement | null>
  gadgets: ReadonlyMap<WorkpieceId, GadgetSummary>
  overseer: RpcStub<Overseer>
  resourceScope?: CanvasResourceScope
  /** Opens a board widget's full view. Without it, cards offer no full view. */
  onOpenWidget?: (widgetId: string) => void
  /** See `CanvasBoardWidgetProps.codingDispatch`. */
  codingDispatch?: boolean
  /** Offer Wiki section edits; see `CanvasWikiWidget`'s `editable`. */
  wikiEditable?: boolean
}) => {
  const resources = resourceScope?.overseer ?? overseer
  useDecidedActionInvalidation(resources)
  return <div className="space-y-6">
    {definition.sections.length === 0 && <p className="text-sm text-kumo-subtle">This view is empty. Edit the layout to add a section.</p>}
    {definition.sections.map(section => <section key={section.id} aria-labelledby={`canvas-section-${section.id}`} className="@container space-y-3">
      <h2 id={`canvas-section-${section.id}`} className="font-medium text-kumo-default">{section.title}</h2>
      {section.widgets.length === 0 ? <p className="text-sm text-kumo-subtle">No widgets in this section yet.</p>
        : <div className={sectionGridClass(section.columns)}>
          {section.widgets.map(widget => <div key={widget.id} className={`min-w-0 ${widgetSpanClass(widget.size, section.columns)}`}>
            {widget.kind === 'inferos.gadget'
              ? <CanvasGadgetWidget scrollRoot={scrollRoot} widget={widget} gadget={gadgets.get(gadgetIdOf(widget.targetRef))} overseer={overseer} />
              : widget.kind === 'inferops.wiki' ? <CanvasWikiWidget scrollRoot={scrollRoot} widget={widget} overseer={resources} editable={wikiEditable} />
              : <CanvasBoardWidget scrollRoot={scrollRoot} widget={widget} overseer={resources} presentation="card" onOpen={onOpenWidget && (() => onOpenWidget(widget.id))} codingDispatch={codingDispatch}
                  unboundAction={resourceScope && (retry => resourceScope.unboundAction(widget.targetRef, retry))} />}
          </div>)}
        </div>}
    </section>)}
  </div>
}
