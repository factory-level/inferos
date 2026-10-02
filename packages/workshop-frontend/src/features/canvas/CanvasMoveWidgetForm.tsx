import { useDialogSelectPortalContainer } from '../../useDialogSelectPortalContainer'
import { useState } from 'react'
import { Button, Select } from '@cloudflare/kumo'
import type { GadgetSummary, WorkpieceId } from '@gadgets/workshop-shared/api'
import type { CanvasOperation, CanvasSection, CanvasWidget } from '@gadgets/workshop-shared/canvas'
import { gadgetIdOf } from './canvasLayout'

export const CanvasMoveWidgetForm = ({ sections, gadgets, busy, onEdit }: {
  sections: CanvasSection[]
  gadgets: ReadonlyMap<WorkpieceId, GadgetSummary>
  busy: boolean
  onEdit: (operations: CanvasOperation[]) => Promise<boolean>
}) => {
  const selectPortalContainer = useDialogSelectPortalContainer()
  const describe = (widget: CanvasWidget) => widget.kind === 'inferos.gadget'
    ? gadgets.get(gadgetIdOf(widget.targetRef))?.title ?? widget.targetRef : widget.targetRef
  const [widgetId, setWidgetId] = useState('')
  const [destinationId, setDestinationId] = useState('')
  const source = sections.find(section => section.widgets.some(widget => widget.id === widgetId))
  const destination = sections.find(section => section.id === destinationId && section.id !== source?.id)
  return <form className="flex flex-wrap items-end gap-2" aria-label="Move a widget between sections" onSubmit={async event => {
    event.preventDefault()
    if (!source || !destination) return
    const form = event.currentTarget
    if (await onEdit([{ type: 'moveWidget', widgetId, sectionId: destination.id, index: destination.widgets.length }])) {
      setDestinationId('')
      // The successful edit clears busy in the same batch; focus after the controls re-enable.
      requestAnimationFrame(() => {
        if (form.isConnected) form.querySelector<HTMLElement>('[role="combobox"]')?.focus()
      })
    }
  }}>
    <Select container={selectPortalContainer} label="Widget to move" value={source ? widgetId : ''}
      renderValue={value => {
        const owner = sections.find(section => section.widgets.some(widget => widget.id === value))
        const widget = owner?.widgets.find(item => item.id === value)
        return widget ? `${owner?.title}: ${describe(widget)}` : 'Choose a widget'
      }} disabled={busy} placeholder="Choose a widget"
      onValueChange={value => { setWidgetId(String(value ?? '')); setDestinationId('') }}>
      {sections.flatMap(section => section.widgets.map((widget, index) => <Select.Option key={widget.id} value={widget.id}>
        {section.title} · {index + 1}: {describe(widget)}
      </Select.Option>))}
    </Select>
    <Select container={selectPortalContainer} label="Destination section" value={destination?.id ?? ''}
      renderValue={value => sections.find(section => section.id === value)?.title ?? 'Choose a section'} disabled={busy || !source} placeholder="Choose a section"
      onValueChange={value => setDestinationId(String(value ?? ''))}>
      {sections.filter(section => section.id !== source?.id).map(section => <Select.Option key={section.id} value={section.id}>{section.title}</Select.Option>)}
    </Select>
    <Button type="submit" disabled={busy || !source || !destination}>Move widget</Button>
  </form>
}
