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
  workpieces: new Map<number, object>(),
}))
vi.mock('@cloudflare/kumo', async importOriginal => withKumoPopupDoubles(await importOriginal<typeof import('@cloudflare/kumo')>()))
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: {} }) }))
vi.mock('../../ServerConfigContext', () => ({ useServerConfig: () => ({ canvasFeatures: { catalog: { widgetKinds: [], blueprints: [], screens: [] } } }) }))
vi.mock('../../useWorkspaceOpen', () => ({ useWorkspaceOpen: ({ id }: { id?: string }) => ({
  overseer: { stub: { createConsole: testState.createConsole, replaceConsole: testState.replaceConsole, createCanvas: testState.createCanvas } },
  metadata: { id: id ?? 'w1', role: testState.denied ? 'use' : 'build' }, error: null,
}) }))
vi.mock('../../hooks/useWorkspaceWorkpieces', () => ({ useWorkspaceWorkpieces: () => ({ ready: true, workpieces: testState.workpieces }) }))
vi.mock('../../pages/inferops-canvas/useWorkspaceScreens', () => ({ invalidateWorkspaceScreens: testState.invalidate }))

import { ConsoleBuilder } from './ConsoleBuilder'

const workspace = { id: 'w1', title: 'Operations', role: 'build' } as ConsoleEntry['workspace']
const workspaces: WorkspaceScreens[] = [{ workspace, flows: [], consoles: [], publishedScreens: {}, screens: [
  { schemaVersion: 1, id: 's1', title: 'Board', revision: '0', sections: [] },
  { schemaVersion: 1, id: 's2', title: 'Activity', revision: '0', sections: [] },
] }]
const initial: ConsoleEntry = { workspace, screens: workspaces[0].screens!, publishedScreens: [], console: {
  id: 'c1', revision: '7', published: null, title: 'Operations lead', fullChat: 'available',
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
  testState.workpieces = new Map()
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
  await click('Create draft')
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
  await click('Continue'); await click('Continue'); await click('Continue'); await click('Save draft')
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

it('registers an installed widget before the console is first saved', async () => {
  testState.workpieces = new Map([[7, { id: 7, type: 'gadget', title: 'Status', commitId: 'c7',
    installedFrom: { blueprintId: 'bp', version: 2, kind: 'widget' } }]])
  vi.stubGlobal('PointerEvent', MouseEvent)
  render()
  fill('Console name', 'Floor')
  await click('Continue')
  fill('Add an existing screen', 's1')
  fill('Widget install', '7')
  fill('Name operators see', 'Shift status')
  await act(async () => container.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click())
  await click('Register widget')
  expect(container.querySelector('[aria-label="Registered widgets"]')?.textContent).toContain('Shift status')
  await click('Continue'); await click('Continue'); await click('Create draft')
  expect(testState.createConsole).toHaveBeenCalledWith(expect.objectContaining({ widgets: [
    { gadgetId: 7, blueprintId: 'bp', version: 2, label: 'Shift status', state: 'resettable' },
  ] }))
})

// Flows (F2 C6): the builder chooses which of the workspace's flows a console offers employees.
const INTAKE = { id: 'f1', revision: '2', title: 'Intake', steps: ['s1', 's2'] }
const NOTES_FLOW = { id: 'f2', revision: '0', title: 'Notes flow', steps: ['s1', 's3'] }
const NOTES = { schemaVersion: 1 as const, id: 's3', title: 'Notes', revision: '0', sections: [] }
const withFlows = (flows = [INTAKE, NOTES_FLOW]): WorkspaceScreens[] =>
  [{ ...workspaces[0], flows, screens: [...workspaces[0].screens!, NOTES] }]
const twoViews = [{ id: 'board', title: 'Board', type: 'screen' as const, screen: 's1' }, { id: 'activity', title: 'Activity', type: 'screen' as const, screen: 's2' }]
const listing = (extra: Partial<ConsoleEntry['console']> = {}): ConsoleEntry =>
  ({ ...initial, screens: withFlows()[0].screens!, console: { ...initial.console, views: twoViews, flows: ['f1'], ...extra } })
const renderWith = (spaces: WorkspaceScreens[], editing?: ConsoleEntry) =>
  act(() => root.render(<ConsoleBuilder workspaces={spaces} initial={editing} onSaved={onSaved} onCancel={onCancel} />))
const flowBox = (text: string) => {
  const box = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Console flows"] [role="checkbox"]')]
    .find(candidate => candidate.closest('li')?.textContent?.includes(text))
  if (!box) throw new Error(`No flow checkbox: ${text}`)
  return box
}
const flowsSection = () => container.querySelector('[aria-labelledby="console-flows-heading"]')
const alertText = () => container.querySelector('footer')?.previousElementSibling?.getAttribute('role') === 'alert'
  ? container.querySelector('footer')?.previousElementSibling?.textContent : [...container.querySelectorAll('[role="alert"]')].at(-1)?.textContent

it('B-1: lists the workspace flows with step counts, and a checked one is saved and reviewed', async () => {
  vi.stubGlobal('PointerEvent', MouseEvent)
  renderWith(withFlows())
  fill('Console name', 'Intake console')
  await click('Continue')
  fill('Add an existing screen', 's1')
  fill('Add an existing screen', 's2')
  expect(flowsSection()?.textContent).toContain('Intake · 2 steps')
  expect(flowsSection()?.textContent).toContain('Notes flow · 2 steps')
  await act(async () => flowBox('Intake').click())
  await click('Continue'); await click('Continue')
  const preview = container.querySelector('[aria-label="Console preview"]')?.textContent
  expect(preview).toContain('Intake')
  expect(preview).toContain('· 1 flow')
  await click('Create draft')
  expect(testState.createConsole).toHaveBeenCalledWith(expect.objectContaining({ flows: ['f1'] }))
})

it('B-2: an edit that leaves Flows alone sends no flows; unchecking all sends []', async () => {
  vi.stubGlobal('PointerEvent', MouseEvent)
  renderWith(withFlows(), listing())
  await click('Continue'); await click('Continue'); await click('Continue'); await click('Save draft')
  expect(testState.replaceConsole.mock.calls[0]![2]).not.toHaveProperty('flows')
  act(() => root.unmount()); root = createRoot(container)
  renderWith(withFlows(), listing())
  await click('Continue')
  await act(async () => flowBox('Intake').click())
  await click('Continue'); await click('Continue'); await click('Save draft')
  expect(testState.replaceConsole.mock.calls[1]![2]).toMatchObject({ flows: [] })
})

it('B-3: a flow over a screen the console does not show says so, and Continue is blocked with nothing saved', async () => {
  vi.stubGlobal('PointerEvent', MouseEvent)
  renderWith(withFlows())
  fill('Console name', 'Intake console')
  await click('Continue')
  fill('Add an existing screen', 's1')
  fill('Add an existing screen', 's2')
  await act(async () => flowBox('Notes flow').click())
  expect(flowBox('Notes flow').closest('li')?.textContent)
    .toContain("Uses Notes, which this console doesn't show. Add it to a view, or leave this flow out.")
  await click('Continue')
  expect(alertText()).toBe('Flow "Notes flow" uses screens this console doesn\'t show. Add them to a view, or leave the flow out.')
  expect(container.querySelector('[aria-current="step"]')?.textContent).toBe('2. Screens and views')
  expect(testState.createConsole).not.toHaveBeenCalled()
})

it('B-4: a listed flow since deleted blocks saving until it is removed, and the save then drops it', async () => {
  vi.stubGlobal('PointerEvent', MouseEvent)
  renderWith(withFlows(), listing({ flows: ['gone'] }))
  await click('Continue')
  expect(flowsSection()?.textContent).toContain('A flow this console listed was deleted')
  await click('Continue')
  expect(alertText()).toBe('A flow this console listed was deleted. Remove it to continue.')
  await click('Remove deleted flow gone')
  expect(flowsSection()?.textContent).not.toContain('was deleted')
  await click('Continue'); await click('Continue'); await click('Save draft')
  expect(testState.replaceConsole).toHaveBeenCalledWith('c1', '7', expect.objectContaining({ flows: [] }))
})

it('B-5: says the workspace has no flows yet, with nothing to check', async () => {
  renderWith(withFlows([]))
  fill('Console name', 'Intake console')
  await click('Continue')
  expect(flowsSection()?.textContent).toContain('This workspace has no flows yet. Create one in Screens and flows, then come back to add it.')
  expect(flowsSection()?.querySelector('[role="checkbox"]')).toBeNull()
})

it('B-6: marks a chosen flow edited since the console was published, or not published at all', async () => {
  const published = { revision: '7', publishedAt: '2026-10-14T00:00:00.000Z', content: { title: 'Operations lead', fullChat: 'available' as const, views: twoViews },
    flows: [{ ...INTAKE, revision: '1' }] }
  renderWith(withFlows(), listing({ flows: ['f1', 'f2'], published }))
  await click('Continue')
  expect(flowBox('Intake').closest('li')?.textContent).toContain('Edited since published. Publish again to give employees this version.')
  expect(flowBox('Notes flow').closest('li')?.textContent).toContain('Not published yet. Publish again to give employees this flow.')
})

it('B-7: once build access is gone the flows cannot be changed', async () => {
  vi.stubGlobal('PointerEvent', MouseEvent)
  renderWith(withFlows(), listing())
  await click('Continue')
  testState.denied = true
  renderWith(withFlows(), listing())
  const boxes = [...container.querySelectorAll('[aria-label="Console flows"] [role="checkbox"]')]
  expect(boxes).toHaveLength(2)
  for (const box of boxes) {
    expect(box.hasAttribute('disabled') || box.getAttribute('aria-disabled') === 'true' || box.hasAttribute('data-disabled')).toBe(true)
  }
  await act(async () => flowBox('Intake').click())
  expect(button('Continue').disabled).toBe(true)
  expect(testState.replaceConsole).not.toHaveBeenCalled()
})

it('B-8: an Assistant-only console says its flows are unavailable to employees', async () => {
  renderWith(withFlows(), listing({ fullChat: 'only' }))
  await click('Continue'); await click('Continue')
  expect([...container.querySelectorAll('[role="status"]')].map(node => node.textContent))
    .toContain('Its flows are unavailable to employees while it shows only Assistant.')
})

it("B-9: shows the kernel's own refusal about a console flow on save, and the generic message otherwise", async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  testState.replaceConsole.mockRejectedValueOnce(new Error('Console flow f1 is not a flow in this workspace'))
  renderWith(withFlows(), listing())
  await click('Continue'); await click('Continue'); await click('Continue'); await click('Save draft')
  expect(alertText()).toBe('Console flow f1 is not a flow in this workspace')
  testState.replaceConsole.mockRejectedValueOnce(new Error('Internal detail 1234'))
  await click('Save draft')
  expect(alertText()).toContain('Could not save this console.')
  expect(container.textContent).not.toContain('Internal detail 1234')
})

it('forgets widgets registered in one workspace when the console moves to another', async () => {
  vi.stubGlobal('PointerEvent', MouseEvent)
  const other: WorkspaceScreens = { ...workspaces[0], workspace: { ...workspace, id: 'w2', title: 'Support' } }
  testState.workpieces = new Map([[7, { id: 7, type: 'gadget', title: 'Status', commitId: 'c7',
    installedFrom: { blueprintId: 'bp', version: 2, kind: 'widget' } }]])
  act(() => root.render(<ConsoleBuilder workspaces={[...workspaces, other]} onSaved={onSaved} onCancel={onCancel} />))
  fill('Console name', 'Floor')
  fill('Workspace', 'w1')
  await click('Continue')
  fill('Widget install', '7')
  await act(async () => container.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click())
  await click('Register widget')
  expect(container.querySelector('[aria-label="Registered widgets"]')).not.toBeNull()
  await click('Back')
  fill('Workspace', 'w2')
  await click('Continue')
  expect(container.querySelector('[aria-label="Registered widgets"]')).toBeNull()
  expect(container.textContent).toContain('No widgets are registered.')
})
