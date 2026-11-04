import type { GadgetSummary, WorkpieceId } from '@gadgets/workshop-shared/api'
import { formatCanvasTarget, type CanvasAttachment, type CanvasPage, type CanvasTarget } from '@gadgets/workshop-shared/canvas-model'
import { widgetLabel } from './canvasLayout'

const attachmentLabel = (attachment: CanvasAttachment) => `Attachment ${attachment.id}`

/**
 * Everything on one view that the builder can select, as the saved model nests it: the page, its
 * objects (sections) and widgets in layout order, and each one's attachments. Selecting an entry
 * edits nothing; it only chooses what the inspector's controls apply to.
 */
export const CanvasTargetTree = ({ page, selected, gadgets, onSelect }: {
  page: CanvasPage
  /** The written form (`formatCanvasTarget`) of the selected target. */
  selected: string
  gadgets: ReadonlyMap<WorkpieceId, GadgetSummary>
  onSelect: (target: CanvasTarget) => void
}) => {
  const byId = new Map(page.nodes.map(node => [node.id, node]))
  const entry = (target: CanvasTarget, label: string) => {
    const current = formatCanvasTarget(target) === selected
    return <button type="button" aria-current={current ? 'true' : undefined} onClick={() => onSelect(target)}
      className={`w-full truncate rounded-md px-2 py-1 text-left text-sm focus-visible:ring-2 focus-visible:ring-kumo-ring ${current ? 'bg-kumo-tint font-medium text-kumo-default' : 'text-kumo-subtle hover:bg-kumo-tint'}`}>
      {label}
    </button>
  }
  const attachments = (list: CanvasAttachment[]) => list.length === 0 ? null : <ul className="ml-3 border-l border-kumo-line pl-2">
    {list.map(attachment => <li key={attachment.id}>
      {entry({ kind: 'attachment', pageId: page.id, attachmentId: attachment.id }, attachmentLabel(attachment))}
    </li>)}
  </ul>
  const branch = (ids: string[]) => <ul className="ml-3 border-l border-kumo-line pl-2">
    {ids.map(id => {
      const node = byId.get(id)
      if (!node) return null
      const target: CanvasTarget = { kind: 'node', pageId: page.id, nodeId: id }
      return <li key={id}>
        {entry(target, node.nodeType === 'object' ? node.title : widgetLabel(node, gadgets))}
        {attachments(node.attachments)}
        {node.nodeType === 'object' && node.children.length > 0 && branch(node.children)}
      </li>
    })}
  </ul>
  return <nav aria-label="Edit targets" className="space-y-1">
    {entry({ kind: 'page', pageId: page.id }, page.title)}
    {attachments(page.attachments)}
    {page.children.length > 0 && branch(page.children)}
  </nav>
}
