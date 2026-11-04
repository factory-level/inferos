// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
// FAC-155: Gatekeepers says it couldn't load, with a retry, when its lists fail or never answer,
// instead of staying on "Loading gatekeepers..." or showing "No gatekeepers yet".
import { act, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LOAD_TIMEOUT_MS } from './loadTimeout'

type Subscriber = { ready(): void }
const api = vi.hoisted(() => ({
  listGatekeeperVendors: vi.fn<() => Promise<unknown[]>>(),
  listAddableGatekeepers: vi.fn<() => Promise<unknown[]>>(async () => []),
  subscribeConnectedAccounts: vi.fn<(subscriber: Subscriber) => unknown>(),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  createFileRoute: () => (options: unknown) => ({ options }),
}))
vi.mock('./AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: api }) }))
vi.mock('./ServerConfigContext', () => ({ useSiteName: () => 'InferOS' }))
vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))

import { Route } from './routes/gatekeepers'

// The router plugin splits route components into a lazy wrapper; load it first so a render is
// synchronous and fake timers start with the page's own timers.
const Page = (Route as unknown as { options: { component: ComponentType & { preload?: () => Promise<void> } } }).options.component
// Load the router's split chunk during module collection, before tests run and fake timers start.
await Page.preload?.()
// A subscription the test settles: `ready()` lists no accounts; never calling it is a hang.
const subscription = (answer: 'ready' | 'hang') => (subscriber: Subscriber) => {
  if (answer === 'ready') queueMicrotask(() => subscriber.ready())
  return Object.assign(new Promise(() => {}), { [Symbol.dispose]() {} })
}

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  api.listGatekeeperVendors.mockReset()
  api.subscribeConnectedAccounts.mockReset()
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals() })

const render = () => act(async () => root.render(<Page />))
const text = () => container.textContent ?? ''
const tryAgain = () => Array.from(container.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Try again')

it('a failed gatekeeper list says so with a retry, and the retry loads it again', async () => {
  api.listGatekeeperVendors.mockRejectedValueOnce(new Error('down'))
  api.subscribeConnectedAccounts.mockImplementation(subscription('ready'))
  await render()
  expect(text()).toContain('Something went wrong loading your gatekeepers.')
  expect(text()).not.toContain('No gatekeepers yet')
  expect(text()).not.toContain('Loading gatekeepers...')
  api.listGatekeeperVendors.mockResolvedValueOnce([])
  await act(async () => tryAgain()!.click())
  expect(text()).not.toContain('Something went wrong')
  expect(text()).toContain('No gatekeepers yet')
})

it('a vendor list that never answers becomes the same error after the load timeout', async () => {
  vi.useFakeTimers()
  api.listGatekeeperVendors.mockReturnValueOnce(new Promise(() => {}))
  api.subscribeConnectedAccounts.mockImplementation(subscription('ready'))
  await render()
  expect(text()).toContain('Loading gatekeepers...')
  await act(async () => { await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS) })
  expect(text()).toContain('Something went wrong loading your gatekeepers.')
  expect(tryAgain()).toBeDefined()
})

it('connected accounts that never report ready become the same error after the load timeout', async () => {
  vi.useFakeTimers()
  api.listGatekeeperVendors.mockResolvedValueOnce([])
  api.subscribeConnectedAccounts.mockImplementation(subscription('hang'))
  await render()
  expect(text()).not.toContain('No gatekeepers yet')
  await act(async () => { await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS) })
  expect(text()).toContain('Something went wrong loading your gatekeepers.')
})
