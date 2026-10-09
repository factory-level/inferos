// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  INITIAL_OPERATE_PAGE,
  type OperateEvent,
  type OperateEventRecord,
  type OperatePageState,
} from '@gadgets/workshop-shared/operate-session'

const testState = vi.hoisted(() => ({
  state: null as unknown,
  dispatch: null as unknown,
  recentEvents: [] as OperateEventRecord[],
  search: {} as { setup?: string; tools?: boolean; settings?: string; workspace?: string },
  navigate: vi.fn<(options: unknown) => void>(),
  hostBoards: false,
}))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => testState.navigate, useSearch: () => testState.search }))
vi.mock('./ConsoleWorkspaceShell', () => ({ ConsoleWorkspaceShell: ({ children }: { children: import('react').ReactNode }) => children }))
vi.mock('./ConsoleBuilder', () => ({ ConsoleBuilder: () => <div data-testid="builder" /> }))
vi.mock('./ConsoleSettings', () => ({ ConsoleSettings: () => <div data-testid="settings" /> }))

vi.mock('@cloudflare/kumo', async importOriginal => ({
  ...await importOriginal<typeof import('@cloudflare/kumo')>(),
  useKumoToastManager: () => ({ add: () => {} }),
}))
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: {} }) }))
vi.mock('../../ServerConfigContext', () => ({ useServerConfig: () => ({ canvasFeatures: { durableViews: true }, hostBoards: testState.hostBoards }) }))
vi.mock('../../pages/inferops-canvas/useWorkspaceScreens', () => ({
  canBuild: (entry: { workspace: { role?: string } }) => entry.workspace.role !== 'use',
  invalidateWorkspaceScreens: () => {},
  useWorkspaceScreens: () => ({ status: 'ready', workspaces: [
    { workspace: { id: 'ws1' }, screens: [{ id: 'board', title: 'Shift board' }], flows: [], publishedScreens: {}, consoles: [
      { id: 'c1', revision: '0', title: 'Operations lead', fullChat: 'available',
        views: [{ id: 'overview', title: 'Overview', type: 'rollup', screens: ['board'] }],
        hostBoards: [{ kind: 'host-board', id: 'hb1', label: 'Team board',
          requirement: { name: 'board-1', resource: 'inferops-board', target: 'inferops://acme.ops/project/board/ENG' } }] },
    ] },
  ] }),
}))
vi.mock('../../pages/inferops-canvas/InferOpsCanvasHome', () => ({ InferOpsCanvasHome: () => <div data-testid="home" /> }))
vi.mock('./ConsoleMosaic', () => ({ ConsoleMosaic: () => <div data-testid="mosaic" /> }))
vi.mock('./ConsolePage', () => ({
  ConsolePage: ({ entry, presentation }: { entry?: { console: { title: string } }; presentation: string }) =>
    <div data-testid="console">{entry?.console.title}/{presentation}</div>,
}))
vi.mock('./OperateChatPanel', () => ({ OperateChatPanel: ({ layout, consoleActions }: { layout: string; consoleActions?: { onOpenHostBoard?: (entryId: string) => void } }) =>
  <div data-testid="chat" data-layout={layout}><input aria-label="Chat draft" />
    {consoleActions?.onOpenHostBoard && <button type="button" onClick={() => consoleActions.onOpenHostBoard!('hb1')}>Open Team board</button>}</div> }))
vi.mock('./ConsoleHostBoard', () => ({
  ConsoleHostBoard: ({ entry, console: ref }: { entry: { id: string; label: string }; console: { consoleId: string; source: string; revision: string } }) =>
    <div data-testid="host-board">{entry.label} {ref.consoleId}/{ref.source}/{ref.revision}</div>,
}))
vi.mock('./SessionApprovals', () => ({
  SessionApprovals: ({ screenWorkspaceId }: { screenWorkspaceId: string | null }) =>
    <div data-testid="approvals">{screenWorkspaceId}</div>,
}))
vi.mock('./useSessionWorkspace', () => ({ useSessionWorkspace: () => null }))
vi.mock('./SessionScreen', () => ({ SessionScreen: ({ screenId }: { screenId: string }) => <div data-testid="screen">{screenId}</div> }))
vi.mock('./FlowScreen', () => ({ FlowScreen: ({ screenId }: { screenId: string }) => <div data-testid="step">{screenId}</div> }))
vi.mock('./OperateSessionContext', () => ({
  useOperateSession: () => ({ snapshot: { seq: 3, state: testState.state }, recentEvents: testState.recentEvents,
    error: null, dispatch: testState.dispatch, session: { stub: {} } }),
}))

