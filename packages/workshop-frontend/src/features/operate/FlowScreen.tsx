import { useEffect, useState, type RefObject } from 'react'
import type { GadgetSummary, WorkpieceId } from '@gadgets/workshop-shared/api'
import { parseCanvasDefinition, type CanvasDefinition } from '@gadgets/workshop-shared/canvas'
import { useAuthenticatedApi } from '../../AuthContext'
import { CanvasView } from '../canvas/CanvasView'
import { useWorkspaceWorkpieces } from '../../hooks/useWorkspaceWorkpieces'
import { useWorkspaceOpen } from '../../useWorkspaceOpen'

const ignore = () => {}

type Step = { status: 'loading' } | { status: 'unavailable' } | { status: 'ready'; definition: CanvasDefinition }

/**
 * One step of a running flow: a screen drawn on its own, with no canvas chrome (no view switcher
 * and no layout editing), through the viewer's own access to its workspace. A step whose screen
 * is gone or out of reach says so, and the flow's controls stay usable.
 */
export const FlowScreen = ({ workspaceId, screenId, onTitle, scrollRoot }: {
  workspaceId: string
  scrollRoot?: RefObject<HTMLElement | null>
  screenId: string
  /** Reports the step's screen title once it is known, for the flow's header. */
  onTitle: (title: string | null) => void
}) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const { overseer, metadata, error } = useWorkspaceOpen({
    id: workspaceId,
    authenticatedApi,
    onMetadata: ignore,
    onShareKeyConsumed: ignore,
    onInvalidShareKey: ignore,
  })
  const { workpieces } = useWorkspaceWorkpieces(overseer, workspaceId)
  const [step, setStep] = useState<Step>({ status: 'loading' })

  useEffect(() => {
    if (!overseer) return
    let cancelled = false
    setStep({ status: 'loading' })
    onTitle(null)
    overseer.stub.getCanvas(screenId).then(value => {
      if (cancelled) return
      if (!value) return setStep({ status: 'unavailable' })
      const definition = parseCanvasDefinition(value)
      setStep({ status: 'ready', definition })
      onTitle(definition.title)
    }).catch(() => { if (!cancelled) setStep({ status: 'unavailable' }) })
    return () => { cancelled = true }
    // onTitle is the parent's setter; only the screen being shown restarts the load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overseer, screenId])

  if (error || metadata?.role === 'use' || step.status === 'unavailable') return (
    <p role="alert" className="p-6 text-sm text-kumo-subtle">
      This step is unavailable. Its screen may have been removed, or you may no longer have access to its workspace.
    </p>
  )
  if (!overseer || step.status === 'loading') return <p role="status" className="p-6 text-sm text-kumo-subtle">Loading step…</p>

  const gadgets = new Map<WorkpieceId, GadgetSummary>()
  for (const workpiece of workpieces.values()) if (workpiece.type === 'gadget') gadgets.set(workpiece.id, workpiece)
  return (
    <div className="mx-auto w-full max-w-6xl p-6">
      <CanvasView scrollRoot={scrollRoot} definition={step.definition} gadgets={gadgets} overseer={overseer.stub} />
    </div>
  )
}
