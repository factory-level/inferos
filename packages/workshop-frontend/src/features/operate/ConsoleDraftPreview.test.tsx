// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GadgetSummary, WorkpieceId } from '@gadgets/workshop-shared/api'
import { parseCanvasPage } from '@gadgets/workshop-shared/canvas-model'
import type { ConsoleDraftProblem } from '@gadgets/workshop-shared/operate-console'
import { ConsoleDraftPreview } from './ConsoleDraftPreview'

// FAC-96: the simulated preview of a console draft. The workspace is a stand-in that answers only
// the reads the preview may make; any other call is recorded, so a write, a connection or a gadget
// opened would fail the test. Nothing here is live and nothing is sent.
const READS = new Set(['getConsole', 'listFlows', 'getWorkspaceConfiguration', 'validateConsoleDraft', 'getConsolePage', 'readFilesAtCommit', 'listTree'])
let forbidden: string[] = []
const STATES = { version: 1, initial: 'editing', persistence: 'person', states: ['editing', 'submitted'],
  transitions: [{ event: 'submit', from: 'editing', to: 'submitted' }] }
const PROBLEMS: ConsoleDraftProblem[] = [{ code: 'navigation-outside-console', target: 'page:form/attachment:out',
  message: 'Screen form navigates to page elsewhere, which the console does not show.',
  repair: 'Point the attachment at a page the console shows, add that page to the console, or remove the attachment.' }]
const page = (id: string) => parseCanvasPage({ schemaVersion: 2, id, revision: '0', title: id === 'form' ? 'Form page' : 'Done page',
  children: ['a'], attachments: [], ...(id === 'form' ? { settings: { 'baseUi.alerts': true } } : {}), nodes: id === 'form' ? [
    { nodeType: 'object', id: 'a', title: 'Intake', columns: 2, children: ['g', 'b'], attachments: [] },
    { nodeType: 'widget', id: 'g', kind: 'inferos.gadget', version: 1, targetRef: 'gadget:7', size: 'normal', params: {},
      attachments: [{ id: 'next', version: 1, on: 'submit', effect: { kind: 'navigate', page: 'done' } }] },
    { nodeType: 'widget', id: 'b', kind: 'inferops.project-board', version: 1, targetRef: 'inferops://acme.operations/project/board/ENG',
      size: 'normal', params: { workflow: 'software', showCompleted: false }, attachments: [] },
  ] : [{ nodeType: 'object', id: 'a', title: 'Finished', columns: 1, children: [], attachments: [] }] })
let commitId = ''
const stub = new Proxy({
  getConsole: async () => ({ id: 'c', revision: '3', title: 'Floor', fullChat: 'off', published: null, flows: ['f'],
    views: [{ id: 'v-form', title: 'Form', type: 'screen', screen: 'form' }, { id: 'v-done', title: 'Done', type: 'screen', screen: 'done' }] }),
  listFlows: async () => [{ id: 'f', revision: '0', title: 'Shift', steps: ['form', 'done'],
    pages: [{ name: 'start', states: ['open', 'checking'], routes: [{ label: 'Finish', to: 'end' }] }, { name: 'end' }] }],
  getWorkspaceConfiguration: async () => ({ revision: '1', settings: { 'chatPane.widgets': 'none' } }),
  validateConsoleDraft: async () => PROBLEMS,
  getConsolePage: async (_console: string, screenId: string) => page(screenId),
  readFilesAtCommit: async (_commit: string, paths: string[]) => paths.map(path => [path, { kind: 'text', text: JSON.stringify(STATES) }]),
  listTree: async () => [],
} as Record<string, unknown>, {
  get(target, name) {
    if (typeof name === 'string' && !READS.has(name) && name !== 'then') forbidden.push(name)
    return target[name as string]
  },
})
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: {} }) }))
vi.mock('../../useWorkspaceOpen', () => ({ useWorkspaceOpen: () => ({ overseer: { stub } }) }))
vi.mock('../../hooks/useWorkspaceWorkpieces', () => ({
  useWorkspaceWorkpieces: () => ({ ready: true, workpieces: new Map<WorkpieceId, GadgetSummary>([[7, { id: 7, type: 'gadget', title: 'Intake form', commitId } as GadgetSummary]]) }),
}))

