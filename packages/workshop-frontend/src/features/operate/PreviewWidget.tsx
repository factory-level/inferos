import { Button } from '@cloudflare/kumo'
import type { GadgetSummary, WorkpieceId } from '@gadgets/workshop-shared/api'
import { CANVAS_WIDGET_ACTIONS, type CanvasWidgetNode } from '@gadgets/workshop-shared/canvas-model'
import type { CommitFileReader } from '../code/commitFileStore'
import { PreviewGadgetWidget } from './PreviewGadgetWidget'

/**
 * One widget of a simulated draft preview (FAC-96). Nothing here reads live data or runs a gadget:
 * - an InferOps board or Wiki is a placeholder naming its reference and binding, and each action it
 *   declares only says what it would request (`onRequest`);
 * - a gadget widget runs no code: its local states come from `states.json` at the gadget's head
 *   commit, read from git, and move in memory, each event reported (`onEvent`) so the page can run
 *   what it is wired to. A gadget without states shows its title only.
 */
export const PreviewWidget = ({ node, gadgets, reader, onEvent, onRequest }: {
  node: CanvasWidgetNode
  gadgets: ReadonlyMap<WorkpieceId, GadgetSummary>
  reader: CommitFileReader
  onEvent: (targetRef: string, event: string) => void
  onRequest: (action: string) => void
}) => {
  if (node.kind !== 'inferos.gadget') {
    return <article aria-label={`Preview ${node.kind} ${node.targetRef}`} className="space-y-2 rounded-lg border border-dashed border-kumo-line p-3 text-sm">
      <p className="font-medium text-kumo-default">{node.kind === 'inferops.wiki' ? 'InferMind Wiki' : 'Project board'}</p>
      <p className="break-all text-xs text-kumo-subtle">{node.targetRef}{node.dataBinding ? ` · reads ${node.dataBinding.resource}` : ''}</p>
      <p className="text-kumo-subtle">Live data isn’t read in preview.</p>
      {CANVAS_WIDGET_ACTIONS[node.kind].length > 0 && <div className="flex flex-wrap gap-2">
        {CANVAS_WIDGET_ACTIONS[node.kind].map(action => <Button key={action} size="sm" variant="secondary" onClick={() => onRequest(action)}>{action}</Button>)}
      </div>}
    </article>
  }
  return <PreviewGadgetWidget node={node} gadgets={gadgets} reader={reader} onEvent={onEvent} />
}
