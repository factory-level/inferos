// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { OperateSession } from '@gadgets/workshop-shared/api'
import type { HostBoardSelection, HostBoardSelectionUpdate, HostBoardView } from '@gadgets/workshop-shared/operate-console'
import type { HostBoardEvent } from './hostBoardState'

const SENTINEL = 'SENTINEL-7f3a-board-secret'

// The real reducer, made to throw the sentinel on the events a test poisons, standing in for a
// reducer bug inside one of the hooks' promise handlers.
const poison = vi.hoisted(() => ({ on: (_event: unknown): boolean => false }))
vi.mock('./hostBoardState', async importOriginal => {
  const actual = await importOriginal<typeof import('./hostBoardState')>()
  return {
    ...actual,
    reduceHostBoard: (state: Parameters<typeof actual.reduceHostBoard>[0], event: HostBoardEvent) => {
      if (poison.on(event)) throw new Error(SENTINEL)
      return actual.reduceHostBoard(state, event)
    },
  }
})

import { useHostBoard, type HostBoardOptions } from './useHostBoard'
import { useHostBoardSelection } from './useHostBoardSelection'
import type { HostBoardViewState } from './hostBoardState'
import type { HostBoardTarget } from './hostBoardTypes'

const TARGET: HostBoardTarget = { entryId: 'hb1', console: { consoleId: 'c1', source: 'published', revision: '4' } }
const ok = (title = 'Fix the login'): HostBoardView => ({ status: 'ok', readAt: new Date().toISOString(), publicationRevision: '4', board: {
  project: { identifier: 'ENG', name: 'Engineering' },
  columns: [{ label: 'Todo', group: 'unstarted', issues: [{ identifier: 'ENG-1', title, priority: 'high', targetDate: null, blocked: false }] }],
} })

// A fake kernel handle whose reads and selection subscriber the test drives.
let log: string[]
let reads: Array<{ resolve: (view: HostBoardView) => void; reject: (caught: unknown) => void }>
let deliver: (update: HostBoardSelectionUpdate) => void
let subscribeFailure: unknown
const selectHostBoardConnection = vi.fn<(console: unknown, entryId: string, accountId: number, requestKey: string) => Promise<HostBoardSelection>>()
const session = {
  getConsoleHostBoard: () => ({
    readRequirement: (name: string) => {
      log.push(`issue ${name}`)
      return new Promise<HostBoardView>((resolve, reject) => reads.push({ resolve, reject }))
    },
    subscribeSelection: async (subscriber: (update: HostBoardSelectionUpdate) => void) => {
      if (subscribeFailure !== undefined) throw subscribeFailure
      deliver = subscriber
      return { [Symbol.dispose]: () => {} }
    },
    [Symbol.dispose]: () => {},
  }),
  selectHostBoardConnection,
} as unknown as RpcStub<OperateSession>

let latest: { view: HostBoardViewState; dispatch: ReturnType<typeof useHostBoard>['dispatch'] }
const Board = ({ options }: { options?: HostBoardOptions }) => {
  latest = useHostBoard(session, TARGET, 'board-1', options)
  return null
}
let select: (accountId: number) => void
const Picker = ({ onConnected }: { onConnected: () => void }) => {
  select = useHostBoardSelection(session, TARGET, onConnected).select
  return null
}

// Everything a failure could reach: the Workshop reporter's transport (installed for real), every
// console method, and window `error` / `unhandledrejection`. jsdom does not raise
// `unhandledrejection` itself, so Node's is forwarded to the window as a browser would raise it.
let transport: ReturnType<typeof vi.fn<typeof fetch>>
let seen: unknown[]
let consoleCalls: unknown[][]
// The test runner's own process (this package has no Node types).
const nodeProcess = (globalThis as unknown as { process: { on: (name: string, listener: (reason: unknown) => void) => void; off: (name: string, listener: (reason: unknown) => void) => void } }).process
const onNodeRejection = (reason: unknown) => {
  window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason }))
}
const onWindowError = (event: ErrorEvent) => seen.push(event.error)
const onWindowRejection = (event: Event) => seen.push((event as Event & { reason: unknown }).reason)

