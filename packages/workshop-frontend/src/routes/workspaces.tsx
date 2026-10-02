import { createFileRoute, Link } from '@tanstack/react-router'
import { Plus } from '@phosphor-icons/react'
import GadgetList from '../components/GadgetList'
import { useDocumentTitle } from '../useDocumentTitle'

/**
 * Full workspace listing. The sidebar surfaces Favorites + a handful of Recent workspaces; this is
 * the "see them all" destination linked from the rail.
 */
export const Route = createFileRoute('/workspaces')({
  component: WorkspacesPage,
})

function WorkspacesPage() {
  useDocumentTitle('Workspaces')
  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col px-3 sm:px-10">
      <header className="flex flex-col items-stretch gap-4 px-3 pb-3 pt-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="m-0 text-[18px] leading-[26px] font-semibold tracking-[-0.01em] text-kumo-default">Workspaces</h1>
          <p className="mt-1 text-[13px] leading-[18px] text-kumo-subtle">
            Each workspace is an isolated environment with its own conversations, gatekeepers, and outputs.
          </p>
        </div>
        {/* "Create" just routes to Home (the new-workspace launcher) for now. */}
        <Link
          to="/"
          className="press inline-flex h-11 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md bg-kumo-brand px-3.5 text-[14px] font-medium text-kumo-inverse transition-colors hover:bg-kumo-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring focus-visible:ring-offset-2 focus-visible:ring-offset-kumo-base sm:h-9 sm:text-[13px]"
        >
          <Plus size={14} weight="bold" />
          Create workspace
        </Link>
      </header>
      <div className="min-h-0 flex-1">
        <GadgetList showHeader={false} />
      </div>
    </div>
  )
}
