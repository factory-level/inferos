import { useState } from 'react'
import { Button, useKumoToastManager } from '@cloudflare/kumo'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { PlusIcon, SlidersHorizontalIcon } from '@phosphor-icons/react'
import type { OperateEvent, OperateRef } from '@gadgets/workshop-shared/operate-session'
import { useAuthenticatedApi } from '../../AuthContext'
import { canBuild, useWorkspaceScreens } from '../../pages/inferops-canvas/useWorkspaceScreens'
import { useServerConfig } from '../../ServerConfigContext'
import { useOperateSession } from './OperateSessionContext'
import { refusalMessage } from './sessionRefusal'
import { AgentActivityNote } from './AgentActivityNote'
import { InferOpsCanvasHome } from '../../pages/inferops-canvas/InferOpsCanvasHome'
import { ConsoleMosaic } from './ConsoleMosaic'
import { ConsolePage } from './ConsolePage'
import { ConsoleBuilder } from './ConsoleBuilder'
import { ConsoleSettings } from './ConsoleSettings'
import { ConsoleWorkspaceShell } from './ConsoleWorkspaceShell'
import type { ConsoleWidgetTarget } from './ConsoleWidgetActions'
import { ConsoleWidgetView } from './ConsoleWidgetView'
import { viewScreens } from './consoles'
import { consoleEntries, findConsole, openConsoleEvent, type ConsoleEntry } from './consoles'
import { FlowPage } from './FlowPage'
import { HandoverInbox } from './HandoverInbox'
import { OperateChatPanel } from './OperateChatPanel'
import { SessionApprovals } from './SessionApprovals'
import { SessionBoard } from './SessionBoard'
import { SessionScreen } from './SessionScreen'
import { useBoardHistory, type BoardSearch } from './useBoardHistory'
import { useSessionWorkspace } from './useSessionWorkspace'

