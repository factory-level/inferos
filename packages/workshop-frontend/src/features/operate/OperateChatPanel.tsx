import { useState } from 'react'
import ChatInterface from '../../ChatInterface'
import { useResizableSplit } from '../../hooks/useResizableSplit'
import type { SessionWorkspace } from './useSessionWorkspace'

const noConsoleLogs = () => ''
const ignore = () => {}

/**
 * The operate chat, as a resizable column beside whatever the session shows. It is the same chat on
 * the session page and while a flow runs, since both render the one session workspace. That
 * workspace's capability is operate-only, so the chat is shown without authoring affordances.
 */
export const OperateChatPanel = ({ workspace }: { workspace: SessionWorkspace | null }) => {
  const split = useResizableSplit(true)
  const [chatId, setChatId] = useState<number | null>(null)
  return (
    <>
      <section aria-label="Operate chat" className="flex min-h-0 flex-shrink-0 flex-col bg-kumo-elevated max-md:!w-full" style={{ width: split.width }}>
        {workspace
          ? <ChatInterface key={workspace.id} workspaceId={workspace.id} overseer={workspace.stub}
              restricted={workspace.restricted} selectedChatId={chatId} onNavigateToChat={setChatId}
              pendingConsoleLogCount={0} consoleLogPreview="" consoleLogSeverity="info"
              onConsumeConsoleLogs={noConsoleLogs} onDiscardConsoleLogs={ignore} constrainChatWidth
              onOpenGadget={ignore} outputOfWorkpiece={() => undefined} operateOnly />
          : <p role="status" className="p-4 text-sm text-kumo-subtle">Opening the operate chat…</p>}
      </section>
      <div role="separator" aria-orientation="vertical" aria-label="Resize operate chat"
        className="relative w-px flex-shrink-0 touch-none cursor-col-resize overflow-visible bg-kumo-line max-md:hidden" {...split.handleProps}>
        <div className="absolute inset-y-0 -left-2 -right-2" />
      </div>
    </>
  )
}
