import { createFileRoute } from '@tanstack/react-router'
import { OperatePublishPage } from '../pages/operate-publish/OperatePublishPage'

type PublishSearch = { space?: string }

/**
 * The publication review of a Build workspace: Publish, Install into an operate space, Upgrade.
 * `workspace_` so the page does not nest inside the workspace editor; `space` is the space under
 * review, so a reload or a shared link reopens it.
 */
export const Route = createFileRoute('/workspace_/$id/publish')({
  component: PublishRoute,
  validateSearch: (search: Record<string, unknown>): PublishSearch => ({
    space: typeof search.space === 'string' && /^[0-9a-f]{64}$/.test(search.space) ? search.space : undefined,
  }),
})

function PublishRoute() {
  const { id } = Route.useParams()
  const { space } = Route.useSearch()
  return <OperatePublishPage key={id} workspaceId={id} spaceId={space ?? null} />
}
