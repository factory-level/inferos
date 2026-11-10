import { useEffect, useState } from 'react'
import { Badge, Button } from '@cloudflare/kumo'
import type { GadgetSummary, WorkpieceId } from '@gadgets/workshop-shared/api'
import { CANVAS_GADGET_REF } from '@gadgets/workshop-shared/canvas'
import type { CanvasWidgetNode } from '@gadgets/workshop-shared/canvas-model'
import { applyWidgetTransition, parseWidgetStates, widgetEventsFrom, WIDGET_STATES_FILE, type WidgetStateMachine } from '@gadgets/workshop-shared/widget-state'
import { commitFileStore, type CommitFileReader } from '../code/commitFileStore'

type Machine = { status: 'loading' } | { status: 'ready'; machine: WidgetStateMachine } | { status: 'none' } | { status: 'unreadable'; message: string }

/**
 * A gadget widget in the simulated draft preview (FAC-96). It runs no gadget code: no frame, no
 * server, no bindings. Its local states come from `states.json` at the gadget's head commit, read
 * from git, and move in memory (`applyWidgetTransition`); each event is reported (`onEvent`) so the
 * page can run what it is wired to. A gadget without states shows its title only.
 */
export const PreviewGadgetWidget = ({ node, gadgets, reader, onEvent }: {
  node: CanvasWidgetNode
  gadgets: ReadonlyMap<WorkpieceId, GadgetSummary>
  reader: CommitFileReader
  onEvent: (targetRef: string, event: string) => void
}) => {
  const match = CANVAS_GADGET_REF.exec(node.targetRef)
  const gadget = match ? gadgets.get(Number(match[1])) : undefined
  const commitId = gadget?.commitId ?? null
  const [read, setRead] = useState<{ commitId: string; machine: Machine } | null>(null)
  const [state, setState] = useState<{ commitId: string; state: string } | null>(null)
  useEffect(() => {
    if (commitId === null) return
    let current = true
    commitFileStore.readFiles(reader, commitId, [WIDGET_STATES_FILE]).then(files => {
      if (!current) return
      const file = files.get(WIDGET_STATES_FILE)
      if (!file || file.kind === 'absent') { setRead({ commitId, machine: { status: 'none' } }); return }
      if (file.kind === 'unreadable') { setRead({ commitId, machine: { status: 'unreadable', message: file.message } }); return }
      try {
        setRead({ commitId, machine: { status: 'ready', machine: parseWidgetStates(file.text) } })
      } catch (error) {
        setRead({ commitId, machine: { status: 'unreadable', message: error instanceof Error ? error.message : String(error) } })
      }
    }, (error: unknown) => {
      if (current) setRead({ commitId, machine: { status: 'unreadable', message: error instanceof Error ? error.message : String(error) } })
    })
    return () => { current = false }
  }, [reader, commitId])

  const machine: Machine = commitId === null ? { status: 'none' } : read?.commitId === commitId ? read.machine : { status: 'loading' }
  const ready = machine.status === 'ready' ? machine.machine : null
  const now = ready ? (state?.commitId === commitId ? state.state : ready.initial) : null
  return <article aria-label={`Preview ${gadget?.title ?? node.targetRef}`} className="space-y-2 rounded-lg border border-dashed border-kumo-line p-3 text-sm">
    <div className="flex flex-wrap items-center gap-2">
      <p className="font-medium text-kumo-default">{gadget?.title ?? 'Unavailable gadget'}</p>
      {now && <Badge variant="neutral">{now}</Badge>}
    </div>
    <p className="text-kumo-subtle">The widget doesn’t run in preview; its local states do.</p>
    {machine.status === 'loading' && <p aria-busy="true" className="text-xs text-kumo-subtle">Reading its states…</p>}
    {machine.status === 'unreadable' && <p role="alert" className="text-xs text-kumo-danger">Its states.json can’t be read: {machine.message}</p>}
    {ready && now && <div className="flex flex-wrap gap-2">
      {widgetEventsFrom(ready, now).map(event => <Button key={event} size="sm" variant="secondary" onClick={() => {
        setState({ commitId: commitId!, state: applyWidgetTransition(ready, now, event) })
        onEvent(node.targetRef, event)
      }}>{event}</Button>)}
    </div>}
  </article>
}