import { OperateSessionPage } from './OperateSessionPage'

const BOARD = { type: 'screen', workspaceId: 'ws1', screenId: 'board' } as const
const OPEN: OperatePageState = { ...INITIAL_OPERATE_PAGE, workingSet: [BOARD], focus: BOARD, chatOpen: false }

let container: HTMLDivElement
let root: Root
const dispatch = vi.fn<(event: OperateEvent) => Promise<void>>(async () => {})

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  dispatch.mockClear()
  testState.dispatch = dispatch
  testState.recentEvents = []
  testState.search = {}
  testState.hostBoards = false
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const render = (state: OperatePageState) => {
  testState.state = state
  act(() => root.render(<OperateSessionPage />))
}

describe('OperateSessionPage', () => {
  it('shows the focused screen', () => {
    render(OPEN)
    expect(container.querySelector('[data-testid="screen"]')?.textContent).toBe('board')
  })

  it('covers the focused screen’s workspace with the session’s approvals', () => {
    render(OPEN)
    expect(container.querySelector('[data-testid="approvals"]')?.textContent).toBe('ws1')
  })

  it('attributes the page change the operate agent made last', () => {
    testState.recentEvents = [
      { seq: 1, event: { type: 'open', ref: BOARD }, actor: 'agent', at: new Date() },
      { seq: 2, event: { type: 'setChatOpen', open: false }, actor: 'person', at: new Date() },
    ]
    render(OPEN)
    const notes = [...container.querySelectorAll('[role="status"]')].map(note => note.textContent)
    expect(notes.some(note => note?.startsWith('Agent opened Shift board'))).toBe(true)
  })

  it('attributes nothing to the agent when a person made every change', () => {
    testState.recentEvents = [{ seq: 1, event: { type: 'open', ref: BOARD }, actor: 'person', at: new Date() }]
    render(OPEN)
    expect(container.textContent).not.toContain('Agent ')
  })

  it('opens on the console mosaic when nothing is open', () => {
    render({ ...INITIAL_OPERATE_PAGE })
    expect(container.querySelector('[data-testid="mosaic"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="home"]')).toBeNull()
    expect(container.querySelector('[data-testid="chat"]')?.getAttribute('data-layout')).toBe('home')
    expect(container.querySelector('[data-testid="console"]')).toBeNull()
  })

  it('gives the page to the open console, found among the saved ones', () => {
    render({ ...OPEN, presentation: 'chat', console: {
      workspaceId: 'ws1', consoleId: 'c1', title: 'Operations lead', source: 'draft', revision: '0', fullChat: 'available', viewId: 'overview', screenId: null,
    } })
    expect(container.querySelector('[data-testid="chat"]')?.getAttribute('data-layout')).toBe('full')
    expect(container.querySelector('[role="tablist"]')).toBeNull()
  })

  it('gives the whole page to a running flow, keeping the working set for afterwards', () => {
    render({ ...OPEN, flow: { workspaceId: 'ws1', flowId: 'f', title: 'Admission', steps: ['intake', 'triage'], index: 1 } })
    expect(container.querySelector('[role="tablist"]')).toBeNull()
    expect(container.querySelector('[data-testid="screen"]')).toBeNull()
    expect(container.querySelector('[data-testid="step"]')?.textContent).toBe('triage')
    expect(container.textContent).toContain('Step 2 of 2')

    const finish = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Finish')!
    act(() => finish.click())
    expect(dispatch).toHaveBeenCalledWith({ type: 'exitFlow' })
  })
})

