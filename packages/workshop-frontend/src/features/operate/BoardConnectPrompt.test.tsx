// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'

const accounts = vi.hoisted(() => ({ list: [] as { id: number; name: string; valid?: boolean }[], filters: [] as unknown[] }))
// One api object, as the real context provides, so the subscription is not restarted every render.
const api = vi.hoisted(() => ({
  authenticatedApi: {
    subscribeConnectedAccounts: (subscriber: { add: (...args: unknown[]) => void; ready: () => void }, filter: unknown) => {
      accounts.filters.push(filter)
      for (const account of accounts.list) {
        subscriber.add(account.id, { displayName: account.name }, { displayName: 'InferOps' }, [], account.valid ?? true, 'inferops')
      }
      subscriber.ready()
      return Object.assign(Promise.resolve({}), { [Symbol.dispose]: () => {} })
    },
  },
}))
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => api }))
vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: unknown }) => <a href="/gatekeepers">{children as never}</a> }))

import { BoardConnectPrompt } from './BoardConnectPrompt'

const REF = 'inferops://acme.operations/project/board/ENG'
const newGatekeeper = vi.fn<(accountId: number, url: string) => Promise<object | null>>()
const scope = { newGatekeeper } as unknown as RpcStub<Overseer>
const onConnected = vi.fn<() => void>()
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  accounts.list = []; accounts.filters = []; newGatekeeper.mockReset(); onConnected.mockReset()
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })
const render = () => act(async () => root.render(<BoardConnectPrompt scope={scope} targetRef={REF} onConnected={onConnected} />))
const button = (text: string) => [...container.querySelectorAll('button')].find(b => b.textContent === text)

it('asks only for accounts that can reach this board, and with none points to connecting InferOps', async () => {
  await render()
  expect(accounts.filters).toEqual([{ resourceUrl: REF }])
  expect(container.textContent).toContain('You have no InferOps account connected')
  expect(container.querySelector('a')?.textContent).toBe('Connect InferOps')
  expect(newGatekeeper).not.toHaveBeenCalled()
})

it('connects the board in the operator\'s own scope with the account they choose, then reads it', async () => {
  accounts.list = [{ id: 7, name: 'ana@acme.test' }, { id: 8, name: 'expired', valid: false }]
  newGatekeeper.mockResolvedValue({ [Symbol.dispose]: () => {} })
  await render()
  expect(button('Connect with expired')).toBeUndefined()
  await act(async () => { button('Connect with ana@acme.test')!.click() })
  expect(newGatekeeper).toHaveBeenCalledWith(7, REF)
  expect(onConnected).toHaveBeenCalledTimes(1)
})

it('shows InferOps\' refusal when the operator\'s own account has no grant for the project', async () => {
  accounts.list = [{ id: 7, name: 'ana@acme.test' }]
  newGatekeeper.mockRejectedValue(new Error('No InferOps project ENG is available on acme.operations.'))
  await render()
  await act(async () => { button('Connect with ana@acme.test')!.click() })
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('No InferOps project ENG is available')
  expect(onConnected).not.toHaveBeenCalled()
})
