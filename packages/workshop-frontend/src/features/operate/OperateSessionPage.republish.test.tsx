// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// The page with the real session provider and console listing over a fake kernel: a console
// republished or refused elsewhere must close this tab's host-board dialog at once and reload the
// listing, so the console reopens at its new revision.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { OperateSessionUpdate } from '@gadgets/workshop-shared/api'
import type { OperateConsole } from '@gadgets/workshop-shared/operate-console'
import { applyOperateEvent, INITIAL_OPERATE_PAGE, type OperateEvent, type OperateSessionSnapshot } from '@gadgets/workshop-shared/operate-session'

const kernel = vi.hoisted(() => ({
  page: null as unknown as OperateSessionSnapshot,
  subscriber: null as ((update: OperateSessionUpdate) => void) | null,
  published: '3',
  listings: 0,
  dispatched: [] as OperateEvent[],
}))

const consoleAt = (revision: string): OperateConsole => {
  const content = { title: 'Console A', fullChat: 'available' as const,
    views: [{ id: 'overview', title: 'Overview', type: 'screen' as const, screen: 'board' }],
    hostBoards: [{ kind: 'host-board' as const, id: 'hb1', label: 'Team board',
      requirement: { name: 'board-1', resource: 'inferops-board' as const, target: 'inferops://acme.ops/project/board/ENG' } }] }
  return { ...content, id: 'c1', revision, published: { revision, publishedAt: '2026-10-09T00:00:00.000Z', content } }
}

const authenticatedApi = vi.hoisted(() => ({
  getOperateSession: () => ({
    subscribe: async (subscriber: (update: OperateSessionUpdate) => void) => {
      kernel.subscriber = subscriber
      subscriber(kernel.page)
      return { [Symbol.dispose]: () => {} }
    },
    listEvents: async () => [],
    dispatch: async (event: OperateEvent, seq: number) => {
      kernel.dispatched.push(event)
      if (seq !== kernel.page.seq) throw new Error('conflict')
      kernel.page = { seq: seq + 1, state: applyOperateEvent(kernel.page.state, event) }
      kernel.subscriber?.(kernel.page)
      return kernel.page
    },
    [Symbol.dispose]: () => {},
  }),
  listGadgets: async () => [{ id: 'ws1', role: 'use', title: 'Ops', lastActive: '2026-10-09T00:00:00.000Z' }],
  // An operator's listing: the console as published now, and the screen it shows.
  openGadget: () => ({
    listConsoles: async () => { kernel.listings++; return [consoleAt(kernel.published)] },
    listCanvases: async () => [{ schemaVersion: 1, id: 'board', title: 'Board', revision: '0', sections: [] }],
    getConsoleScreen: async () => ({ schemaVersion: 1, id: 'board', title: 'Board', revision: '0', sections: [] }),
    [Symbol.dispose]: () => {},
  }),
}))

vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi }) }))
vi.mock('../../ServerConfigContext', () => ({ useServerConfig: () => ({ canvasFeatures: { durableViews: true }, hostBoards: true }) }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => () => {}, useSearch: () => ({}) }))
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
vi.mock('./ConsoleHostBoard', () => ({
  ConsoleHostBoard: ({ console: ref, onRefused, onStaleOrUnavailable }: { console: { revision: string }; onRefused?: () => void; onStaleOrUnavailable?: () => void }) =>
    <div data-testid="host-board">Team board at {ref.revision}<button type="button" onClick={() => onRefused?.()}>Refuse</button>
      <button type="button" onClick={() => onStaleOrUnavailable?.()}>Answer stale</button></div>,
}))

import { OperateSessionProvider } from './OperateSessionContext'
import { OperateSessionPage } from './OperateSessionPage'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  kernel.page = { seq: 0, state: INITIAL_OPERATE_PAGE }
  kernel.subscriber = null
  kernel.published = '3'
  kernel.listings = 0
  kernel.dispatched = []
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

const settle = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() })
const button = (label: string) => [...container.querySelectorAll('button')].find(item => item.textContent === label)
const dialog = () => container.querySelector('[data-testid="host-board"]')?.textContent ?? null
const click = async (label: string) => {
  const found = button(label)
  if (!found) throw new Error(`No ${label} button`)
  await act(async () => found.click())
  await settle()
}

/** Console A opened at revision 3, with its host board's dialog showing. */
const openBoardAtThree = async () => {
  await act(async () => root.render(<OperateSessionProvider><OperateSessionPage /></OperateSessionProvider>))
  await settle()
  await click('Open Console A')
  expect(kernel.page.state.console?.revision).toBe('3')
  await click('Open Team board')
  expect(dialog()).toContain('Team board at 3')
}

it('closes the dialog at once when another session republishes the console, reloads the list, and reopens at the new revision', async () => {
  await openBoardAtThree()
  const listed = kernel.listings

  // The builder republishes from another browser; the kernel tells this session, changing nothing.
  kernel.published = '5'
  await act(async () => kernel.subscriber!({ ...kernel.page,
    consoleRevision: { workspaceId: 'ws1', consoleId: 'c1', revision: '5' } }))
  expect(dialog()).toBeNull()
  await settle()
  expect(kernel.listings).toBeGreaterThan(listed)
  // The superseded revision offers no board, so nothing can reopen the old one.
  expect(button('Open Team board')).toBeUndefined()

  // Back on All consoles, opening Console A now opens revision 5, whose board opens again.
  await act(async () => kernel.subscriber!(kernel.page = { seq: kernel.page.seq + 1,
    state: applyOperateEvent(kernel.page.state, { type: 'showHome' }) }))
  await click('Open Console A')
  expect(kernel.dispatched.at(-1)).toMatchObject({ type: 'openConsole', revision: '5' })
  await click('Open Team board')
  expect(dialog()).toContain('Team board at 5')
})

it('ignores a notice about a revision the session no longer has open', async () => {
  await openBoardAtThree()
  await act(async () => kernel.subscriber!({ ...kernel.page,
    consoleRevision: { workspaceId: 'ws1', consoleId: 'other', revision: '9' } }))
  expect(dialog()).toContain('Team board at 3')
})

it('closes the dialog and reloads the list when the kernel refuses the board for that revision', async () => {
  await openBoardAtThree()
  const listed = kernel.listings
  kernel.published = '5'
  await click('Refuse')
  expect(dialog()).toBeNull()
  expect(kernel.listings).toBeGreaterThan(listed)
})

// The lost-notice gap: no notice arrives, but a `stale` or `unavailable` answer makes the page
// re-read its consoles, and the dialog closes only if that list shows the revision moved on.
it('re-reads the list on a stale or unavailable answer, closing the dialog only once the revision has moved', async () => {
  await openBoardAtThree()
  let listed = kernel.listings
  await click('Answer stale')
  expect(kernel.listings).toBeGreaterThan(listed)
  expect(dialog()).toContain('Team board at 3')

  kernel.published = '5'
  listed = kernel.listings
  await click('Answer stale')
  expect(kernel.listings).toBeGreaterThan(listed)
  expect(dialog()).toBeNull()
  await act(async () => kernel.subscriber!(kernel.page = { seq: kernel.page.seq + 1,
    state: applyOperateEvent(kernel.page.state, { type: 'showHome' }) }))
  await click('Open Console A')
  expect(kernel.dispatched.at(-1)).toMatchObject({ type: 'openConsole', revision: '5' })
})
