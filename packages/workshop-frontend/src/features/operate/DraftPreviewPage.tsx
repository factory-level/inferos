import type { ReactNode } from 'react'
import type { GadgetSummary, WorkpieceId } from '@gadgets/workshop-shared/api'
import type { CanvasNode, CanvasPage } from '@gadgets/workshop-shared/canvas-model'
import { resolveWorkspaceSettings, type WorkspaceSettings } from '@gadgets/workshop-shared/workspace-settings'
import type { CommitFileReader } from '../code/commitFileStore'
import { PreviewWidget } from './PreviewWidget'

/**
 * One draft page in the simulated preview (FAC-96): its objects as nested sections with their
 * columns, each widget a `PreviewWidget`, and the settings the page gets, each with the level that
 * owns it (FAC-95).
 */
export const DraftPreviewPage = ({ page, workspace, gadgets, reader, onEvent, onRequest }: {
  page: CanvasPage
  workspace: WorkspaceSettings
  gadgets: ReadonlyMap<WorkpieceId, GadgetSummary>
  reader: CommitFileReader
  onEvent: (targetRef: string, event: string) => void
  onRequest: (action: string) => void
}) => {
  const byId = new Map(page.nodes.map(node => [node.id, node]))
  const render = (node: CanvasNode | undefined): ReactNode => {
    if (!node) return null
    if (node.nodeType === 'widget') return <PreviewWidget key={node.id} node={node} gadgets={gadgets} reader={reader} onEvent={onEvent} onRequest={onRequest} />
    return <div key={node.id} className="space-y-2 rounded-lg border border-kumo-line p-3">
      <p className="text-xs font-medium uppercase text-kumo-subtle">{node.title}</p>
      <div className={`grid gap-3 ${node.columns === 3 ? 'md:grid-cols-3' : node.columns === 2 ? 'md:grid-cols-2' : ''}`}>{node.children.map(id => render(byId.get(id)))}</div>
    </div>
  }
  return <div className="space-y-3">
    <h3 className="text-sm font-medium text-kumo-default">{page.title}</h3>
    <p aria-label="Page settings" className="text-xs text-kumo-subtle">
      {resolveWorkspaceSettings(workspace, page.settings).map(setting => `${setting.key}: ${String(setting.value)} (${setting.owner})`).join(' · ')}
    </p>
    {page.children.map(id => render(byId.get(id)))}
  </div>
}
