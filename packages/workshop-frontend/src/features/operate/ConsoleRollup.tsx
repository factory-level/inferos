import { AppWindowIcon, ArrowRightIcon, BookOpenIcon, KanbanIcon } from '@phosphor-icons/react'
import type { GadgetSummary, WorkpieceId } from '@gadgets/workshop-shared/api'
import type { CanvasDefinition } from '@gadgets/workshop-shared/canvas'
import { screenInventory } from './consoles'

/**
 * A rollup view: one tile per screen it summarizes, each listing the widgets and gadgets that
 * screen shows. Selecting a tile opens the screen in full. A screen that is gone or out of reach
 * keeps its place as an unavailable tile, so the rollup's layout doesn't shift under the person.
 */
export const ConsoleRollup = ({ screenIds, screens, gadgets, onShowScreen }: {
  screenIds: readonly string[]
  screens: readonly CanvasDefinition[]
  gadgets: ReadonlyMap<WorkpieceId, GadgetSummary>
  onShowScreen: (screenId: string) => void
}) => (
  <ul aria-label="Screens" className="grid grid-cols-1 gap-3 lg:grid-cols-2">
    {screenIds.map(id => {
      const screen = screens.find(candidate => candidate.id === id)
      if (!screen) return (
        <li key={id} className="rounded-2xl border border-dashed border-kumo-line p-4 text-sm text-kumo-subtle">
          This screen is unavailable.
        </li>
      )
      const inventory = screenInventory(screen, gadgets)
      return (
        <li key={id}>
          <button type="button" onClick={() => onShowScreen(id)}
            className="group flex h-full w-full flex-col gap-3 rounded-2xl border border-kumo-line bg-kumo-base p-4 text-left transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">
            <span className="flex items-center justify-between gap-2">
              <span className="truncate font-medium text-kumo-default">{screen.title}</span>
              <ArrowRightIcon size={14} aria-hidden className="shrink-0 text-kumo-subtle group-hover:text-kumo-default" />
            </span>
            {inventory.length === 0
              ? <span className="text-sm text-kumo-subtle">Nothing on this screen yet.</span>
              : <span className="flex flex-col gap-1.5" aria-label={`On ${screen.title}`}>
                  {inventory.map(item => {
                    const Icon = item.kind === 'board' ? KanbanIcon : item.kind === 'wiki' ? BookOpenIcon : AppWindowIcon
                    return (
                      <span key={item.id} className="flex items-center gap-2 rounded-xl bg-kumo-tint px-2.5 py-1.5 text-sm text-kumo-default">
                        <Icon size={14} aria-hidden className="shrink-0 text-kumo-subtle" />
                        <span className="truncate">{item.label}</span>
                        <span className="ml-auto shrink-0 text-xs text-kumo-subtle">{item.kind === 'gadget' ? 'Gadget' : 'Widget'}</span>
                      </span>
                    )
                  })}
                </span>}
          </button>
        </li>
      )
    })}
  </ul>
)
