// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { BoundViewDescription, OperateSession } from '@gadgets/workshop-shared/api'
import type { BoundViewEntry, ConsoleRef, HostBoardEntry, HostBoardSelection, HostBoardSelectionUpdate, HostBoardView } from '@gadgets/workshop-shared/operate-console'
import type { HostBoardEvent } from './hostBoardState'

// Every failure path of a bound view, under real `createRoot` for both the page's root and the
// view's dedicated root, with a sentinel in the spec and the snapshot: the sentinel must never
// reach the Workshop reporter's transport, the console, window `error` or `unhandledrejection`.
const SENTINEL = 'SENTINEL-bound-view-4c1e'

const poison = vi.hoisted(() => ({
  reducer: (_event: unknown): boolean => false,
  evaluate: false,
  badge: 'off' as 'off' | 'always' | 'once',
  accounts: false,
  /** Whether the badge throws this time; `once` throws on the first render only. */
  badgeThrows(): boolean {
    const throws = this.badge !== 'off'
    if (this.badge === 'once') this.badge = 'off'
    return throws
  },
}))
const hooks = vi.hoisted(() => ({ fired: [] as string[] }))

vi.mock('./hostBoardState', async importOriginal => {
  const actual = await importOriginal<typeof import('./hostBoardState')>()
  return { ...actual, reduceHostBoard: (state: Parameters<typeof actual.reduceHostBoard>[0], event: HostBoardEvent) => {
    if (poison.reducer(event)) throw new Error(`${SENTINEL} ${JSON.stringify(event)}`)
    return actual.reduceHostBoard(state, event)
  } }
})
vi.mock('./boundView/evaluate', async importOriginal => {
  const actual = await importOriginal<typeof import('./boundView/evaluate')>()
  return { ...actual, evaluateBoundView: (...args: Parameters<typeof actual.evaluateBoundView>) => {
    if (poison.evaluate) throw new Error(`${SENTINEL} ${JSON.stringify(args[1].get('a'))}`)
    return actual.evaluateBoundView(...args)
  } }
})
// A renderer component that throws a RangeError echoing what it was given.
vi.mock('@cloudflare/kumo', async importOriginal => {
  const actual = await importOriginal<typeof import('@cloudflare/kumo')>()
  const Badge = (props: { children?: ReactNode }) => {
    if (poison.badgeThrows()) {
      throw new RangeError(`${SENTINEL} ${JSON.stringify(props.children, (_key, value) => typeof value === 'object' && value?.$$typeof ? value.props : value)}`)
    }
    return <actual.Badge {...(props as Parameters<typeof actual.Badge>[0])} />
  }
  return { ...actual, Badge }
})
// Records which of a root's error hooks React called.
vi.mock('react-dom/client', async importOriginal => {
  const actual = await importOriginal<typeof import('react-dom/client')>()
  return { ...actual, createRoot: (container: Element, options?: Record<string, unknown>) => actual.createRoot(container, options && Object.fromEntries(
    Object.entries(options).map(([name, hook]) => [name, typeof hook === 'function' ? (...args: unknown[]) => { hooks.fired.push(name); return (hook as (...a: unknown[]) => unknown)(...args) } : hook]))) }
})
type Subscriber = { add: (...args: unknown[]) => void; remove: (id: number) => void; ready: () => void }
const api = vi.hoisted(() => ({ authenticatedApi: {
  subscribeConnectedAccounts: (subscriber: Subscriber) => {
    if (poison.accounts) return Object.assign(Promise.reject(new Error(SENTINEL)), { [Symbol.dispose]: () => {} })
    subscriber.add(7, { displayName: 'ada@acme.test' }, { displayName: 'InferOps' }, [], true, 'inferops')
    subscriber.ready()
    return Object.assign(Promise.resolve({}), { [Symbol.dispose]: () => {} })
  },
} }))
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => api }))
vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: unknown }) => <a href="/gatekeepers">{children as never}</a> }))

import { ConsoleBoundView } from './ConsoleBoundView'
import { boundRootOptions } from './boundView/BoundViewRenderer'

