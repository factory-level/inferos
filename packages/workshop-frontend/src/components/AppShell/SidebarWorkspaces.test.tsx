// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
// FAC-155: the sidebar's workspace list says it couldn't load, with a retry, when the list fails or
// never answers. It never reads as "No workspaces yet." for an account that has workspaces.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LOAD_TIMEOUT_MS } from '../../loadTimeout'

const api = vi.hoisted(() => ({
  listGadgets: vi.fn<() => Promise<unknown[]>>(),
  whoami: vi.fn<() => Promise<{ type: string; id: string; name: string }>>(async () => ({ type: 'user', id: 'me', name: 'Me' })),
}))

vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: api }) }))
vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  useNavigate: () => vi.fn<() => void>(),
  useRouterState: () => ({ location: { pathname: '/' } }),
}))
vi.mock('../../ShareModal', () => ({ default: () => null }))
vi.mock('../DeleteConfirmationDialog', () => ({ default: () => null }))
vi.mock('./SidebarGadgetRow', () => ({ default: ({ gadget }: { gadget: { title: string } }) => <span>{gadget.title}</span> }))

import { SidebarWorkspacesLists, SidebarWorkspacesProvider } from './SidebarWorkspaces'

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  api.listGadgets.mockReset()
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals() })

const render = () => act(async () => root.render(
  <SidebarWorkspacesProvider><SidebarWorkspacesLists /></SidebarWorkspacesProvider>))
const text = () => container.textContent ?? ''
const tryAgain = () => Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Try again')

it('a failed list says so and offers a retry, never "No workspaces yet."', async () => {
  api.listGadgets.mockRejectedValueOnce(new Error('down'))
  await render()
  expect(text()).toContain("Couldn't load your workspaces.")
  expect(text()).not.toContain('No workspaces yet.')
  api.listGadgets.mockResolvedValueOnce([{ id: 'w1', title: 'Field work', lastActive: new Date(), pinned: false }])
  await act(async () => tryAgain()!.click())
  expect(text()).toContain('Field work')
  expect(text()).not.toContain("Couldn't load")
})

it('a list that never answers becomes the same error after the load timeout', async () => {
  vi.useFakeTimers()
  api.listGadgets.mockReturnValueOnce(new Promise(() => {}))
  await render()
  expect(text()).not.toContain('No workspaces yet.')
  await act(async () => { await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS) })
  expect(text()).toContain("Couldn't load your workspaces.")
  expect(tryAgain()).toBeDefined()
})

it('an account with no workspaces still says so', async () => {
  api.listGadgets.mockResolvedValueOnce([])
  await render()
  expect(text()).toContain('No workspaces yet.')
  expect(tryAgain()).toBeUndefined()
})
