// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CanvasDefinition } from '@gadgets/workshop-shared/canvas'
import type { OperateConsole } from '@gadgets/workshop-shared/operate-console'
import type { OperateConsoleRun, OperateEvent } from '@gadgets/workshop-shared/operate-session'

vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: {} }) }))
vi.mock('../../useWorkspaceOpen', () => ({ useWorkspaceOpen: () => ({ overseer: { stub: {} }, error: null }) }))
vi.mock('../../hooks/useWorkspaceWorkpieces', () => ({ useWorkspaceWorkpieces: () => ({ workpieces: new Map() }) }))
vi.mock('../canvas/CanvasView', () => ({
  CanvasView: ({ definition, onOpenWidget }: { definition: CanvasDefinition; onOpenWidget?: (widgetId: string) => void }) =>
    <div data-testid="canvas">{definition.title}
      {definition.sections.flatMap(section => section.widgets).map(widget =>
        <button key={widget.id} type="button" disabled={!onOpenWidget} onClick={() => onOpenWidget?.(widget.id)}>Open {widget.id}</button>)}
    </div>,
}))
vi.mock('../canvas/CanvasBoardFullView', () => ({
  CanvasBoardFullView: ({ widget, viewTitle, onBack }: { widget: { id: string }; viewTitle: string; onBack: () => void }) =>
    <div data-testid="full">{widget.id}<button type="button" onClick={onBack}>Back to {viewTitle}</button></div>,
}))
vi.mock('./ConsoleRollup', () => ({ ConsoleRollup: () => <div data-testid="rollup" /> }))
vi.mock('./OperateChatPanel', () => ({
  OperateChatPanel: ({ layout = 'side' }: { layout?: string }) => <div data-testid="chat">{layout}</div>,
}))

import { ConsolePage } from './ConsolePage'

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
  <ConsolePage run={run()} entry={entry} loading={false} onEvent={onEvent} {...props} />))
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

it('opens a board card in its full view in place, and back to the screen', () => {
  const withBoard = { ...entry, screens: [boardScreen] }
  render({ run: run({ viewId: 'board' }), entry: withBoard })
  act(() => button('Open kanban')!.click())
  expect(container.querySelector('[data-testid="full"]')?.textContent).toContain('kanban')
  expect(container.querySelector('[data-testid="canvas"]')).toBeNull()
  act(() => button('Back to Board screen')!.click())
  expect(container.querySelector('[data-testid="canvas"]')).not.toBeNull()
})

it('closes the full view when the screen changes', () => {
  const withBoard = { ...entry, screens: [boardScreen, screen('s2', 'Other')] }
  render({ run: run({ screenId: 's1' }), entry: withBoard })
  act(() => button('Open kanban')!.click())
  expect(container.querySelector('[data-testid="full"]')).not.toBeNull()
  render({ run: run({ screenId: null }), entry: withBoard })
  render({ run: run({ screenId: 's1' }), entry: withBoard })
  expect(container.querySelector('[data-testid="full"]')).toBeNull()
})

it('says a use-role console cannot show its screens yet', () => {
  render({ entry: { ...entry, workspace: { id: 'w1', role: 'use' } as never, screens: [] } })
  expect(container.textContent).toContain("can't be shown without build access")
})
