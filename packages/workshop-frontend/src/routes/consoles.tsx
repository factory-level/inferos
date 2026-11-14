import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ConsolesPage } from '../pages/consoles/ConsolesPage'

type ConsolesSearch = { new?: boolean }

/** Build's Consoles: a person's consoles, and where one is created by name. */
export const Route = createFileRoute('/consoles')({
  component: ConsolesRoute,
  validateSearch: (search: Record<string, unknown>): ConsolesSearch =>
    ({ new: search.new === true || search.new === 'true' ? true : undefined }),
})

function ConsolesRoute() {
  const navigate = useNavigate()
  const search = Route.useSearch()
  return <ConsolesPage creating={search.new === true}
    onCreatingChange={creating => void navigate({ to: '/consoles', search: { new: creating ? true : undefined }, replace: true })} />
}
