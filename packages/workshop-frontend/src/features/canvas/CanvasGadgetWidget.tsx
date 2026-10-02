import { useEffect, useRef, useState, type RefObject } from 'react'
import type { RpcStub } from 'capnweb'
import type { GadgetClient, GadgetSummary, Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'
import type { CanvasGadgetWidget as Widget } from '@gadgets/workshop-shared/canvas'
import GadgetUI from '../../GadgetUI'

// Latches once the element has been on screen, so a gadget far down a long canvas doesn't fetch
// and boot its bundle until someone scrolls to it. Without IntersectionObserver, load eagerly.
const useHasBeenOnScreen = (ref: RefObject<HTMLElement | null>) => {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    if (seen || !ref.current) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setSeen(true)
    }, { rootMargin: '200px' })
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [ref, seen])
  return seen
}

export const CanvasGadgetWidget = ({ widget, gadget, overseer }: {
  widget: Widget
  /** The live summary of the referenced gadget, or undefined if the workspace has no such gadget. */
  gadget: GadgetSummary | undefined
  overseer: RpcStub<Overseer>
}) => {
  const ref = useRef<HTMLElement>(null)
  const visible = useHasBeenOnScreen(ref)
  const [client, setClient] = useState<{ id: WorkpieceId; stub: RpcStub<GadgetClient> } | null>(null)
  // A draft belongs to its conversation until accepted, so it is never shown on a shared canvas.
  const gadgetId = gadget && gadget.chatId === undefined ? gadget.id : undefined

  useEffect(() => {
    if (gadgetId === undefined) return
    const stub = overseer.getGadget(gadgetId)
    setClient({ id: gadgetId, stub })
    return () => { stub[Symbol.dispose]() }
  }, [overseer, gadgetId])

  const stub = client && client.id === gadgetId ? client.stub : null
  const title = gadget?.title ?? 'Unavailable gadget'
  return <article ref={ref} aria-label={title} className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-kumo-line bg-kumo-base">
    <h3 className="truncate border-b border-kumo-line px-3 py-2 text-sm font-medium text-kumo-default">{title}</h3>
    {gadget === undefined ? <p className="p-4 text-sm text-kumo-subtle">This gadget is no longer in the workspace. Remove it from the layout or choose another gadget.</p>
      : gadgetId === undefined ? <p className="p-4 text-sm text-kumo-subtle">This gadget is still a draft in a conversation. Accept the conversation's changes to show it here.</p>
      : stub && <GadgetUI key={gadget.commitId} gadget={stub} isVisible={visible}
        height={widget.size === 'full' ? '560px' : '420px'} />}
  </article>
}
