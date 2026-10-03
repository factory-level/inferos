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
}))

vi.mock('@cloudflare/kumo', async importOriginal => ({
  ...await importOriginal<typeof import('@cloudflare/kumo')>(),
  useKumoToastManager: () => ({ add: () => {} }),
}))
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: {} }) }))
vi.mock('../../ServerConfigContext', () => ({ useServerConfig: () => ({ canvasFeatures: { durableViews: true } }) }))
vi.mock('../../pages/inferops-canvas/useWorkspaceScreens', () => ({
  useWorkspaceScreens: () => ({ status: 'ready', workspaces: [
    { workspace: { id: 'ws1' }, screens: [{ id: 'board', title: 'Shift board' }], flows: [], consoles: [
      { id: 'c1', revision: '0', title: 'Operations lead', fullChat: 'available',
        views: [{ id: 'overview', title: 'Overview', type: 'rollup', screens: ['board'] }] },
    ] },
  ] }),
}))
vi.mock('../../pages/inferops-canvas/InferOpsCanvasHome', () => ({ InferOpsCanvasHome: () => <div data-testid="home" /> }))
vi.mock('./ConsoleMosaic', () => ({ ConsoleMosaic: () => <div data-testid="mosaic" /> }))
vi.mock('./ConsolePage', () => ({
  ConsolePage: ({ entry, presentation }: { entry?: { console: { title: string } }; presentation: string }) =>
    <div data-testid="console">{entry?.console.title}/{presentation}</div>,
}))
vi.mock('./OperateChatPanel', () => ({ OperateChatPanel: () => <div data-testid="chat" /> }))
vi.mock('./SessionApprovals', () => ({
  SessionApprovals: ({ screenWorkspaceId }: { screenWorkspaceId: string | null }) =>
    <div data-testid="approvals">{screenWorkspaceId}</div>,
}))
vi.mock('./useSessionWorkspace', () => ({ useSessionWorkspace: () => null }))
vi.mock('./SessionScreen', () => ({ SessionScreen: ({ screenId }: { screenId: string }) => <div data-testid="screen">{screenId}</div> }))
vi.mock('./FlowScreen', () => ({ FlowScreen: ({ screenId }: { screenId: string }) => <div data-testid="step">{screenId}</div> }))
vi.mock('./OperateSessionContext', () => ({
  useOperateSession: () => ({ snapshot: { seq: 3, state: testState.state }, recentEvents: testState.recentEvents,
    error: null, dispatch: testState.dispatch, session: null }),
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
  it('shows the working set as tabs and the focused screen', () => {
    render(OPEN)
    expect([...container.querySelectorAll('[role="tab"]')].map(tab => tab.textContent)).toEqual(['Shift board'])
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
    expect(container.querySelector('[data-testid="home"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="console"]')).toBeNull()
  })

  it('gives the page to the open console, found among the saved ones', () => {
    render({ ...OPEN, presentation: 'chat', console: {
      workspaceId: 'ws1', consoleId: 'c1', title: 'Operations lead', fullChat: 'available', viewId: 'overview', screenId: null,
    } })
    expect(container.querySelector('[data-testid="console"]')?.textContent).toBe('Operations lead/chat')
    expect(container.querySelector('[role="tablist"]')).toBeNull()
  })

  it('gives the whole page to a running flow, keeping the working set for afterwards', () => {
    render({ ...OPEN, flow: { workspaceId: 'ws1', flowId: 'f', title: 'Admission', steps: ['intake', 'triage'], index: 1 } })
    expect(container.querySelector('[role="tablist"]')).toBeNull()
    expect(container.querySelector('[data-testid="screen"]')).toBeNull()
    expect(container.querySelector('[data-testid="step"]')?.textContent).toBe('triage')
    expect(container.querySelector('h1')?.textContent).toBe('Step 2 of 2')

    const finish = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Finish')!
    act(() => finish.click())
    expect(dispatch).toHaveBeenCalledWith({ type: 'exitFlow' })
  })
})
