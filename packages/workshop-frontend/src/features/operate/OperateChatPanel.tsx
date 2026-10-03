import { useState } from 'react'
import ChatInterface from '../../ChatInterface'
import { useResizableSplit } from '../../hooks/useResizableSplit'
import type { SessionWorkspace } from './useSessionWorkspace'

const noConsoleLogs = () => ''
const ignore = () => {}

/**
 * The operate chat. Beside the page (`side`) it is a rounded card in a resizable column on the
 * right; as full chat (`full`) it fills the page, centered, with no canvas. It is the same chat
 * everywhere, since every place renders the one session workspace. That workspace's capability is
 * operate-only, so the chat is shown without authoring affordances.
 */
export const OperateChatPanel = ({ workspace, layout = 'side' }: {
  workspace: SessionWorkspace | null
  layout?: 'side' | 'full'
}) => {
  const split = useResizableSplit(layout === 'side', 'right')
  const [chatId, setChatId] = useState<number | null>(null)
  const chat = workspace
    ? <ChatInterface key={workspace.id} workspaceId={workspace.id} overseer={workspace.stub}
        restricted={workspace.restricted} selectedChatId={chatId} onNavigateToChat={setChatId}
        pendingConsoleLogCount={0} consoleLogPreview="" consoleLogSeverity="info"
        onConsumeConsoleLogs={noConsoleLogs} onDiscardConsoleLogs={ignore} constrainChatWidth
        onOpenGadget={ignore} outputOfWorkpiece={() => undefined} operateOnly />
    : <p role="status" className="p-4 text-sm text-kumo-subtle">Opening the operate chat…</p>

  if (layout === 'full') return (
    <section aria-label="Operate chat" className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col p-3">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-kumo-line bg-kumo-elevated">{chat}</div>
    </section>
  )
  return (
    <>
      <div role="separator" aria-orientation="vertical" aria-label="Resize operate chat"
        className="group relative w-1 flex-shrink-0 touch-none cursor-col-resize max-md:hidden" {...split.handleProps}>
        <div className="absolute inset-y-6 left-1/2 w-px -translate-x-1/2 bg-kumo-line group-hover:bg-kumo-ring" />
        <div className="absolute inset-y-0 -left-2 -right-2" />
      </div>
      <section aria-label="Operate chat" className="flex min-h-0 flex-shrink-0 flex-col py-3 pr-3 max-md:!w-full max-md:px-3" style={{ width: split.width }}>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-kumo-line bg-kumo-elevated">{chat}</div>
      </section>
    </>
  )
}
