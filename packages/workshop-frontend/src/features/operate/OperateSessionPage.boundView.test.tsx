// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INITIAL_OPERATE_PAGE, type OperatePageState } from '@gadgets/workshop-shared/operate-session'

// The page with every region mocked to a marker, so the test sees exactly what is mounted while a
// bound view is shown: co-residence unmounts the whole main content region and the modal widget.
const testState = vi.hoisted(() => ({
  state: null as unknown,
  search: {} as Record<string, unknown>,
  config: { hostBoards: true, boundViews: true } as { hostBoards?: boolean; boundViews?: boolean },
}))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => () => {}, useSearch: () => testState.search }))
vi.mock('./ConsoleWorkspaceShell', () => ({ ConsoleWorkspaceShell: ({ children }: { children: import('react').ReactNode }) => children }))
vi.mock('@cloudflare/kumo', async importOriginal => ({
  ...await importOriginal<typeof import('@cloudflare/kumo')>(),
  useKumoToastManager: () => ({ add: () => {} }),
}))
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: {} }) }))
vi.mock('../../ServerConfigContext', () => ({ useServerConfig: () => ({ canvasFeatures: { durableViews: true }, ...testState.config }) }))
vi.mock('../../pages/inferops-canvas/useWorkspaceScreens', () => ({
  canBuild: () => true,
  invalidateWorkspaceScreens: () => {},
  recheckWorkspaceScreens: () => {},
  useWorkspaceScreens: () => ({ status: 'ready', workspaces: [
    { workspace: { id: 'ws1' }, screens: [{ id: 'board', title: 'Shift board', sections: [] }], flows: [], publishedScreens: {}, consoles: [
      { id: 'c1', revision: '0', title: 'Operations lead', fullChat: 'available',
        views: [{ id: 'overview', title: 'Overview', type: 'rollup', screens: ['board'] }],
        hostBoards: [{ kind: 'host-board', id: 'hb1', label: 'Team board',
          requirement: { name: 'board-1', resource: 'inferops-board', target: 'inferops://acme.ops/project/board/ENG' } }],
        boundViews: [{ kind: 'bound-view', id: 'bv1', label: 'Triage view', gadgetId: 7, blueprintId: 'bp', version: 1, requirements: ['board-1'] }] },
    ] },
  ] }),
}))
vi.mock('../../pages/inferops-canvas/InferOpsCanvasHome', () => ({ InferOpsCanvasHome: () => <div data-testid="tools" /> }))
vi.mock('./ConsoleMosaic', () => ({ ConsoleMosaic: () => <div data-testid="mosaic" /> }))
vi.mock('./ConsolePage', () => ({ ConsolePage: () => <div data-testid="console-page" /> }))
vi.mock('./FlowPage', () => ({ FlowPage: () => <div data-testid="flow-page" /> }))
vi.mock('./SessionScreen', () => ({ SessionScreen: () => <div data-testid="session-screen" /> }))
vi.mock('./ConsoleWidgetView', () => ({
  ConsoleWidgetView: ({ target }: { target: { presentation: string } }) => <div data-testid={`widget-${target.presentation}`} />,
}))
vi.mock('./OperateChatPanel', () => ({
  OperateChatPanel: ({ consoleActions }: { consoleActions?: {
    onOpenWidget: (target: unknown) => void; onOpenHostBoard?: (entryId: string) => void; onOpenBoundView?: (entryId: string) => void
  } }) => <div data-testid="chat">
    {consoleActions && <button type="button" onClick={() => consoleActions.onOpenWidget({ consoleId: 'c1', screenId: 'board', widgetId: 'w1', presentation: 'modal' })}>Open widget modal</button>}
    {consoleActions?.onOpenHostBoard && <button type="button" onClick={() => consoleActions.onOpenHostBoard!('hb1')}>Open Team board</button>}
    {consoleActions?.onOpenBoundView && <button type="button" onClick={() => consoleActions.onOpenBoundView!('bv1')}>Open Triage view</button>}
  </div>,
}))
vi.mock('./ConsoleHostBoard', () => ({ ConsoleHostBoard: () => <div data-testid="host-board" /> }))
vi.mock('./ConsoleBoundView', () => ({
  ConsoleBoundView: ({ entry, console: ref, hostBoards, onClose }: { entry: { id: string; label: string }; console: { consoleId: string; source: string; revision: string };
    hostBoards: { id?: string }[]; onClose: () => void }) =>
    <div data-testid="bound-view">{entry.label} {ref.consoleId}/{ref.source}/{ref.revision} {hostBoards.map(board => board.id).join(',')}
      <button type="button" onClick={onClose}>Close view</button></div>,
}))
vi.mock('./SessionApprovals', () => ({ SessionApprovals: () => null }))
vi.mock('./HandoverInbox', () => ({ HandoverInbox: () => null }))
vi.mock('./useSessionWorkspace', () => ({ useSessionWorkspace: () => null }))
vi.mock('./OperateSessionContext', () => ({
  useOperateSession: () => ({ snapshot: { seq: 3, state: testState.state }, recentEvents: [], error: null,
    dispatch: async () => {}, session: { stub: {} } }),
}))

