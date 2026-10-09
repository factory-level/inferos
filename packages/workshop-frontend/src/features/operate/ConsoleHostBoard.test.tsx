// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { OperateSession } from '@gadgets/workshop-shared/api'
import type { HostBoardEntry, HostBoardSelection, HostBoardSelectionUpdate, HostBoardView } from '@gadgets/workshop-shared/operate-console'

const accounts = vi.hoisted(() => ({ list: [] as { id: number; name: string }[], filters: [] as unknown[] }))
const api = vi.hoisted(() => ({
  authenticatedApi: {
    subscribeConnectedAccounts: (subscriber: { add: (...args: unknown[]) => void; ready: () => void }, filter: unknown) => {
      accounts.filters.push(filter)
      for (const account of accounts.list) {
        subscriber.add(account.id, { displayName: account.name }, { displayName: 'InferOps' }, [], true, 'inferops')
      }
      subscriber.ready()
      return Object.assign(Promise.resolve({}), { [Symbol.dispose]: () => {} })
    },
  },
}))
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => api }))
vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: unknown }) => <a href="/gatekeepers">{children as never}</a> }))

import { ConsoleHostBoard } from './ConsoleHostBoard'

const ENTRY: HostBoardEntry & { id: string } = { kind: 'host-board', id: 'hb1', label: 'Team board',
  requirement: { name: 'board-1', resource: 'inferops-board', target: 'inferops://acme.ops/project/board/ENG' } }
const REF = { consoleId: 'c1', source: 'published' as const, revision: '4' }
const OK: HostBoardView = { status: 'ok', readAt: new Date().toISOString(), publicationRevision: '4', board: {
  project: { identifier: 'ENG', name: 'Engineering' },
  columns: [{ label: 'Todo', group: 'unstarted', issues: [{ identifier: 'ENG-1', title: 'Fix the login', priority: 'high', targetDate: null, blocked: false }] }],
} }

// A fake kernel: one handle per `getConsoleHostBoard`, whose subscriber the test drives.
let deliver: (update: HostBoardSelectionUpdate) => void
let reads: Array<(view: HostBoardView) => void>
let disposed: string[]
const readRequirement = vi.fn<(name: string) => Promise<HostBoardView>>()
const subscribeSelection = vi.fn<(subscriber: (update: HostBoardSelectionUpdate) => void) => Promise<object>>()
const getConsoleHostBoard = vi.fn<(console: unknown, entryId: string) => object>()
const selectHostBoardConnection = vi.fn<(console: unknown, entryId: string, accountId: number, requestKey: string) => Promise<HostBoardSelection>>()
const session = { getConsoleHostBoard, selectHostBoardConnection } as unknown as RpcStub<OperateSession>

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('PointerEvent', MouseEvent)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  accounts.list = []; accounts.filters = []; reads = []; disposed = []
  readRequirement.mockReset().mockImplementation(() => new Promise(resolve => reads.push(resolve)))
  subscribeSelection.mockReset().mockImplementation(async subscriber => {
    deliver = subscriber
    return { [Symbol.dispose]: () => disposed.push('subscription') }
  })
  getConsoleHostBoard.mockReset().mockImplementation(() => ({ readRequirement, subscribeSelection, [Symbol.dispose]: () => disposed.push('handle') }))
  selectHostBoardConnection.mockReset()
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

const render = () => act(async () => root.render(<ConsoleHostBoard session={session} console={REF} entry={ENTRY} onClose={() => {}} />))
const send = (update: HostBoardSelectionUpdate) => act(async () => deliver(update))
const text = () => document.body.textContent ?? ''
const button = (label: string) => [...document.body.querySelectorAll('button')].find(item => item.textContent === label)

it('acquires the handle for the open revision and reads nothing until the selection is known', async () => {
  await render()
  expect(getConsoleHostBoard).toHaveBeenCalledWith(REF, 'hb1')
  expect(subscribeSelection).toHaveBeenCalledOnce()
  expect(readRequirement).not.toHaveBeenCalled()
  expect(text()).toContain('Checking your connection for this board')
})

it('reads the entry\'s requirement once selected and renders the snapshot', async () => {
  await render()
  await send({ state: 'selected', changeSeq: 1, selectionEpoch: 1 })
  expect(readRequirement).toHaveBeenCalledWith('board-1')
  expect(text()).toContain('Reading the board')
  await act(async () => reads[0](OK))
  expect(text()).toContain('ENG · Engineering')
  expect(text()).toContain('Fix the login')
})

it('offers only the operator\'s own accounts for the target, and selects through the session with a request key', async () => {
  accounts.list = [{ id: 7, name: 'ana@acme.test' }]
  selectHostBoardConnection.mockResolvedValue({ status: 'selected' })
  await render()
  await send({ state: 'none', changeSeq: 1, selectionEpoch: null })
  expect(text()).toContain('Not connected for you')
  expect(accounts.filters).toEqual([{ resourceUrl: ENTRY.requirement.target }])
  await act(async () => button('Use ana@acme.test')!.click())
  expect(selectHostBoardConnection).toHaveBeenCalledWith(REF, 'hb1', 7, expect.stringMatching(/^[A-Za-z0-9_-]{1,128}$/))
  // The read waits for the committed selection, which the subscription delivers.
  await send({ state: 'selected', changeSeq: 2, selectionEpoch: 1 })
  expect(readRequirement).toHaveBeenCalledOnce()
})

it('reuses the request key when the same choice is retried after a failure', async () => {
  accounts.list = [{ id: 7, name: 'ana@acme.test' }]
  selectHostBoardConnection.mockResolvedValueOnce({ status: 'failed' }).mockResolvedValueOnce({ status: 'selected' })
  await render()
  await send({ state: 'none', changeSeq: 1, selectionEpoch: null })
  await act(async () => button('Use ana@acme.test')!.click())
  expect(text()).toContain('Could not use that connection')
  await act(async () => button('Use ana@acme.test')!.click())
  const [first, second] = selectHostBoardConnection.mock.calls
  expect(second[3]).toBe(first[3])
})

it('clears the board when the subscription ends as unknown', async () => {
  await render()
  await send({ state: 'selected', changeSeq: 1, selectionEpoch: 1 })
  await act(async () => reads[0](OK))
  await send({ state: 'unknown' })
  expect(text()).not.toContain('Fix the login')
  expect(text()).toContain('Checking your connection for this board')
})

it('never reads a handle again after a guard refusal', async () => {
  await render()
  await send({ state: 'selected', changeSeq: 1, selectionEpoch: 1 })
  readRequirement.mockRejectedValue(new Error('Console c1 at revision 4 is not open in your operate session with host board hb1.'))
  await act(async () => { reads[0]({ status: 'unavailable' }) })
  await act(async () => button('Retry')!.click())
  await act(async () => {})
  expect(text()).toContain('Nothing is shown for this board right now')
  const calls = readRequirement.mock.calls.length
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(readRequirement.mock.calls.length).toBe(calls)
})

it('disposes the subscription and the handle on unmount, and drops a late answer', async () => {
  await render()
  await send({ state: 'selected', changeSeq: 1, selectionEpoch: 1 })
  act(() => root.render(<></>))
  expect(disposed.toSorted()).toEqual(['handle', 'subscription'])
  await act(async () => reads[0](OK))
  expect(text()).not.toContain('Fix the login')
})
