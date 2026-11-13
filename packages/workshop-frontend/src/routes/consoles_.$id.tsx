import { createFileRoute } from '@tanstack/react-router'
import { ConsoleCreatorPage } from '../pages/consoles/ConsoleCreatorPage'

type ConsoleCreatorSearch = { view?: string; widget?: string }

/**
 * One console's creator. The file is `consoles_.$id` (trailing underscore) so the page does not
 * nest inside the Consoles list's component. The id is the console's own; no workspace is named.
 */
export const Route = createFileRoute('/consoles_/$id')({
  component: ConsoleCreatorRoute,
  validateSearch: (search: Record<string, unknown>): ConsoleCreatorSearch => ({
    view: typeof search.view === 'string' && search.view.length <= 64 ? search.view : undefined,
    widget: typeof search.widget === 'string' && search.widget.length <= 64 ? search.widget : undefined,
  }),
})

function ConsoleCreatorRoute() {
  const { id } = Route.useParams()
  const { view, widget } = Route.useSearch()
  return <ConsoleCreatorPage key={id} consoleId={id} viewId={view ?? null} widgetId={widget ?? null} />
}
