// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// A reconnect replaces the authenticated stub (`main.tsx` swaps the RPC stub when the socket
// breaks, and `useAuth` re-authenticates on the replacement). The page runs here under the real
// feature flags, session provider, console listing and host-board dialog, gated the way
// `AuthenticatedShell` (routes/__root.tsx) gates Operate, over a fake kernel whose second
// connection answers nothing until it is restored. The open host board clears during the gap and
// comes back by itself, with a fresh handle and read, only when the restored session still has
// the same console revision open and the operator neither closed it nor left.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { OperateSessionUpdate } from '@gadgets/workshop-shared/api'
import type { HostBoardSelectionUpdate, HostBoardView, OperateConsole } from '@gadgets/workshop-shared/operate-console'
import { applyOperateEvent, INITIAL_OPERATE_PAGE, type OperateEvent, type OperateSessionSnapshot } from '@gadgets/workshop-shared/operate-session'

type Handle = { revision: string; reads: Array<(view: HostBoardView) => void>; deliver: ((update: HostBoardSelectionUpdate) => void) | null; disposed: boolean }
type Connection = { name: string; restore: () => void; handles: Handle[]; api: object }

const kernel = vi.hoisted(() => ({
  page: null as unknown as OperateSessionSnapshot,
  subscriber: null as ((update: OperateSessionUpdate) => void) | null,
  // The console's published revision as listed, or null once it is deleted.
  published: '3' as string | null,
  current: null as unknown as { api: object },
}))

vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: kernel.current.api }) }))
vi.mock('../../ServerConfigContext', () => ({ useServerConfig: () => ({ canvasFeatures: { durableViews: true, composableViews: true }, hostBoards: true }) }))
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => () => {}, useSearch: () => ({}), useRouterState: () => '/inferops-canvas',
  Link: ({ children }: { children: unknown }) => <a href="/gatekeepers">{children as never}</a>,
}))
vi.mock('@cloudflare/kumo', async importOriginal => ({
  ...await importOriginal<typeof import('@cloudflare/kumo')>(),
  useKumoToastManager: () => ({ add: () => {} }),
}))
vi.mock('./ConsoleWorkspaceShell', () => ({ ConsoleWorkspaceShell: ({ children }: { children: import('react').ReactNode }) => children }))
vi.mock('./useSessionWorkspace', () => ({ useSessionWorkspace: () => null }))
vi.mock('./SessionApprovals', () => ({ SessionApprovals: () => null }))
vi.mock('./HandoverInbox', () => ({ HandoverInbox: () => null }))
vi.mock('./ConsolePage', () => ({ ConsolePage: () => <div data-testid="console" /> }))
vi.mock('../../pages/inferops-canvas/InferOpsCanvasHome', () => ({ InferOpsCanvasHome: () => null }))
vi.mock('./ConsoleMosaic', async () => {
  const { consoleEntries } = await import('./consoles')
  return {
    ConsoleMosaic: ({ screens, onOpen }: { screens: { status: string; workspaces?: never[] }; onOpen: (entry: unknown, source: 'published') => void }) =>
      <>{consoleEntries(screens.workspaces ?? []).map(entry =>
        <button key={entry.console.id} type="button" onClick={() => onOpen(entry, 'published')}>Open {entry.console.title}</button>)}</>,
  }
})
vi.mock('./OperateChatPanel', () => ({
  OperateChatPanel: ({ consoleActions }: { consoleActions?: { onOpenHostBoard?: (entryId: string) => void } }) =>
    consoleActions?.onOpenHostBoard ? <button type="button" onClick={() => consoleActions.onOpenHostBoard!('hb1')}>Open Team board</button> : null,
}))

import { useOperateModeAvailable } from './useAppMode'
import { FeatureFlagsProvider } from '../../FeatureFlagsContext'
import { OperateSessionProvider } from './OperateSessionContext'
import { OperateSessionPage } from './OperateSessionPage'

const consoleAt = (revision: string): OperateConsole => {
  const content = { title: 'Console A', fullChat: 'available' as const,
    views: [{ id: 'overview', title: 'Overview', type: 'screen' as const, screen: 'board' }],
    hostBoards: [{ kind: 'host-board' as const, id: 'hb1', label: 'Team board',
      requirement: { name: 'board-1', resource: 'inferops-board' as const, target: 'inferops://acme.ops/project/board/ENG' } }] }
  return { ...content, id: 'c1', revision, published: { revision, publishedAt: '2026-10-09T00:00:00.000Z', content } }
}