it('keeps one conversation mounted as home changes to a console, a screen, and setup', () => {
  render(INITIAL_OPERATE_PAGE)
  const chat = container.querySelector('[data-testid="chat"]')
  const draft = container.querySelector<HTMLInputElement>('input')!
  draft.value = 'Keep this draft'
  const consoleState: OperatePageState = { ...INITIAL_OPERATE_PAGE, presentation: 'chat', console: {
    workspaceId: 'ws1', consoleId: 'c1', title: 'Operations lead', source: 'draft', revision: '0', fullChat: 'default', viewId: 'overview', screenId: null,
  } }
  render(consoleState)
  expect(container.querySelector('[data-testid="chat"]')).toBe(chat)
  expect(chat?.getAttribute('data-layout')).toBe('full')
  render({ ...consoleState, presentation: 'canvas' })
  expect(chat?.getAttribute('data-layout')).toBe('side')
  testState.search = { setup: 'new' }
  render(consoleState)
  expect(chat?.getAttribute('data-layout')).toBe('hidden')
  expect(container.querySelector('[data-testid="builder"]')).not.toBeNull()
  testState.search = {}
  render(INITIAL_OPERATE_PAGE)
  expect(container.querySelector('input')).toBe(draft)
  expect(draft.value).toBe('Keep this draft')
})

const openBoard = () => [...container.querySelectorAll('button')].find(b => b.textContent === 'Open Team board')

describe('host boards', () => {
  const RUN = { workspaceId: 'ws1', consoleId: 'c1', title: 'Operations lead', source: 'draft' as const, revision: '0',
    fullChat: 'available' as const, viewId: 'overview', screenId: null }

  it('offers no host board while host boards are off', () => {
    render({ ...INITIAL_OPERATE_PAGE, presentation: 'canvas', chatOpen: true, console: RUN })
    expect(openBoard()).toBeUndefined()
    expect(container.querySelector('[data-testid="host-board"]')).toBeNull()
  })

  it('offers no host board on a console that shows only Assistant', () => {
    testState.hostBoards = true
    render({ ...INITIAL_OPERATE_PAGE, presentation: 'canvas', chatOpen: true, console: { ...RUN, fullChat: 'only' } })
    expect(openBoard()).toBeUndefined()
    expect(container.querySelector('[data-testid="host-board"]')).toBeNull()
  })

  it.each([
    ['the console is left', { ...INITIAL_OPERATE_PAGE }, {}],
    ['settings open', null, { settings: 'c1', workspace: 'ws1' }],
    ['the tools open', null, { tools: true }],
  ] as const)('keeps a board closed after %s and the same revision is shown again', (_, away, search) => {
    testState.hostBoards = true
    const open = { ...INITIAL_OPERATE_PAGE, presentation: 'canvas' as const, chatOpen: true, console: RUN }
    render(open)
    act(() => openBoard()!.click())
    expect(container.querySelector('[data-testid="host-board"]')).not.toBeNull()
    testState.search = search
    render(away ?? open)
    testState.search = {}
    render(open)
    expect(container.querySelector('[data-testid="host-board"]')).toBeNull()
  })

  it('opens a host board for the console revision the session has open, and closes it when that revision changes', () => {
    testState.hostBoards = true
    render({ ...INITIAL_OPERATE_PAGE, presentation: 'canvas', chatOpen: true, console: RUN })
    act(() => openBoard()!.click())
    expect(container.querySelector('[data-testid="host-board"]')?.textContent).toBe('Team board c1/draft/0')
    // Opening a board is local to this tab: nothing about it enters the shared session state.
    expect(dispatch).not.toHaveBeenCalled()
    render({ ...INITIAL_OPERATE_PAGE, presentation: 'canvas', chatOpen: true, console: { ...RUN, revision: '1' } })
    expect(container.querySelector('[data-testid="host-board"]')).toBeNull()
  })
})
