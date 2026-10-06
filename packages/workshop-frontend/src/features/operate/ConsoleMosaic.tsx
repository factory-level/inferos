import { useState } from 'react'
import { Badge, Button } from '@cloudflare/kumo'
import { ArrowRightIcon, ChatsCircleIcon, EyeIcon, LayoutIcon, PencilSimpleIcon, UploadSimpleIcon } from '@phosphor-icons/react'
import type { ConsoleSource } from '@gadgets/workshop-shared/operate-console'
import type { WorkspaceScreensState } from '../../pages/inferops-canvas/useWorkspaceScreens'
import { consoleEntries, publicationStatus, type ConsoleEntry } from './consoles'

const PAGE_SIZE = 8

const STATUS = {
  unpublished: { label: 'Draft', variant: 'secondary' },
  changed: { label: 'Unpublished changes', variant: 'warning' },
  published: { label: 'Published', variant: 'success' },
} as const

/**
 * The console launcher: eight real consoles per page. Opening a tile opens the published console
 * operators use. Where the viewer can build, each tile also shows its publication status and offers
 * edit, a preview of the draft and publish.
 */
export const ConsoleMosaic = ({ screens, onOpen, onEdit, onPublish, highlighted }: {
  screens: WorkspaceScreensState
  onOpen: (entry: ConsoleEntry, source: ConsoleSource) => void
  onEdit: (entry: ConsoleEntry) => void
  onPublish: (entry: ConsoleEntry) => void
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
            const building = entry.workspace.role !== 'use'
            const status = building ? publicationStatus(entry) : 'published'
            // A console never published has only its draft, which only a builder previews.
            const source: ConsoleSource = status === 'unpublished' ? 'draft' : 'published'
            return <li key={`${entry.workspace.id}/${saved.id}`}
              className={`group relative rounded-xl border bg-kumo-base transition-colors hover:border-kumo-ring ${saved.id === highlighted ? 'border-kumo-ring' : 'border-kumo-line'}`}>
              <button type="button" onClick={() => onOpen(entry, source)} aria-label={`${source === 'draft' ? 'Preview' : 'Open'} ${saved.title}`}
                className="flex min-h-40 w-full flex-col p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring rounded-xl">
                <Icon size={22} aria-hidden className="mb-5 text-kumo-subtle" />
                <span className="line-clamp-2 pr-4 text-sm font-medium text-kumo-default">{saved.title}</span>
                <span className="mt-1 block w-full truncate text-xs text-kumo-subtle">{entry.workspace.title || 'Untitled workspace'}</span>
                <span className="mt-3 flex w-full items-center gap-2 text-xs text-kumo-subtle">
                  <span className="truncate">{saved.fullChat === 'only' ? 'Assistant' : `${saved.views.length} ${saved.views.length === 1 ? 'view' : 'views'}${first ? ' · Assistant first' : ''}`}</span>
                  <ArrowRightIcon size={14} aria-hidden className="ml-auto shrink-0" />
                </span>
              </button>
              {building && <>
                <Button variant="ghost" size="sm" aria-label={`Edit ${saved.title}`} onClick={() => onEdit(entry)} className="!absolute right-2 top-2">
                  <PencilSimpleIcon size={14} aria-hidden />
                </Button>
                <div className="flex flex-wrap items-center gap-2 border-t border-kumo-line px-4 py-2">
                  <Badge variant={STATUS[status].variant}>{STATUS[status].label}</Badge>
                  {status !== 'published' && <span className="ml-auto flex gap-1">
                    {status === 'changed' && <Button variant="ghost" size="sm" aria-label={`Preview the draft of ${saved.title}`} onClick={() => onOpen(entry, 'draft')}>
                      <EyeIcon size={14} aria-hidden />Preview
                    </Button>}
                    <Button variant="ghost" size="sm" aria-label={`Publish ${saved.title}`} onClick={() => onPublish(entry)}>
                      <UploadSimpleIcon size={14} aria-hidden />Publish
                    </Button>
                  </span>}
                </div>
              </>}
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
