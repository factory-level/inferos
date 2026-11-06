import { useState } from 'react'
import { Button, Select } from '@cloudflare/kumo'
import type { GadgetSummary, WorkpieceId } from '@gadgets/workshop-shared/api'
import { CANVAS_ACTION_EVENTS, CANVAS_WIDGET_ACTIONS, type CanvasAttachment, type CanvasNode, type CanvasPageOperation } from '@gadgets/workshop-shared/canvas-model'
import type { CommitFileReader } from '../code/commitFileStore'
import { useGadgetWidgetEvents } from './useGadgetWidgetEvents'

const describe = (attachment: CanvasAttachment, pageTitle: (id: string) => string) => {
  const { effect } = attachment
  if (effect.kind === 'navigate') return `On ${attachment.on}, open ${pageTitle(effect.page)}`
  if (effect.kind === 'raise-event') return `On ${attachment.on}, raise ${effect.event} on ${effect.target}`
  return `On ${attachment.on}, request ${effect.action} of ${effect.target}`
}

/**
 * The attachments of one selected target (FAC-83), edited as a whole through one `setAttachments`
 * operation for that target only. An attachment grants nothing; what it requests is checked at use.
 * Adding offers navigation on a widget's events: a board or Wiki widget's action events, or a
 * gadget widget's own events, the ones its `states.json` declares (FAC-94). Nothing else on the page
 * hears a widget's event unless an attachment wires it; publication refuses an event the published
 * widget doesn't declare.
 */
export const CanvasAttachmentsEditor = ({ target, node, attachments, pages, busy, reader, gadgets, onEdit }: {
  /** The page or node ID whose attachments these are. */
  target: string
  /** The selected node, or undefined for the page. */
  node: CanvasNode | undefined
  attachments: CanvasAttachment[]
  /** The workspace's pages a navigation may open. */
  pages: { id: string; title: string }[]
  busy: boolean
  /** Reads a placed gadget's `states.json` at its head commit. */
  reader: CommitFileReader
  /** The workspace's gadgets, to find a gadget widget's head commit. */
  gadgets: ReadonlyMap<WorkpieceId, GadgetSummary>
  onEdit: (operations: CanvasPageOperation[]) => Promise<boolean>
}) => {
  const [event, setEvent] = useState('')
  const [page, setPage] = useState('')
  const pageTitle = (id: string) => pages.find(item => item.id === id)?.title ?? 'a page no longer in this workspace'
  const save = (next: CanvasAttachment[]) => onEdit([{ type: 'setAttachments', target, attachments: next }])
  const own = useGadgetWidgetEvents(reader, gadgets, node)
  const events: readonly string[] = own ? (own.status === 'ready' ? own.events : [])
    : node?.nodeType === 'widget' && CANVAS_WIDGET_ACTIONS[node.kind].length > 0 ? CANVAS_ACTION_EVENTS : []
  const offersEvents = events.length > 0

  return <div className="space-y-2">
    <p className="text-xs font-medium uppercase text-kumo-subtle">Attachments</p>
    {attachments.length === 0 && <p className="text-sm text-kumo-subtle">None.</p>}
    <ul className="space-y-1">
      {attachments.map(attachment => <li key={attachment.id} className="flex flex-wrap items-center gap-2 text-sm text-kumo-default">
        <span>{describe(attachment, pageTitle)}</span>
        <Button size="sm" variant="ghost" disabled={busy} aria-label={`Remove attachment: ${describe(attachment, pageTitle)}`}
          onClick={() => void save(attachments.filter(item => item.id !== attachment.id))}>Remove</Button>
      </li>)}
    </ul>
    {own?.status === 'loading' && <p className="text-sm text-kumo-subtle">Reading this widget's events…</p>}
    {(own?.status === 'none' || (own?.status === 'ready' && own.events.length === 0)) && <p className="text-sm text-kumo-subtle">This widget declares no events, so nothing on the page can listen for one.</p>}
    {own?.status === 'unavailable' && <p role="alert" className="text-sm text-kumo-danger">{own.message}</p>}
    {offersEvents && <form className="flex flex-wrap items-end gap-2" onSubmit={async submit => {
      submit.preventDefault()
      if (!event || !page) return
      if (await save([...attachments, { id: crypto.randomUUID(), version: 1, on: event, effect: { kind: 'navigate', page } }])) {
        setEvent(''); setPage('')
      }
    }}>
      <Select label="When" value={event} disabled={busy} onValueChange={value => setEvent(String(value ?? ''))}
        renderValue={value => value ? String(value) : 'Choose an event'}>
        {events.map(name => <Select.Option key={name} value={name}>{name}</Select.Option>)}
      </Select>
      <Select label="Open" value={page} disabled={busy} onValueChange={value => setPage(String(value ?? ''))}
        renderValue={value => value ? pageTitle(String(value)) : 'Choose a view'}>
        {pages.map(item => <Select.Option key={item.id} value={item.id}>{item.title}</Select.Option>)}
      </Select>
      <Button type="submit" disabled={busy || !event || !page}>Add attachment</Button>
    </form>}
  </div>
}
