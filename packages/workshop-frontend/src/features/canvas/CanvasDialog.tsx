import { useState } from 'react'
import { Button, Dialog, Input } from '@cloudflare/kumo'
import DeleteConfirmationDialog from '../../components/DeleteConfirmationDialog'
import { CanvasSectionEditor } from './CanvasSectionEditor'
import { useCanvasWorkspace, type CanvasStorage } from './useCanvasWorkspace'

export const CanvasDialog = ({ open, onOpenChange, storage }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  storage: CanvasStorage
}) => {
  const canvas = useCanvasWorkspace(storage)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const active = canvas.active
  return <>
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog size="lg" className="max-h-[90dvh] !w-[min(1100px,calc(100vw-24px))] overflow-y-auto p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <Dialog.Title>Canvas</Dialog.Title>
            <Dialog.Description>
              {storage.kind === 'durable' ? 'Saved compositions in this workspace. Board access is authorized separately.'
                : 'Temporary views — unsaved. Reloading or leaving this workspace discards them.'}
            </Dialog.Description>
          </div>
          <Button onClick={() => onOpenChange(false)}>Close canvas</Button>
        </div>
        <div className="mt-4 space-y-4" aria-busy={canvas.busy}>
          {canvas.error && <p role="alert" className="text-sm text-kumo-danger">{canvas.error}</p>}
          <p role="status" className="text-sm text-kumo-subtle">{canvas.busy ? 'Working…' : storage.kind === 'durable' ? 'Saved views' : 'Unsaved views'}</p>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Choose a view">
            {canvas.views.map(view => <Button key={view.id} disabled={canvas.busy} aria-pressed={active?.id === view.id}
              onClick={() => canvas.select(view.id)}>{view.title}</Button>)}
            {storage.kind === 'durable' && <Button disabled={canvas.busy} onClick={() => void canvas.reload()}>Reload saved views</Button>}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <form className="flex flex-wrap items-end gap-2" onSubmit={event => {
              event.preventDefault()
              const title = String(new FormData(event.currentTarget).get('title') ?? '').trim()
              void canvas.create({ title, sections: [{ id: crypto.randomUUID(), title: 'Boards', columns: 1, widgets: [] }] })
            }}>
              <Input label="New view title" name="title" required maxLength={120} defaultValue="Operations" disabled={canvas.busy} />
              <Button type="submit" disabled={canvas.busy}>Create view</Button>
            </form>
            <Input label="Import view definition" type="file" accept=".json,application/json" disabled={canvas.busy}
              onChange={event => { const file = event.target.files?.[0]; if (file) void canvas.importDefinition(file); event.target.value = '' }} />
          </div>
          {!active && <p className="text-kumo-subtle">Choose a view, create one, or import a definition from your repository.</p>}
          {active && <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-semibold text-kumo-default">{active.title}</h2>
              <div className="flex gap-2">
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
              first={index === 0} onEdit={canvas.edit} onMoveUp={() => void canvas.edit([{ type: 'moveSection', sectionId: section.id, index: index - 1 }])} />)}
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
      </Dialog>
    </Dialog.Root>
    <DeleteConfirmationDialog open={confirmDelete} onOpenChange={setConfirmDelete} title="Delete this view?"
      description="Only the composition will be deleted. InferOps records are unchanged. This deletion cannot be undone here."
      isDeleting={canvas.busy} confirmLabel="Delete view" onConfirm={() => {
        void canvas.remove().then(success => { if (success) setConfirmDelete(false) })
      }} />
  </>
}
