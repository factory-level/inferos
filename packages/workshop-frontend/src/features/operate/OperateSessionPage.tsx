import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import { useKumoToastManager } from '@cloudflare/kumo'
import { ChatCircleIcon, LayoutIcon, XIcon, AppWindowIcon } from '@phosphor-icons/react'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { sameOperateRef, type OperateEvent, type OperateRef } from '@gadgets/workshop-shared/operate-session'
import { useAuthenticatedApi } from '../../AuthContext'
import ChatInterface from '../../ChatInterface'
import { useResizableSplit } from '../../hooks/useResizableSplit'
import { InferOpsCanvasHome } from '../../pages/inferops-canvas/InferOpsCanvasHome'
import { useWorkspaceScreens } from '../../pages/inferops-canvas/useWorkspaceScreens'
import { useServerConfig } from '../../ServerConfigContext'
import { useOperateSession } from './OperateSessionContext'
import { SessionScreen } from './SessionScreen'

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

const refKey = (ref: OperateRef) => ref.type === 'screen' ? `${ref.workspaceId}/${ref.screenId}` : ref.workspaceId

/**
 * Operate: the person's one operate session. Its tabs are the working set, the main region shows the
 * focused reference, and the operate chat sits beside it. Every change goes through the session, so
 * every tab and device of theirs shows the same page.
 */
export const OperateSessionPage = () => {
  const operate = useOperateSession()
  const toasts = useKumoToastManager()
  const { authenticatedApi } = useAuthenticatedApi()
  const durableViews = useServerConfig()?.canvasFeatures?.durableViews === true
  const screens = useWorkspaceScreens(authenticatedApi, durableViews)
  const workspace = useSessionWorkspace()
  const split = useResizableSplit(true)
  const [chatId, setChatId] = useState<number | null>(null)

  if (!operate) return null
  if (operate.error) return <p role="alert" className="p-6 text-sm text-kumo-danger">{operate.error}</p>
  if (!operate.snapshot) return <p role="status" className="p-6 text-sm text-kumo-subtle">Opening your operate session…</p>

  const { state } = operate.snapshot
  const send = (event: OperateEvent) => {
    operate.dispatch(event).catch(caught => {
      console.error('Operate session change failed:', caught)
      toasts.add({ title: 'That change could not be applied to your session.', variant: 'error' })
    })
  }
  const titleOf = (ref: OperateRef) => {
    if (ref.type === 'workspace') return 'Workspace'
    if (screens.status !== 'ready') return 'Screen'
    const entry = screens.workspaces.find(({ workspace: w }) => w.id === ref.workspaceId)
    return entry?.screens?.find(screen => screen.id === ref.screenId)?.title ?? 'Screen'
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-kumo-base">
      <header className="flex h-14 flex-shrink-0 items-center gap-2 px-4">
        <div role="tablist" aria-label="Open in this session" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {state.workingSet.map(ref => {
            const selected = state.focus !== null && sameOperateRef(state.focus, ref)
            const Icon = ref.type === 'screen' ? LayoutIcon : AppWindowIcon
            return (
              <div key={refKey(ref)} className={`flex shrink-0 items-center rounded-lg ${selected ? 'bg-kumo-control' : ''}`}>
                <button type="button" role="tab" aria-selected={selected}
                  onClick={() => send({ type: 'focus', ref })}
                  className={`flex h-8 items-center gap-1.5 rounded-lg pl-2.5 pr-1 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring ${selected ? 'text-kumo-default' : 'text-kumo-subtle hover:text-kumo-default'}`}>
                  <Icon size={13} aria-hidden />{titleOf(ref)}
                </button>
                <button type="button" aria-label={`Close ${titleOf(ref)}`} onClick={() => send({ type: 'close', ref })}
                  className="mr-1 grid h-6 w-6 place-items-center rounded-md text-kumo-inactive hover:bg-kumo-fill-hover hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">
                  <XIcon size={11} aria-hidden />
                </button>
              </div>
            )
          })}
          {state.workingSet.length === 0 && <span className="px-1 text-[13px] text-kumo-inactive">Nothing open yet</span>}
        </div>
        <span className="text-[11px] text-kumo-inactive" title="Session sequence number">#{operate.snapshot.seq}</span>
        <button type="button" aria-pressed={state.chatOpen} onClick={() => send({ type: 'setChatOpen', open: !state.chatOpen })}
          className={`flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring ${state.chatOpen ? 'bg-kumo-control text-kumo-default' : 'text-kumo-subtle hover:text-kumo-default'}`}>
          <ChatCircleIcon size={14} aria-hidden />Operate chat
        </button>
      </header>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {state.chatOpen && (
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
        )}
        <main className="min-h-0 min-w-0 flex-1 overflow-auto">
          {state.focus?.type === 'screen'
            ? <SessionScreen key={refKey(state.focus)} workspaceId={state.focus.workspaceId} screenId={state.focus.screenId}
                onShowScreen={screenId => send({ type: 'open', ref: { type: 'screen', workspaceId: (state.focus as OperateRef).workspaceId, screenId } })}
                onClose={() => state.focus && send({ type: 'close', ref: state.focus })} />
            : state.focus?.type === 'workspace'
              ? <p className="p-6 text-sm text-kumo-subtle">Workspaces open in a session come next.</p>
              : <InferOpsCanvasHome />}
        </main>
      </div>
    </div>
  )
}