let root: Root
let container: HTMLDivElement
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
const button = (name: string) => [...container.querySelectorAll('button')].find(item => item.textContent === name)
const text = () => container.textContent ?? ''
const choose = async (label: string, option: string) => {
  const field = [...container.querySelectorAll<HTMLElement>('[role="combobox"]')].find(item => item.closest('label, div')?.textContent?.includes(label))
  if (!field) throw new Error(`No select ${label}`)
  await act(async () => field.click()); await settle()
  const item = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(entry => entry.textContent === option)
  if (!item) throw new Error(`No option ${option}`)
  if (!('PointerEvent' in window)) Object.defineProperty(window, 'PointerEvent', { value: class extends MouseEvent {} })
  await act(async () => {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      item.dispatchEvent(new (type.startsWith('pointer') ? window.PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true }))
    }
  })
  await settle()
}
const render = async () => {
  await act(async () => root.render(<ConsoleDraftPreview workspaceId="ws" consoleId="c" onClose={() => {}} />))
  for (let i = 0; i < 4; i++) await settle()
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  forbidden = []; commitId = crypto.randomUUID().replaceAll('-', '').slice(0, 40)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

it('runs a gadget’s local transition from states.json and the navigation it is wired to, with nothing live', async () => {
  await render()
  expect(text()).toContain('Simulated preview of the draft')
  expect(text()).toContain('Form page')
  expect(text()).toContain('The widget doesn’t run in preview; its local states do.')
  expect(container.querySelector('[aria-label="Preview Intake form"]')?.textContent).toContain('editing')
  await act(async () => button('submit')!.click()); await settle(); await settle()
  // Wired to navigate: the preview's own page moves to the Done view.
  expect(text()).toContain('Done page')
  expect(forbidden).toEqual([])
})

it('shows an InferOps widget as a placeholder, and its action as what it would request, sending nothing', async () => {
  await render()
  const board = container.querySelector('[aria-label="Preview inferops.project-board inferops://acme.operations/project/board/ENG"]')!
  expect(board.textContent).toContain('Live data isn’t read in preview.')
  await act(async () => [...board.querySelectorAll('button')].find(item => item.textContent === 'create-issue')!.click())
  expect(container.querySelector('[role="status"]')?.textContent)
    .toBe('Would request create-issue of this widget: it would need the person’s own grant and approval. Nothing was sent.')
  expect(forbidden).toEqual([])
})

it('lists what would stop publishing, each with its target and repair, and the page’s settings with their owners', async () => {
  await render()
  const problems = container.querySelector('[aria-label="What would stop publishing"]')!.textContent ?? ''
  expect(problems).toContain(PROBLEMS[0]!.message)
  expect(problems).toContain('In page:form/attachment:out')
  expect(problems).toContain(`Fix: ${PROBLEMS[0]!.repair}`)
  const settings = container.querySelector('[aria-label="Page settings"]')!.textContent ?? ''
  expect(settings).toContain('baseUi.alerts: true (page)')
  expect(settings).toContain('chatPane.widgets: none (workspace)')
  expect(settings).toContain('baseUi.notifications: false (default)')
})

it('runs a flow’s routes, back and page states on the preview’s own page', async () => {
  await render()
  await choose('Run a flow', 'Shift')
  expect(text()).toContain('Flow: Shift')
  await choose('Page state', 'checking')
  await act(async () => button('Finish')!.click()); await settle(); await settle()
  expect(text()).toContain('Done page')
  await act(async () => button('Back')!.click()); await settle(); await settle()
  expect(text()).toContain('Form page')
  await act(async () => button('Leave the flow')!.click())
  expect(text()).not.toContain('Flow: Shift')
  expect(forbidden).toEqual([])
})
