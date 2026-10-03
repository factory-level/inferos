import { SquaresFourIcon } from '@phosphor-icons/react'
import type { WorkspaceScreensState } from '../../pages/inferops-canvas/useWorkspaceScreens'
import { consoleEntries, viewScreens, type ConsoleEntry } from './consoles'

/**
 * Operate's home: one tile per console the person can open, each naming its views and how many
 * widgets they show, so they can pick the console for the work in front of them.
 */
export const ConsoleMosaic = ({ screens, onOpen }: {
  screens: WorkspaceScreensState
  onOpen: (entry: ConsoleEntry) => void
}) => {
  if (screens.status === 'loading') return <p role="status" className="p-6 text-sm text-kumo-subtle">Loading consoles…</p>
  if (screens.status === 'error') return <p role="alert" className="p-6 text-sm text-kumo-danger">Consoles could not be loaded.</p>
  const entries = consoleEntries(screens.workspaces)
  return (
    <div className="min-h-full bg-kumo-tint p-6">
      <div className="mx-auto max-w-6xl space-y-4">
        <div>
          <h1 className="text-lg font-semibold text-kumo-default">Consoles</h1>
          <p className="text-sm text-kumo-subtle">Pick the console for your role.</p>
        </div>
        {entries.length === 0
          ? <p className="rounded-2xl border border-kumo-line bg-kumo-base p-6 text-sm text-kumo-subtle">
              No consoles yet. A lead creates them in Build.
            </p>
          : <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {entries.map(entry => {
                const { console: saved, workspace, screens: available } = entry
                const widgets = [...new Set(saved.views.flatMap(viewScreens))]
                  .flatMap(id => available.find(screen => screen.id === id)?.sections ?? [])
                  .reduce((count, section) => count + section.widgets.length, 0)
                return (
                  <li key={`${workspace.id}/${saved.id}`}>
                    <button type="button" onClick={() => onOpen(entry)}
                      className="flex h-full w-full flex-col gap-3 rounded-2xl border border-kumo-line bg-kumo-base p-4 text-left transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">
                      <span className="flex items-center gap-2">
                        <span className="grid h-8 w-8 place-items-center rounded-xl bg-kumo-tint text-kumo-brand"><SquaresFourIcon size={16} aria-hidden /></span>
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-kumo-default">{saved.title}</span>
                          <span className="block truncate text-xs text-kumo-subtle">{workspace.title || 'Untitled workspace'}</span>
                        </span>
                      </span>
                      <span className="flex flex-wrap gap-1">
                        {saved.views.map(view => <span key={view.id} className="rounded-full bg-kumo-tint px-2 py-0.5 text-xs text-kumo-default">{view.title}</span>)}
                      </span>
                      <span className="text-xs text-kumo-subtle">
                        {saved.views.length} {saved.views.length === 1 ? 'view' : 'views'} · {widgets} {widgets === 1 ? 'widget' : 'widgets'}
                        {saved.fullChat !== 'off' && ' · full chat'}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>}
      </div>
    </div>
  )
}