const view = (title: string, revision = '3'): HostBoardView => ({ status: 'ok', readAt: new Date().toISOString(), publicationRevision: revision, board: {
  project: { identifier: 'ENG', name: 'Engineering' },
  columns: [{ label: 'Todo', group: 'unstarted', issues: [{ identifier: 'ENG-1', title, priority: 'high', targetDate: null, blocked: false }] }],
} })

/**
 * One WebSocket connection's authenticated stub. Until `restore`, it answers nothing: capnweb
 * queues what is pipelined onto the replacement stub and delivers it once the socket is proven.
 */
const connect = (name: string): Connection => {
  let restore!: () => void
  const up = new Promise<void>(resolve => { restore = resolve })
  const handles: Handle[] = []
  const session = {
    subscribe: async (subscriber: (update: OperateSessionUpdate) => void) => {
      await up
      kernel.subscriber = subscriber
      subscriber(kernel.page)
      return { [Symbol.dispose]: () => {} }
    },
    listEvents: async () => [],
    dispatch: async (event: OperateEvent, seq: number) => {
      await up
      if (seq !== kernel.page.seq) throw new Error('conflict')
      kernel.page = { seq: seq + 1, state: applyOperateEvent(kernel.page.state, event) }
      kernel.subscriber?.(kernel.page)
      return kernel.page
    },
    getConsoleHostBoard: (ref: { revision: string }) => {
      const handle: Handle = { revision: ref.revision, reads: [], deliver: null, disposed: false }
      handles.push(handle)
      return {
        readRequirement: async () => { await up; return new Promise<HostBoardView>(resolve => handle.reads.push(resolve)) },
        subscribeSelection: async (subscriber: (update: HostBoardSelectionUpdate) => void) => {
          await up
          handle.deliver = subscriber
          return { [Symbol.dispose]: () => {} }
        },
        [Symbol.dispose]: () => { handle.disposed = true },
      }
    },
    selectHostBoardConnection: async () => { await up; return { state: 'selected' } },
    [Symbol.dispose]: () => {},
  }
  const api = {
    getUiFeatureFlags: async () => { await up; return { 'operate-mode': true } },
    getOperateSession: () => session,
    listGadgets: async () => { await up; return [{ id: 'ws1', role: 'use', title: 'Ops', lastActive: '2026-10-09T00:00:00.000Z' }] },
    openGadget: () => ({
      listConsoles: async () => { await up; return kernel.published === null ? [] : [consoleAt(kernel.published)] },
      listCanvases: async () => [{ schemaVersion: 1, id: 'board', title: 'Board', revision: '0', sections: [] }],
      getConsoleScreen: async () => ({ schemaVersion: 1, id: 'board', title: 'Board', revision: '0', sections: [] }),
      [Symbol.dispose]: () => {},
    }),
    subscribeConnectedAccounts: (subscriber: { ready: () => void }) => {
      subscriber.ready()
      return Object.assign(Promise.resolve({}), { [Symbol.dispose]: () => {} })
    },
  }
  return { name, restore, handles, api }
}

// Operate is offered only while the `operate-mode` flag is on, as in `AuthenticatedShell`.
const Shell = () => useOperateModeAvailable()
  ? <OperateSessionProvider><OperateSessionPage /></OperateSessionProvider>
  : <OperateSessionPage />
const App = () => <FeatureFlagsProvider><Shell /></FeatureFlagsProvider>

let container: HTMLDivElement
let root: Root
let first: Connection
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('PointerEvent', MouseEvent)
  kernel.page = { seq: 0, state: INITIAL_OPERATE_PAGE }
  kernel.subscriber = null
  kernel.published = '3'
  first = connect('first')
  first.restore()
  kernel.current = first
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

