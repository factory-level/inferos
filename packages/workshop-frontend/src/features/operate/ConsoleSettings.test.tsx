// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BoundViewEntry, HostBoardEntry, OperateConsoleContent } from '@gadgets/workshop-shared/operate-console'
import type { ConsoleEntry } from './consoles'

const state = vi.hoisted(() => ({
  denied: false,
  replace: vi.fn<(id: string, revision: string, content: OperateConsoleContent) => Promise<void>>(),
  invalidate: vi.fn<() => void>(),
  hostBoards: false,
  boundViews: false,
  // One overseer for every render, as the real hook keeps it in state.
  overseer: null as unknown,
  workpieces: new Map() as Map<number, object>,
  getPage: vi.fn<(consoleId: string, screenId: string, source: string) => Promise<object | null>>(),
}))
state.overseer = { stub: { replaceConsole: state.replace, listConsoleWidgetCandidates: () => Promise.resolve([]), getConsolePage: state.getPage,
  getConsoleWidgetIndex: () => Promise.resolve(null), listConsoleWidgetIndexWorkspaces: () => Promise.resolve([]) } }
vi.mock('../../ServerConfigContext', () => ({ useServerConfig: () => ({ hostBoards: state.hostBoards, boundViews: state.boundViews }) }))
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: {} }) }))
vi.mock('../../useWorkspaceOpen', () => ({ useWorkspaceOpen: () => ({
  overseer: state.overseer, metadata: { role: state.denied ? 'use' : 'build' },
}) }))
vi.mock('../../pages/inferops-canvas/useWorkspaceScreens', () => ({ invalidateWorkspaceScreens: state.invalidate }))
vi.mock('../../hooks/useWorkspaceWorkpieces', () => ({ useWorkspaceWorkpieces: () => ({ workpieces: state.workpieces, ready: true }) }))
import { ConsoleSettings } from './ConsoleSettings'

const entry: ConsoleEntry = { workspace: { id: 'w1', title: 'Operations', created: new Date(), lastActive: new Date() }, screens: [], publishedScreens: [], console: {
  id: 'c1', revision: '3', published: null, title: 'Operations', fullChat: 'default',
  views: [{ id: 'v1', type: 'screen', title: 'Board', screen: 's1' }],
} }
let container: HTMLDivElement
let root: Root
const close = vi.fn<() => void>()
const edit = vi.fn<() => void>()
const openBuild = vi.fn<() => void>()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('PointerEvent', MouseEvent)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  state.denied = false; state.hostBoards = false; state.boundViews = false; state.workpieces = new Map(); state.getPage.mockReset().mockResolvedValue(null); state.replace.mockReset().mockResolvedValue(); state.invalidate.mockClear(); close.mockClear(); edit.mockClear(); openBuild.mockClear()
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })
const render = () => act(() => root.render(<ConsoleSettings entry={entry} onClose={close} onEdit={edit} onOpenBuild={openBuild} />))
const save = () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Save settings')!

it('opens the configuration workspace through its callback, without a page load', () => {
  render()
  const open = [...container.querySelectorAll('button')].find(button => button.textContent === 'Open configuration workspace')!
  act(() => open.click())
  expect(openBuild).toHaveBeenCalledTimes(1)
})

