import { Button, Popover } from '@cloudflare/kumo'
import { ArrowSquareOutIcon, SquaresFourIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import type { ConsoleEntry } from './consoles'
import { consoleScreens } from '@gadgets/workshop-shared/operate-console'

export type ConsoleWidgetTarget = {
  consoleId: string
  screenId: string
  widgetId: string
  presentation: 'page' | 'modal'
}

/**
 * Open a console widget directly from the assistant dock, without changing its conversation, or
 * one of the console's host boards when `onOpenHostBoard` is given (host boards are on).
 */
export const ConsoleWidgetActions = ({ entry, onOpen, onOpenHostBoard }: {
  entry: ConsoleEntry
  onOpen: (target: ConsoleWidgetTarget) => void
  onOpenHostBoard?: (entryId: string) => void
}) => {
  const [open, setOpen] = useState(false)
  const included = new Set(consoleScreens(entry.console))
  const screens = entry.screens.filter(screen => included.has(screen.id))
  const hostBoards = onOpenHostBoard ? (entry.console.hostBoards ?? []).flatMap(board => board.id === undefined ? [] : [{ ...board, id: board.id }]) : []
  const chooseHostBoard = (entryId: string) => {
    setOpen(false)
    onOpenHostBoard?.(entryId)
  }
  const choose = (screenId: string, widgetId: string, presentation: 'page' | 'modal') => {
    setOpen(false)
    onOpen({ consoleId: entry.console.id, screenId, widgetId, presentation })
  }
  return <Popover open={open} onOpenChange={setOpen}>
    <Popover.Trigger render={<Button size="sm" variant="ghost" aria-label="Open a widget" title="Open a widget"><SquaresFourIcon size={16} aria-hidden /></Button>} />
    <Popover.Content className="z-50 max-h-96 w-72 overflow-auto rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm">
      <p className="mb-3 text-sm font-medium text-kumo-default">Widgets</p>
      {hostBoards.length > 0 && <section className="mb-3" aria-label="Boards">
        <h3 className="mb-1 text-xs text-kumo-subtle">Boards</h3>
        {hostBoards.map(board => <Button key={board.id} size="sm" variant="ghost" className="w-full justify-start" onClick={() => chooseHostBoard(board.id)}>
          <span className="truncate">{board.label}</span>
        </Button>)}
      </section>}
      {hostBoards.length === 0 && screens.every(screen => screen.sections.every(section => section.widgets.length === 0)) && <p className="text-sm text-kumo-subtle">Add widgets to a screen in console setup.</p>}
      {screens.filter(screen => screen.sections.some(section => section.widgets.length > 0)).map(screen => <section key={screen.id} className="mb-3 last:mb-0" aria-label={screen.title}>
        <h3 className="mb-1 text-xs text-kumo-subtle">{screen.title}</h3>
        {screen.sections.flatMap(section => section.widgets.map((widget, index) => {
          const label = widget.kind === 'inferops.project-board' ? `${section.title} board` : `${section.title} widget ${index + 1}`
          return <div key={`${section.id}/${widget.id}`} className="flex items-center gap-1 rounded-md hover:bg-kumo-tint">
            <Button size="sm" variant="ghost" className="min-w-0 flex-1 justify-start" onClick={() => choose(screen.id, widget.id, 'page')}>
              <span className="truncate">{label}</span>
            </Button>
            <Button size="sm" variant="ghost" aria-label={`Open ${label} in a modal`} title="Open in a modal" onClick={() => choose(screen.id, widget.id, 'modal')}><ArrowSquareOutIcon size={14} aria-hidden /></Button>
          </div>
        }))}
      </section>)}
    </Popover.Content>
  </Popover>
}
