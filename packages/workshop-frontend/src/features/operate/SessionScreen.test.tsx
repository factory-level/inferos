// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ testOnly: false }))
vi.mock('@cloudflare/kumo', async importOriginal => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: {} }) }))
vi.mock('../../ServerConfigContext', () => ({ useServerConfig: () => ({ canvasFeatures: { durableViews: true } }) }))
vi.mock('../../hooks/useWorkspaceWorkpieces', () => ({ useWorkspaceWorkpieces: () => ({ workpieces: new Map(), ready: true }) }))
vi.mock('../canvas/CanvasWorkspacePane', () => ({ CanvasWorkspacePane: () => <div>Screen</div> }))
vi.mock('../../useWorkspaceOpen', () => ({ useWorkspaceOpen: () => ({
  overseer: { stub: { getCanvas: async () => ({ id: 's1' }) } },
  metadata: { id: 'space', title: 'Night shift', role: 'build', testOnly: state.testOnly || undefined },
  error: null,
}) }))
import { SessionScreen } from './SessionScreen'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

const render = async () => {
  await act(async () => root.render(<SessionScreen workspaceId="space" screenId="s1" onShowScreen={() => {}} onClose={() => {}} />))
}

it('marks a screen of a test-only space in the Operate session, naming the space', async () => {
  state.testOnly = true
  await render()
  expect(container.textContent).toContain('Test space')
  expect(container.textContent).toContain('Night shift may use mock data and models.')
  expect(container.textContent).toContain('Screen')
})

it('adds nothing to a screen of a normal space', async () => {
  state.testOnly = false
  await render()
  expect(container.textContent).toBe('Screen')
})
