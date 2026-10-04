// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CanvasDefinition } from '@gadgets/workshop-shared/canvas'
import type { OperateConsole } from '@gadgets/workshop-shared/operate-console'
import type { OperateConsoleRun, OperateEvent } from '@gadgets/workshop-shared/operate-session'

vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: {} }) }))
vi.mock('../../useWorkspaceOpen', () => ({ useWorkspaceOpen: () => ({ overseer: { stub: CONSOLE_STUB }, error: null }) }))
vi.mock('../../hooks/useWorkspaceWorkpieces', () => ({ useWorkspaceWorkpieces: () => ({ workpieces: new Map() }) }))
const { CONSOLE_STUB } = vi.hoisted(() => ({ CONSOLE_STUB: { name: 'console' } }))
const canvasProps = vi.hoisted(() => ({ last: null as null | { overseer: unknown; resourceScope?: { overseer: unknown } } }))
vi.mock('../canvas/CanvasView', () => ({
  CanvasView: (props: { definition: CanvasDefinition; overseer: unknown; resourceScope?: { overseer: unknown }; onOpenWidget?: (widgetId: string) => void }) => {
    const { definition, onOpenWidget } = props
    canvasProps.last = props
    return <div data-testid="canvas">{definition.title}
      {definition.sections.flatMap(section => section.widgets).map(widget =>
        <button key={widget.id} type="button" disabled={!onOpenWidget} onClick={() => onOpenWidget?.(widget.id)}>Open {widget.id}</button>)}
    </div>
  },
}))
vi.mock('../canvas/CanvasBoardFullView', () => ({
  CanvasBoardFullView: ({ widget, viewTitle, overseer, onBack, openIssue }: {
    widget: { id: string }; viewTitle: string; overseer: { name?: string }; onBack: () => void
    openIssue: { issueId: string | null; onChange: (issueId: string | null) => void }
  }) =>
    <div data-testid="full" data-scope={overseer.name}>{widget.id}{openIssue.issueId && ` issue ${openIssue.issueId}`}
      <button type="button" onClick={onBack}>Back to {viewTitle}</button>
      <button type="button" onClick={() => openIssue.onChange('i1')}>Open issue</button>
      <button type="button" onClick={() => openIssue.onChange(null)}>Close issue</button>
    </div>,
}))
vi.mock('./BoardConnectPrompt', () => ({ BoardConnectPrompt: () => <div data-testid="connect" /> }))
vi.mock('./ConsoleRollup', () => ({ ConsoleRollup: () => <div data-testid="rollup" /> }))
vi.mock('./OperateChatPanel', () => ({
  OperateChatPanel: ({ layout = 'side' }: { layout?: string }) => <div data-testid="chat">{layout}</div>,
}))

import { ConsolePage } from './ConsolePage'
import type { SessionWorkspace } from './useSessionWorkspace'

const screen = (id: string, title: string): CanvasDefinition => ({ schemaVersion: 1, id, revision: '0', title, sections: [] })
const SAVED: OperateConsole = {
  id: 'c1', revision: '0', title: 'Operations lead', fullChat: 'available',
  views: [
    { id: 'overview', title: 'Overview', type: 'rollup', screens: ['s1'] },
    { id: 'board', title: 'Board', type: 'screen', screen: 's1' },
  ],
}
const entry = { workspace: { id: 'w1' } as never, console: SAVED, screens: [screen('s1', 'Board screen')] }
const run = (extra: Partial<OperateConsoleRun> = {}): OperateConsoleRun =>
  ({ workspaceId: 'w1', consoleId: 'c1', title: 'Operations lead', fullChat: 'available', viewId: 'overview', screenId: null, ...extra })

const SESSION: SessionWorkspace = { stub: { name: 'session' } as never, id: 'session-ws', restricted: false }
let container: HTMLDivElement
let root: Root
const onEvent = vi.fn<(event: OperateEvent) => void>()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  onEvent.mockClear()
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

const render = (props: Partial<Parameters<typeof ConsolePage>[0]> = {}) => act(() => root.render(
  <ConsolePage run={run()} entry={entry} loading={false} board={null} sessionWorkspace={SESSION} onEvent={onEvent} {...props} />))
const back = () => [...container.querySelectorAll('button')].find(b => b.textContent?.startsWith('Back to'))

it('shows a rollup view with no Back at the view itself', () => {
  render()
  expect(container.querySelector('[data-testid="rollup"]')).not.toBeNull()
  expect(back()).toBeUndefined()
})

it('draws a screen opened from the rollup, and goes back to the view', () => {
  render({ run: run({ screenId: 's1' }) })
  expect(back()?.textContent).toBe('Back to Overview')
  expect(container.querySelector('[data-testid="canvas"]')?.textContent).toBe('Board screen')
  act(() => back()!.click())
  expect(onEvent).toHaveBeenCalledWith({ type: 'showScreen', screenId: null })
})

it('draws a screen view directly', () => {
  render({ run: run({ viewId: 'board' }) })
  expect(container.querySelector('[data-testid="canvas"]')?.textContent).toBe('Board screen')
})

