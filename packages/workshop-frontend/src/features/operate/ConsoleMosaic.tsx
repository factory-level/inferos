import { useState } from 'react'
import { Button } from '@cloudflare/kumo'
import { ArrowRightIcon, ChatsCircleIcon, LayoutIcon, PencilSimpleIcon } from '@phosphor-icons/react'
import type { WorkspaceScreensState } from '../../pages/inferops-canvas/useWorkspaceScreens'
import { consoleEntries, type ConsoleEntry } from './consoles'

const PAGE_SIZE = 8

/** The console launcher: eight real consoles per page, with separate open and edit actions (edit only where the viewer can build). */
export const ConsoleMosaic = ({ screens, onOpen, onEdit, highlighted }: {
  screens: WorkspaceScreensState
  onOpen: (entry: ConsoleEntry) => void
  onEdit: (entry: ConsoleEntry) => void
  highlighted?: string
}) => {
  const [requestedPage, setPage] = useState<number | null>(null)
  if (screens.status === 'loading') return <p role="status" className="py-10 text-sm text-kumo-subtle">Loading consoles…</p>
  if (screens.status === 'error') return <p role="alert" className="py-10 text-sm text-kumo-danger">Consoles could not be loaded. Reload to try again.</p>
  const entries = consoleEntries(screens.workspaces)
  const pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE))
  const savedPage = Math.floor(Math.max(0, entries.findIndex(entry => entry.console.id === highlighted)) / PAGE_SIZE)
  const page = Math.min(requestedPage ?? savedPage, pages - 1)
  return <section aria-label="Consoles" className="space-y-4">
    {entries.length === 0
      ? <div className="rounded-xl border border-dashed border-kumo-line px-6 py-12 text-center">
          <h2 className="font-medium text-kumo-default">Your consoles live here</h2>
          <p className="mt-2 text-sm text-kumo-subtle">Create a console to bring your assistant and screens together.</p>
        </div>
      : <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(entry => {
            const saved = entry.console
            const first = saved.fullChat === 'default' || saved.fullChat === 'only'
            const Icon = first ? ChatsCircleIcon : LayoutIcon
            return <li key={`${entry.workspace.id}/${saved.id}`}
              className={`group relative rounded-xl border bg-kumo-base transition-colors hover:border-kumo-ring ${saved.id === highlighted ? 'border-kumo-ring' : 'border-kumo-line'}`}>
              <button type="button" onClick={() => onOpen(entry)} aria-label={`Open ${saved.title}`}
                className="flex min-h-40 w-full flex-col p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring rounded-xl">
                <Icon size={22} aria-hidden className="mb-5 text-kumo-subtle" />
                <span className="line-clamp-2 pr-4 text-sm font-medium text-kumo-default">{saved.title}</span>
                <span className="mt-1 block w-full truncate text-xs text-kumo-subtle">{entry.workspace.title || 'Untitled workspace'}</span>
                <span className="mt-3 flex w-full items-center gap-2 text-xs text-kumo-subtle">
                  <span className="truncate">{saved.fullChat === 'only' ? 'Assistant' : `${saved.views.length} ${saved.views.length === 1 ? 'view' : 'views'}${first ? ' · Assistant first' : ''}`}</span>
                  <ArrowRightIcon size={14} aria-hidden className="ml-auto shrink-0" />
                </span>
              </button>
              {entry.workspace.role !== 'use' && <Button variant="ghost" size="sm" aria-label={`Edit ${saved.title}`} onClick={() => onEdit(entry)} className="!absolute right-2 top-2">
                <PencilSimpleIcon size={14} aria-hidden />
              </Button>}
            </li>
          })}
        </ul>}
    {pages > 1 && <nav aria-label="Console pages" className="flex items-center justify-end gap-3">
      <Button size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
      <span aria-live="polite" className="text-xs text-kumo-subtle">{page + 1} / {pages}</span>
      <Button size="sm" disabled={page === pages - 1} onClick={() => setPage(page + 1)}>Next</Button>
    </nav>}
  </section>
}
