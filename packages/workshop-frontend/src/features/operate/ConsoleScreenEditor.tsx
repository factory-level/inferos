import { useState } from 'react'
import { Button, Input, Select } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { GadgetSummary, Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'
import { applyCanvasOperations, parseCanvasDefinition, type CanvasCatalog, type CanvasDefinition, type CanvasOperation } from '@gadgets/workshop-shared/canvas'
import { CanvasSectionEditor } from '../canvas/CanvasSectionEditor'
import { CanvasMoveWidgetForm } from '../canvas/CanvasMoveWidgetForm'
import { invalidateWorkspaceScreens } from '../../pages/inferops-canvas/useWorkspaceScreens'

/** A local screen draft; only Save screen persists it in the selected workspace. */
export const ConsoleScreenEditor = ({ overseer, gadgets, catalog, onSaved, onCancel }: {
  overseer: RpcStub<Overseer>
  gadgets: ReadonlyMap<WorkpieceId, GadgetSummary>
  catalog: CanvasCatalog
  onSaved: (screen: CanvasDefinition) => void
  onCancel: () => void
}) => {
  const [screen, setScreen] = useState<CanvasDefinition>(() => ({
    schemaVersion: 1, id: crypto.randomUUID(), revision: '0', title: 'New screen',
    sections: [{ id: crypto.randomUUID(), title: 'Overview', columns: 2, widgets: [] }],
  }))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [template, setTemplate] = useState(':blank')
  const acceptedGadgets = [...gadgets.values()].filter(gadget => gadget.chatId === undefined)
  const edit = async (operations: CanvasOperation[]) => {
    try {
      setScreen(applyCanvasOperations(screen, screen.revision, operations))
      setError(null)
      return true
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Check this layout and try again.')
      return false
    }
  }
  const save = async () => {
    if (saving) return
    setSaving(true); setError(null)
    try {
      const content = parseCanvasDefinition(screen)
      const saved = parseCanvasDefinition(await overseer.createCanvas({ title: content.title, sections: content.sections }))
      invalidateWorkspaceScreens()
      onSaved(saved)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save this screen. Your draft is still here.')
    } finally { setSaving(false) }
  }
  return <section aria-label="New screen" className="space-y-5 rounded-xl border border-kumo-line bg-kumo-base p-5">
    <div>
      <h2 className="font-semibold text-kumo-default">Create a screen</h2>
      <p className="mt-1 text-sm text-kumo-subtle">Saved screens stay in this workspace, even if you cancel console setup.</p>
    </div>
    <div className="flex flex-wrap items-end gap-3">
      <Input label="Screen name" value={screen.title} maxLength={120} required disabled={saving}
        onChange={event => setScreen({ ...screen, title: event.target.value })} />
      {catalog.screens.length > 0 && <Select label="Screen template" value={template} disabled={saving} renderValue={value => catalog.screens.find(item => item.id === value)?.content.title ?? 'Blank screen'}
        onValueChange={value => {
          const next = String(value)
          const content = catalog.screens.find(item => item.id === next)?.content
          setTemplate(next)
          setScreen({ ...screen, sections: content ? structuredClone(content.sections) : [{ id: crypto.randomUUID(), title: 'Overview', columns: 2, widgets: [] }] })
        }}>
        <Select.Option value=":blank">Blank screen</Select.Option>
        {catalog.screens.map(item => <Select.Option key={item.id} value={item.id}>{item.content.title}</Select.Option>)}
      </Select>}
    </div>
    {screen.sections.map((section, index) => <CanvasSectionEditor key={section.id} section={section} busy={saving}
      first={index === 0} gadgets={gadgets} acceptedGadgets={acceptedGadgets} catalog={catalog} viewTitle={screen.title}
      onEdit={edit} onMoveUp={() => void edit([{ type: 'moveSection', sectionId: section.id, index: index - 1 }])} />)}
    {screen.sections.length > 1 && <CanvasMoveWidgetForm sections={screen.sections} gadgets={gadgets} busy={saving} onEdit={edit} />}
    <Button disabled={saving || screen.sections.length >= 12} onClick={() => void edit([{
      type: 'addSection', index: screen.sections.length,
      section: { id: crypto.randomUUID(), title: `Section ${screen.sections.length + 1}`, columns: 2, widgets: [] },
    }])}>Add section</Button>
    {error && <p role="alert" className="text-sm text-kumo-danger">{error}</p>}
    <div className="flex gap-2 border-t border-kumo-line pt-4">
      <Button variant="primary" disabled={saving || !screen.title.trim()} onClick={() => void save()}>{saving ? 'Saving…' : 'Save screen'}</Button>
      <Button disabled={saving} onClick={onCancel}>Discard screen draft</Button>
    </div>
  </section>
}
