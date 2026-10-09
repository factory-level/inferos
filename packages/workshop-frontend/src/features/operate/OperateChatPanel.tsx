import { Button } from '@cloudflare/kumo'
import { XIcon } from '@phosphor-icons/react'
import type { ConsoleEntry } from './consoles'
import { ConsoleWidgetActions, type ConsoleWidgetTarget } from './ConsoleWidgetActions'
import { useState } from 'react'
import ChatInterface from '../../ChatInterface'
import { useResizableSplit } from '../../hooks/useResizableSplit'
import type { SessionWorkspace } from './useSessionWorkspace'

const noConsoleLogs = () => ''
const ignore = () => {}

/** One mounted conversation moves between the home composer, centered assistant and side panel. */
export const OperateChatPanel = ({ workspace, layout = 'side', welcome, consoleActions, onClose }: {
  workspace: SessionWorkspace | null
  layout?: 'home' | 'side' | 'full' | 'hidden'
  welcome?: string
  onClose: () => void
  consoleActions?: { entry: ConsoleEntry; onOpenWidget: (target: ConsoleWidgetTarget) => void; onOpenView: (viewId: string) => void; onOpenHostBoard?: (entryId: string) => void }
}) => {
  const split = useResizableSplit(layout === 'side', 'right')
  const [chatId, setChatId] = useState<number | null>(null)
  return <>
    <div role="separator" aria-orientation="vertical" aria-label="Resize operate chat" aria-valuemin={280} aria-valuemax={Math.max(280, window.innerWidth - 400)} aria-valuenow={Math.round(split.width)} aria-valuetext={`${Math.round(split.width)} pixels`}
      hidden={layout !== 'side'}
      className="relative w-1 shrink-0 touch-none cursor-col-resize bg-kumo-line max-md:!hidden" {...split.handleProps} />
    <section aria-label="Operate chat" hidden={layout === 'hidden'}
      className={layout === 'hidden' ? 'hidden' : layout === 'side'
        ? 'flex min-h-0 shrink-0 flex-col border-l border-kumo-line bg-kumo-base max-md:!w-full'
        : 'mx-auto flex min-h-[180px] w-full max-w-3xl flex-1 flex-col bg-kumo-base'}
      style={layout === 'side' ? { width: split.width } : undefined}>
      {layout === 'side' && <header className="flex h-12 shrink-0 items-center justify-between border-b border-kumo-line px-4">
        <span className="text-sm font-medium text-kumo-default">Assistant</span>
        <div className="flex items-center gap-1">
          {consoleActions && <ConsoleWidgetActions entry={consoleActions.entry} onOpen={consoleActions.onOpenWidget} onOpenHostBoard={consoleActions.onOpenHostBoard} />}
          <Button size="sm" variant="ghost" aria-label="Close assistant" onClick={onClose}><XIcon size={15} aria-hidden /></Button>
        </div>
      </header>}
      {workspace
        ? <ChatInterface key={workspace.id} workspaceId={workspace.id} overseer={workspace.stub}
            restricted={workspace.restricted} selectedChatId={chatId} onNavigateToChat={setChatId}
            pendingConsoleLogCount={0} consoleLogPreview="" consoleLogSeverity="info"
            onConsumeConsoleLogs={noConsoleLogs} onDiscardConsoleLogs={ignore} constrainChatWidth
            onOpenGadget={ignore} outputOfWorkpiece={() => undefined} operateOnly
            operateWelcome={layout === 'full' || layout === 'side' ? welcome ?? 'How can I help you today?' : undefined}
            operateCenteredStart={layout === 'full'}
            operateSuggestions={layout === 'full' && consoleActions ? { pages: consoleActions.entry.console.views.map(view => ({ id: view.id, title: view.title })), onOpen: consoleActions.onOpenView } : undefined} />
        : <p role="status" className="p-4 text-sm text-kumo-subtle">Opening your assistant…</p>}
    </section>
  </>
}
