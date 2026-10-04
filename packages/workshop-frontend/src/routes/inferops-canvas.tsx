import { createFileRoute } from '@tanstack/react-router'
import { InferOpsCanvasHome } from '../pages/inferops-canvas/InferOpsCanvasHome'
import { OperateSessionPage } from '../features/operate/OperateSessionPage'
import { useOperateModeAvailable } from '../features/operate/useAppMode'

/**
 * The InferOps Canvas landing page. With Operate mode it is the person's operate session; without
 * it, every screen across the user's workspaces.
 */
const InferOpsCanvasRoute = () => useOperateModeAvailable() ? <OperateSessionPage /> : <InferOpsCanvasHome />

export const Route = createFileRoute('/inferops-canvas')({
  component: InferOpsCanvasRoute,
  validateSearch: (search: Record<string, unknown>): { setup?: string; settings?: string; workspace?: string; tools?: boolean } => ({
    settings: typeof search.settings === 'string' && search.settings.length <= 64 ? search.settings : undefined,
    setup: typeof search.setup === 'string' && search.setup.length <= 64 ? search.setup : undefined,
    workspace: typeof search.workspace === 'string' && search.workspace.length <= 128 ? search.workspace : undefined,
    tools: search.tools === true || search.tools === 'true' ? true : undefined,
  }),
})
