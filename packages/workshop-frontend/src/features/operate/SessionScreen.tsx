import { useEffect, useState } from 'react'
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
  // Whether the screen is still in its workspace; null until checked. The pane would otherwise show
  // some other view in its place, and the session would follow it there.
  const [exists, setExists] = useState<boolean | null>(null)
  // A board opened to its full view inside this screen; the session page, not the URL, owns it.
  const [openWidgetId, setOpenWidgetId] = useState<string | null>(null)
  useEffect(() => {
    if (!overseer) return
    let cancelled = false
    overseer.stub.getCanvas(screenId).then(
      value => { if (!cancelled) setExists(value !== null) },
      () => { if (!cancelled) setExists(false) },
    )
    return () => { cancelled = true }
  }, [overseer, screenId])
  const gadgets = new Map<WorkpieceId, GadgetSummary>()
  for (const workpiece of workpieces.values()) if (workpiece.type === 'gadget') gadgets.set(workpiece.id, workpiece)

  if (error || metadata?.role === 'use' || exists === false) return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-sm text-kumo-subtle">This screen is unavailable. You may no longer have access to its workspace.</p>
      <WorkshopButton tone="secondary" onClick={onClose}>Close it</WorkshopButton>
    </div>
  )
  if (!overseer || !metadata || !ready || !canvasFeatures || exists === null) return (
    <p role="status" className="p-6 text-sm text-kumo-subtle">Loading screen…</p>
  )
  return (
    <CanvasWorkspacePane key={workspaceId} overseer={overseer.stub} gadgets={gadgets}
      catalog={canvasFeatures.catalog ?? DEFAULT_CANVAS_CATALOG} viewId={screenId}
      openWidgetId={openWidgetId} onOpenWidgetChange={setOpenWidgetId}
      // The pane also reports the view it opened with, and falls back to another view when this
      // one is gone. Only a different view chosen while this screen exists is a move.
      onViewChange={view => { if (view && view !== screenId && exists) onShowScreen(view) }}
      onAskAgent={async () => {
        toasts.add({ title: 'Ask the operate chat beside this screen instead.' })
      }}
      storage={canvasFeatures.durableViews ? { kind: 'durable', api: overseer.stub } : { kind: 'temporary' }} />
  )
}
