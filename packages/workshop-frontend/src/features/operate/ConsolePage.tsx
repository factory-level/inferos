import { useEffect, useRef, type ReactNode } from 'react'
import { Banner, Button } from '@cloudflare/kumo'
import { ArrowLeftIcon } from '@phosphor-icons/react'
import type { GadgetSummary, WorkpieceId } from '@gadgets/workshop-shared/api'
import type { CanvasProjectBoardWidget } from '@gadgets/workshop-shared/canvas'
import type { OperateBoardView, OperateConsoleRun, OperateEvent } from '@gadgets/workshop-shared/operate-session'
import { useAuthenticatedApi } from '../../AuthContext'
import { useWorkspaceWorkpieces } from '../../hooks/useWorkspaceWorkpieces'
import { useWorkspaceOpen } from '../../useWorkspaceOpen'
import { canonicalBoardRef } from '../canvas/boardData'
import { CanvasView, type CanvasResourceScope } from '../canvas/CanvasView'
import { BoardConnectPrompt } from './BoardConnectPrompt'
import { ConsoleRollup } from './ConsoleRollup'
import { openConsoleEvent, type ConsoleEntry } from './consoles'
import { SessionBoard } from './SessionBoard'
import type { SessionWorkspace } from './useSessionWorkspace'

const ignore = () => {}

/**
 * A console view reads screens through the viewer's own workspace capability. Its boards resolve
 * under the viewer's own authority: through the console workspace's connections for a builder, and
 * for a use-role operator through their own session workspace, whose connections they make from
 * their own InferOps account (`BoardConnectPrompt`); the console owner's connection is never used
 * for them. A board card's full view is the session's shown board (`openBoard`), so it survives
 * reload and reconnect and Back is a session event.
 *
 * A draft opened as a preview says so, and offers publishing it. When the revision the session
 * opened is no longer the latest (a newer one was published, or the previewed draft was saved
 * again), the kernel refuses the next move, so the page offers to reopen it on the latest one.
 */