it('defaults old consoles to opt-out and persists four independent flags without copying pages', async () => {
  render()
  const checkboxes = [...container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')]
    .filter(checkbox => !checkbox.closest('[aria-labelledby="console-widgets-heading"]'))
  expect(checkboxes).toHaveLength(4)
  expect(checkboxes.every(checkbox => checkbox.getAttribute('aria-checked') === 'false')).toBe(true)
  act(() => checkboxes[0].click())
  act(() => checkboxes[2].click())
  await act(async () => save().click())
  expect(state.replace).toHaveBeenCalledWith('c1', '3', expect.objectContaining({
    views: entry.console.views, customization: { screens: true, widgets: false, tools: true, skills: false },
  }))
  expect(close).toHaveBeenCalledOnce()
  expect(state.invalidate).toHaveBeenCalledOnce()
})

it('keeps choices after a revision conflict', async () => {
  state.replace.mockRejectedValue(new Error('Conflict'))
  render()
  const checkbox = container.querySelector<HTMLButtonElement>('[role="checkbox"]')!
  act(() => checkbox.click())
  await act(async () => save().click())
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Your choices are still here')
  expect(checkbox.getAttribute('aria-checked')).toBe('true')
  expect(close).not.toHaveBeenCalled()
})

it('does not offer policy or configuration writes to use-role viewers', () => {
  state.denied = true
  render()
  expect(save()).toBeUndefined()
  expect(container.querySelector('a')).toBeNull()
  expect([...container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')].every(checkbox => checkbox.getAttribute('aria-disabled') === 'true' || checkbox.disabled)).toBe(true)
  expect(state.replace).not.toHaveBeenCalled()
})

it('keeps the console\'s widget registry when saving its settings', async () => {
  const widgets = [{ gadgetId: 3, blueprintId: 'bp', version: 2, label: 'Status', state: 'resettable' as const }]
  act(() => root.render(<ConsoleSettings entry={{ ...entry, console: { ...entry.console, widgets } }} onClose={close} onEdit={edit} onOpenBuild={openBuild} />))
  await act(async () => save().click())
  expect(state.replace).toHaveBeenCalledWith('c1', '3', expect.objectContaining({ widgets }))
})

const BOARD: HostBoardEntry = { kind: 'host-board', id: 'hb1', label: 'Team board',
  requirement: { name: 'board-1', resource: 'inferops-board', target: 'inferops://acme.ops/project/board/ENG' } }
const withBoard = { ...entry, console: { ...entry.console, hostBoards: [BOARD] } }
const lastContent = () => state.replace.mock.calls.at(-1)![2]
// Scoped to the boards section: the widget registry has a field of the same name.
const input = (label: string) => document.getElementById([...container.querySelectorAll<HTMLLabelElement>('[aria-labelledby="console-host-boards-heading"] label')].find(item => item.textContent === label)!.htmlFor) as HTMLInputElement
const type = (element: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
})

it('shows no boards while host boards are off, and saving leaves the saved boards to the kernel to keep', async () => {
  act(() => root.render(<ConsoleSettings entry={withBoard} onClose={close} onEdit={edit} onOpenBuild={openBuild} />))
  expect(container.querySelector('#console-host-boards-heading')).toBeNull()
  expect(container.textContent).not.toContain('Team board')
  await act(async () => save().click())
  expect(lastContent()).not.toHaveProperty('hostBoards')
})

it('keeps saved boards untouched when they are not edited, with host boards on', async () => {
  state.hostBoards = true
  act(() => root.render(<ConsoleSettings entry={withBoard} onClose={close} onEdit={edit} onOpenBuild={openBuild} />))
  expect(container.querySelector('[aria-label="Registered boards"]')?.textContent).toContain('Team board')
  await act(async () => save().click())
  expect(lastContent()).not.toHaveProperty('hostBoards')
})

it('sends an edited board list in full: a removal as an empty list, an addition without an id', async () => {
  state.hostBoards = true
  act(() => root.render(<ConsoleSettings entry={withBoard} onClose={close} onEdit={edit} onOpenBuild={openBuild} />))
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Remove Team board"]')!.click())
  await act(async () => save().click())
  expect(lastContent().hostBoards).toEqual([])

  type(input('Board'), ' inferops://acme.ops/project/board/OPS/ ')
  type(input('Name operators see'), 'Ops board')
  act(() => [...container.querySelectorAll('button')].find(button => button.textContent === 'Register board')!.click())
  await act(async () => save().click())
  expect(lastContent().hostBoards).toEqual([{ kind: 'host-board', label: 'Ops board',
    requirement: { name: 'board-1', resource: 'inferops-board', target: 'inferops://acme.ops/project/board/OPS' } }])
})

it('marks boards unavailable and offers none to add on a console that shows only Assistant', () => {
  state.hostBoards = true
  act(() => root.render(<ConsoleSettings entry={{ ...withBoard, console: { ...withBoard.console, fullChat: 'only' } }} onClose={close} onEdit={edit} onOpenBuild={openBuild} />))
  const section = container.querySelector('[aria-labelledby="console-host-boards-heading"]')!
  expect(section.textContent).toContain('This console shows only Assistant, so operators can\'t open boards on it.')
  expect(section.querySelector('[aria-label="Registered boards"]')?.textContent).toContain('Unavailable on an Assistant-only console')
  expect([...section.querySelectorAll('button')].some(button => button.textContent === 'Register board')).toBe(false)
})

const VIEW: BoundViewEntry = { kind: 'bound-view', id: 'bv1', gadgetId: 3, blueprintId: 'bp', version: 1, label: 'Triage view', requirements: ['board-1'] }
const withView = { ...withBoard, console: { ...withBoard.console, boundViews: [VIEW] } }

it.each([
  ['bound views are off', { hostBoards: true, boundViews: false }],
  ['host boards are off', { hostBoards: false, boundViews: true }],
])('shows no views while %s, and saving leaves the saved views to the kernel to keep', async (_, flags) => {
  Object.assign(state, flags)
  act(() => root.render(<ConsoleSettings entry={withView} onClose={close} onEdit={edit} onOpenBuild={openBuild} />))
  expect(container.querySelector('#console-bound-views-heading')).toBeNull()
  expect(container.textContent).not.toContain('Triage view')
  await act(async () => save().click())
  expect(lastContent()).not.toHaveProperty('boundViews')
})

it('keeps saved views untouched when not edited, and sends an edited list in full', async () => {
  state.hostBoards = true; state.boundViews = true
  act(() => root.render(<ConsoleSettings entry={withView} onClose={close} onEdit={edit} onOpenBuild={openBuild} />))
  expect(container.querySelector('[aria-label="Registered views"]')?.textContent).toContain('Triage view')
  await act(async () => save().click())
  expect(lastContent()).not.toHaveProperty('boundViews')
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Remove Triage view"]')!.click())
  await act(async () => save().click())
  expect(lastContent().boundViews).toEqual([])
})

it('tells the builder to publish again when a console published before apps were fenced places one only inside a nested page', async () => {
  state.workpieces = new Map([[3, { id: 3, type: 'gadget', title: 'Counter', commitId: 'c1' }]])
  // The published page holds the app one object deep; the version 1 copy shows none of it.
  state.getPage.mockImplementation(async (_consoleId, screenId) => screenId !== 's1' ? null : {
    schemaVersion: 2, id: 's1', revision: '5', title: 'Board', children: ['work'], attachments: [],
    nodes: [
      { nodeType: 'object', id: 'work', title: 'Work', columns: 1, children: ['inner'], attachments: [] },
      { nodeType: 'object', id: 'inner', title: 'Inner', columns: 1, children: ['w3'], attachments: [] },
      { nodeType: 'widget', id: 'w3', kind: 'inferos.gadget', version: 1, targetRef: 'gadget:3', size: 'normal', params: {}, attachments: [] },
    ],
  })
  const legacy: ConsoleEntry = { ...entry, publishedScreens: [{ schemaVersion: 1, id: 's1', revision: '5', title: 'Board', sections: [] }],
    console: { ...entry.console, published: { revision: '3', publishedAt: '2026-11-01T00:00:00.000Z', content: {
      title: 'Operations', fullChat: 'default', views: entry.console.views } } } }
  await act(async () => root.render(<ConsoleSettings entry={legacy} onClose={close} onEdit={edit} onOpenBuild={openBuild} />))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(state.getPage).toHaveBeenCalledWith('c1', 's1', 'published')
  expect(container.textContent).toContain("Operators can't open Counter until you publish Operations again")
})
