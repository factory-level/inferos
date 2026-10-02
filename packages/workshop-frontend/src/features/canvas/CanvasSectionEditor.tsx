import { CanvasWidgetCard } from './CanvasWidgetCard'
import { Button, Input } from '@cloudflare/kumo'
import type { CanvasOperation, CanvasSection } from '@gadgets/workshop-shared/canvas'

type Props = {
  section: CanvasSection
  busy: boolean
  first: boolean
  onMoveUp: () => void
  onEdit: (operations: CanvasOperation[]) => Promise<boolean>
}

export const CanvasSectionEditor = ({ section, busy, first, onMoveUp, onEdit }: Props) => (
  <section className="space-y-3 rounded-lg border border-kumo-line p-4" aria-label={section.title}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-medium text-kumo-default">{section.title}</h3>
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label={`Columns for ${section.title}`} className="flex gap-1">
          {([1, 2, 3] as const).map(columns => <Button key={columns} size="sm" disabled={busy}
            aria-pressed={section.columns === columns} onClick={() => void onEdit([{ type: 'configureSection', sectionId: section.id, title: section.title, columns }])}>
            {columns} {columns === 1 ? 'column' : 'columns'}
          </Button>)}
        </div>
        <Button size="sm" disabled={busy || first} onClick={onMoveUp}>Move section up</Button>
        <Button size="sm" disabled={busy} onClick={() => void onEdit([{ type: 'removeSection', sectionId: section.id }])}>Remove section</Button>
      </div>
    </div>
    <form key={`${section.id}:${section.title}`} className="flex flex-wrap items-end gap-2" onSubmit={event => {
      event.preventDefault()
      void onEdit([{ type: 'configureSection', sectionId: section.id, columns: section.columns,
        title: String(new FormData(event.currentTarget).get('title') ?? '').trim() }])
    }}>
      <Input label="Section title" name="title" defaultValue={section.title} required maxLength={120} disabled={busy} />
      <Button type="submit" disabled={busy}>Rename section</Button>
    </form>
    <div className={`grid grid-cols-1 gap-3 ${section.columns === 3 ? 'lg:grid-cols-3' : section.columns === 2 ? 'lg:grid-cols-2' : ''}`}>
      {section.widgets.map((widget, index) => <CanvasWidgetCard key={widget.id} widget={widget} section={section}
        index={index} busy={busy} onEdit={onEdit} />)}
    </div>
    <form className="flex flex-wrap items-end gap-2" onSubmit={async event => {
      event.preventDefault()
      const form = event.currentTarget
      const targetRef = String(new FormData(form).get('target') ?? '').trim()
      const success = await onEdit([{ type: 'addWidget', sectionId: section.id, index: section.widgets.length,
        widget: { id: crypto.randomUUID(), kind: 'inferops.project-board', version: 1, targetRef,
          size: 'full', params: { workflow: 'software', showCompleted: false } } }])
      if (success) form.reset()
    }}>
      <Input label="InferOps board reference" name="target" required maxLength={512} disabled={busy}
        placeholder="inferops://tenant.workspace/project/board/PROJECT" className="min-w-0 flex-1" />
      <Button type="submit" disabled={busy || section.widgets.length >= 48}>Add board</Button>
    </form>
  </section>
)