import { OperateSessionPage } from './OperateSessionPage'

const RUN = { workspaceId: 'ws1', consoleId: 'c1', title: 'Operations lead', source: 'draft' as const, revision: '0',
  fullChat: 'available' as const, viewId: 'overview', screenId: 'board' }
const OPEN: OperatePageState = { ...INITIAL_OPERATE_PAGE, presentation: 'canvas', chatOpen: true, console: RUN }

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  testState.search = {}
  testState.config = { hostBoards: true, boundViews: true }
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
const click = async (label: string) => {
  const button = [...container.querySelectorAll('button')].find(item => item.textContent === label)
  if (!button) throw new Error(`no button ${label}`)
  await act(async () => button.click())
}
const shown = (id: string) => container.querySelector(`[data-testid="${id}"]`) !== null
const openButton = () => [...container.querySelectorAll('button')].some(item => item.textContent === 'Open Triage view')

describe('bound views on the operate page', () => {
  it('opens a bound view of the open console revision, with that revision\'s host boards', async () => {
    render(OPEN)
    await click('Open Triage view')
    expect(container.querySelector('[data-testid="bound-view"]')?.textContent).toContain('Triage view c1/draft/0 hb1')
  })

  it('unmounts the whole main region and the modal widget while a view is shown, and restores them after', async () => {
    render(OPEN)
    await click('Open widget modal')
    expect(shown('console-page')).toBe(true)
    expect(shown('widget-modal')).toBe(true)
    await click('Open Triage view')
    expect(shown('bound-view')).toBe(true)
    for (const region of ['console-page', 'widget-modal', 'widget-page', 'flow-page', 'session-screen', 'mosaic', 'host-board']) {
      expect(shown(region)).toBe(false)
    }
    expect(container.textContent).toContain('A view is open')
    // The chat stays: its own frames (the connection-accept flow) are the frame gate's to block.
    expect(shown('chat')).toBe(true)
    await click('Close view')
    expect(shown('bound-view')).toBe(false)
    expect(shown('console-page')).toBe(true)
  })

  it('unmounts a running flow too', async () => {
    render({ ...OPEN, flow: { workspaceId: 'ws1', flowId: 'f', title: 'Admission', steps: ['intake'], index: 0 } })
    expect(shown('flow-page')).toBe(true)
    await click('Open Triage view')
    expect(shown('bound-view')).toBe(true)
    expect(shown('flow-page')).toBe(false)
  })

  it('closes a host board when a view opens, so only one shows', async () => {
    render(OPEN)
    await click('Open Team board')
    expect(shown('host-board')).toBe(true)
    await click('Open Triage view')
    expect(shown('host-board')).toBe(false)
    expect(shown('bound-view')).toBe(true)
  })

  it('closes the view when the session moves to another revision', async () => {
    render(OPEN)
    await click('Open Triage view')
    render({ ...OPEN, console: { ...RUN, revision: '1' } })
    expect(shown('bound-view')).toBe(false)
  })

  it('offers and shows nothing on a console that shows only Assistant', async () => {
    render({ ...OPEN, console: { ...RUN, fullChat: 'only' } })
    expect(openButton()).toBe(false)
    expect(shown('bound-view')).toBe(false)
  })

  it.each([
    ['bound views are off', { hostBoards: true, boundViews: false }],
    ['host boards are off', { hostBoards: false, boundViews: true }],
    ['the server reports neither', {}],
  ])('offers and shows nothing while %s', (_, config) => {
    testState.config = config
    render(OPEN)
    expect(openButton()).toBe(false)
    expect(shown('bound-view')).toBe(false)
    expect(shown('console-page')).toBe(true)
  })
})
