// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
// FAC-155: while the screen lists load, or after they fail, the Canvas home and its New screen
// picker never say "No workspaces yet"; a failure offers Try again. The load's own failure and hang
// handling is in useWorkspaceScreens.test.tsx.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WorkspaceScreensState } from './useWorkspaceScreens'

const screens = vi.hoisted(() => ({
  state: { status: 'loading' } as WorkspaceScreensState,
  retry: vi.fn<() => void>(),
}))

vi.mock('./useWorkspaceScreens', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./useWorkspaceScreens')>()),
  useWorkspaceScreens: () => screens.state,
  retryWorkspaceScreens: screens.retry,
}))
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: {} }) }))
vi.mock('../../ServerConfigContext', () => ({
  useServerConfig: () => ({ canvasFeatures: { composableViews: true, durableViews: true } }),
  useSiteName: () => 'InferOS',
}))
vi.mock('../../features/operate/OperateSessionContext', () => ({ useOperateSession: () => null }))
vi.mock('../../features/operate/WorkspaceFlows', () => ({ WorkspaceFlows: () => null }))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  useNavigate: () => vi.fn<() => void>(),
}))

import { InferOpsCanvasHome } from './InferOpsCanvasHome'

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  screens.retry.mockReset()
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

const render = (state: WorkspaceScreensState) => {
  screens.state = state
  return act(async () => root.render(<InferOpsCanvasHome />))
}
const text = () => container.textContent ?? ''

it('while loading, the New screen picker says it is loading, not that there are no workspaces', async () => {
  await render({ status: 'loading' })
  expect(text()).toContain('Loading screens…')
  expect(text()).toContain('Loading workspaces…')
  expect(text()).not.toContain('No workspaces yet')
})

it('after a failed or timed-out load, it says so and Try again reloads', async () => {
  await render({ status: 'error' })
  expect(text()).toContain('Could not load your workspaces.')
  expect(text()).toContain('Could not load workspaces')
  expect(text()).not.toContain('No workspaces yet')
  const tryAgain = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Try again')!
  await act(async () => tryAgain.click())
  expect(screens.retry).toHaveBeenCalledOnce()
})

it('an account that really has no workspaces still says so', async () => {
  await render({ status: 'ready', workspaces: [] })
  expect(text()).toContain('You have no workspaces yet.')
  expect(text()).toContain('No workspaces yet')
})
