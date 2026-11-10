import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, GadgetClient, WorkpieceId } from '@gadgets/workshop-shared/api'
import type { EmbeddedConsoleWidget, EmbeddedConsoleWidgetUnavailable } from '@gadgets/workshop-shared/operate-console'

/** What an embedded console widget shows. Each failure is its own state, never an empty frame. */
export type EmbeddedWidgetShown =
  | { status: 'loading' }
  /** The person can't open the console's workspace, or isn't signed in: nothing of it is shown. */
  | { status: 'no-access' }
  | { status: 'unavailable'; reason: EmbeddedConsoleWidgetUnavailable }
  | { status: 'error'; message: string }
  | { status: 'ready'; widget: Extract<EmbeddedConsoleWidget, { status: 'available' }>; stub: RpcStub<GadgetClient> }
  /** It was shown, then the console stopped offering it or the person's access ended. */
  | { status: 'revoked' }

/** Why a console widget is not shown, in a person's words. */
export const EMBEDDED_WIDGET_UNAVAILABLE: Record<EmbeddedConsoleWidgetUnavailable, string> = {
  'not-published': 'Its console is not published, so the widget is not shown.',
  'not-offered': 'Its console no longer offers this widget.',
  'no-ui': 'This widget has no UI to show here; its console offers only its tools.',
}

/**
 * Opens a published console's widget as a Wiki page embeds it (FAC-12), and as a person's canvas
 * places it (FAC-13): the console's workspace opened with the person's own access, the source
 * gadget resolved to the console's current publication (`resolveEmbeddedWidget`), and that frozen
 * install run (`getEmbeddedWidget`). What was shown belongs to the exact target, `attempt` and
 * viewer it was resolved for, so a changed target or a newly signed-in account never renders the
 * previous answer. Both stubs are disposed when the target changes or the caller unmounts.
 */
export const useEmbeddedConsoleWidget = (
  api: RpcStub<AuthenticatedApi> | undefined,
  viewer: object | null,
  target: { workspaceId: string; consoleId: string; sourceGadgetId: WorkpieceId },
  attempt: string,
): EmbeddedWidgetShown => {
  const { workspaceId, consoleId, sourceGadgetId } = target
  const key = `${workspaceId}\n${consoleId}\n${sourceGadgetId}\n${attempt}`
  const [answer, setAnswer] = useState<{ key: string; viewer: object | null; api: unknown; shown: EmbeddedWidgetShown } | null>(null)
  const shown: EmbeddedWidgetShown = answer?.key === key && answer.viewer === viewer && answer.api === api
    ? answer.shown : { status: 'loading' }

  useEffect(() => {
    const setShown = (next: EmbeddedWidgetShown | ((state: EmbeddedWidgetShown) => EmbeddedWidgetShown)) => setAnswer(previous => {
      const before = previous?.key === key && previous.viewer === viewer && previous.api === api
        ? previous.shown : { status: 'loading' } as EmbeddedWidgetShown
      return { key, viewer, api, shown: typeof next === 'function' ? next(before) : next }
    })
    if (!api) { setShown({ status: 'no-access' }); return }
    let current = true
    let stub: RpcStub<GadgetClient> | null = null
    const workspace = api.openGadget(workspaceId)
    ;(async () => {
      let widget: EmbeddedConsoleWidget
      try {
        widget = await workspace.resolveEmbeddedWidget(consoleId, sourceGadgetId)
      } catch {
        // Not opening the workspace says nothing about whether it, or the widget, exists.
        if (current) setShown({ status: 'no-access' })
        return
      }
      if (!current) return
      if (widget.status === 'unavailable') { setShown({ status: 'unavailable', reason: widget.reason }); return }
      stub = workspace.getEmbeddedWidget(widget.consoleId, widget.revision, widget.gadgetId)
      stub.onRpcBroken?.(() => { if (current) setShown(state => state.status === 'ready' ? { status: 'revoked' } : state) })
      try {
        await stub.getId()
      } catch (error) {
        if (current) setShown({ status: 'error', message: error instanceof Error ? error.message : String(error) })
        return
      }
      if (current) setShown({ status: 'ready', widget, stub })
    })()
    return () => {
      current = false
      stub?.[Symbol.dispose]()
      workspace[Symbol.dispose]()
    }
  }, [api, viewer, workspaceId, consoleId, sourceGadgetId, key])

  return shown
}
