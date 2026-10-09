// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { OperateSession } from '@gadgets/workshop-shared/api'
import type { HostBoardEntry, HostBoardSelection, HostBoardSelectionUpdate, HostBoardView } from '@gadgets/workshop-shared/operate-console'

type Subscriber = { add: (...args: unknown[]) => void; remove: (id: number) => void; ready: () => void }
const accounts = vi.hoisted(() => ({ list: [] as { id: number; name: string }[], filters: [] as unknown[], subscriber: null as Subscriber | null }))
const api = vi.hoisted(() => ({
  authenticatedApi: {
    subscribeConnectedAccounts: (subscriber: Subscriber, filter: unknown) => {
      accounts.filters.push(filter)
      accounts.subscriber = subscriber
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
import { HOST_BOARD_RESUBSCRIBE_MS } from './useHostBoard'

const SECRET = 'Fix the login'
const ENTRY: HostBoardEntry & { id: string } = { kind: 'host-board', id: 'hb1', label: 'Team board',
  requirement: { name: 'board-1', resource: 'inferops-board', target: 'inferops://acme.ops/project/board/ENG' } }
const REF = { consoleId: 'c1', source: 'published' as const, revision: '4' }
const ok = (title = SECRET, readAt = new Date().toISOString(), revision = '4'): HostBoardView => ({ status: 'ok', readAt, publicationRevision: revision, board: {
  project: { identifier: 'ENG', name: 'Engineering' },
  columns: [{ label: 'Todo', group: 'unstarted', issues: [{ identifier: 'ENG-1', title, priority: 'high', targetDate: null, blocked: false }] }],
} })

// A fake kernel: one handle per `getConsoleHostBoard`, whose reads and subscriber the test drives.
// A read takes the next queued failure, if any, else waits for the test to answer it.
type Handle = { reads: Array<(view: HostBoardView) => void>; deliver: (update: HostBoardSelectionUpdate) => void }
let handles: Handle[]
let disposed: string[]
let readFailures: unknown[]
let subscribeFailure: unknown
const readRequirement = vi.fn<(name: string) => void>()
const selectHostBoardConnection = vi.fn<(console: unknown, entryId: string, accountId: number, requestKey: string) => Promise<HostBoardSelection>>()
const getConsoleHostBoard = vi.fn<(ref: { revision: string }, entryId: string) => object>((ref) => {
  const handle: Handle = { reads: [], deliver: () => {} }
  handles.push(handle)
  return {
    readRequirement: (name: string) => {
      readRequirement(name)
      return new Promise<HostBoardView>((resolve, reject) => {
        if (readFailures.length > 0) reject(readFailures.shift())
        else handle.reads.push(resolve)
      })
    },
    subscribeSelection: async (subscriber: (update: HostBoardSelectionUpdate) => void) => {
      if (subscribeFailure !== undefined) { const failure = subscribeFailure; subscribeFailure = undefined; throw failure }
      handle.deliver = subscriber
      return { [Symbol.dispose]: () => disposed.push(`subscription@${ref.revision}`) }
    },
    [Symbol.dispose]: () => disposed.push(`handle@${ref.revision}`),
  }
})
const session = { getConsoleHostBoard, selectHostBoardConnection } as unknown as RpcStub<OperateSession>

let root: Root
let container: HTMLDivElement
let visibility: DocumentVisibilityState
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('PointerEvent', MouseEvent)
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  accounts.list = []; accounts.filters = []; accounts.subscriber = null
  handles = []; disposed = []; readFailures = []; subscribeFailure = undefined
  readRequirement.mockReset(); getConsoleHostBoard.mockClear(); selectHostBoardConnection.mockReset()
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const render = (ref = REF) => act(async () => root.render(<ConsoleHostBoard session={session} console={ref} entry={ENTRY} onClose={() => {}} />))
const current = () => handles.at(-1)!
const send = (update: HostBoardSelectionUpdate, handle = current()) => act(async () => handle.deliver(update))
const answer = (view: HostBoardView, handle = current(), index = handle.reads.length - 1) => act(async () => handle.reads[index](view))
const selected = (changeSeq = 1, selectionEpoch = 1) => send({ state: 'selected', changeSeq, selectionEpoch })
const text = () => document.body.textContent ?? ''
const button = (label: string) => [...document.body.querySelectorAll('button')].find(item => item.textContent === label)
const reads = () => readRequirement.mock.calls.length
const flush = () => act(async () => {})

describe('handle and first read', () => {
  it('acquires the handle for the open revision and reads nothing until the selection is known', async () => {
    await render()
    expect(getConsoleHostBoard).toHaveBeenCalledWith(REF, 'hb1')
    expect(reads()).toBe(0)
    expect(text()).toContain('Checking your connection for this board')
  })

  it('reads the entry\'s requirement once selected and renders the snapshot', async () => {
    await render()
    await selected()
    expect(readRequirement).toHaveBeenCalledWith('board-1')
    expect(text()).toContain('Reading the board')
    await answer(ok())
    expect(text()).toContain('ENG · Engineering')
    expect(text()).toContain(SECRET)
  })
})

describe('refusals and unrecognized errors', () => {
  it.each([
    ['an Error the matcher does not recognize', new Error(`provider said: ${SECRET} is forbidden`)],
    ['a thrown non-Error', `${SECRET}: 500`],
  ])('clears the board for %s, shows only the generic unavailable state, and reads again only on Retry', async (_, failure) => {
    await render()
    await selected()
    await answer(ok())
    readFailures.push(failure)
    // A newer selection clears the board and re-reads; that read fails.
    await send({ state: 'selected', changeSeq: 2, selectionEpoch: 2 })
    await flush()
    expect(text()).not.toContain(SECRET)
    expect(text()).toContain('This board is unavailable right now.')
    expect(text()).not.toContain('forbidden')
    expect(text()).not.toContain('500')
    const calls = reads()
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(reads()).toBe(calls)
    await act(async () => button('Retry')!.click())
    expect(reads()).toBe(calls + 1)
    expect(text()).not.toContain(SECRET)
  })

  it('never reads a handle again after a recognized guard refusal', async () => {
    await render()
    await selected()
    readFailures.push(new Error('Console c1 at revision 4 is not open in your operate session with host board hb1.'))
    await answer({ status: 'unavailable' })
    await act(async () => button('Retry')!.click())
    await flush()
    expect(text()).toContain('Nothing is shown for this board right now')
    const calls = reads()
    await act(async () => window.dispatchEvent(new Event('focus')))
    await send({ state: 'selected', changeSeq: 2, selectionEpoch: 2 })
    expect(reads()).toBe(calls)
  })
})

describe('selection', () => {
  it('offers only the operator\'s own accounts for the target, and reads only after the subscription commits the choice', async () => {
    accounts.list = [{ id: 7, name: 'ana@acme.test' }]
    selectHostBoardConnection.mockResolvedValue({ status: 'selected' })
    await render()
    await send({ state: 'none', changeSeq: 1, selectionEpoch: null })
    expect(text()).toContain('Not connected for you')
    expect(accounts.filters).toEqual([{ resourceUrl: ENTRY.requirement.target }])
    await act(async () => button('Use ana@acme.test')!.click())
    expect(selectHostBoardConnection).toHaveBeenCalledWith(REF, 'hb1', 7, expect.stringMatching(/^[A-Za-z0-9_-]{1,128}$/))
    expect(reads()).toBe(0)
    await send({ state: 'selected', changeSeq: 2, selectionEpoch: 1 })
    expect(reads()).toBe(1)
  })

  it('reuses the request key for a retry after a lost answer, so a duplicate makes no second connection', async () => {
    accounts.list = [{ id: 7, name: 'ana@acme.test' }]
    selectHostBoardConnection.mockRejectedValueOnce(new Error('connection lost')).mockResolvedValueOnce({ status: 'selected' })
    await render()
    await send({ state: 'none', changeSeq: 1, selectionEpoch: null })
    await act(async () => button('Use ana@acme.test')!.click())
    expect(text()).toContain('Could not use that connection')
    expect(text()).not.toContain('connection lost')
    await act(async () => button('Use ana@acme.test')!.click())
    const [first, second] = selectHostBoardConnection.mock.calls
    expect(second[3]).toBe(first[3])
  })

  it('never restores a superseded selection: it reads nothing, and the next choice is a new request', async () => {
    accounts.list = [{ id: 7, name: 'ana@acme.test' }]
    selectHostBoardConnection.mockResolvedValueOnce({ status: 'superseded' }).mockResolvedValueOnce({ status: 'selected' })
    await render()
    await send({ state: 'none', changeSeq: 2, selectionEpoch: 1 })
    await act(async () => button('Use ana@acme.test')!.click())
    expect(reads()).toBe(0)
    expect(text()).toContain('Not connected for you')
    // A replayed older delivery cannot bring back what the superseding change replaced.
    await send({ state: 'selected', changeSeq: 1, selectionEpoch: 1 })
    expect(reads()).toBe(0)
    await act(async () => button('Use ana@acme.test')!.click())
    const [first, second] = selectHostBoardConnection.mock.calls
    expect(second[3]).not.toBe(first[3])
  })

  it('clears first on an account change while the board shows, re-reads without choosing an account, and drops the overlapping read', async () => {
    accounts.list = [{ id: 7, name: 'ana@acme.test' }]
    await render()
    await selected()
    await answer(ok())
    expect(text()).toContain(SECRET)
    await act(async () => accounts.subscriber!.remove(7))
    expect(text()).not.toContain(SECRET)
    const overlapping = current().reads.length - 1
    // A second change while that re-read is in flight supersedes it.
    await act(async () => accounts.subscriber!.add(8, { displayName: 'bo@acme.test' }, { displayName: 'InferOps' }, [], true, 'inferops'))
    await answer(ok('Late answer'), current(), overlapping)
    expect(text()).not.toContain('Late answer')
    await answer(ok('Fresh answer'))
    expect(text()).toContain('Fresh answer')
    expect(selectHostBoardConnection).not.toHaveBeenCalled()
  })
})

describe('invalidation across delayed answers', () => {
  it('drops a read answered after a selection change', async () => {
    await render()
    await selected()
    await send({ state: 'selected', changeSeq: 2, selectionEpoch: 2 })
    await answer(ok('Before the change'), current(), 0)
    expect(text()).not.toContain('Before the change')
  })

  it('drops the old handle\'s answer after leaving and reopening the dialog, and disposes it', async () => {
    await render()
    await selected()
    const first = current()
    act(() => root.render(<></>))
    expect(disposed.toSorted()).toEqual(['handle@4', 'subscription@4'])
    await render()
    await answer(ok('From the closed dialog'), first, 0)
    expect(text()).not.toContain('From the closed dialog')
    expect(text()).toContain('Checking your connection for this board')
  })

  it('drops the old revision\'s answer after a republish and reads through a new handle for the new revision', async () => {
    await render()
    await selected()
    const old = current()
    await render({ ...REF, revision: '5' })
    expect(getConsoleHostBoard).toHaveBeenLastCalledWith({ ...REF, revision: '5' }, 'hb1')
    expect(disposed).toContain('handle@4')
    await answer(ok('Old revision', new Date().toISOString(), '4'), old, 0)
    expect(text()).not.toContain('Old revision')
    await selected()
    await answer(ok('New revision', new Date().toISOString(), '5'))
    expect(text()).toContain('New revision')
  })
})

describe('subscription end and recovery', () => {
  it('clears on unknown, resubscribes after the backoff, and restores only through a fresh snapshot and read', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await render()
    await selected()
    await answer(ok())
    const ended = current().deliver
    await send({ state: 'unknown' })
    expect(text()).not.toContain(SECRET)
    expect(text()).toContain('Checking your connection for this board')
    // A late delivery on the ended subscription restores nothing.
    await act(async () => ended({ state: 'selected', changeSeq: 9, selectionEpoch: 9 }))
    const calls = reads()
    expect(text()).not.toContain(SECRET)
    await act(async () => { vi.advanceTimersByTime(HOST_BOARD_RESUBSCRIBE_MS) })
    await selected()
    expect(reads()).toBe(calls + 1)
    await answer(ok('Recovered'))
    expect(text()).toContain('Recovered')
  })

  it('resubscribes at once on a resume after a failed subscription', async () => {
    subscribeFailure = new Error('transport broke')
    await render()
    await flush()
    expect(text()).toContain('Checking your connection for this board')
    await act(async () => window.dispatchEvent(new Event('pageshow')))
    await selected()
    await answer(ok())
    expect(text()).toContain(SECRET)
  })
})

describe('expiry from readAt', () => {
  it('clears a board 60 s after its readAt, not after it arrived', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    await render()
    await selected()
    await answer(ok(SECRET, new Date(Date.now() - 50_000).toISOString()))
    expect(text()).toContain(SECRET)
    await act(async () => { vi.advanceTimersByTime(10_000) })
    expect(text()).not.toContain(SECRET)
  })

  it('never renders an answer whose readAt is already 60 s old', async () => {
    await render()
    await selected()
    await answer(ok(SECRET, new Date(Date.now() - 61_000).toISOString()))
    expect(text()).not.toContain(SECRET)
    expect(text()).toContain('This board is unavailable right now.')
  })

  it('clears an expired board while the tab is hidden, and re-reads when it is shown again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    await render()
    await selected()
    await answer(ok())
    visibility = 'hidden'
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(text()).not.toContain(SECRET)
    const calls = reads()
    visibility = 'visible'
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(reads()).toBe(calls + 1)
    await answer(ok('Shown again'))
    expect(text()).toContain('Shown again')
  })
})

it('keeps board data out of logs, storage and the URL', async () => {
  const logged: unknown[] = []
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logged.push(...args) })
  }
  const stored = vi.spyOn(Storage.prototype, 'setItem')
  const url = location.href
  await render()
  await selected()
  await answer(ok())
  readFailures.push(new Error(SECRET))
  await send({ state: 'selected', changeSeq: 2, selectionEpoch: 2 })
  await flush()
  expect(JSON.stringify(logged.map(String))).not.toContain(SECRET)
  expect(stored).not.toHaveBeenCalled()
  expect(location.href).toBe(url)
})
