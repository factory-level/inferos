import { createFileRoute } from '@tanstack/react-router'
import { InferOpsCanvasPage } from '../pages/inferops-canvas/InferOpsCanvasPage'

type InferOpsCanvasSearch = { chat?: number; view?: string; widget?: string }

/**
 * A workspace's InferOps Canvas: its composed views beside its chat. The file is
 * `workspace_.$id.inferops-canvas` (trailing underscore) so the page does not nest inside the
 * workspace editor's component; it still renders without app chrome because the root treats every
 * /workspace/ path as fullscreen.
 */
export const Route = createFileRoute('/workspace_/$id/inferops-canvas')({
  component: InferOpsCanvasRoute,
  validateSearch: (search: Record<string, unknown>): InferOpsCanvasSearch => {
    const chat = typeof search.chat === 'string' ? Number(search.chat) : search.chat
    return {
      chat: typeof chat === 'number' && Number.isInteger(chat) && chat >= 0 ? chat : undefined,
      view: typeof search.view === 'string' && search.view.length <= 64 ? search.view : undefined,
      widget: typeof search.widget === 'string' && search.widget.length <= 64 ? search.widget : undefined,
    }
  },
})

function InferOpsCanvasRoute() {
  const { id } = Route.useParams()
  const { chat, view, widget } = Route.useSearch()
  return <InferOpsCanvasPage key={id} workspaceId={id} chatId={chat ?? null} viewId={view ?? null} widgetId={widget ?? null} />
}
