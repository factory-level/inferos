import { useEffect, useRef, useState, type RefObject } from 'react'
import type { RpcStub } from 'capnweb'
import type { GadgetClient, GadgetSummary, Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'
import type { CanvasGadgetWidget as Widget } from '@gadgets/workshop-shared/canvas'
import GadgetUI from '../../GadgetUI'
import { useHasBeenOnScreen } from './useHasBeenOnScreen'

/** The published console revision a screen is shown from; its widgets open through it. */
export type CanvasConsoleRevision = { consoleId: string; revision: string }

export const CanvasGadgetWidget = ({ widget, gadget, overseer, offeredBy, scrollRoot }: {
  widget: Widget
  scrollRoot?: RefObject<HTMLElement | null>
  /** The live summary of the referenced gadget, or undefined if the workspace has no such gadget. */
  gadget: GadgetSummary | undefined
  overseer: RpcStub<Overseer>
  /**
   * Set on a published console's screen. A frozen install there is the widget that revision
   * offers, opened through the console (`getConsoleWidget`), which is how the use role reaches it;
   * any other gadget (an app, say) opens as before.
   */
  offeredBy?: CanvasConsoleRevision
}) => {
  const ref = useRef<HTMLElement>(null)
  const visible = useHasBeenOnScreen(ref, false, scrollRoot)
  const [client, setClient] = useState<{ id: WorkpieceId; stub: RpcStub<GadgetClient> } | null>(null)
  // A draft belongs to its conversation until accepted, so it is never shown on a shared canvas.
  const gadgetId = gadget && gadget.chatId === undefined ? gadget.id : undefined

  const offered = offeredBy && gadget?.frozenFor ? offeredBy : undefined
  const consoleId = offered?.consoleId
  const revision = offered?.revision
  useEffect(() => {
    if (gadgetId === undefined) return
    const stub = consoleId !== undefined && revision !== undefined
      ? overseer.getConsoleWidget(consoleId, revision, gadgetId)
      : overseer.getGadget(gadgetId)
    setClient({ id: gadgetId, stub })
    return () => { stub[Symbol.dispose]() }
  }, [overseer, gadgetId, consoleId, revision])

  const stub = client && client.id === gadgetId ? client.stub : null
  const title = gadget?.title ?? 'Unavailable gadget'
  return <article ref={ref} aria-label={title} className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-kumo-line bg-kumo-base shadow-md">
    <h3 className="truncate border-b border-kumo-line px-3 py-2 text-sm font-medium text-kumo-default">{title}</h3>
    {gadget === undefined ? <p className="p-4 text-sm text-kumo-subtle">This gadget is no longer in the workspace. Remove it from the layout or choose another gadget.</p>
      : gadgetId === undefined ? <p className="p-4 text-sm text-kumo-subtle">This gadget is still a draft in a conversation. Accept the conversation's changes to show it here.</p>
      : stub && <GadgetUI key={gadget.commitId} gadget={stub} isVisible={visible}
        height={widget.size === 'full' ? '560px' : '420px'} />}
  </article>
}
