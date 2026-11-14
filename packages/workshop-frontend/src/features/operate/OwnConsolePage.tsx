import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@cloudflare/kumo'
import { ArrowLeftIcon } from '@phosphor-icons/react'
import { parseCanvasDefinition, type CanvasDefinition, type CanvasProjectBoardWidget } from '@gadgets/workshop-shared/canvas'
import type { OperateConsole } from '@gadgets/workshop-shared/operate-console'
import type { OperateBoardView, OperateConsoleRun, OperateEvent } from '@gadgets/workshop-shared/operate-session'
import { useAuthenticatedApi } from '../../AuthContext'
import { canonicalBoardRef } from '../canvas/boardData'
import { CanvasView } from '../canvas/CanvasView'
import { BoardConnectPrompt } from './BoardConnectPrompt'
import { ConsoleRollup } from './ConsoleRollup'
import { viewScreens } from './consoles'
import { useOperateSession } from './OperateSessionContext'
import { SessionBoard } from './SessionBoard'
import type { SessionWorkspace } from './useSessionWorkspace'

/** A run of a console that belongs to no workspace. */
export type OwnConsoleRun = Extract<OperateConsoleRun, { home: 'console' }>

type Loaded = { console: OperateConsole | null; screens: readonly CanvasDefinition[] }

/** The event that opens a published console that belongs to no workspace, at `viewId` or its first view. */
export const openOwnConsoleEvent = (console: OperateConsole, viewId?: string): OperateEvent => ({
  type: 'openConsole', home: 'console', consoleId: console.id, title: console.title, source: 'published',
  revision: console.revision, fullChat: console.fullChat,
  viewId: console.views.some(view => view.id === viewId) ? viewId! : console.views[0].id,
})

const NO_GADGETS = new Map<never, never>()

/**
 * A published console that belongs to no workspace (ADR 0021), open in the session. It is read
 * through the viewer's own access to the console itself, never through a workspace. Its boards and
 * Wikis resolve in the viewer's own session workspace, whose connections they make from their own
 * InferOps account (`BoardConnectPrompt`); the console grants no access to any of it.
 *
 * A newer revision is never shown under the run that opened an older one: once the console read is
 * newer than the run, the page reopens on it by itself, once per revision.
 */