export const ConsolePage = ({ run, entry, loading, board, sessionWorkspace, onEvent, onPublish }: {
  run: OperateConsoleRun
  /** The latest saved revision of the kind the session opened, or undefined when it is gone (or not loaded yet). */
  entry: ConsoleEntry | undefined
  /** Whether the saved consoles are still loading. */
  loading: boolean
  /** The board the session shows, if any. */
  board: OperateBoardView | null
  /** The viewer's own session workspace, null until it has opened. */
  sessionWorkspace: SessionWorkspace | null
  onEvent: (event: OperateEvent) => void
  /** Publish the previewed draft. */
  onPublish: (entry: ConsoleEntry) => void
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
  const boardWidgets = (screen?.sections.flatMap(section => section.widgets) ?? [])
    .filter((widget): widget is CanvasProjectBoardWidget => widget.kind === 'inferops.project-board')

  const useRole = entry?.workspace.role === 'use'
  // Where this viewer's boards resolve, and the workspace an openBoard names for them.
  const boardScope = useRole
    ? sessionWorkspace && { stub: sessionWorkspace.stub, id: sessionWorkspace.id }
    : overseer && { stub: overseer.stub, id: run.workspaceId }
  const resourceScope: CanvasResourceScope | undefined = useRole && sessionWorkspace ? {
    overseer: sessionWorkspace.stub,
    unboundAction: (targetRef, retry) => <BoardConnectPrompt scope={sessionWorkspace.stub} targetRef={targetRef} onConnected={retry} />,
  } : undefined
  const openBoard = (widgetId: string) => {
    const widget = boardWidgets.find(candidate => candidate.id === widgetId)
    if (widget && boardScope) onEvent({ type: 'openBoard', board: { workspaceId: boardScope.id, boardRef: canonicalBoardRef(widget.targetRef) } })
  }
  // The shown board is read only through the workspace the session names, and only where this
  // viewer reads boards: their session workspace, or (building) the console's own.
  const shownStub = !board ? undefined
    : board.workspaceId === sessionWorkspace?.id ? sessionWorkspace.stub
    : !useRole && board.workspaceId === run.workspaceId ? overseer?.stub : undefined
  // Until the workspace that could read it has (re)opened, as after a reconnect, the board is
  // still opening: whether it can be shown here is not known yet, so nothing claims it can't.
  const boardOpening = !!board && !shownStub
    && (!sessionWorkspace || (!useRole && board.workspaceId === run.workspaceId && !overseer))
  const viewTitle = screen && run.screenId !== null ? screen.title : view?.title ?? 'view'

  // Opening or leaving a board moves focus to the page, so a keyboard user is not left on an
  // element that no longer exists.
  const main = useRef<HTMLElement>(null)
  const boardKey = board ? `${board.workspaceId} ${board.boardRef}` : null
  const lastBoardKey = useRef(boardKey)
  useEffect(() => {
    if (lastBoardKey.current === boardKey) return
    lastBoardKey.current = boardKey
    main.current?.focus()
  }, [boardKey])

  let body: ReactNode
  if (loading) body = <p role="status" className="text-sm text-kumo-subtle">Loading…</p>
  else if (error) body = <Notice>This console's workspace can't be opened. You may no longer have access to it.</Notice>
  else if (!entry) body = <Notice>This console is unavailable. It may have been removed.</Notice>
  else if (!view) body = <Notice>This view is no longer part of the console.</Notice>
  else if (board) {
    body = boardOpening ? <p role="status" className="text-sm text-kumo-subtle">Opening the board…</p>
      : shownStub
      ? <SessionBoard board={board} overseer={shownStub} backLabel={viewTitle} onEvent={onEvent}
          widget={boardWidgets.find(widget => canonicalBoardRef(widget.targetRef) === board.boardRef)} />
      : <div className="space-y-3">
          <Notice>This board can't be shown here. It was opened through a workspace you don't read boards from on this console.</Notice>
          <BackButton label={viewTitle} onBack={() => onEvent({ type: 'closeBoard' })} />
        </div>
  }
  else if (!overseer || (useRole && !sessionWorkspace)) body = <p role="status" className="text-sm text-kumo-subtle">Loading…</p>
  else if (screenId !== null) {
    body = !screen ? <Notice>This screen is unavailable. It may have been removed.</Notice>
      : <CanvasView scrollRoot={main} definition={screen} gadgets={gadgets} overseer={overseer.stub} resourceScope={resourceScope}
          offeredBy={run.source === 'published' ? { consoleId: run.consoleId, revision: run.revision } : undefined}
          onOpenWidget={openBoard} />
  } else if (view.type === 'rollup') {
    body = <ConsoleRollup screenIds={view.screens} screens={entry.screens} gadgets={gadgets}
      onShowScreen={id => onEvent({ type: 'showScreen', screenId: id })} />
  }

  const outdated = !!entry && entry.console.revision !== run.revision
  const reopen = () => {
    if (!entry) return
    const event = openConsoleEvent(entry, run.source)
    if (event?.type !== 'openConsole') return
    const keep = entry.console.views.some(candidate => candidate.id === run.viewId)
    onEvent({ ...event, viewId: keep ? run.viewId : event.viewId })
  }

  const crumbs = [run.title, view?.title, run.screenId !== null ? screen?.title : undefined,
    board ? `Board ${board.boardRef.split('/').at(-1) ?? ''}` : undefined].filter((crumb): crumb is string => !!crumb)
  return (
    <div className="flex h-full flex-col overflow-hidden bg-kumo-base">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 pt-3">
        {run.screenId !== null && !board && <BackButton label={view?.title ?? 'view'} onBack={() => onEvent({ type: 'showScreen', screenId: null })} />}
        <nav aria-label="Breadcrumb" className="min-w-0 truncate text-xs text-kumo-subtle">
          <ol className="flex min-w-0 items-center gap-1">
            {crumbs.map((crumb, index) => <li key={index} aria-current={index === crumbs.length - 1 ? 'page' : undefined} className="truncate">
              {index > 0 && <span aria-hidden className="mr-1">›</span>}{crumb}
            </li>)}
          </ol>
        </nav>
      </div>
      {(run.source === 'draft' || outdated) && <div className="space-y-2 px-5 pt-3">
        {run.source === 'draft' && <Banner variant="secondary" title="Previewing the draft"
          description="Operators don't see these changes until you publish. Actions use your own access and still need approval."
          action={<span className="flex gap-2">
            {entry && <Button size="sm" variant="primary" onClick={() => onPublish(entry)}>Publish</Button>}
            <Button size="sm" onClick={() => onEvent({ type: 'closeConsole' })}>Exit preview</Button>
          </span>} />}
        {outdated && <Banner variant="alert"
          title={run.source === 'draft' ? 'This draft has been saved since you opened it' : 'A newer version of this console was published'}
          description="Reopen it to continue on the latest version."
          action={<Button size="sm" onClick={reopen}>Reopen</Button>} />}
      </div>}
      <main ref={main} tabIndex={-1} aria-label={crumbs.at(-1)} className="min-h-0 min-w-0 flex-1 overflow-auto focus:outline-none">
        <div className="mx-auto w-full max-w-6xl p-5">{body}</div>
      </main>
    </div>
  )
}

const BackButton = ({ label, onBack }: { label: string; onBack: () => void }) =>
  <button type="button" onClick={onBack}
    className="flex items-center gap-1.5 rounded-md text-sm text-kumo-subtle hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">
    <ArrowLeftIcon size={14} aria-hidden />Back to {label}
  </button>

const Notice = ({ children }: { children: ReactNode }) =>
  <p role="alert" className="rounded-2xl border border-kumo-line bg-kumo-base p-6 text-sm text-kumo-subtle">{children}</p>
