import { useDialogSelectPortalContainer } from '../../useDialogSelectPortalContainer'
import { useState } from 'react'
import { Button, Select } from '@cloudflare/kumo'
import type { CanvasOperation, CanvasSection } from '@gadgets/workshop-shared/canvas'

export const CanvasMoveWidgetForm = ({ sections, busy, onEdit }: {
  sections: CanvasSection[]
  busy: boolean
  onEdit: (operations: CanvasOperation[]) => Promise<boolean>
}) => {
  const selectPortalContainer = useDialogSelectPortalContainer()
  const [widgetId, setWidgetId] = useState('')
  const [destinationId, setDestinationId] = useState('')
  const source = sections.find(section => section.widgets.some(widget => widget.id === widgetId))
  const destination = sections.find(section => section.id === destinationId && section.id !== source?.id)
  return <form className="flex flex-wrap items-end gap-2" aria-label="Move board between sections" onSubmit={async event => {
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
    <Select container={selectPortalContainer} label="Board to move" value={source ? widgetId : ''}
      renderValue={value => {
        const owner = sections.find(section => section.widgets.some(widget => widget.id === value))
        const widget = owner?.widgets.find(item => item.id === value)
        return widget ? `${owner?.title}: ${widget.targetRef}` : 'Choose a board'
      }} disabled={busy} placeholder="Choose a board"
      onValueChange={value => { setWidgetId(String(value ?? '')); setDestinationId('') }}>
      {sections.flatMap(section => section.widgets.map((widget, index) => <Select.Option key={widget.id} value={widget.id}>
        {section.title} · {index + 1}: {widget.targetRef}
      </Select.Option>))}
    </Select>
    <Select container={selectPortalContainer} label="Destination section" value={destination?.id ?? ''}
      renderValue={value => sections.find(section => section.id === value)?.title ?? 'Choose a section'} disabled={busy || !source} placeholder="Choose a section"
      onValueChange={value => setDestinationId(String(value ?? ''))}>
      {sections.filter(section => section.id !== source?.id).map(section => <Select.Option key={section.id} value={section.id}>{section.title}</Select.Option>)}
    </Select>
    <Button type="submit" disabled={busy || !source || !destination}>Move board</Button>
  </form>
}
