import { useEffect, useState } from 'react'
import { Button, Dialog } from '@cloudflare/kumo'
import { XIcon } from '@phosphor-icons/react'
import type { GadgetSummary, WorkpieceId } from '@gadgets/workshop-shared/api'
import type { CanvasDefinition } from '@gadgets/workshop-shared/canvas'
import { useAuthenticatedApi } from '../../AuthContext'
import { useWorkspaceOpen } from '../../useWorkspaceOpen'
import { useWorkspaceWorkpieces } from '../../hooks/useWorkspaceWorkpieces'
import { CanvasBoardWidget } from '../canvas/CanvasBoardWidget'
import { CanvasGadgetWidget } from '../canvas/CanvasGadgetWidget'
import { CanvasWikiWidget } from '../canvas/CanvasWikiWidget'
import { useDecidedActionInvalidationInEveryScope } from '../canvas/useBoardData'
import { gadgetIdOf } from '../canvas/canvasLayout'
import type { ConsoleWidgetTarget } from './ConsoleWidgetActions'

const ignore = () => {}

/** Resolves the latest screen through its workspace capability; a widget reference grants no access. */
export const ConsoleWidgetView = ({ workspaceId, target, onClose }: {
  workspaceId: string
  target: ConsoleWidgetTarget
  onClose: () => void
}) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const { overseer, error } = useWorkspaceOpen({ id: workspaceId, authenticatedApi,
    onMetadata: ignore, onShareKeyConsumed: ignore, onInvalidShareKey: ignore })
  useDecidedActionInvalidationInEveryScope(overseer?.stub ?? null)
  const { workpieces, ready } = useWorkspaceWorkpieces(overseer, workspaceId)
  const [screen, setScreen] = useState<CanvasDefinition | null | undefined>(undefined)
  useEffect(() => {
    if (!overseer) return
    let cancelled = false
    setScreen(undefined)
    overseer.stub.getCanvas(target.screenId).then(value => { if (!cancelled) setScreen(value ?? null) })
      .catch(() => { if (!cancelled) setScreen(null) })
    return () => { cancelled = true }
  }, [overseer, target.screenId])
  const widget = screen?.sections.flatMap(section => section.widgets).find(item => item.id === target.widgetId)
  const gadgets = new Map<WorkpieceId, GadgetSummary>()
  for (const piece of workpieces.values()) if (piece.type === 'gadget') gadgets.set(piece.id, piece)
  const body = error || screen === null || (screen && !widget)
    ? <p role="alert" className="p-5 text-sm text-kumo-danger">This widget is unavailable. It may have been removed, or you may no longer have access.</p>
    : !overseer || !screen || !widget || !ready ? <p role="status" className="p-5 text-sm text-kumo-subtle">Opening widget…</p>
    : widget.kind === 'inferos.gadget'
      ? <CanvasGadgetWidget widget={{ ...widget, size: 'full' }} gadget={gadgets.get(gadgetIdOf(widget.targetRef))} overseer={overseer.stub} />
      // Wiki is operated read-only, as on session screens (no `editable`).
      : widget.kind === 'inferops.wiki' ? <CanvasWikiWidget widget={widget} overseer={overseer.stub} />
      : <CanvasBoardWidget widget={widget} overseer={overseer.stub} presentation="full" />
  if (target.presentation === 'modal') return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}>
    <Dialog size="lg" className="flex max-h-[90dvh] !w-[min(1000px,calc(100vw-32px))] flex-col overflow-hidden rounded-xl bg-kumo-base p-0">
      <header className="flex items-center justify-between border-b border-kumo-line px-5 py-3">
        <Dialog.Title className="text-sm font-medium text-kumo-default">{screen?.title ?? 'Widget'}</Dialog.Title>
        <Dialog.Close render={<Button size="sm" variant="ghost" aria-label="Close widget"><XIcon size={16} aria-hidden /></Button>} />
      </header>
      <Dialog.Description className="sr-only">Widget opened from the console assistant.</Dialog.Description>
      <div className="min-h-0 overflow-auto p-5">{body}</div>
    </Dialog>
  </Dialog.Root>
  return <div className="flex h-full min-h-0 flex-col gap-4 p-5">
    <div><Button size="sm" variant="ghost" onClick={onClose}>Back to {screen?.title ?? 'screen'}</Button></div>
    <div className="min-h-0 flex-1 overflow-auto">{body}</div>
  </div>
}