it('says when the console or the view is gone', () => {
  render({ entry: undefined })
  expect(container.textContent).toContain('This console is unavailable.')
  render({ run: run({ viewId: 'removed' }) })
  expect(container.textContent).toContain('This view is no longer part of the console.')
})

const boardScreen = { schemaVersion: 1, id: 's1', revision: '0', title: 'Board screen', sections: [{
  id: 'main', title: 'Main', columns: 2, widgets: [{
    id: 'kanban', kind: 'inferops.project-board', targetRef: 'inferops://demo.local/project/board/DEMO', size: 'wide', params: {},
  }],
}] } as unknown as CanvasDefinition
const button = (label: string) => [...container.querySelectorAll('button')].find(b => b.textContent === label)

const DEMO = 'inferops://demo.local/project/board/DEMO'
const withBoard = { ...entry, screens: [boardScreen] }
const useEntry = { ...withBoard, workspace: { id: 'w1', role: 'use' } as never }

it('opens a board card as the session board, through the console workspace for a builder', () => {
  render({ run: run({ viewId: 'board' }), entry: withBoard })
  expect(canvasProps.last?.resourceScope).toBeUndefined()
  act(() => button('Open kanban')!.click())
  expect(onEvent).toHaveBeenCalledWith({ type: 'openBoard', board: { workspaceId: 'w1', boardRef: DEMO } })

  render({ run: run({ viewId: 'board' }), entry: withBoard, board: { workspaceId: 'w1', boardRef: DEMO, issueId: null } })
  const full = container.querySelector('[data-testid="full"]')
  expect(full?.textContent).toContain('kanban')
  expect(full?.getAttribute('data-scope')).toBe('console')
  expect(container.querySelector('nav[aria-label="Breadcrumb"]')?.textContent).toContain('Board DEMO')
  act(() => button('Back to Board')!.click())
  expect(onEvent).toHaveBeenLastCalledWith({ type: 'closeBoard' })
})

it('reads a use-role operator\'s boards through their own session workspace, never the console owner\'s', () => {
  render({ run: run({ viewId: 'board' }), entry: useEntry })
  expect(container.querySelector('[data-testid="canvas"]')?.textContent).toContain('Board screen')
  expect(canvasProps.last?.overseer).toBe(CONSOLE_STUB)
  expect(canvasProps.last?.resourceScope?.overseer).toBe(SESSION.stub)
  act(() => button('Open kanban')!.click())
  expect(onEvent).toHaveBeenCalledWith({ type: 'openBoard', board: { workspaceId: 'session-ws', boardRef: DEMO } })

  render({ run: run({ viewId: 'board' }), entry: useEntry, board: { workspaceId: 'session-ws', boardRef: DEMO, issueId: null } })
  expect(container.querySelector('[data-testid="full"]')?.getAttribute('data-scope')).toBe('session')
  // A board named through the console workspace is never read for them.
  render({ run: run({ viewId: 'board' }), entry: useEntry, board: { workspaceId: 'w1', boardRef: DEMO, issueId: null } })
  expect(container.querySelector('[data-testid="full"]')).toBeNull()
  expect(container.textContent).toContain("This board can't be shown here")
  act(() => button('Back to Board')!.click())
  expect(onEvent).toHaveBeenLastCalledWith({ type: 'closeBoard' })
})

it('drives the issue over the board from session state: open, reload, Back', () => {
  render({ run: run({ viewId: 'board' }), entry: withBoard, board: { workspaceId: 'w1', boardRef: DEMO, issueId: null } })
  act(() => button('Open issue')!.click())
  expect(onEvent).toHaveBeenLastCalledWith({ type: 'openIssue', issueId: 'i1' })
  // What the session holds is what shows, as after a reload or from another tab.
  render({ run: run({ viewId: 'board' }), entry: withBoard, board: { workspaceId: 'w1', boardRef: DEMO, issueId: 'i1' } })
  expect(container.querySelector('[data-testid="full"]')?.textContent).toContain('issue i1')
  act(() => button('Close issue')!.click())
  expect(onEvent).toHaveBeenLastCalledWith({ type: 'closeIssue' })
  onEvent.mockClear()
  render({ run: run({ viewId: 'board' }), entry: withBoard, board: { workspaceId: 'w1', boardRef: DEMO, issueId: null } })
  act(() => button('Close issue')!.click())
  expect(onEvent).not.toHaveBeenCalled()
})

it('moves focus to the page when a board opens or closes', () => {
  render({ run: run({ viewId: 'board' }), entry: withBoard })
  render({ run: run({ viewId: 'board' }), entry: withBoard, board: { workspaceId: 'w1', boardRef: DEMO, issueId: null } })
  expect(document.activeElement?.tagName).toBe('MAIN')
  ;(document.activeElement as HTMLElement).blur()
  render({ run: run({ viewId: 'board' }), entry: withBoard })
  expect(document.activeElement?.tagName).toBe('MAIN')
})
