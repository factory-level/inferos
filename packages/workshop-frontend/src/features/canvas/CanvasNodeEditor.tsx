import { useState } from 'react'
import { Button, Input, Select } from '@cloudflare/kumo'
import type { CanvasNode, CanvasPage, CanvasPageOperation } from '@gadgets/workshop-shared/canvas-model'

const COLUMN_CHOICES = [1, 2, 3] as const

/** Where a node may go: the page (objects only) and every object that isn't it or inside it. */
const destinations = (page: CanvasPage, node: CanvasNode) => {
  const byId = new Map(page.nodes.map(item => [item.id, item]))
  const inside = new Set<string>()
  const collect = (id: string) => {
    inside.add(id)
    const item = byId.get(id)
    if (item?.nodeType === 'object') item.children.forEach(collect)
  }
  collect(node.id)
  const objects = page.nodes.filter(item => item.nodeType === 'object' && !inside.has(item.id))
  return [
    ...(node.nodeType === 'object' ? [{ id: page.id, label: `${page.title} (top level)` }] : []),
    ...objects.map(item => ({ id: item.id, label: item.nodeType === 'object' ? item.title : item.id })),
  ]
}

/** The parent holding a node, and its position there. */
const placement = (page: CanvasPage, id: string) => {
  if (page.children.includes(id)) return { parent: page.id, siblings: page.children }
  const parent = page.nodes.find(item => item.nodeType === 'object' && item.children.includes(id))
  return parent?.nodeType === 'object' ? { parent: parent.id, siblings: parent.children } : null
}

/**
 * Edits one selected object or widget of a nested page through typed page operations (FAC-83).
 * Each control sends only its own operation for this node. Removing it removes only what the page
 * shows; the gadgets and InferOps records it names are untouched.
 */
export const CanvasNodeEditor = ({ page, node, busy, onEdit, nestingOnly = false }: {
  page: CanvasPage
  node: CanvasNode
  busy: boolean
  onEdit: (operations: CanvasPageOperation[]) => Promise<boolean>
  /**
   * Offer only nesting (an object inside, moving into another object), beside the version 1 section
   * editor or widget card, which already rename, reorder and remove.
   */
  nestingOnly?: boolean
}) => {
  const [destination, setDestination] = useState('')
  const at = placement(page, node.id)
  const index = at?.siblings.indexOf(node.id) ?? -1
  const targets = destinations(page, node)
  const moveTo = (parent: string, position: number) => onEdit([{ type: 'moveNode', nodeId: node.id, parent, index: position }])
  const label = node.nodeType === 'object' ? node.title : node.id

  return <div className="space-y-4">
    {node.nodeType === 'object' && !nestingOnly && <>
      <div className="flex flex-wrap gap-2" role="group" aria-label={`Columns of ${node.title}`}>
        {COLUMN_CHOICES.map(columns => <Button key={columns} size="sm" disabled={busy} aria-pressed={node.columns === columns}
          onClick={() => void onEdit([{ type: 'configureObject', nodeId: node.id, title: node.title, columns }])}>
          {columns} {columns === 1 ? 'column' : 'columns'}
        </Button>)}
      </div>
      <form key={`${node.id}:${node.title}`} className="flex flex-wrap items-end gap-2" onSubmit={event => {
        event.preventDefault()
        void onEdit([{ type: 'configureObject', nodeId: node.id, title: String(new FormData(event.currentTarget).get('title') ?? '').trim(), columns: node.columns }])
      }}>
        <Input label="Object title" name="title" defaultValue={node.title} required maxLength={120} disabled={busy} />
        <Button type="submit" disabled={busy}>Rename object</Button>
      </form>
    </>}

    {node.nodeType === 'object' && <form className="flex flex-wrap items-end gap-2" onSubmit={async event => {
      event.preventDefault()
      const form = event.currentTarget
      const title = String(new FormData(form).get('child') ?? '').trim()
      if (await onEdit([{ type: 'addObject', parent: node.id, index: node.children.length,
        object: { id: crypto.randomUUID(), title, columns: 1 } }])) form.reset()
    }}>
      <Input label="New object inside" name="child" required maxLength={120} disabled={busy} />
      <Button type="submit" disabled={busy}>Add object</Button>
    </form>}

    {at && !nestingOnly && <div className="flex flex-wrap items-center gap-2" role="group" aria-label={`Order of ${label}`}>
      <Button size="sm" disabled={busy || index <= 0} onClick={() => void moveTo(at.parent, index - 1)}>Move up</Button>
      <Button size="sm" disabled={busy || index < 0 || index >= at.siblings.length - 1} onClick={() => void moveTo(at.parent, index + 1)}>Move down</Button>
    </div>}

    {targets.length > 0 && <form className="flex flex-wrap items-end gap-2" onSubmit={event => {
      event.preventDefault()
      const parent = targets.find(target => target.id === destination)
      if (!parent) return
      const children = parent.id === page.id ? page.children
        : (page.nodes.find(item => item.id === parent.id && item.nodeType === 'object') as Extract<CanvasNode, { nodeType: 'object' }> | undefined)?.children ?? []
      void moveTo(parent.id, children.filter(child => child !== node.id).length)
    }}>
      <Select label="Move into" value={destination} disabled={busy} onValueChange={value => setDestination(String(value ?? ''))}
        renderValue={value => targets.find(target => target.id === value)?.label ?? 'Choose where'}>
        {targets.map(target => <Select.Option key={target.id} value={target.id}>{target.label}</Select.Option>)}
      </Select>
      <Button type="submit" disabled={busy || !destination}>Move</Button>
    </form>}

    {!nestingOnly && <div className="space-y-1">
      <Button variant="secondary-destructive" disabled={busy} onClick={() => void onEdit([{ type: 'removeNode', nodeId: node.id }])}>
        Remove from view
      </Button>
      <p className="text-xs text-kumo-subtle">
        {node.nodeType === 'object' ? 'Removes this object and what it holds from the view only.' : 'Removes this widget from the view only.'} Gadgets and InferOps records are unchanged.
      </p>
    </div>}
  </div>
}
