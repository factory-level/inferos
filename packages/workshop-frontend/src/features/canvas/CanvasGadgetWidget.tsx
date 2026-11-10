import { useEffect, useRef, useState, type RefObject } from 'react'
import type { RpcStub } from 'capnweb'
import type { GadgetClient, GadgetSummary, Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'
import type { CanvasGadgetWidget as Widget } from '@gadgets/workshop-shared/canvas'
import GadgetUI from '../../GadgetUI'
import { useHasBeenOnScreen } from './useHasBeenOnScreen'
import { WidgetStateBar } from './WidgetStateBar'
import { useOperateSession } from '../operate/OperateSessionContext'
import { useInsertOperatePrompt } from '../operate/OperatePromptContext'

/**
 * The published console revision a screen is shown from; its widgets open through it. With the
 * console's `workspaceId`, inside an operate session, a widget declaring local states shows them.
 */
export type CanvasConsoleRevision = { consoleId: string; revision: string; workspaceId?: string }

export const CanvasGadgetWidget = ({ widget, gadget, overseer, offeredBy, scrollRoot }: {
  widget: Widget
  scrollRoot?: RefObject<HTMLElement | null>
  /** The live summary of the referenced gadget, or undefined if the workspace has no such gadget. */
  gadget: GadgetSummary | undefined
  overseer: RpcStub<Overseer>
  /**
   * Set on a published console's screen, whose gadgets all open through that console revision,
   * which is how the use role reaches them: a frozen install is the widget the revision offers
   * (`getConsoleWidget`), and any other gadget is an app it fenced at the commit it published
   * (`getConsoleApp`). Once a builder changes such an app, the console refuses it in its own
   * words, which are shown here in place of the app.
   */
  offeredBy?: CanvasConsoleRevision
}) => {
  const ref = useRef<HTMLElement>(null)
  const operate = useOperateSession()
  const insertPrompt = useInsertOperatePrompt()
  const visible = useHasBeenOnScreen(ref, false, scrollRoot)
  const [client, setClient] = useState<{ id: WorkpieceId; stub: RpcStub<GadgetClient> } | null>(null)
  // A draft belongs to its conversation until accepted, so it is never shown on a shared canvas.
  const gadgetId = gadget && gadget.chatId === undefined ? gadget.id : undefined

  const consoleId = offeredBy?.consoleId
  const revision = offeredBy?.revision
  const isWidget = !!gadget?.frozenFor
  // The widget a published revision offers (a frozen install); apps there have no local states.
  const offeredWidget = offeredBy && isWidget ? offeredBy : undefined
  // The state its bar shows, which the widget's own frame is told so it can draw it.
  const [widgetState, setWidgetState] = useState<string | null>(null)
  useEffect(() => {
    if (gadgetId === undefined) return
    const stub = consoleId === undefined || revision === undefined ? overseer.getGadget(gadgetId)
      : isWidget ? overseer.getConsoleWidget(consoleId, revision, gadgetId)
      : overseer.getConsoleApp(consoleId, revision, gadgetId)
    setClient({ id: gadgetId, stub })
    return () => { stub[Symbol.dispose]() }
  }, [overseer, gadgetId, consoleId, revision, isWidget])

  const stub = client && client.id === gadgetId ? client.stub : null
  const commitId = gadget?.commitId
  // A console app is checked before it is shown, and again whenever its commit moves, so a
  // builder's change shows the console's refusal rather than a broken frame. The answer is keyed to
  // the stub and commit it was read for, so a newer open is never shown an older one.
  const [fence, setFence] = useState<{ stub: RpcStub<GadgetClient>; commitId: string | undefined; refusal: string | null } | null>(null)
  const checksFence = consoleId !== undefined && !isWidget
  useEffect(() => {
    if (!stub || !checksFence) return
    let current = true
    stub.getTitle().then(
      () => { if (current) setFence({ stub, commitId, refusal: null }) },
      (error: unknown) => { if (current) setFence({ stub, commitId, refusal: error instanceof Error ? error.message : String(error) }) })
    return () => { current = false }
  }, [stub, checksFence, commitId])
  const answered = fence && fence.stub === stub && fence.commitId === commitId ? fence : null
  const refused = checksFence ? answered?.refusal ?? null : null
  const shown = checksFence ? answered !== null && answered.refusal === null : true
  const title = gadget?.title ?? 'Unavailable gadget'
  return <article ref={ref} aria-label={title} className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-kumo-line bg-kumo-base shadow-md">
    <h3 className="truncate border-b border-kumo-line px-3 py-2 text-sm font-medium text-kumo-default">{title}</h3>
    {/* The widget's own state (FAC-86), only for a published console's frozen widget in Operate. */}
    {offeredWidget?.workspaceId !== undefined && operate?.session && gadgetId !== undefined &&
      <WidgetStateBar session={operate.session.stub}
        widgetRef={{ workspaceId: offeredWidget.workspaceId, consoleId: offeredWidget.consoleId, revision: offeredWidget.revision, gadgetId }}
        onStateChange={setWidgetState} onPrompt={insertPrompt ?? undefined} />}
    {gadget === undefined ? <p className="p-4 text-sm text-kumo-subtle">This gadget is no longer in the workspace. Remove it from the layout or choose another gadget.</p>
      : gadgetId === undefined ? <p className="p-4 text-sm text-kumo-subtle">This gadget is still a draft in a conversation. Accept the conversation's changes to show it here.</p>
      : refused ? <p role="status" className="p-4 text-sm text-kumo-subtle">{refused}</p>
      : stub && shown && <GadgetUI key={gadget.commitId} gadget={stub} isVisible={visible}
        height={widget.size === 'full' ? '560px' : '420px'} widgetState={widgetState} />}
  </article>
}
