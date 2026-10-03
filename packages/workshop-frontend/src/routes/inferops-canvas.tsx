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
})
