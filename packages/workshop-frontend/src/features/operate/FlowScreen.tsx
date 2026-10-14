import { useEffect, useState, type RefObject } from 'react'
import type { GadgetSummary, WorkpieceId } from '@gadgets/workshop-shared/api'
import { parseCanvasDefinition, type CanvasDefinition } from '@gadgets/workshop-shared/canvas'
import { consoleScreens } from '@gadgets/workshop-shared/operate-console'
import type { OperateConsoleRun, OperateFlowRun } from '@gadgets/workshop-shared/operate-session'
import { useAuthenticatedApi } from '../../AuthContext'
import { CanvasView, type CanvasResourceScope } from '../canvas/CanvasView'
import { useWorkspaceWorkpieces } from '../../hooks/useWorkspaceWorkpieces'
import { useWorkspaceOpen } from '../../useWorkspaceOpen'
import { BoardConnectPrompt } from './BoardConnectPrompt'
import type { ConsoleEntry } from './consoles'
import type { SessionWorkspace } from './useSessionWorkspace'

const ignore = () => {}

const UNAVAILABLE = 'This step is unavailable. Its screen may have been removed, or you may no longer have access to its workspace.'
const NOT_OPEN = "This flow's console is not open. Exit the flow and start it again from its console."
const CHANGED = 'This console has changed since the flow started. Exit the flow and start it again from its console.'

/** The console open on the page, which is how a use-role viewer sees a flow's steps. */
export type FlowConsole = {
  /** The console the session has open, or null. */
  open: OperateConsoleRun | null
  /** Its listed entry as the revision kind opened (`findConsole`); undefined if gone or not loaded. */
  entry: ConsoleEntry | undefined
  /** Whether the saved consoles are still loading. */
  loading: boolean
  /** The viewer's own session workspace, null until it has opened. */
  sessionWorkspace: SessionWorkspace | null
}

type Step = { status: 'loading' } | { status: 'unavailable'; reason: string } | { status: 'ready'; definition: CanvasDefinition }

/**
 * A use-role viewer's step, only through the published console open on the page, as `ConsolePage`
 * shows its screens: that console must be the current published revision over the run's workspace,
 * offering this flow with exactly the run's title and steps, and showing the step's screen. Anything
 * else is unavailable, with no other read; a run keeps its copied steps, so the person exits and
 * starts again from the console.
 */
const publishedStep = (run: OperateFlowRun, { open, entry, loading }: FlowConsole): Step => {
  if (loading) return { status: 'loading' }
  if (!open || open.source !== 'published' || open.workspaceId !== run.workspaceId || !entry) {
    return { status: 'unavailable', reason: NOT_OPEN }
  }
  if (entry.console.revision !== open.revision) return { status: 'unavailable', reason: CHANGED }
  const snapshot = entry.console.published?.flows?.find(flow => flow.id === run.flowId)
  if (!snapshot) return { status: 'unavailable', reason: NOT_OPEN }
  if (snapshot.title !== run.title || snapshot.steps.length !== run.steps.length ||
      snapshot.steps.some((step, index) => step !== run.steps[index])) {
    return { status: 'unavailable', reason: CHANGED }
  }
  const screenId = run.steps[run.index]!
  const screen = consoleScreens(entry.console).includes(screenId)
    ? entry.screens.find(candidate => candidate.id === screenId) : undefined
  return screen ? { status: 'ready', definition: screen } : { status: 'unavailable', reason: UNAVAILABLE }
}

/**
 * One step of a running flow: a screen drawn on its own, with no canvas chrome (no view switcher
 * and no layout editing), through the viewer's own access to its workspace. For a use-role viewer
 * that is the published console open on the page (`publishedStep`), read as `ConsolePage` reads
 * it: its screen copy, its frozen widgets (`offeredBy`) and boards through their own session
 * workspace. A step whose screen is gone or out of reach says so, and the flow's controls stay
 * usable.
 */
export const FlowScreen = ({ run, console: shown, onTitle, scrollRoot }: {
  run: OperateFlowRun
  console: FlowConsole
  scrollRoot?: RefObject<HTMLElement | null>
  /** Reports the step's screen title once it is known, for the flow's header. */
  onTitle: (title: string | null) => void
}) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const { overseer, metadata, error } = useWorkspaceOpen({
    id: run.workspaceId,
    authenticatedApi,
    onMetadata: ignore,
    onShareKeyConsumed: ignore,
    onInvalidShareKey: ignore,
  })
  const { workpieces } = useWorkspaceWorkpieces(overseer, run.workspaceId)
  const [stored, setStored] = useState<Step>({ status: 'loading' })
  const screenId = run.steps[run.index]!
  // Until the metadata (and so the role; absent for an owner) is known, neither path is taken: a
  // use-role viewer never reads the workspace's screens.
  const known = metadata !== null
  const useRole = metadata?.role === 'use'

  useEffect(() => {
    if (!overseer || !known || useRole) return
    let cancelled = false
    setStored({ status: 'loading' })
    overseer.stub.getCanvas(screenId).then(value => {
      if (cancelled) return
      setStored(value ? { status: 'ready', definition: parseCanvasDefinition(value) } : { status: 'unavailable', reason: UNAVAILABLE })
    }).catch(() => { if (!cancelled) setStored({ status: 'unavailable', reason: UNAVAILABLE }) })
    return () => { cancelled = true }
  }, [overseer, known, useRole, screenId])

  const step: Step = error ? { status: 'unavailable', reason: UNAVAILABLE }
    : !known ? { status: 'loading' }
    : useRole ? publishedStep(run, shown)
    : stored
  const title = step.status === 'ready' ? step.definition.title : null
  // onTitle is the parent's setter; only the title shown restarts it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { onTitle(title) }, [title])

  if (step.status === 'unavailable') return <p role="alert" className="p-6 text-sm text-kumo-subtle">{step.reason}</p>
  const sessionWorkspace = shown.sessionWorkspace
  if (!overseer || step.status === 'loading' || (useRole && !sessionWorkspace)) {
    return <p role="status" className="p-6 text-sm text-kumo-subtle">Loading step…</p>
  }

  const gadgets = new Map<WorkpieceId, GadgetSummary>()
  for (const workpiece of workpieces.values()) if (workpiece.type === 'gadget') gadgets.set(workpiece.id, workpiece)
  // As on ConsolePage: a use-role viewer's boards resolve through their own session workspace.
  const resourceScope: CanvasResourceScope | undefined = useRole && sessionWorkspace ? {
    overseer: sessionWorkspace.stub,
    unboundAction: (targetRef, retry) => <BoardConnectPrompt scope={sessionWorkspace.stub} targetRef={targetRef} onConnected={retry} />,
  } : undefined
  const offeredBy = useRole && shown.open ? { consoleId: shown.open.consoleId, revision: shown.open.revision } : undefined
  return (
    <div className="mx-auto w-full max-w-6xl p-6">
      <CanvasView scrollRoot={scrollRoot} definition={step.definition} gadgets={gadgets} overseer={overseer.stub}
        resourceScope={resourceScope} offeredBy={offeredBy} />
    </div>
  )
}
