import { useKumoToastManager } from '@cloudflare/kumo'
import { ChatCircleIcon, LayoutIcon, XIcon, AppWindowIcon } from '@phosphor-icons/react'
import { sameOperateRef, type OperateEvent, type OperateRef } from '@gadgets/workshop-shared/operate-session'
import { useAuthenticatedApi } from '../../AuthContext'
import { useWorkspaceScreens } from '../../pages/inferops-canvas/useWorkspaceScreens'
import { useServerConfig } from '../../ServerConfigContext'
import { useOperateSession } from './OperateSessionContext'
import { AgentActivityNote } from './AgentActivityNote'
import { InferOpsCanvasHome } from '../../pages/inferops-canvas/InferOpsCanvasHome'
import { ConsoleMosaic } from './ConsoleMosaic'
import { ConsolePage } from './ConsolePage'
import { findConsole, openConsoleEvent } from './consoles'
import { FlowPage } from './FlowPage'
import { OperateChatPanel } from './OperateChatPanel'
import { SessionApprovals } from './SessionApprovals'
import { SessionScreen } from './SessionScreen'
import { useSessionWorkspace } from './useSessionWorkspace'

const refKey = (ref: OperateRef) => ref.type === 'screen' ? `${ref.workspaceId}/${ref.screenId}` : ref.workspaceId

/**
 * Operate: the person's one operate session. With a console open, the page is that console. With
 * none, the home is the console mosaic, and anything the session has open (the working set, for
 * example screens the operate agent opened) shows as tabs, with the focused one in the main region
 * and the operate chat beside it on the right. While a flow runs, the flow's current
 * step takes the whole page instead. Every change goes through the session, so
 * every tab and device of theirs shows the same page. Pending approvals of the session workspace
 * and the focused screen's workspace are decided above the main region.
 */
export const OperateSessionPage = () => {
  const operate = useOperateSession()
  const toasts = useKumoToastManager()
  const { authenticatedApi } = useAuthenticatedApi()
  const durableViews = useServerConfig()?.canvasFeatures?.durableViews === true
  const screens = useWorkspaceScreens(authenticatedApi, durableViews)
  const sessionWorkspace = useSessionWorkspace(operate?.session ?? null)

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
  if (state.flow) return <FlowPage flow={state.flow} chatOpen={state.chatOpen} onEvent={send} sessionWorkspace={sessionWorkspace} />
  if (state.console) return (
    <ConsolePage run={state.console} loading={screens.status === 'loading'}
      entry={screens.status === 'ready' ? findConsole(screens.workspaces, state.console) : undefined}
      presentation={state.presentation} chatOpen={state.chatOpen} sessionWorkspace={sessionWorkspace} onEvent={send}
      approvals={<SessionApprovals session={sessionWorkspace} screenWorkspaceId={state.console.workspaceId}
        reviewing={state.reviewing} lastOutcome={state.lastApprovalOutcome} onEvent={operate.dispatch} />} />
  )

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
        </div>
        <div className="max-w-[40%] min-w-0"><AgentActivityNote records={operate.recentEvents} titleOf={titleOf} /></div>
        <span className="text-[11px] text-kumo-inactive" title="Session sequence number">#{operate.snapshot.seq}</span>
        <button type="button" aria-pressed={state.chatOpen} onClick={() => send({ type: 'setChatOpen', open: !state.chatOpen })}
          className={`flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring ${state.chatOpen ? 'bg-kumo-control text-kumo-default' : 'text-kumo-subtle hover:text-kumo-default'}`}>
          <ChatCircleIcon size={14} aria-hidden />Operate chat
        </button>
      </header>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <SessionApprovals session={sessionWorkspace}
            screenWorkspaceId={state.focus?.type === 'screen' ? state.focus.workspaceId : null}
            reviewing={state.reviewing} lastOutcome={state.lastApprovalOutcome} onEvent={operate.dispatch} />
          <main className="min-h-0 min-w-0 flex-1 overflow-auto">
            {state.focus?.type === 'screen'
              ? <SessionScreen key={refKey(state.focus)} workspaceId={state.focus.workspaceId} screenId={state.focus.screenId}
                  onShowScreen={screenId => send({ type: 'open', ref: { type: 'screen', workspaceId: (state.focus as OperateRef).workspaceId, screenId } })}
                  onClose={() => state.focus && send({ type: 'close', ref: state.focus })} />
              : state.focus?.type === 'workspace'
                ? <p className="p-6 text-sm text-kumo-subtle">Workspaces open in a session come next.</p>
                : <>
                    <ConsoleMosaic screens={screens} onOpen={entry => send(openConsoleEvent(entry))} />
                    {/* Creating screens and starting flows has no home in Build yet, so it stays
                        here, below the consoles, until the console builder lands. */}
                    <section aria-label="Screens and flows" className="border-t border-kumo-line"><InferOpsCanvasHome /></section>
                  </>}
          </main>
        </div>
        {state.chatOpen && <OperateChatPanel workspace={sessionWorkspace} />}
      </div>
    </div>
  )
}
