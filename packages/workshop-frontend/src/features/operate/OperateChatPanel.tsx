import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import ChatInterface from '../../ChatInterface'
import { useResizableSplit } from '../../hooks/useResizableSplit'
import { useOperateSession } from './OperateSessionContext'

const noConsoleLogs = () => ''
const ignore = () => {}

type SessionWorkspace = { stub: RpcStub<Overseer>; id: string; restricted: boolean }

/** The session's owner-only workspace, where its operate chat runs. */
const useSessionWorkspace = () => {
  const session = useOperateSession()?.session ?? null
  const [workspace, setWorkspace] = useState<SessionWorkspace | null>(null)
  useEffect(() => {
    if (!session) return
    let cancelled = false
    const stub = session.stub.getWorkspace()
    stub.getMetadata().then(metadata => {
      if (!cancelled) setWorkspace({ stub, id: metadata.id, restricted: metadata.containsRestrictedData === true })
    }).catch(caught => console.error('Failed to open the operate session workspace:', caught))
    return () => {
      cancelled = true
      stub[Symbol.dispose]()
      setWorkspace(null)
    }
  }, [session])
  return workspace
}

/**
 * The operate chat, as a resizable column beside whatever the session shows. It is the same chat on
 * the session page and while a flow runs, since both render the one session.
 */
export const OperateChatPanel = () => {
  const workspace = useSessionWorkspace()
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
              onOpenGadget={ignore} outputOfWorkpiece={() => undefined} />
          : <p role="status" className="p-4 text-sm text-kumo-subtle">Opening the operate chat…</p>}
      </section>
      <div role="separator" aria-orientation="vertical" aria-label="Resize operate chat"
        className="relative w-px flex-shrink-0 touch-none cursor-col-resize overflow-visible bg-kumo-line max-md:hidden" {...split.handleProps}>
        <div className="absolute inset-y-0 -left-2 -right-2" />
      </div>
    </>
  )
}
