import { useKumoToastManager } from '@cloudflare/kumo'
import type { GadgetSummary, WorkpieceId } from '@gadgets/workshop-shared/api'
import { DEFAULT_CANVAS_CATALOG } from '@gadgets/workshop-shared/canvas'
import { useAuthenticatedApi } from '../../AuthContext'
import { WorkshopButton } from '../../components/WorkshopControls'
import { CanvasWorkspacePane } from '../canvas/CanvasWorkspacePane'
import { useWorkspaceWorkpieces } from '../../hooks/useWorkspaceWorkpieces'
import { useServerConfig } from '../../ServerConfigContext'
import { useWorkspaceOpen } from '../../useWorkspaceOpen'

const ignore = () => {}

/**
 * One screen opened in the operate session, rendered through the viewer's own access to its
 * workspace. A screen they can no longer open shows as unavailable, with a way to close it, rather
 * than failing the page.
 */
export const SessionScreen = ({ workspaceId, screenId, onShowScreen, onClose }: {
  workspaceId: string
  screenId: string
  onShowScreen: (screenId: string) => void
  onClose: () => void
}) => {
  const toasts = useKumoToastManager()
  const { authenticatedApi } = useAuthenticatedApi()
  const canvasFeatures = useServerConfig()?.canvasFeatures
  const { overseer, metadata, error } = useWorkspaceOpen({
    id: workspaceId,
    authenticatedApi,
    onMetadata: ignore,
    onShareKeyConsumed: ignore,
    onInvalidShareKey: ignore,
  })
  const { workpieces, ready } = useWorkspaceWorkpieces(overseer, workspaceId)
  const gadgets = new Map<WorkpieceId, GadgetSummary>()
  for (const workpiece of workpieces.values()) if (workpiece.type === 'gadget') gadgets.set(workpiece.id, workpiece)

  if (error || metadata?.role === 'use') return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-sm text-kumo-subtle">This screen is unavailable. You may no longer have access to its workspace.</p>
      <WorkshopButton tone="secondary" onClick={onClose}>Close it</WorkshopButton>
    </div>
  )
  if (!overseer || !metadata || !ready || !canvasFeatures) return (
    <p role="status" className="p-6 text-sm text-kumo-subtle">Loading screen…</p>
  )
  return (
    <CanvasWorkspacePane key={workspaceId} overseer={overseer.stub} gadgets={gadgets}
      catalog={canvasFeatures.catalog ?? DEFAULT_CANVAS_CATALOG} viewId={screenId}
      onViewChange={view => { if (view) onShowScreen(view) }}
      onAskAgent={async () => {
        toasts.add({ title: 'Ask the operate chat beside this screen instead.' })
      }}
      storage={canvasFeatures.durableViews ? { kind: 'durable', api: overseer.stub } : { kind: 'temporary' }} />
  )
}
