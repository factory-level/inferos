import { useState } from 'react'
import { Link, Navigate, useNavigate } from '@tanstack/react-router'
import { useKumoToastManager } from '@cloudflare/kumo'
import { ArrowLeft } from '@phosphor-icons/react'
import type { GadgetSummary, WorkpieceId } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import ChatInterface from '../../ChatInterface'
import WorkspaceOpenErrorPage from '../../components/WorkspaceOpenErrorPage'
import { WorkshopButton } from '../../components/WorkshopControls'
import { CanvasWorkspacePane } from '../../features/canvas/CanvasWorkspacePane'
import ObserverConfigModal from '../../ObserverConfigModal'
import { useServerConfig } from '../../ServerConfigContext'
import { useResizableSplit } from '../../hooks/useResizableSplit'
import { useWorkspaceOpen } from '../../useWorkspaceOpen'
import { useWorkspaceWorkpieces } from '../../hooks/useWorkspaceWorkpieces'
import { getStoredSelectedModel } from '../../modelSelection'
import { DEFAULT_CANVAS_CATALOG } from '@gadgets/workshop-shared/canvas'

const noConsoleLogs = () => ''
const ignore = () => {}

const Centered = ({ children }: { children: React.ReactNode }) =>
  <div className="flex min-h-full flex-col items-center justify-center gap-4 bg-kumo-base px-6 text-center">{children}</div>