export const OwnConsolePage = ({ run, board, sessionWorkspace, onEvent }: {
  run: OwnConsoleRun
  /** The board the session shows, if any. */
  board: OperateBoardView | null
  /** The viewer's own session workspace, null until it has opened. */
  sessionWorkspace: SessionWorkspace | null
  onEvent: (event: OperateEvent) => void
}) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const operate = useOperateSession()
  const [loaded, setLoaded] = useState<Loaded | 'error' | null>(null)
  // The kernel's notice that this run's revision moved on: read the console again.
  const stale = operate?.staleConsole
  const noticed = !!stale && stale.workspaceId === null && stale.consoleId === run.consoleId && stale.revision === run.revision

  useEffect(() => {
    let cancelled = false
    setLoaded(null)
    const reading = authenticatedApi.openConsoleReading(run.consoleId)
    const read = async (): Promise<Loaded> => {
      const console = await reading.getConsole()
      const ids = console ? [...new Set(console.views.flatMap(viewScreens))] : []
      const screens = await Promise.all(ids.map(id => reading.getConsoleScreen(id)))
      return { console, screens: screens.flatMap(screen => screen ? [parseCanvasDefinition(screen)] : []) }
    }
    read().then(
      value => { if (!cancelled) setLoaded(value) },
      caught => {
        console.error('Failed to read the console:', caught)
        if (!cancelled) setLoaded('error')
      }).finally(() => reading[Symbol.dispose]())
    return () => { cancelled = true }
  }, [authenticatedApi, run.consoleId, run.revision, noticed])

  const saved = loaded && loaded !== 'error' ? loaded.console : null
  const outdated = !!saved && saved.revision !== run.revision
  const shown = outdated ? null : saved
  const view = shown?.views.find(candidate => candidate.id === run.viewId)
  const screenId = run.screenId ?? (view?.type === 'screen' ? view.screen : null)
  const screens = loaded && loaded !== 'error' && !outdated ? loaded.screens : []
  const screen = screenId === null ? undefined : screens.find(candidate => candidate.id === screenId)
  const boardWidgets = (screen?.sections.flatMap(section => section.widgets) ?? [])
    .filter((widget): widget is CanvasProjectBoardWidget => widget.kind === 'inferops.project-board')

  // Moves to a newer publication by itself, once per (run, revision): a refused reopen is not repeated.
  const reopened = useRef<string | null>(null)
  const dispatch = operate?.dispatch
  const reopenKey = outdated && saved ? `${run.consoleId}/${run.revision}>${saved.revision}` : null
  useEffect(() => {
    if (reopenKey === null || reopened.current === reopenKey || !saved || !dispatch) return
    reopened.current = reopenKey
    dispatch(openOwnConsoleEvent(saved, run.viewId)).catch(caught => console.error('Failed to reopen the console:', caught))
  }, [reopenKey, saved, dispatch, run.viewId])

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

  const openBoard = (widgetId: string) => {
    const widget = boardWidgets.find(candidate => candidate.id === widgetId)
    if (widget && sessionWorkspace) {
      onEvent({ type: 'openBoard', board: { workspaceId: sessionWorkspace.id, boardRef: canonicalBoardRef(widget.targetRef) } })
    }
  }
  const viewTitle = screen && run.screenId !== null ? screen.title : view?.title ?? 'view'

  let body: ReactNode
  if (loaded === null) body = <p role="status" className="text-sm text-kumo-subtle">Loading…</p>
  else if (loaded === 'error') body = <Notice>This console can't be opened. You may no longer have access to it.</Notice>
  else if (!saved) body = <Notice>This console is unavailable. It may have been removed or unpublished.</Notice>
  else if (outdated) body = <p role="status" className="text-sm text-kumo-subtle">Opening the latest version of this console…</p>
  else if (!view) body = <Notice>This view is no longer part of the console.</Notice>
  else if (!sessionWorkspace) body = <p role="status" className="text-sm text-kumo-subtle">Loading…</p>
  else if (board) {
    body = board.workspaceId === sessionWorkspace.id
      ? <SessionBoard board={board} overseer={sessionWorkspace.stub} backLabel={viewTitle} onEvent={onEvent}
          widget={boardWidgets.find(widget => canonicalBoardRef(widget.targetRef) === board.boardRef)} />
      : <Notice>This board can't be shown here.</Notice>
  } else if (screenId !== null) {
    body = !screen ? <Notice>This screen is unavailable. It may have been removed.</Notice>
      : <CanvasView scrollRoot={main} definition={screen} gadgets={NO_GADGETS} overseer={sessionWorkspace.stub}
          resourceScope={{
            overseer: sessionWorkspace.stub,
            unboundAction: (targetRef, retry) => <BoardConnectPrompt scope={sessionWorkspace.stub} targetRef={targetRef} onConnected={retry} />,
          }}
          onOpenWidget={openBoard} />
  } else if (view.type === 'rollup') {
    body = <ConsoleRollup screenIds={view.screens} screens={screens} gadgets={NO_GADGETS}
      onShowScreen={id => onEvent({ type: 'showScreen', screenId: id })} />
  }

  const crumbs = [run.title, view?.title, run.screenId !== null ? screen?.title : undefined,
    board ? `Board ${board.boardRef.split('/').at(-1) ?? ''}` : undefined].filter((crumb): crumb is string => !!crumb)
  return (
    <div className="flex h-full flex-col overflow-hidden bg-kumo-base">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 pt-3">
        {run.screenId !== null && !board && <button type="button" onClick={() => onEvent({ type: 'showScreen', screenId: null })}
          className="flex items-center gap-1.5 rounded-md text-sm text-kumo-subtle hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">
          <ArrowLeftIcon size={14} aria-hidden />Back to {view?.title ?? 'view'}
        </button>}
        <nav aria-label="Breadcrumb" className="min-w-0 truncate text-xs text-kumo-subtle">
          <ol className="flex min-w-0 items-center gap-1">
            {crumbs.map((crumb, index) => <li key={index} aria-current={index === crumbs.length - 1 ? 'page' : undefined} className="truncate">
              {index > 0 && <span aria-hidden className="mr-1">›</span>}{crumb}
            </li>)}
          </ol>
        </nav>
        {shown && shown.views.length > 1 && !board && <nav aria-label="Views" className="ml-auto flex flex-wrap gap-1">
          {shown.views.map(candidate => <Button key={candidate.id} size="sm" variant={candidate.id === run.viewId ? 'primary' : 'ghost'}
            aria-current={candidate.id === run.viewId ? 'page' : undefined}
            onClick={() => onEvent({ type: 'openView', viewId: candidate.id })}>{candidate.title}</Button>)}
        </nav>}
      </div>
      <main ref={main} tabIndex={-1} aria-label={crumbs.at(-1)} className="min-h-0 min-w-0 flex-1 overflow-auto focus:outline-none">
        <div className="mx-auto w-full max-w-6xl space-y-4 p-5">{body}</div>
      </main>
    </div>
  )
}

const Notice = ({ children }: { children: ReactNode }) =>
  <p role="alert" className="rounded-2xl border border-kumo-line bg-kumo-base p-6 text-sm text-kumo-subtle">{children}</p>
