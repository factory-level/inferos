import { Badge, Button } from '@cloudflare/kumo'
import { ArrowRightIcon, LayoutIcon, PencilSimpleIcon } from '@phosphor-icons/react'
import type { ConsoleSummary } from '@gadgets/workshop-shared/api'
import type { MyConsolesState } from './useMyConsoles'

/**
 * The person's consoles that belong to no workspace, beside the workspace-stored ones. A published
 * one opens in Operate; its owner and authors edit it in Build, where an unpublished one is
 * finished first.
 */
export const OwnConsoleTiles = ({ consoles, onOpen, onEdit }: {
  consoles: MyConsolesState
  onOpen: (console: ConsoleSummary) => void
  onEdit: (console: ConsoleSummary) => void
}) => {
  if (consoles.status === 'error') return <p role="alert" className="py-4 text-sm text-kumo-danger">Your consoles could not be loaded. Reload to try again.</p>
  if (consoles.status === 'loading' || consoles.consoles.length === 0) return null
  return <section aria-label="Your consoles" className="mb-4 space-y-3">
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {consoles.consoles.map(console => {
        const building = console.role !== 'use'
        return <li key={console.id} className="group relative rounded-xl border border-kumo-line bg-kumo-base transition-colors hover:border-kumo-ring">
          <button type="button" disabled={!console.published} onClick={() => onOpen(console)}
            aria-label={console.published ? `Open ${console.title}` : `${console.title} is not published yet`}
            className="flex min-h-40 w-full flex-col rounded-xl p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring disabled:cursor-default">
            <LayoutIcon size={22} aria-hidden className="mb-5 text-kumo-subtle" />
            <span className="line-clamp-2 pr-4 text-sm font-medium text-kumo-default">{console.title}</span>
            <span className="mt-3 flex w-full items-center gap-2 text-xs text-kumo-subtle">
              <Badge variant={console.published ? 'success' : 'secondary'}>{console.published ? 'Published' : 'Not published'}</Badge>
              {console.published && <ArrowRightIcon size={14} aria-hidden className="ml-auto shrink-0" />}
            </span>
          </button>
          {building && <Button variant="ghost" size="sm" aria-label={`Edit ${console.title}`} onClick={() => onEdit(console)} className="!absolute right-2 top-2">
            <PencilSimpleIcon size={14} aria-hidden />
          </Button>}
        </li>
      })}
    </ul>
  </section>
}
