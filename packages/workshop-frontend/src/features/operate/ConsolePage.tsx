import type { ReactNode } from 'react'
import { ArrowLeftIcon, CaretRightIcon, ChatCircleIcon } from '@phosphor-icons/react'
import type { GadgetSummary, WorkpieceId } from '@gadgets/workshop-shared/api'
import type { OperateConsoleRun, OperateEvent, OperatePresentation } from '@gadgets/workshop-shared/operate-session'
import { useAuthenticatedApi } from '../../AuthContext'
import { useWorkspaceWorkpieces } from '../../hooks/useWorkspaceWorkpieces'
import { useWorkspaceOpen } from '../../useWorkspaceOpen'
import { CanvasView } from '../canvas/CanvasView'
import { ConsoleRollup } from './ConsoleRollup'
import type { ConsoleEntry } from './consoles'
import { OperateChatPanel } from './OperateChatPanel'
import type { SessionWorkspace } from './useSessionWorkspace'

const ignore = () => {}

/**
 * An open console: a breadcrumb of console, view and screen with Back, the shown view (a rollup of
 * screen tiles, or one screen drawn read-only), and the operate chat as a card on the right. In
 * the full chat presentation the conversation fills the page instead. Screens are read through the
 * viewer's own access to the console's workspace; nothing here can edit them.
 */
export const ConsolePage = ({ run, entry, loading, presentation, chatOpen, sessionWorkspace, approvals, onEvent }: {
  run: OperateConsoleRun
  /** The console's saved definition, or undefined when it is gone (or not loaded yet). */
  entry: ConsoleEntry | undefined
  /** Whether the saved consoles are still loading. */
  loading: boolean
  presentation: OperatePresentation
  chatOpen: boolean
  sessionWorkspace: SessionWorkspace | null
  /** Pending approvals to decide, shown above the canvas. */
  approvals: ReactNode
  onEvent: (event: OperateEvent) => void
}) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const { overseer, error } = useWorkspaceOpen({
    id: run.workspaceId, authenticatedApi, onMetadata: ignore, onShareKeyConsumed: ignore, onInvalidShareKey: ignore,
  })
  const { workpieces } = useWorkspaceWorkpieces(overseer, run.workspaceId)
  const gadgets = new Map<WorkpieceId, GadgetSummary>()
  for (const workpiece of workpieces.values()) if (workpiece.type === 'gadget') gadgets.set(workpiece.id, workpiece)

  const view = entry?.console.views.find(candidate => candidate.id === run.viewId)
  const screenId = run.screenId ?? (view?.type === 'screen' ? view.screen : null)
  const screen = screenId === null ? undefined : entry?.screens.find(candidate => candidate.id === screenId)

  let body: ReactNode
  if (loading) body = <p role="status" className="text-sm text-kumo-subtle">Loading…</p>
  else if (error) body = <Notice>This console's workspace can't be opened. You may no longer have access to it.</Notice>
  else if (!entry) body = <Notice>This console is unavailable. It may have been removed.</Notice>
  else if (!view) body = <Notice>This view is no longer part of the console.</Notice>
  else if (!overseer) body = <p role="status" className="text-sm text-kumo-subtle">Loading…</p>
  else if (screenId !== null) {
    body = screen
      ? <CanvasView definition={screen} gadgets={gadgets} overseer={overseer.stub} />
      : <Notice>This screen is unavailable. It may have been removed.</Notice>
  } else if (view.type === 'rollup') {
    body = <ConsoleRollup screenIds={view.screens} screens={entry.screens} gadgets={gadgets}
      onShowScreen={id => onEvent({ type: 'showScreen', screenId: id })} />
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-kumo-base">
      <header className="flex h-14 flex-shrink-0 items-center gap-2 px-4">
        {presentation === 'canvas' && run.screenId !== null && (
          <button type="button" onClick={() => onEvent({ type: 'showScreen', screenId: null })}
            className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] text-kumo-default hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">
            <ArrowLeftIcon size={14} aria-hidden />Back
          </button>
        )}
        <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
          <ol className="flex min-w-0 items-center gap-1 text-[13px]">
            <li className="truncate text-kumo-subtle">{run.title}</li>
            <li aria-hidden><CaretRightIcon size={11} className="text-kumo-inactive" /></li>
            {presentation === 'chat'
              ? <li className="truncate font-medium text-kumo-default" aria-current="page">Full chat</li>
              : <li className={`truncate ${run.screenId === null ? 'font-medium text-kumo-default' : 'text-kumo-subtle'}`}
                  aria-current={run.screenId === null ? 'page' : undefined}>{view?.title ?? 'View'}</li>}
            {presentation === 'canvas' && run.screenId !== null && <>
              <li aria-hidden><CaretRightIcon size={11} className="text-kumo-inactive" /></li>
              <li className="truncate font-medium text-kumo-default" aria-current="page">{screen?.title ?? 'Screen'}</li>
            </>}
          </ol>
        </nav>
        {presentation === 'canvas' && (
          <button type="button" aria-pressed={chatOpen} onClick={() => onEvent({ type: 'setChatOpen', open: !chatOpen })}
            className={`flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring ${chatOpen ? 'bg-kumo-control text-kumo-default' : 'text-kumo-subtle hover:text-kumo-default'}`}>
            <ChatCircleIcon size={14} aria-hidden />Operate chat
          </button>
        )}
      </header>
      <div className="flex min-h-0 flex-1 overflow-hidden bg-kumo-tint">
        {presentation === 'chat'
          ? <OperateChatPanel workspace={sessionWorkspace} layout="full" />
          : <>
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                {approvals}
                <main className="min-h-0 min-w-0 flex-1 overflow-auto">
                  <div className="mx-auto w-full max-w-6xl p-6">{body}</div>
                </main>
              </div>
              {chatOpen && <OperateChatPanel workspace={sessionWorkspace} />}
            </>}
      </div>
    </div>
  )
}

const Notice = ({ children }: { children: ReactNode }) =>
  <p role="alert" className="rounded-2xl border border-kumo-line bg-kumo-base p-6 text-sm text-kumo-subtle">{children}</p>