/** Operate's launcher and workspaces share one mounted conversation, including during setup. */
export const OperateSessionPage = () => {
  const operate = useOperateSession()
  const toasts = useKumoToastManager()
  const navigate = useNavigate()
  const search = useSearch({ from: '/inferops-canvas' })
  const { authenticatedApi } = useAuthenticatedApi()
  const durableViews = useServerConfig()?.canvasFeatures?.durableViews === true
  const screens = useWorkspaceScreens(authenticatedApi, durableViews)
  const sessionWorkspace = useSessionWorkspace(operate?.session ?? null)
  const [savedEntry, setSavedEntry] = useState<ConsoleEntry | null>(null)

  const [widgetTarget, setWidgetTarget] = useState<ConsoleWidgetTarget | null>(null)
  const consoleId = operate?.snapshot?.state.console?.consoleId
  const notifyRefused = (caught: unknown) => {
    console.error('Operate session change failed:', caught)
    toasts.add({ title: refusalMessage(caught), variant: 'error' })
  }
  const send = (event: OperateEvent) => { operate?.dispatch(event).catch(notifyRefused) }
  useBoardHistory(operate?.snapshot?.state.board ?? null, search,
    (boardSearch: BoardSearch, replace) => void navigate({ to: '/inferops-canvas', search: previous => ({ ...previous, ...boardSearch }), replace }),
    event => (operate ? operate.dispatch(event) : Promise.reject(new Error('No operate session'))).catch(caught => { notifyRefused(caught); throw caught }))

  if (!operate) return null
  if (operate.error) return <p role="alert" className="p-6 text-sm text-kumo-danger">{operate.error}</p>
  if (!operate.snapshot) return <p role="status" className="p-6 text-sm text-kumo-subtle">Opening your operate session…</p>

  const { state } = operate.snapshot
  const run = state.console
  const workspaces = screens.status === 'ready' ? screens.workspaces : []
  const entry = run ? findConsole(workspaces, run) : undefined
  const viewTitle = run?.screenId ? entry?.screens.find(screen => screen.id === run.screenId)?.title : entry?.console.views.find(view => view.id === run?.viewId)?.title
  const setup = search.setup
  const settings = search.settings
  const configuring = !!setup || !!settings
  const tools = search.tools === true
  const home = !state.flow && !run && !state.board && !state.focus && !tools && !configuring
  const centered = !state.flow && !tools && !configuring && run !== null && state.presentation === 'chat'
  const hideChat = configuring || tools || (!home && !centered && !state.chatOpen)
  const showHome = async () => {
    try {
      await operate.dispatch({ type: 'showHome' })
      await navigate({ to: '/inferops-canvas', search: {} })
    } catch { toasts.add({ title: 'Could not return to consoles. Try again.', variant: 'error' }) }
  }
  const titleOf = (ref: OperateRef) => ref.type === 'workspace' ? 'Workspace'
    : workspaces.find(item => item.workspace.id === ref.workspaceId)?.screens?.find(screen => screen.id === ref.screenId)?.title ?? 'Screen'
  const editing = setup && setup !== 'new'
    ? consoleEntries(workspaces).find(item => item.workspace.id === search.workspace && item.console.id === setup) : undefined
  const openWidget = async (target: ConsoleWidgetTarget) => {
    if (!entry || target.consoleId !== entry.console.id) return
    try {
      if (target.presentation === 'page') {
        const view = entry.console.views.find(candidate => viewScreens(candidate).includes(target.screenId))
        if (!view) return
        if (state.presentation === 'chat') await operate.dispatch({ type: 'setPresentation', presentation: 'canvas' })
        await operate.dispatch({ type: 'openView', viewId: view.id })
        await operate.dispatch({ type: 'showScreen', screenId: target.screenId })
      }
      setWidgetTarget(target)
    } catch (caught) { toasts.add({ title: refusalMessage(caught), variant: 'error' }) }
  }
  const visibleWidget = widgetTarget?.consoleId === consoleId ? widgetTarget : null
  const settingsEntry = settings ? consoleEntries(workspaces).find(item => item.workspace.id === search.workspace && item.console.id === settings) : undefined
  const openView = async (viewId: string) => {
    setWidgetTarget(null)
    try {
      if (state.presentation === 'chat') await operate.dispatch({ type: 'setPresentation', presentation: 'canvas' })
      await operate.dispatch({ type: 'openView', viewId })
      await operate.dispatch({ type: 'setChatOpen', open: true })
    } catch (caught) { toasts.add({ title: refusalMessage(caught), variant: 'error' }) }
  }
  const edit = (item: ConsoleEntry) => void navigate({ to: '/inferops-canvas', search: { setup: item.console.id, workspace: item.workspace.id } })

  return <ConsoleWorkspaceShell onOpenWidget={target => void openWidget(target)} onNavigate={() => setWidgetTarget(null)}>
    <div className="flex h-full min-h-0 flex-col bg-kumo-base">
    {!configuring && <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-3 px-5 py-3">
      <h1 className="min-w-0 flex-1 truncate text-sm font-medium text-kumo-default">{state.flow ? state.flow.title : tools ? 'Screens and flows' : (run ? centered ? 'Assistant' : viewTitle ?? 'Console' : state.focus ? titleOf(state.focus) : 'Consoles')}</h1>
      <div className="hidden max-w-[30%] md:block"><AgentActivityNote records={operate.recentEvents} titleOf={titleOf} /></div>
      {home && <>
        <Button variant="ghost" size="sm" onClick={() => void navigate({ to: '/inferops-canvas', search: { tools: true } })}>Screens and flows</Button>
        <Button variant="primary" size="sm" disabled={!durableViews} onClick={() => void navigate({ to: '/inferops-canvas', search: { setup: 'new' } })}><PlusIcon size={14} aria-hidden />New console</Button>
      </>}
      {tools && <Button size="sm" onClick={() => void showHome()}>All consoles</Button>}
      {entry && !state.flow && <Button size="sm" variant="ghost" aria-label="Console settings" title="Console settings" onClick={() => void navigate({ to: '/inferops-canvas', search: { settings: entry.console.id, workspace: entry.workspace.id } })}><SlidersHorizontalIcon size={16} aria-hidden /></Button>}
      {!home && !tools && !centered && <Button size="sm" aria-pressed={state.chatOpen}
        onClick={() => send({ type: 'setChatOpen', open: !state.chatOpen })}>{state.chatOpen ? 'Hide assistant' : 'Show assistant'}</Button>}
    </header>}
    {!configuring && <SessionApprovals session={sessionWorkspace}
      screenWorkspaceId={state.flow?.workspaceId ?? run?.workspaceId ?? (state.focus?.type === 'screen' ? state.focus.workspaceId : null)}
      reviewing={state.reviewing} lastOutcome={state.lastApprovalOutcome} onEvent={operate.dispatch} />}
    {!configuring && <HandoverInbox handovers={state.handovers} workspace={sessionWorkspace} onEvent={operate.dispatch} />}
    <div className={`flex min-h-0 flex-1 ${home ? 'flex-col overflow-y-auto' : 'overflow-hidden'}`}>
      <div hidden={centered} className={centered ? 'hidden' : home
        ? 'mx-auto w-full max-w-6xl shrink-0 px-5 pb-4 pt-6 sm:px-8'
        : `min-h-0 min-w-0 flex-1 overflow-auto ${!hideChat ? 'max-md:hidden' : ''}`}>
        {settings
          ? settingsEntry ? <ConsoleSettings key={`${settingsEntry.console.id}/${settingsEntry.console.revision}`} entry={settingsEntry}
              onClose={() => void navigate({ to: '/inferops-canvas', search: {} })} onEdit={() => edit(settingsEntry)} />
            : <p role="status" className="p-6 text-sm text-kumo-subtle">{screens.status === 'loading' ? 'Loading settings…' : 'This console is unavailable.'}</p>
          : setup
          ? screens.status !== 'ready'
            ? <p role={screens.status === 'error' ? 'alert' : 'status'} className="p-6 text-sm text-kumo-subtle">{screens.status === 'error' ? 'Could not load console setup. Reload to try again.' : 'Loading console setup…'}</p>
            : setup !== 'new' && !editing
              ? <p role="alert" className="p-6 text-sm text-kumo-danger">This console is unavailable. Return to All consoles to choose another.</p>
              : <ConsoleBuilder key={`${search.workspace ?? ''}/${setup}`} workspaces={workspaces.filter(canBuild)} initial={editing}
                  onCancel={() => void showHome()} onSaved={saved => { setSavedEntry(saved); void showHome() }} />
          : tools ? <InferOpsCanvasHome />
          : state.flow ? <FlowPage flow={state.flow} chatOpen={state.chatOpen} onEvent={send} />
          : run && visibleWidget?.presentation === 'page' && run.screenId === visibleWidget.screenId ? <ConsoleWidgetView workspaceId={run.workspaceId} target={visibleWidget} onClose={() => setWidgetTarget(null)} />
          : run ? <ConsolePage run={run} entry={entry} loading={screens.status === 'loading'} board={state.board}
              sessionWorkspace={sessionWorkspace} onEvent={send} />
          : state.board
            ? sessionWorkspace?.id === state.board.workspaceId
              ? <div className="h-full p-5"><SessionBoard board={state.board} overseer={sessionWorkspace.stub} backLabel="consoles" onEvent={send} /></div>
              : sessionWorkspace
                ? <div role="alert" className="space-y-3 p-6 text-sm text-kumo-subtle"><p>This board was opened through a workspace you no longer reach.</p>
                    <Button size="sm" onClick={() => send({ type: 'closeBoard' })}>Back to consoles</Button></div>
                : <p role="status" className="p-6 text-sm text-kumo-subtle">Opening the board…</p>
          : state.focus?.type === 'screen'
            ? <SessionScreen key={`${state.focus.workspaceId}/${state.focus.screenId}`} workspaceId={state.focus.workspaceId} screenId={state.focus.screenId}
                onShowScreen={screenId => send({ type: 'open', ref: { type: 'screen', workspaceId: state.focus!.workspaceId, screenId } })}
                onClose={() => state.focus && send({ type: 'close', ref: state.focus })} />
            : state.focus ? <p className="p-6 text-sm text-kumo-subtle">Workspaces open in a session come next.</p>
            : <>
                {savedEntry && <div role="status" className="mb-4 flex items-center gap-3 text-sm text-kumo-subtle">
                  <span>{savedEntry.console.title} saved.</span><Button size="sm" onClick={() => send(openConsoleEvent(savedEntry))}>Open console</Button>
                </div>}
                <ConsoleMosaic key={savedEntry?.console.id} screens={screens} highlighted={savedEntry?.console.id}
                  onOpen={item => send(openConsoleEvent(item))} onEdit={edit} />
                {state.workingSet.length > 0 && <nav aria-label="Open in this session" className="mt-4 flex flex-wrap gap-2">
                  {state.workingSet.map(ref => <Button key={ref.type === 'screen' ? `${ref.workspaceId}/${ref.screenId}` : ref.workspaceId}
                    size="sm" onClick={() => send({ type: 'focus', ref })}>{titleOf(ref)}</Button>)}
                </nav>}
              </>}
      </div>
      <OperateChatPanel workspace={sessionWorkspace} layout={hideChat ? 'hidden' : home ? 'home' : centered ? 'full' : 'side'}
        onClose={() => send({ type: 'setChatOpen', open: false })}
        consoleActions={entry && run?.fullChat !== 'only' ? { entry, onOpenView: viewId => void openView(viewId), onOpenWidget: target => void openWidget(target) } : undefined} />
    </div>
    {!configuring && !tools && run && visibleWidget?.presentation === 'modal' && <ConsoleWidgetView workspaceId={run.workspaceId} target={visibleWidget} onClose={() => setWidgetTarget(null)} />}
  </div>
  </ConsoleWorkspaceShell>
}
