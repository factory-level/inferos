import { useState } from 'react'
import { Button, Select } from '@cloudflare/kumo'
import type { GadgetSummary } from '@gadgets/workshop-shared/api'
import type { CanvasOperation, CanvasSection } from '@gadgets/workshop-shared/canvas'
import { useDialogSelectPortalContainer } from '../../useDialogSelectPortalContainer'
import { gadgetRef } from './canvasLayout'

export const CanvasAddGadgetForm = ({ section, gadgets, busy, onEdit }: {
  section: CanvasSection
  /** Accepted gadgets of this workspace; drafts are excluded by the caller. */
  gadgets: GadgetSummary[]
  busy: boolean
  onEdit: (operations: CanvasOperation[]) => Promise<boolean>
}) => {
  const selectPortalContainer = useDialogSelectPortalContainer()
  const [selected, setSelected] = useState('')
  const gadget = gadgets.find(item => String(item.id) === selected)
  return <form className="flex flex-wrap items-end gap-2" aria-label={`Add a gadget to ${section.title}`} onSubmit={async event => {
    event.preventDefault()
    if (!gadget) return
    const success = await onEdit([{ type: 'addWidget', sectionId: section.id, index: section.widgets.length,
      widget: { id: crypto.randomUUID(), kind: 'inferos.gadget', version: 1, targetRef: gadgetRef(gadget.id), size: 'normal', params: {} } }])
    if (success) setSelected('')
  }}>
    <Select container={selectPortalContainer} label="Gadget" value={gadget ? selected : ''} disabled={busy || gadgets.length === 0}
      placeholder={gadgets.length === 0 ? 'No accepted gadgets yet' : 'Choose a gadget'}
      renderValue={value => gadgets.find(item => String(item.id) === value)?.title ?? 'Choose a gadget'}
      onValueChange={value => setSelected(String(value ?? ''))}>
      {gadgets.map(item => <Select.Option key={item.id} value={String(item.id)}>{item.title}</Select.Option>)}
    </Select>
    <Button type="submit" disabled={busy || !gadget || section.widgets.length >= 48}>Add gadget</Button>
  </form>
}
