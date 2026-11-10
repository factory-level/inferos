import { useState } from 'react'
import { Badge, Button, Loader } from '@cloudflare/kumo'
import { useOptionalAuthenticatedApi } from '../../AuthContext'
import GadgetUI from '../../GadgetUI'
import type { WikiReference } from './wikiPage'
import { EMBEDDED_WIDGET_UNAVAILABLE, useEmbeddedConsoleWidget } from './useEmbeddedConsoleWidget'

type GadgetReference = Extract<WikiReference, { kind: 'gadget' }>

const viewerIds = new WeakMap<object, number>()
let nextViewerId = 1
/**
 * A stable id for a signed-in account (`AuthContext.accountKey`, an opaque object per account), for
 * keying an embed so that another account's sign-in remounts it. `anonymous` when nobody is.
 */
export const embedViewerKey = (accountKey: object | null | undefined): string => {
  if (!accountKey) return 'anonymous'
  let id = viewerIds.get(accountKey)
  if (id === undefined) { id = nextViewerId++; viewerIds.set(accountKey, id) }
  return `viewer-${id}`
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
  const viewer = auth?.accountKey ?? null
  const [attempt, setAttempt] = useState(0)
  const { workspaceId, consoleId, sourceGadgetId, href } = reference
  // The link and the attempt are part of what was shown: a changed link or "Check again" never
  // renders the previous answer.
  const shown = useEmbeddedConsoleWidget(api, viewer, { workspaceId, consoleId, sourceGadgetId }, `${href}\n${attempt}`)

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
      <p>{EMBEDDED_WIDGET_UNAVAILABLE[shown.reason]}</p>{again}
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
