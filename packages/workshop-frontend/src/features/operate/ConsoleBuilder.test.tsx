// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { OperateConsoleContent } from '@gadgets/workshop-shared/operate-console'
import type { CanvasContent } from '@gadgets/workshop-shared/canvas'
import { withKumoPopupDoubles, setFieldValue } from '../canvas/kumoPopupDoubles'
import type { WorkspaceScreens } from '../../pages/inferops-canvas/useWorkspaceScreens'
import type { ConsoleEntry } from './consoles'

const testState = vi.hoisted(() => ({
  createConsole: vi.fn<(content: OperateConsoleContent) => Promise<unknown>>(),
  replaceConsole: vi.fn<(id: string, revision: string, content: OperateConsoleContent) => Promise<unknown>>(),
  createCanvas: vi.fn<(content: CanvasContent) => Promise<unknown>>(),
  invalidate: vi.fn<() => void>(),
  denied: false,
}))
vi.mock('@cloudflare/kumo', async importOriginal => withKumoPopupDoubles(await importOriginal<typeof import('@cloudflare/kumo')>()))
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: {} }) }))
vi.mock('../../ServerConfigContext', () => ({ useServerConfig: () => ({ canvasFeatures: { catalog: { widgetKinds: [], blueprints: [], screens: [] } } }) }))
vi.mock('../../useWorkspaceOpen', () => ({ useWorkspaceOpen: () => ({
  overseer: { stub: { createConsole: testState.createConsole, replaceConsole: testState.replaceConsole, createCanvas: testState.createCanvas } },
  metadata: { id: 'w1', role: testState.denied ? 'use' : 'build' }, error: null,
}) }))
vi.mock('../../hooks/useWorkspaceWorkpieces', () => ({ useWorkspaceWorkpieces: () => ({ ready: true, workpieces: new Map() }) }))
vi.mock('../../pages/inferops-canvas/useWorkspaceScreens', () => ({ invalidateWorkspaceScreens: testState.invalidate }))

import { ConsoleBuilder } from './ConsoleBuilder'

const workspace = { id: 'w1', title: 'Operations', role: 'build' } as ConsoleEntry['workspace']
const workspaces: WorkspaceScreens[] = [{ workspace, flows: [], consoles: [], screens: [
  { schemaVersion: 1, id: 's1', title: 'Board', revision: '0', sections: [] },
  { schemaVersion: 1, id: 's2', title: 'Activity', revision: '0', sections: [] },
] }]
const initial: ConsoleEntry = { workspace, screens: workspaces[0].screens!, console: {
  id: 'c1', revision: '7', title: 'Operations lead', fullChat: 'available',
  views: [{ id: 'board', title: 'Board', type: 'screen', screen: 's1' }],
} }
let root: Root
let container: HTMLDivElement
const onSaved = vi.fn<(entry: ConsoleEntry) => void>()
const onCancel = vi.fn<() => void>()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  testState.denied = false
  testState.createConsole.mockReset().mockImplementation(async content => ({ ...content, id: 'new', revision: '0' }))
  testState.replaceConsole.mockReset().mockImplementation(async (id, revision, content) => ({ ...content, id, revision: String(Number(revision) + 1) }))
  testState.createCanvas.mockReset().mockImplementation(async content => ({ ...content, schemaVersion: 1, id: 'created-screen', revision: '0' }))
  testState.invalidate.mockClear(); onSaved.mockClear(); onCancel.mockClear()
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const render = (editing?: ConsoleEntry) => act(() => root.render(<ConsoleBuilder workspaces={workspaces} initial={editing} onSaved={onSaved} onCancel={onCancel} />))
const field = (label: string) => {
  const element = [...container.querySelectorAll('label')].find(item => item.textContent?.startsWith(label))?.control
  if (!element) throw new Error(`No field: ${label}`)
  return element as HTMLInputElement | HTMLSelectElement
}
const fill = (label: string, value: string) => act(() => setFieldValue(field(label), value))
const button = (label: string) => {
  const element = [...container.querySelectorAll('button')].find(item => (item.getAttribute('aria-label') ?? item.textContent?.trim()) === label)
  if (!element) throw new Error(`No button: ${label}`)
  return element
}
const click = (label: string) => act(async () => button(label).click())

it('creates an assistant-first console with screens in the chosen navigation order', async () => {
  render()
  fill('Console name', 'My operations')
  await click('Continue')
  fill('Add an existing screen', 's1')
  fill('Add an existing screen', 's2')
  await click('Move Activity up')
  await click('Continue')
  expect(field('Starting experience').value).toBe('default')
  await click('Continue')
  expect(container.querySelector('[aria-label="Console preview"]')).not.toBeNull()
  await click('Create console')
  expect(testState.createConsole).toHaveBeenCalledWith(expect.objectContaining({ title: 'My operations', fullChat: 'default', views: [
    expect.objectContaining({ screen: 's2', title: 'Activity' }), expect.objectContaining({ screen: 's1', title: 'Board' }),
  ] }))
  expect(onSaved).toHaveBeenCalledOnce()
  expect(testState.invalidate).toHaveBeenCalledOnce()
})

it('saves new screens explicitly and keeps them when console setup is cancelled', async () => {
  render()
  fill('Console name', 'Draft console')
  await click('Continue'); await click('Create a new screen')
  fill('Screen name', 'Daily work')
  expect(testState.createCanvas).not.toHaveBeenCalled()
  await click('Save screen')
  expect(testState.createCanvas).toHaveBeenCalledWith(expect.objectContaining({ title: 'Daily work' }))
  expect(container.textContent).toContain('Daily work')
  await click('Cancel'); await click('Discard changes')
  expect(onCancel).toHaveBeenCalledOnce()
  expect(testState.createConsole).not.toHaveBeenCalled()
})

it('uses the original revision and retains the draft after a failed edit', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  testState.replaceConsole.mockRejectedValueOnce(new Error('Revision conflict'))
  render(initial)
  fill('Console name', 'Updated console')
  await click('Continue'); await click('Continue'); await click('Continue'); await click('Save console')
  expect(testState.replaceConsole).toHaveBeenCalledWith('c1', '7', expect.objectContaining({ title: 'Updated console' }))
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Your draft is still here')
  expect(onSaved).not.toHaveBeenCalled()
  await click('Back'); await click('Back'); await click('Back')
  expect(field('Console name').value).toBe('Updated console')
})

it('does not advance with missing screens or without build access', async () => {
  render({ ...initial, console: { ...initial.console, views: [{ id: 'gone', title: 'Gone', type: 'screen', screen: 'missing' }] } })
  await click('Continue'); await click('Continue')
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('available screen')
  await click('Back')
  testState.denied = true
  render(initial)
  expect(button('Continue').disabled).toBe(true)
  expect(testState.createConsole).not.toHaveBeenCalled()
})