const settle = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve() })
const text = () => document.body.textContent ?? ''
const button = (label: string) => [...document.body.querySelectorAll('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label)
const dialogOpen = () => document.body.querySelector('[role="dialog"]') !== null
const click = async (label: string) => {
  const found = button(label)
  if (!found) throw new Error(`No ${label} button`)
  await act(async () => found.click())
  await settle()
}
/** Shows the board on the connection's newest handle: the selection, then the read's answer. */
const showBoard = async (connection: Connection, title: string) => {
  const handle = connection.handles.at(-1)!
  await act(async () => handle.deliver!({ state: 'selected', changeSeq: 1, selectionEpoch: 1 }))
  await settle()
  expect(handle.reads).toHaveLength(1)
  await act(async () => handle.reads[0](view(title)))
  await settle()
}

/** Console A open at revision 3, with its host board showing data read on the first connection. */
const openBoard = async () => {
  await act(async () => root.render(<App />))
  await settle()
  await click('Open Console A')
  await click('Open Team board')
  await showBoard(first, 'Before the blip')
  expect(text()).toContain('Before the blip')
}

/**
 * The socket breaks: the stub is replaced at once by one for a connection not yet made. During
 * that gap the dialog stays open with nothing shown, and nothing is read on the new connection.
 */
const blip = async () => {
  const second = connect('second')
  kernel.current = second
  await act(async () => root.render(<App />))
  await settle()
  expect(dialogOpen()).toBe(true)
  expect(text()).not.toContain('Before the blip')
  expect(text()).toContain('Checking your connection for this board')
  expect(first.handles.every(handle => handle.disposed)).toBe(true)
  return second
}

it('clears the board during the gap and, restored to the same console revision, shows a fresh read by itself', async () => {
  await openBoard()
  const second = await blip()
  await act(async () => second.restore())
  await settle()
  expect(dialogOpen()).toBe(true)
  // A fresh handle on the restored connection, for the same revision and entry.
  expect(second.handles.map(handle => handle.revision)).toEqual(['3'])
  await showBoard(second, 'After the blip')
  expect(text()).toContain('After the blip')
  expect(text()).not.toContain('Before the blip')
})

it('stays closed when the restored session has the console open at another revision', async () => {
  await openBoard()
  const second = await blip()
  // Meanwhile the console was republished and the session reopened it at revision 5.
  kernel.published = '5'
  kernel.page = { seq: kernel.page.seq + 1, state: { ...kernel.page.state, console: { ...kernel.page.state.console!, revision: '5' } } }
  await act(async () => second.restore())
  await settle()
  expect(dialogOpen()).toBe(false)
  expect(second.handles.every(handle => handle.disposed && handle.reads.length === 0)).toBe(true)
  // Revision 5's board opens only by hand.
  await click('Open Team board')
  expect(second.handles.at(-1)!.revision).toBe('5')
})

it('stays closed when the console is gone once the session is restored', async () => {
  await openBoard()
  const second = await blip()
  kernel.published = null
  await act(async () => second.restore())
  await settle()
  expect(dialogOpen()).toBe(false)
  expect(second.handles.every(handle => handle.disposed && handle.reads.length === 0)).toBe(true)
})

it('stays closed after the operator closes it during the gap', async () => {
  await openBoard()
  const second = await blip()
  await click('Close board')
  expect(dialogOpen()).toBe(false)
  await act(async () => second.restore())
  await settle()
  expect(dialogOpen()).toBe(false)
  expect(second.handles.every(handle => handle.disposed && handle.reads.length === 0)).toBe(true)
})

it('stays closed after the operator leaves the console during the gap, even on returning to the same revision', async () => {
  await openBoard()
  const second = await blip()
  // The leave is sent during the gap; the restored connection delivers it.
  kernel.page = { seq: kernel.page.seq + 1, state: applyOperateEvent(kernel.page.state, { type: 'showHome' }) }
  await act(async () => second.restore())
  await settle()
  expect(dialogOpen()).toBe(false)
  await click('Open Console A')
  expect(kernel.page.state.console?.revision).toBe('3')
  expect(dialogOpen()).toBe(false)
  expect(second.handles.every(handle => handle.reads.length === 0)).toBe(true)
})

it('never shows the earlier board during the gap, even when the dead connection answers late', async () => {
  await openBoard()
  // A refresh was in flight on the first connection when it broke.
  const before = first.handles.at(-1)!
  await act(async () => before.deliver!({ state: 'selected', changeSeq: 2, selectionEpoch: 2 }))
  await settle()
  const second = await blip()
  await act(async () => before.reads.at(-1)!(view('Late from the dead connection')))
  await settle()
  expect(text()).not.toContain('Late from the dead connection')
  expect(text()).not.toContain('Before the blip')
  // And after the restore, only the new connection's read shows anything.
  await act(async () => second.restore())
  await settle()
  expect(text()).not.toContain('Late from the dead connection')
  await showBoard(second, 'After the blip')
  expect(text()).toContain('After the blip')
})

// The provider now outlives a reconnect, so a subscribe that failed on the dead connection must not
// keep the page on its error once the replacement connection delivers the session.
it('drops a failed subscribe of the dead connection once the replacement delivers the session', async () => {
  const session = (first.api as { getOperateSession: () => { subscribe: unknown } }).getOperateSession()
  session.subscribe = async () => { throw new Error('socket closed') }
  await act(async () => root.render(<App />))
  await settle()
  expect(text()).toContain('Could not reach your operate session')
  const second = connect('second')
  kernel.current = second
  await act(async () => root.render(<App />))
  await act(async () => second.restore())
  await settle()
  expect(text()).not.toContain('Could not reach your operate session')
  expect(button('Open Console A')).toBeDefined()
})
