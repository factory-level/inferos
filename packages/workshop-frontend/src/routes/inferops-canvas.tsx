import { createFileRoute } from '@tanstack/react-router'
import { InferOpsCanvasHome } from '../pages/inferops-canvas/InferOpsCanvasHome'

/** The InferOps Canvas landing page: every screen across the user's workspaces. */
export const Route = createFileRoute('/inferops-canvas')({
  component: InferOpsCanvasHome,
})
