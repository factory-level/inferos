import { useState } from 'react'
import { Button, Select } from '@cloudflare/kumo'
import type { GadgetSummary, WorkpieceId } from '@gadgets/workshop-shared/api'
import {
  CANVAS_ACTION_EVENTS, CANVAS_WIDGET_ACTIONS, canvasRunEvent, parseCanvasRunEvent, type CanvasAttachment, type CanvasNode,
  type CanvasPageOperation, type CanvasRunEvent,
} from '@gadgets/workshop-shared/canvas-model'
import type { CommitFileReader } from '../code/commitFileStore'
import { useGadgetRunTriggers, type HookLister } from './useGadgetRunTriggers'
import { useGadgetWidgetEvents } from './useGadgetWidgetEvents'

/** How a builder names each run outcome an attachment may hear (FAC-116). */
const RUN_EVENT_LABELS: Readonly<Record<CanvasRunEvent, string>> = {
  'run-succeeded': 'Finished', 'run-failed': "Didn't finish", 'run-uncertain': 'Uncertain',
}
const RUN_EVENT_PHRASES: Readonly<Record<CanvasRunEvent, string>> = {
  'run-succeeded': 'finished', 'run-failed': "didn't finish", 'run-uncertain': 'may or may not have finished',
}

const describe = (attachment: CanvasAttachment, pageTitle: (id: string) => string, triggerTitle: (id: number) => string) => {
  const { effect } = attachment
  const run = parseCanvasRunEvent(attachment.on)
  if (run && run !== 'malformed' && effect.kind === 'navigate') {
    return `When a ${triggerTitle(run.trigger)} run ${RUN_EVENT_PHRASES[run.event]}, open ${pageTitle(effect.page)}`
  }
  if (effect.kind === 'navigate') return `On ${attachment.on}, open ${pageTitle(effect.page)}`
  if (effect.kind === 'raise-event') return `On ${attachment.on}, raise ${effect.event} on ${effect.target}`
  if (effect.kind === 'insert-prompt') return `On ${attachment.on}, ${effect.submit ? 'send' : 'put as a draft'} “${effect.text}” in the person’s chat`
  return `On ${attachment.on}, request ${effect.action} of ${effect.target}`
}

/**
 * The attachments of one selected target (FAC-83), edited as a whole through one `setAttachments`
 * operation for that target only. An attachment grants nothing; what it requests is checked at use.
 * Adding offers navigation on a widget's events: a board or Wiki widget's action events, or a
 * gadget widget's own events, the ones its `states.json` declares (FAC-94), and the run results of
 * the triggers its gadget binds (FAC-116; navigation only). Nothing else on the page hears a
 * widget's event unless an attachment wires it; publication refuses an event the published widget
 * doesn't declare, and a trigger its gadget doesn't bind.
 */
export const CanvasAttachmentsEditor = ({ target, node, attachments, pages, busy, reader, hooks, gadgets, onEdit }: {
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
  /** Reads the workspace's triggers, for a gadget widget's run results. */
  hooks: HookLister
  /** The workspace's gadgets, to find a gadget widget's head commit. */
  gadgets: ReadonlyMap<WorkpieceId, GadgetSummary>
  onEdit: (operations: CanvasPageOperation[]) => Promise<boolean>
}) => {
  const [event, setEvent] = useState('')
  const [page, setPage] = useState('')
  const pageTitle = (id: string) => pages.find(item => item.id === id)?.title ?? 'a page no longer in this workspace'
  const save = (next: CanvasAttachment[]) => onEdit([{ type: 'setAttachments', target, attachments: next }])
  const own = useGadgetWidgetEvents(reader, gadgets, node)
  const runs = useGadgetRunTriggers(hooks, node)
  const triggers = runs?.status === 'ready' ? runs.triggers : []
  const triggerTitle = (id: number) => triggers.find(trigger => trigger.id === id)?.title ?? `trigger ${id}`
  const ownEvents: readonly string[] = own ? (own.status === 'ready' ? own.events : [])
    : node?.nodeType === 'widget' && CANVAS_WIDGET_ACTIONS[node.kind].length > 0 ? CANVAS_ACTION_EVENTS : []
  const events = [
    ...ownEvents.map(name => ({ value: name, label: name })),
    ...triggers.flatMap(trigger => (Object.keys(RUN_EVENT_LABELS) as CanvasRunEvent[]).map(run =>
      ({ value: canvasRunEvent(run, trigger.id), label: `${trigger.title}: ${RUN_EVENT_LABELS[run]}` }))),
  ]
  const eventLabel = (value: string) => events.find(item => item.value === value)?.label ?? value
  const offersEvents = events.length > 0

  return <div className="space-y-2">
    <p className="text-xs font-medium uppercase text-kumo-subtle">Attachments</p>
    {attachments.length === 0 && <p className="text-sm text-kumo-subtle">None.</p>}
    <ul className="space-y-1">
      {attachments.map(attachment => <li key={attachment.id} className="flex flex-wrap items-center gap-2 text-sm text-kumo-default">
        <span>{describe(attachment, pageTitle, triggerTitle)}</span>
        <Button size="sm" variant="ghost" disabled={busy} aria-label={`Remove attachment: ${describe(attachment, pageTitle, triggerTitle)}`}
          onClick={() => void save(attachments.filter(item => item.id !== attachment.id))}>Remove</Button>
      </li>)}
    </ul>
    {own?.status === 'loading' && <p className="text-sm text-kumo-subtle">Reading this widget's events…</p>}
    {runs?.status === 'loading' && <p className="text-sm text-kumo-subtle">Reading this gadget's triggers…</p>}
    {(own?.status === 'none' || (own?.status === 'ready' && own.events.length === 0)) && runs?.status === 'ready' && triggers.length === 0 &&
      <p className="text-sm text-kumo-subtle">This widget declares no events and its gadget has no triggers, so nothing on the page can listen for one.</p>}
    {own?.status === 'unavailable' && <p role="alert" className="text-sm text-kumo-danger">{own.message}</p>}
    {runs?.status === 'unavailable' && <p role="alert" className="text-sm text-kumo-danger">{runs.message}</p>}
    {offersEvents && <form className="flex flex-wrap items-end gap-2" onSubmit={async submit => {
      submit.preventDefault()
      if (!event || !page) return
      if (await save([...attachments, { id: crypto.randomUUID(), version: 1, on: event, effect: { kind: 'navigate', page } }])) {
        setEvent(''); setPage('')
      }
    }}>
      <Select label="When" value={event} disabled={busy} onValueChange={value => setEvent(String(value ?? ''))}
        renderValue={value => value ? eventLabel(String(value)) : 'Choose an event'}>
        {events.map(item => <Select.Option key={item.value} value={item.value}>{item.label}</Select.Option>)}
      </Select>
      <Select label="Open" value={page} disabled={busy} onValueChange={value => setPage(String(value ?? ''))}
        renderValue={value => value ? pageTitle(String(value)) : 'Choose a view'}>
        {pages.map(item => <Select.Option key={item.id} value={item.id}>{item.title}</Select.Option>)}
      </Select>
      <Button type="submit" disabled={busy || !event || !page}>Add attachment</Button>
    </form>}
  </div>
}