let root: Root
let container: HTMLDivElement
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  log = []; reads = []; deliver = () => {}; subscribeFailure = undefined; poison.on = () => false
  selectHostBoardConnection.mockReset()
  seen = []; consoleCalls = []
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { consoleCalls.push(args) })
  }
  transport = vi.fn<typeof fetch>().mockResolvedValue(new Response())
  vi.stubGlobal('fetch', transport)
  vi.stubEnv('VITE_FRONTEND_ERROR_REPORTING', 'true')
  vi.resetModules()
  const reporting = await import('../../errorReporting')
  reporting.installWorkshopErrorReporting()
  nodeProcess.on('unhandledRejection', onNodeRejection)
  window.addEventListener('error', onWindowError)
  window.addEventListener('unhandledrejection', onWindowRejection)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount()); container.remove()
  nodeProcess.off('unhandledRejection', onNodeRejection)
  window.removeEventListener('error', onWindowError)
  window.removeEventListener('unhandledrejection', onWindowRejection)
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})

// Lets settled promises run their handlers, then a macrotask so Node can raise any rejection
// left unhandled.
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const selected = () => act(async () => deliver({ state: 'selected', changeSeq: 1, selectionEpoch: 1 }))

/** The sinks the sentinel reached: the reporter's transport, the console or the window. */
const leaks = () => Object.entries({
  reporter: transport.mock.calls.map(([, init]) => init?.body ?? ''),
  console: consoleCalls.map(args => args.map(String)),
  window: seen.map(String),
}).filter(([, values]) => JSON.stringify(values).includes(SENTINEL)).map(([sink]) => sink)

describe('containment', () => {
  it('contains a reducer throw on read-answer, including on the failure path it falls into', async () => {
    // The answer of this read throws in the reducer, and so does the read-failed it falls into.
    poison.on = event => (event as HostBoardEvent).type === 'read-answer' || (event as HostBoardEvent).type === 'read-failed'
    await act(async () => root.render(<Board />))
    await selected()
    expect(reads).toHaveLength(1)
    await act(async () => reads[0].resolve(ok(SENTINEL)))
    await settle()
    expect(leaks()).toEqual([])
    expect(seen).toEqual([])
    expect(transport).not.toHaveBeenCalled()
    expect(latest.view.status).toBe('loading')
  })

  it('contains a rejected subscribeSelection whose handler throws', async () => {
    subscribeFailure = new Error(SENTINEL)
    poison.on = event => (event as HostBoardEvent).type === 'selection-failed'
    await act(async () => root.render(<Board />))
    await settle()
    expect(leaks()).toEqual([])
    expect(seen).toEqual([])
    expect(transport).not.toHaveBeenCalled()
    expect(latest.view.status).toBe('unknown')
  })

  it('contains a throw from the selection hook\'s completion handler', async () => {
    selectHostBoardConnection.mockResolvedValue({ status: 'selected' } as HostBoardSelection)
    await act(async () => root.render(<Picker onConnected={() => { throw new Error(SENTINEL) }} />))
    await act(async () => select(7))
    await settle()
    expect(selectHostBoardConnection).toHaveBeenCalledOnce()
    expect(leaks()).toEqual([])
    expect(seen).toEqual([])
    expect(transport).not.toHaveBeenCalled()
  })
})

describe('onRequest', () => {
  it('is called with each read\'s token where the read is issued, before its answer, in order', async () => {
    const onRequest = (token: number) => log.push(`request ${token}`)
    await act(async () => root.render(<Board options={{ onRequest }} />))
    expect(log).toEqual([])
    await selected()
    expect(log).toEqual(['request 1', 'issue board-1'])
    expect(latest.view.status).toBe('loading')
    await act(async () => reads[0].resolve(ok()))
    expect(latest.view).toMatchObject({ status: 'ok', read: { token: 1 } })
    await act(async () => latest.dispatch({ type: 'retry' }))
    expect(log).toEqual(['request 1', 'issue board-1', 'request 2', 'issue board-1'])
    // The second read's answer has not arrived, so the board still shows the first.
    expect(latest.view).toMatchObject({ status: 'ok', read: { token: 1 } })
    await act(async () => reads[1].resolve(ok()))
    expect(latest.view).toMatchObject({ status: 'ok', read: { token: 2 } })
  })
})
