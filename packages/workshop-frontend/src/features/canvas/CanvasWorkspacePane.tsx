import { useEffect, useState } from 'react'
import { Button, Input, Select } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { GadgetSummary, Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'
import type { CanvasCatalog, CanvasContent, CanvasProjectBoardWidget } from '@gadgets/workshop-shared/canvas'
import DeleteConfirmationDialog from '../../components/DeleteConfirmationDialog'
import { CanvasBoardFullView } from './CanvasBoardFullView'
import { CanvasMoveWidgetForm } from './CanvasMoveWidgetForm'
import { CanvasSectionEditor } from './CanvasSectionEditor'
import { CanvasView } from './CanvasView'
import { exportCanvas } from './exportCanvas'
import { useCanvasWorkspace, type CanvasStorage } from './useCanvasWorkspace'

// Kumo's Select treats an empty value as unselected and shows nothing; ':' never starts a template ID.
const BLANK_TEMPLATE = ':blank'

export const CanvasWorkspacePane = ({ storage, overseer, gadgets, catalog, viewId, onViewChange, openWidgetId, onOpenWidgetChange, onAskAgent, codingDispatch, wikiEditable }: {
  storage: CanvasStorage
  overseer: RpcStub<Overseer>
  /** Every gadget in the workspace, drafts included, keyed by workpiece ID. */
  gadgets: ReadonlyMap<WorkpieceId, GadgetSummary>
  /** What the deployment offers: addable widget kinds, blueprint widgets and screen templates. */
  catalog: CanvasCatalog
  /** The view to open first, when it exists. */
  viewId: string | null
  /** Reports the selected view so the page can keep it in its URL. */
  onViewChange: (viewId: string | null) => void
  /** The board widget of the active view to show on its own (its full view), if any. */
  openWidgetId: string | null
  /** Reports the opened widget so the page can keep it in its URL; null closes the full view. */
  onOpenWidgetChange: (widgetId: string | null) => void
  /** Hands a request to the chat agent. */
  onAskAgent: (request: string) => Promise<void>
  /**
   * Offer coding dispatch on boards whose project the workspace also holds a coding-dispatch
   * connection for. The workspace's own canvas passes it; an Operate session's screen never does.
   */
  codingDispatch?: boolean
  /**
   * Offer Wiki section edits (through approval). The workspace's own canvas passes it; an Operate
   * session's screen shows Wikis read-only.
   */
  wikiEditable?: boolean
}) => {
  const canvas = useCanvasWorkspace(storage, viewId)
  const [template, setTemplate] = useState(BLANK_TEMPLATE)
  const [editing, setEditing] = useState(false)
  const activeId = canvas.active?.id ?? null
  // The URL is the external system here: keep it naming the view on screen.
  useEffect(() => {
    if (activeId !== viewId && !canvas.busy) onViewChange(activeId)
  }, [activeId, viewId, canvas.busy, onViewChange])
  const [confirmDelete, setConfirmDelete] = useState(false)
  const active = canvas.active
  const openWidget = active?.sections.flatMap(section => section.widgets)
    .find((widget): widget is CanvasProjectBoardWidget => widget.id === openWidgetId && widget.kind === 'inferops.project-board')
  // An opened widget that the view on screen no longer has (removed, or another view) closes.
  useEffect(() => {
    if (openWidgetId !== null && !openWidget && !canvas.busy) onOpenWidgetChange(null)
  }, [openWidgetId, openWidget, canvas.busy, onOpenWidgetChange])
  const acceptedGadgets = [...gadgets.values()].filter(gadget => gadget.chatId === undefined).toSorted((a, b) => a.id - b.id)

  const createForm = <div className="flex flex-wrap items-end gap-3">
    <form className="flex flex-wrap items-end gap-2" onSubmit={event => {
      event.preventDefault()
      const title = String(new FormData(event.currentTarget).get('title') ?? '').trim()
      const screen = catalog.screens.find(item => item.id === template)
      const content: CanvasContent = screen ? { ...structuredClone(screen.content), title }
        : { title, sections: [{ id: crypto.randomUUID(), title: 'Overview', columns: 2, widgets: [] }] }
      void canvas.create(content).then(success => { if (success) setEditing(!screen) })
    }}>
      <Input label="New view title" name="title" required maxLength={120} defaultValue="Operations" disabled={canvas.busy} />
      {catalog.screens.length > 0 && <Select label="Start from" value={template}
        disabled={canvas.busy} onValueChange={value => setTemplate(String(value ?? BLANK_TEMPLATE))}
        renderValue={value => catalog.screens.find(item => item.id === value)?.content.title ?? 'Blank view'}>
        <Select.Option value={BLANK_TEMPLATE}>Blank view</Select.Option>
        {catalog.screens.map(screen => <Select.Option key={screen.id} value={screen.id}>{screen.content.title}</Select.Option>)}
      </Select>}
      <Button type="submit" disabled={canvas.busy}>Create view</Button>
    </form>
    <Input label="Import view definition" type="file" accept=".json,application/json" disabled={canvas.busy}
      onChange={event => { const file = event.target.files?.[0]; if (file) void canvas.importDefinition(file); event.target.value = '' }} />
  </div>

  return <div className="flex h-full min-h-0 flex-col" aria-busy={canvas.busy}>
    <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-kumo-line px-4 py-2">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2" role="group" aria-label="Choose a view">
        {canvas.views.map(view => <Button key={view.id} size="sm" disabled={canvas.busy} aria-pressed={active?.id === view.id}
          onClick={() => canvas.select(view.id)}>{view.title}</Button>)}
        {storage.kind === 'durable' && <Button size="sm" disabled={canvas.busy} onClick={() => void canvas.reload()}>Reload saved views</Button>}
      </div>
      <p role="status" className="text-xs text-kumo-subtle">
        {canvas.busy ? 'Working…' : storage.kind === 'durable' ? 'Saved views' : 'Unsaved views — reloading discards them'}
      </p>
      <Button size="sm" aria-pressed={editing} onClick={() => setEditing(value => !value)}>{editing ? 'Done editing' : 'Edit layout'}</Button>
    </div>
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
      {canvas.error && <p role="alert" className="text-sm text-kumo-danger">{canvas.error}</p>}
      {!active && <div className="space-y-4">
        <p className="text-kumo-subtle">Compose gadgets, InferOps boards and InferMind Wikis into a page. Choose a view, create one, or import a definition from your repository. You can also ask the agent in chat to build a screen for you.</p>
        {createForm}
      </div>}
      {active && !editing && (openWidget
        ? <CanvasBoardFullView widget={openWidget} viewTitle={active.title} overseer={overseer} onBack={() => onOpenWidgetChange(null)}
          codingDispatch={codingDispatch} />
        : <>
          <h1 className="text-lg font-semibold text-kumo-default">{active.title}</h1>
          <CanvasView definition={active} gadgets={gadgets} overseer={overseer} onOpenWidget={onOpenWidgetChange} codingDispatch={codingDispatch}
            wikiEditable={wikiEditable} />
        </>)}
      {active && editing && <div className="space-y-4">
        {createForm}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-lg font-semibold text-kumo-default">{active.title}</h1>
          <div className="flex flex-wrap gap-2">
            <Button disabled={canvas.busy} onClick={() => exportCanvas(active)}>Export view</Button>
            <Button disabled={canvas.busy || !canvas.canUndo} onClick={() => void canvas.undo()}>Undo layout change</Button>
            <Button disabled={canvas.busy} onClick={() => setConfirmDelete(true)}>Delete view</Button>
          </div>
        </div>
        <form key={`${active.id}:${active.title}`} className="flex flex-wrap items-end gap-2" onSubmit={event => {
          event.preventDefault()
          void canvas.edit([{ type: 'rename', title: String(new FormData(event.currentTarget).get('title') ?? '').trim() }])
        }}>
          <Input label="View title" name="title" defaultValue={active.title} required maxLength={120} disabled={canvas.busy} />
          <Button type="submit" disabled={canvas.busy}>Rename view</Button>
        </form>
        {active.sections.map((section, index) => <CanvasSectionEditor key={section.id} section={section} busy={canvas.busy}
          first={index === 0} gadgets={gadgets} acceptedGadgets={acceptedGadgets} onEdit={canvas.edit}
          catalog={catalog} viewTitle={active.title} onAskAgent={onAskAgent}
          onMoveUp={() => void canvas.edit([{ type: 'moveSection', sectionId: section.id, index: index - 1 }])} />)}
        {active.sections.length > 1 && <CanvasMoveWidgetForm key={active.id} sections={active.sections} gadgets={gadgets}
          busy={canvas.busy} onEdit={canvas.edit} />}
        <form className="flex flex-wrap items-end gap-2" onSubmit={async event => {
          event.preventDefault()
          const form = event.currentTarget
          const title = String(new FormData(form).get('section') ?? '').trim()
          if (await canvas.edit([{ type: 'addSection', index: active.sections.length,
            section: { id: crypto.randomUUID(), title, columns: 1, widgets: [] } }])) form.reset()
        }}>
          <Input label="New section title" name="section" required maxLength={120} disabled={canvas.busy} />
          <Button type="submit" disabled={canvas.busy || active.sections.length >= 12}>Add section</Button>
        </form>
      </div>}
    </div>
    <DeleteConfirmationDialog open={confirmDelete} onOpenChange={setConfirmDelete} title="Delete this view?"
      description="Only the composition will be deleted. Gadgets and InferOps records are unchanged. This deletion cannot be undone here."
      isDeleting={canvas.busy} confirmLabel="Delete view" onConfirm={() => {
        void canvas.remove().then(success => { if (success) { setConfirmDelete(false); setEditing(false) } })
      }} />
  </div>
}
