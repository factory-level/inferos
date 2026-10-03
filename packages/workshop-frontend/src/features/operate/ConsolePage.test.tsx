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
  CanvasView: ({ definition }: { definition: CanvasDefinition }) => <div data-testid="canvas">{definition.title}</div>,
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
  <ConsolePage run={run()} entry={entry} loading={false} presentation="canvas" chatOpen sessionWorkspace={null}
    approvals={null} onEvent={onEvent} {...props} />))
const crumbs = () => [...container.querySelectorAll('nav[aria-label="Breadcrumb"] li')].map(li => li.textContent).filter(Boolean)
const back = () => [...container.querySelectorAll('button')].find(b => b.textContent === 'Back')

it('shows a rollup view with the chat beside it, and no Back at the view itself', () => {
  render()
  expect(crumbs()).toEqual(['Operations lead', 'Overview'])
  expect(container.querySelector('[data-testid="rollup"]')).not.toBeNull()
  expect(container.querySelector('[data-testid="chat"]')?.textContent).toBe('side')
  expect(back()).toBeUndefined()
})

it('draws a screen opened from the rollup, and goes back to the view', () => {
  render({ run: run({ screenId: 's1' }) })
  expect(crumbs()).toEqual(['Operations lead', 'Overview', 'Board screen'])
  expect(container.querySelector('[data-testid="canvas"]')?.textContent).toBe('Board screen')
  act(() => back()!.click())
  expect(onEvent).toHaveBeenCalledWith({ type: 'showScreen', screenId: null })
})

it('draws a screen view directly', () => {
  render({ run: run({ viewId: 'board' }) })
  expect(container.querySelector('[data-testid="canvas"]')?.textContent).toBe('Board screen')
})

it('gives the page to the conversation in full chat', () => {
  render({ presentation: 'chat' })
  expect(container.querySelector('[data-testid="chat"]')?.textContent).toBe('full')
  expect(crumbs()).toEqual(['Operations lead', 'Full chat'])
  expect(container.querySelector('[data-testid="rollup"]')).toBeNull()
  expect([...container.querySelectorAll('button')].some(b => b.textContent === 'Operate chat')).toBe(false)
})

it('says when the console or the view is gone', () => {
  render({ entry: undefined })
  expect(container.textContent).toContain('This console is unavailable.')
  render({ run: run({ viewId: 'removed' }) })
  expect(container.textContent).toContain('This view is no longer part of the console.')
})