/** A workspace's InferOps Canvas: composed views beside its chat, gadgets and InferOps widgets on one page. */
export const InferOpsCanvasPage = ({ workspaceId, chatId, viewId, widgetId }: {
  workspaceId: string
  chatId: number | null
  viewId: string | null
  /** A board widget of the view opened in its full view. */
  widgetId: string | null
}) => {
  const navigate = useNavigate()
  const toasts = useKumoToastManager()
  const { authenticatedApi } = useAuthenticatedApi()
  const canvasFeatures = useServerConfig()?.canvasFeatures
  const [mobilePane, setMobilePane] = useState<'chat' | 'canvas'>('canvas')
  const split = useResizableSplit(true)
  const { overseer, metadata, error, observerConfig, retry, cancelObserverConfig } = useWorkspaceOpen({
    id: workspaceId,
    authenticatedApi,
    onMetadata: ignore,
    onShareKeyConsumed: () => navigate({ to: '/workspace/$id/inferops-canvas', params: { id: workspaceId }, search: {}, replace: true }),
    onInvalidShareKey: () => toasts.add({ title: 'Invalid or expired share link.', variant: 'error' }),
  })
  const { workpieces, ready } = useWorkspaceWorkpieces(overseer, workspaceId)
  const gadgets = new Map<WorkpieceId, GadgetSummary>()
  for (const workpiece of workpieces.values()) if (workpiece.type === 'gadget') gadgets.set(workpiece.id, workpiece)

  const goToWorkspaces = () => navigate({ to: '/workspaces' })
  const selectView = (view: string | null) => navigate({
    to: '/workspace/$id/inferops-canvas', params: { id: workspaceId }, replace: true,
    search: (prev: Record<string, unknown>) => ({ ...prev, view: view ?? undefined, widget: undefined }),
  })
  // Opening a widget is a step the back button undoes; closing it replaces that step.
  const openWidget = (widget: string | null) => navigate({
    to: '/workspace/$id/inferops-canvas', params: { id: workspaceId }, replace: widget === null,
    search: (prev: Record<string, unknown>) => ({ ...prev, widget: widget ?? undefined }),
  })
  // Blueprint widgets are built by the agent (create the gadget, wire its connection, place it),
  // so the canvas hands the request to a new chat with the user's last-chosen model.
  const askAgent = async (request: string) => {
    if (!overseer) return
    const modelId = getStoredSelectedModel(await overseer.stub.listModels())
    if (!modelId) {
      toasts.add({ title: 'Choose a model in the chat first, then try again.', variant: 'error' })
      return
    }
    const chat = await overseer.stub.newChat(request, modelId)
    setMobilePane('chat')
    navigateToChat(chat)
  }
  const navigateToChat = (chat: number | null, options?: { replace?: boolean }) => navigate({
    to: '/workspace/$id/inferops-canvas', params: { id: workspaceId }, replace: options?.replace,
    search: (prev: Record<string, unknown>) => ({ ...prev, chat: chat ?? undefined }),
  })

  if (error?.kind === 'open') return <WorkspaceOpenErrorPage kind={error.failure} onGoToWorkspaces={goToWorkspaces} onRetry={retry} />
  if (error?.kind === 'message') return <Centered>
    <p className="max-w-lg whitespace-pre-line text-sm text-kumo-danger">{error.message}</p>
    <div className="flex items-center gap-2">
      <WorkshopButton tone="secondary" onClick={goToWorkspaces}>Go to workspaces</WorkshopButton>
      <WorkshopButton tone="primary" onClick={retry}>Try again</WorkshopButton>
    </div>
  </Centered>
  if (!metadata || !overseer || !ready) return <Centered>
    <p role="status" className="text-sm text-kumo-subtle">Loading workspace…</p>
    {observerConfig && <ObserverConfigModal needs={observerConfig.needs} authenticatedApi={authenticatedApi}
      onConfirm={observerConfig.resolve} onCancel={cancelObserverConfig} />}
  </Centered>
  // Use-only collaborators may only run the deployed gadget UI, which the workspace route provides.
  if (metadata.role === 'use') return <Navigate to="/workspace/$id" params={{ id: workspaceId }} replace />
  if (!canvasFeatures?.composableViews) return <Centered>
    <p className="text-sm text-kumo-subtle">Composable views are not enabled for this deployment.</p>
    <Link to="/workspace/$id" params={{ id: workspaceId }} className="text-sm text-kumo-brand">Back to workspace</Link>
  </Centered>

  return <div className="flex h-full flex-col overflow-hidden bg-kumo-base">
    <header className="flex h-14 flex-shrink-0 items-center gap-3 border-b border-kumo-line px-4">
      <Link to="/workspace/$id" params={{ id: workspaceId }} className="flex min-w-0 items-center gap-2 text-sm text-kumo-subtle hover:text-kumo-default">
        <ArrowLeft size={16} aria-hidden /><span className="truncate">{metadata.title}</span>
      </Link>
      <span className="text-sm font-medium text-kumo-default">InferOps Canvas</span>
      <Link to="/inferops-canvas" className="text-sm text-kumo-subtle hover:text-kumo-default max-md:hidden">All screens</Link>
      <div role="group" aria-label="Show pane" className="ml-auto flex gap-1 md:hidden">
        {(['chat', 'canvas'] as const).map(pane => <WorkshopButton key={pane} tone={mobilePane === pane ? 'primary' : 'secondary'}
          aria-pressed={mobilePane === pane} onClick={() => setMobilePane(pane)}>{pane === 'chat' ? 'Chat' : 'Canvas'}</WorkshopButton>)}
      </div>
    </header>
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className={`flex min-h-0 flex-shrink-0 flex-col border-r border-kumo-line max-md:!w-full ${mobilePane === 'chat' ? '' : 'max-md:hidden'}`}
        style={{ width: split.width }}>
        <ChatInterface key={workspaceId} workspaceId={workspaceId} overseer={overseer.stub}
          restricted={metadata.containsRestrictedData === true} selectedChatId={chatId} onNavigateToChat={navigateToChat}
          pendingConsoleLogCount={0} consoleLogPreview="" consoleLogSeverity="info"
          onConsumeConsoleLogs={noConsoleLogs} onDiscardConsoleLogs={ignore} constrainChatWidth
          onOpenGadget={id => navigate({ to: '/workspace/$id', params: { id: workspaceId }, search: { w: id } })}
          outputOfWorkpiece={id => gadgets.get(id)?.output} />
      </div>
      <div role="separator" aria-orientation="vertical" aria-label="Resize chat"
        className="relative w-px flex-shrink-0 touch-none cursor-col-resize overflow-visible bg-kumo-line max-md:hidden" {...split.handleProps}>
        <div className="absolute inset-y-0 -left-2 -right-2" />
      </div>
      <main className={`min-h-0 min-w-0 flex-1 ${mobilePane === 'canvas' ? '' : 'max-md:hidden'}`}>
        <CanvasWorkspacePane key={workspaceId} overseer={overseer.stub} gadgets={gadgets}
          catalog={canvasFeatures.catalog ?? DEFAULT_CANVAS_CATALOG} viewId={viewId} onViewChange={selectView}
          openWidgetId={widgetId} onOpenWidgetChange={openWidget} onAskAgent={askAgent}
          storage={canvasFeatures.durableViews ? { kind: 'durable', api: overseer.stub } : { kind: 'temporary' }} />
      </main>
    </div>
  </div>
}
