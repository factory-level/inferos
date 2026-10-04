import { createFileRoute } from '@tanstack/react-router'
import { InferOpsCanvasHome } from '../pages/inferops-canvas/InferOpsCanvasHome'
import { OperateSessionPage } from '../features/operate/OperateSessionPage'
import { useOperateModeAvailable } from '../features/operate/useAppMode'
import type { BoardSearch } from '../features/operate/useBoardHistory'

/**
 * The InferOps Canvas landing page. With Operate mode it is the person's operate session; without
 * it, every screen across the user's workspaces.
 */
const InferOpsCanvasRoute = () => useOperateModeAvailable() ? <OperateSessionPage /> : <InferOpsCanvasHome />

export const Route = createFileRoute('/inferops-canvas')({
  component: InferOpsCanvasRoute,
  validateSearch: (search: Record<string, unknown>): { setup?: string; settings?: string; workspace?: string; tools?: boolean } & BoardSearch => ({
    settings: typeof search.settings === 'string' && search.settings.length <= 64 ? search.settings : undefined,
    setup: typeof search.setup === 'string' && search.setup.length <= 64 ? search.setup : undefined,
    workspace: typeof search.workspace === 'string' && search.workspace.length <= 128 ? search.workspace : undefined,
    tools: search.tools === true || search.tools === 'true' ? true : undefined,
    // The session's shown board and issue (see useBoardHistory); references only, checked by the kernel.
    board: typeof search.board === 'string' && search.board.length <= 512 ? search.board : undefined,
    boardWorkspace: typeof search.boardWorkspace === 'string' && search.boardWorkspace.length <= 128 ? search.boardWorkspace : undefined,
    issue: typeof search.issue === 'string' && search.issue.length <= 128 ? search.issue : undefined,
  }),
})
