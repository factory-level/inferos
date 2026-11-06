import { useEffect, useState } from 'react'
import { Badge, Button, Loader } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { GadgetClient } from '@gadgets/workshop-shared/api'
import type { EmbeddedConsoleWidget, EmbeddedConsoleWidgetUnavailable } from '@gadgets/workshop-shared/operate-console'
import { useOptionalAuthenticatedApi } from '../../AuthContext'
import GadgetUI from '../../GadgetUI'
import type { WikiReference } from './wikiPage'

type GadgetReference = Extract<WikiReference, { kind: 'gadget' }>

/** What the embed shows. Each failure is said in its own words, never as an empty frame. */
type Shown =
  | { status: 'loading' }
  /** The person can't open the console's workspace, or isn't signed in: nothing of it is shown. */
  | { status: 'no-access' }
  | { status: 'unavailable'; reason: EmbeddedConsoleWidgetUnavailable }
  | { status: 'error'; message: string }
  | { status: 'ready'; widget: Extract<EmbeddedConsoleWidget, { status: 'available' }>; stub: RpcStub<GadgetClient> }
  /** It was shown, then the console stopped offering it or the person's access ended. */
  | { status: 'revoked' }

const UNAVAILABLE: Record<EmbeddedConsoleWidgetUnavailable, string> = {
  'not-published': 'Its console is not published, so the widget is not shown.',
  'not-offered': 'Its console no longer offers this widget.',
  'no-ui': 'This widget has no UI to show here; its console offers only its tools.',
}

/**
 * A published console's widget embedded in a Wiki page (FAC-12, inferops ADR 0013 W11). It opens
 * the console's workspace with the person's own access, never the Wiki's connection, resolves the
 * link's source gadget to the console's current publication (`resolveEmbeddedWidget`) and runs that
 * frozen install (`getEmbeddedWidget`), the same instance Operate runs, so the page and Operate
 * share its state. Someone who can't open the workspace sees that, and nothing of the widget.
 * `stale` says the publication now runs another version than the link was written for; the
 * widget is still the console's current one. A capability that breaks while shown, once the
 * console stops offering the widget or the person's access ends, reads as revoked.
 */
export const WikiGadgetEmbed = ({ reference, label }: { reference: GadgetReference; label: string }) => {
  const auth = useOptionalAuthenticatedApi()
  const api = auth?.authenticatedApi
  const [attempt, setAttempt] = useState(0)
  const { workspaceId, consoleId, sourceGadgetId, href } = reference
  // What was shown belongs to the exact reference and attempt it was resolved for, and is used only
  // while those still match: a changed target never renders the previous widget, even before the
  // effect below has run for it.
  const key = `${href}\n${attempt}`
  const [answer, setAnswer] = useState<{ key: string; shown: Shown } | null>(null)
  const shown: Shown = answer?.key === key ? answer.shown : { status: 'loading' }

  useEffect(() => {
    const setShown = (next: Shown | ((state: Shown) => Shown)) => setAnswer(previous => {
      const before = previous?.key === key ? previous.shown : { status: 'loading' } as Shown
      return { key, shown: typeof next === 'function' ? next(before) : next }
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
  }, [api, workspaceId, consoleId, sourceGadgetId, key])

  const title = shown.status === 'ready' ? shown.widget.label : label || 'Embedded widget'
  const stale = shown.status === 'ready' &&
    (shown.widget.blueprintId !== reference.blueprintId || shown.widget.version !== reference.version)
  const again = <Button size="sm" onClick={() => setAttempt(n => n + 1)}>Check again</Button>
  return <article aria-label={`Embedded widget ${title}`} className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-kumo-line bg-kumo-base">
    <header className="flex flex-wrap items-center gap-2 border-b border-kumo-line px-3 py-2">
      <h4 className="min-w-0 flex-1 truncate text-sm font-medium text-kumo-default">{title}</h4>
      {stale && <Badge variant="warning">Updated since it was placed</Badge>}
    </header>
    {shown.status === 'loading' && <p aria-busy="true" className="flex items-center gap-2 p-3 text-sm text-kumo-subtle"><Loader size="sm" /> Loading the widget…</p>}
    {shown.status === 'no-access' && <div className="flex flex-wrap items-center gap-2 p-3 text-sm text-kumo-subtle">
      <p>This widget is in a workspace you can’t open, so it isn’t shown. <code className="break-all">{reference.href}</code></p>{again}
    </div>}
    {shown.status === 'unavailable' && <div className="flex flex-wrap items-center gap-2 p-3 text-sm text-kumo-subtle">
      <p>{UNAVAILABLE[shown.reason]}</p>{again}
    </div>}
    {shown.status === 'error' && <div className="flex flex-wrap items-center gap-2 p-3 text-sm">
      <p role="alert" className="text-kumo-danger">Couldn’t open this widget: {shown.message}</p>{again}
    </div>}
    {shown.status === 'revoked' && <div className="flex flex-wrap items-center gap-2 p-3 text-sm">
      <p role="status" className="text-kumo-subtle">This widget is no longer available to you here. Its console changed, or your access to it ended.</p>{again}
    </div>}
    {shown.status === 'ready' && <GadgetUI key={`${shown.widget.revision}:${shown.widget.gadgetId}`} gadget={shown.stub} height="420px" />}
  </article>
}
