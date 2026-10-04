import type { ReactNode } from 'react'
import { ArrowLeftIcon } from '@phosphor-icons/react'
import type { GadgetSummary, WorkpieceId } from '@gadgets/workshop-shared/api'
import type { OperateConsoleRun, OperateEvent } from '@gadgets/workshop-shared/operate-session'
import { useAuthenticatedApi } from '../../AuthContext'
import { useWorkspaceWorkpieces } from '../../hooks/useWorkspaceWorkpieces'
import { useWorkspaceOpen } from '../../useWorkspaceOpen'
import { CanvasView } from '../canvas/CanvasView'
import { ConsoleRollup } from './ConsoleRollup'
import type { ConsoleEntry } from './consoles'

const ignore = () => {}

/** A console view reads screens through the viewer's own workspace capability. */
export const ConsolePage = ({ run, entry, loading, onEvent }: {
  run: OperateConsoleRun
  /** The console's saved definition, or undefined when it is gone (or not loaded yet). */
  entry: ConsoleEntry | undefined
  /** Whether the saved consoles are still loading. */
  loading: boolean
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
      {run.screenId !== null && <div className="px-5 pt-3">
        <button type="button" onClick={() => onEvent({ type: 'showScreen', screenId: null })}
          className="flex items-center gap-1.5 rounded-md text-sm text-kumo-subtle hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">
          <ArrowLeftIcon size={14} aria-hidden />Back to {view?.title ?? 'view'}
        </button>
      </div>}
      <main className="min-h-0 min-w-0 flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-6xl p-5">{body}</div>
      </main>
    </div>
  )
}

const Notice = ({ children }: { children: ReactNode }) =>
  <p role="alert" className="rounded-2xl border border-kumo-line bg-kumo-base p-6 text-sm text-kumo-subtle">{children}</p>
