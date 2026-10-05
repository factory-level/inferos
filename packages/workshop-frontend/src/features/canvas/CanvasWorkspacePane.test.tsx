// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { DEFAULT_CANVAS_CATALOG, type CanvasCatalog, type CanvasDefinition } from '@gadgets/workshop-shared/canvas'
import { CanvasWorkspacePane } from './CanvasWorkspacePane'
import type { CanvasStorage } from './useCanvasWorkspace'

vi.mock('../../GadgetUI', () => ({ default: () => null }))

let root: Root
let container: HTMLDivElement
// The read-only view watches the action log for decided moves and resolves board references;
// nothing else here reaches the workspace.
const overseer = {
  subscribeToActions: async () => ({ [Symbol.dispose]: () => {} }),
  listActions: async () => ({ entries: [] }),
  getGatekeeperByResourceUrl: async () => null,
} as unknown as RpcStub<Overseer>
const onOpenWidgetChange = vi.fn<(widgetId: string | null) => void>()
const render = async (storage: CanvasStorage, catalog: CanvasCatalog = DEFAULT_CANVAS_CATALOG,
    onAskAgent = vi.fn<(request: string) => Promise<void>>(async () => {}), openWidgetId: string | null = null) => {
  await act(async () => root.render(<CanvasWorkspacePane storage={storage} overseer={overseer} gadgets={new Map()}
    catalog={catalog} viewId={null} onViewChange={() => {}} openWidgetId={openWidgetId} onOpenWidgetChange={onOpenWidgetChange} onAskAgent={onAskAgent} />))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
const BOARD = 'inferops://demo.local/project/board/DEMO'
const saved: CanvasDefinition = { schemaVersion: 1, id: 'ops', revision: '0', title: 'Ops', sections: [{ id: 'main', title: 'Main', columns: 2,
  widgets: [{ id: 'b', kind: 'inferops.project-board', version: 1, targetRef: BOARD, size: 'wide', params: { workflow: 'software', showCompleted: false } }] }] }
const durable = (): CanvasStorage => ({ kind: 'durable', api: { listCanvases: async () => [saved], createCanvas: vi.fn<Overseer['createCanvas']>(),
  editCanvas: vi.fn<Overseer['editCanvas']>(), deleteCanvas: vi.fn<Overseer['deleteCanvas']>() } })
const button = (name: string) => [...container.querySelectorAll('button')].find(item => item.textContent === name)

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  onOpenWidgetChange.mockClear()
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

it('labels temporary views as unsaved and opens a newly created view for editing', async () => {
  await render({ kind: 'temporary' })
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Unsaved views')
  expect(button('Edit layout')).toBeDefined()
  await act(async () => { container.querySelector('form')!.requestSubmit() })
  expect(button('Operations')?.getAttribute('aria-pressed')).toBe('true')
  expect(button('Done editing')?.getAttribute('aria-pressed')).toBe('true')
  expect(container.textContent).toContain('Add gadget')
  await act(async () => { button('Done editing')!.click() })
  expect(container.textContent).toContain('No widgets in this section yet.')
})

it('labels durable views as saved', async () => {
  await render({ kind: 'durable', api: { listCanvases: async () => [], createCanvas: vi.fn<Overseer['createCanvas']>(), editCanvas: vi.fn<Overseer['editCanvas']>(), deleteCanvas: vi.fn<Overseer['deleteCanvas']>() } })
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Saved views')
})

it('offers only the widget kinds the catalog enables, and hands blueprint widgets to the agent', async () => {
  const onAskAgent = vi.fn<(request: string) => Promise<void>>(async () => {})
  await render({ kind: 'temporary' }, {
    widgetKinds: ['inferos.gadget'],
    blueprints: [{ blueprintId: 'inferops.kanban', label: 'InferOps Kanban', description: 'A project board.' }],
    screens: [],
  }, onAskAgent)
  await act(async () => { container.querySelector('form')!.requestSubmit() })
  expect(container.textContent).toContain('Add gadget')
  expect(container.textContent).not.toContain('Add board')
  await act(async () => { button('InferOps Kanban')!.click() })
  expect(onAskAgent).toHaveBeenCalledOnce()
  expect(onAskAgent.mock.calls[0][0]).toContain('blueprint inferops.kanban')
  expect(onAskAgent.mock.calls[0][0]).toContain('"Overview" section of the "Operations" canvas')
})

it('reports the agent hand-off failing instead of dropping it silently', async () => {
  await render({ kind: 'temporary' }, {
    widgetKinds: ['inferos.gadget'],
    blueprints: [{ blueprintId: 'inferops.kanban', label: 'InferOps Kanban', description: 'A project board.' }],
    screens: [],
  }, vi.fn<(request: string) => Promise<void>>(async () => { throw new Error("offline") }))
  await act(async () => { container.querySelector('form')!.requestSubmit() })
  await act(async () => { button('InferOps Kanban')!.click() })
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not start the chat')
})

it('opens a board card in its full view from the card, closes it from the full view, and closes an opened widget the view lacks', async () => {
  await render(durable())
  expect(container.querySelector('[data-presentation="card"]')).not.toBeNull()
  await act(async () => { button('Open')!.click() })
  expect(onOpenWidgetChange).toHaveBeenCalledWith('b')
  await render(durable(), DEFAULT_CANVAS_CATALOG, undefined, 'b')
  expect(container.querySelector('[data-presentation="full"]')).not.toBeNull()
  expect(container.querySelector('[data-presentation="card"]')).toBeNull()
  expect(container.querySelector('h1')).toBeNull()
  await act(async () => { button('Back to Ops')!.click() })
  expect(onOpenWidgetChange).toHaveBeenLastCalledWith(null)
  onOpenWidgetChange.mockClear()
  await render(durable(), DEFAULT_CANVAS_CATALOG, undefined, 'gone')
  expect(onOpenWidgetChange).toHaveBeenCalledWith(null)
  expect(container.querySelector('[data-presentation="card"]')).not.toBeNull()
})

it('preloads board cards against the canvas scroll pane with a 200px margin and keeps the first load', async () => {
  const observers: { options: IntersectionObserverInit; report: (entries: { isIntersecting: boolean }[]) => void; target?: Element }[] = []
  vi.stubGlobal('IntersectionObserver', class {
    readonly entry: (typeof observers)[number]
    constructor(report: (typeof observers)[number]['report'], options: IntersectionObserverInit) {
      this.entry = { report, options }; observers.push(this.entry)
    }
    observe(target: Element) { this.entry.target = target }
    disconnect() {}
  })
  const lookup = vi.spyOn(overseer, 'getGatekeeperByResourceUrl')
  try {
    await render(durable())
    const pane = container.querySelector('.overflow-y-auto')
    const observer = observers.find(item => item.target === container.querySelector('[data-presentation="card"]'))!
    expect(observer.options.root).toBe(pane)
    expect(observer.options.rootMargin).toBe('200px')
    expect(lookup).not.toHaveBeenCalled()
    // The browser reports an intersection with the expanded root before the widget enters the
    // pane itself. Once loaded it stays subscribed when a later observation is outside the root.
    await act(async () => observer.report([{ isIntersecting: true }]))
    expect(lookup).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Not connected')
    await act(async () => observer.report([{ isIntersecting: false }]))
    expect(lookup).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Not connected')
  } finally { lookup.mockRestore() }
})