const REF: ConsoleRef = { consoleId: 'c1', source: 'published', revision: '4' }
const ENTRY: BoundViewEntry & { id: string } = { kind: 'bound-view', id: 'bv1', gadgetId: 3, blueprintId: 'bp', version: 1, label: 'Triage view', requirements: ['a'] }
const BOARDS: HostBoardEntry[] = [{ kind: 'host-board', id: 'hb-a', label: 'Board A', requirement: { name: 'a', resource: 'inferops-board', target: 'inferops://acme.ops/project/board/A' } }]
const DESCRIPTION: BoundViewDescription = { consoleRef: REF, entryId: 'bv1', commitId: 'commit-a', requirements: [{ name: 'a', hostBoardEntryId: 'hb-a' }],
  specText: JSON.stringify({ version: 1, title: `Title ${SENTINEL}`, requirements: ['a'], root: { type: 'stack', children: [
    { type: 'text', text: `Spec ${SENTINEL}` },
    { type: 'list', of: { requirement: 'a', collection: 'issues' }, empty: 'None', item: [
      { type: 'field', value: { field: 'title' } }, { type: 'badge', value: { field: 'title' } }] },
  ] } }) }
const OK: HostBoardView = { status: 'ok', readAt: new Date().toISOString(), publicationRevision: '4', board: {
  project: { identifier: 'ENG', name: `Project ${SENTINEL}` },
  columns: [{ label: `Column ${SENTINEL}`, group: 'started', issues: [{ identifier: 'ENG-1', title: `Title ${SENTINEL}`, priority: 'high', targetDate: null, blocked: false }] }],
} }

type Handle = { reads: Array<{ resolve: (view: HostBoardView) => void; reject: (caught: unknown) => void }>; deliver: (update: HostBoardSelectionUpdate) => void }
let handle: Handle
let failures: { read?: unknown; subscribe?: unknown; select?: unknown }
const session = {
  getConsoleBoundView: async () => DESCRIPTION,
  getConsoleHostBoard: () => {
    handle = { reads: [], deliver: () => {} }
    const current = handle
    return {
      readRequirement: () => failures.read !== undefined ? Promise.reject(failures.read) : new Promise<HostBoardView>((resolve, reject) => current.reads.push({ resolve, reject })),
      subscribeSelection: async (subscriber: (update: HostBoardSelectionUpdate) => void) => {
        if (failures.subscribe !== undefined) throw failures.subscribe
        current.deliver = subscriber
        return { [Symbol.dispose]: () => {} }
      },
      [Symbol.dispose]: () => {},
    }
  },
  selectHostBoardConnection: async (): Promise<HostBoardSelection> => {
    if (failures.select !== undefined) throw failures.select
    return { status: 'selected' }
  },
} as unknown as RpcStub<OperateSession>

// The sinks, as in useHostBoard.test.tsx: the reporter installed for real over a mocked transport,
// every console method, and window `error` / `unhandledrejection` (Node's own uncaught exceptions
// and rejections forwarded to the window, as a browser would raise them).
let transport: ReturnType<typeof vi.fn<typeof fetch>>
let seen: unknown[]
let consoleCalls: unknown[][]
const nodeProcess = (globalThis as unknown as { process: { on: (name: string, listener: (reason: unknown) => void) => void; off: (name: string, listener: (reason: unknown) => void) => void } }).process
const onNodeRejection = (reason: unknown) => { window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason })) }
const onNodeException = (error: unknown) => { window.dispatchEvent(new ErrorEvent('error', { error, message: String(error) })) }
const onWindowError = (event: ErrorEvent) => seen.push(event.error ?? event.message)
const onWindowRejection = (event: Event) => seen.push((event as Event & { reason: unknown }).reason)

let root: Root
let host: HTMLDivElement
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('PointerEvent', MouseEvent)
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  poison.reducer = () => false; poison.evaluate = false; poison.badge = 'off'; poison.accounts = false
  hooks.fired = []; failures = {}
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
  nodeProcess.on('uncaughtException', onNodeException)
  window.addEventListener('error', onWindowError)
  window.addEventListener('unhandledrejection', onWindowRejection)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount()); host.remove(); document.body.replaceChildren()
  nodeProcess.off('unhandledRejection', onNodeRejection)
  nodeProcess.off('uncaughtException', onNodeException)
  window.removeEventListener('error', onWindowError)
  window.removeEventListener('unhandledrejection', onWindowRejection)
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
/** The sinks the sentinel reached. */
const leaks = () => Object.entries({
  reporter: transport.mock.calls.map(([, init]) => init?.body ?? ''),
  console: consoleCalls.map(args => args.map(String)),
  window: seen.map(String),
}).filter(([, values]) => JSON.stringify(values).includes(SENTINEL)).map(([sink]) => sink)
const text = () => document.body.textContent ?? ''
const render = () => act(async () => root.render(<ConsoleBoundView session={session} console={REF} entry={ENTRY} hostBoards={BOARDS}
  onClose={() => {}} onRefused={() => {}} onStaleOrUnavailable={() => {}} />))
