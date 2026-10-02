import { createFileRoute } from '@tanstack/react-router'
import { CanvasPage } from '../pages/canvas/CanvasPage'

type CanvasSearch = { chat?: number }

/**
 * A workspace's composable views beside its chat. The file is `workspace_.$id.canvas` (trailing
 * underscore) so the page does not nest inside the workspace editor's component; it still renders
 * without app chrome because the root treats every /workspace/ path as fullscreen.
 */
export const Route = createFileRoute('/workspace_/$id/canvas')({
  component: CanvasRoute,
  validateSearch: (search: Record<string, unknown>): CanvasSearch => {
    const chat = typeof search.chat === 'string' ? Number(search.chat) : search.chat
    return { chat: typeof chat === 'number' && Number.isInteger(chat) && chat >= 0 ? chat : undefined }
  },
})

function CanvasRoute() {
  const { id } = Route.useParams()
  const { chat } = Route.useSearch()
  return <CanvasPage key={id} workspaceId={id} chatId={chat ?? null} />
}