const selected = () => act(async () => handle.deliver({ state: 'selected', changeSeq: 1, selectionEpoch: 1 }))
const answer = (view: HostBoardView = OK) => act(async () => handle.reads.at(-1)!.resolve(view))
const view = () => document.querySelector<HTMLElement>('[data-bound-view]')!
const Throwing = () => { throw new RangeError(SENTINEL) }

describe('containment', () => {
  it('renders the sentinels when nothing fails, and leaks none of them', async () => {
    await render(); await selected(); await answer(); await settle()
    expect(view().textContent).toContain(SENTINEL)
    expect(leaks()).toEqual([])
  })

  it('contains a reducer throw on read-answer: the board shows unavailable', async () => {
    poison.reducer = event => (event as HostBoardEvent).type === 'read-answer'
    await render(); await selected(); await answer(); await settle()
    expect(text()).toContain('This board is unavailable right now.')
    expect(view().childNodes.length).toBe(0)
    expect(leaks()).toEqual([])
  })

  it.each([
    ['a rejected subscribeSelection', () => { failures.subscribe = new Error(SENTINEL) }],
    ['a rejected readRequirement', () => { failures.read = new Error(SENTINEL) }],
    ['a rejected account subscription', () => { poison.accounts = true }],
  ])('contains %s', async (_, arm) => {
    arm()
    await render()
    if (failures.subscribe === undefined) await selected()
    await settle()
    expect(view().childNodes.length).toBe(0)
    expect(leaks()).toEqual([])
  })

  it('contains a rejected selectHostBoardConnection', async () => {
    failures.select = new Error(SENTINEL)
    await render()
    await act(async () => handle.deliver({ state: 'none', changeSeq: 1, selectionEpoch: null }))
    const use = [...document.querySelectorAll('button')].find(button => button.textContent?.startsWith('Use '))!
    await act(async () => use.click())
    await settle()
    expect(leaks()).toEqual([])
  })

  it('contains a thrown evaluator error: the view shows its fixed failure state', async () => {
    poison.evaluate = true
    await render(); await selected(); await answer(); await settle()
    expect(text()).toContain('This view could not be shown.')
    expect(view().childNodes.length).toBe(0)
    expect(leaks()).toEqual([])
  })

  it('contains a renderer component\'s RangeError caught by the dedicated root\'s boundary: the view shows its failure state', async () => {
    poison.badge = 'always'
    await render(); await selected(); await answer(); await settle()
    expect(hooks.fired).toContain('onCaughtError')
    expect(leaks()).toEqual([])
    expect(text()).toContain('This view could not be shown.')
    expect(view().childNodes.length).toBe(0)
  })

  it('contains a renderer component\'s RangeError that React recovers from', async () => {
    poison.badge = 'once'
    await render(); await selected(); await answer(); await settle()
    expect(hooks.fired).toContain('onRecoverableError')
    expect(leaks()).toEqual([])
  })

  it('contains a RangeError the dedicated root\'s hooks see as uncaught', async () => {
    const element = document.createElement('div')
    document.body.append(element)
    const reported: unknown[] = []
    const dedicated = createRoot(element, boundRootOptions(failure => reported.push(failure)))
    // Outside act(), which would rethrow the render error to the test itself: in a page, the
    // root's `onUncaughtError` is the error's only way out.
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false)
    dedicated.render(<Throwing />)
    await new Promise(resolve => setTimeout(resolve, 20))
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    expect(hooks.fired).toContain('onUncaughtError')
    expect(reported).toEqual([{ type: 'BoundViewFailure' }])
    expect(leaks()).toEqual([])
    dedicated.unmount()
  })

  it('contains a throwing event handler', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => { throw new Error(SENTINEL) } })
    await render()
    await act(async () => handle.deliver({ state: 'none', changeSeq: 1, selectionEpoch: null }))
    const use = [...document.querySelectorAll('button')].find(button => button.textContent?.startsWith('Use '))!
    await act(async () => use.click())
    await settle()
    expect(text()).toContain('This view could not be shown.')
    expect(leaks()).toEqual([])
  })

  it('contains a throwing effect', async () => {
    vi.stubGlobal('MutationObserver', function MutationObserver() { throw new Error(SENTINEL) })
    await render(); await settle()
    expect(text()).toContain('This view could not be shown.')
    expect(view().childNodes.length).toBe(0)
    expect(leaks()).toEqual([])
  })
})
