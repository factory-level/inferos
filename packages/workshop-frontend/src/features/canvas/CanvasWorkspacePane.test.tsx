// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { GadgetSummary, Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'
import { DEFAULT_CANVAS_CATALOG, type CanvasCatalog, type CanvasDefinition } from '@gadgets/workshop-shared/canvas'
import { canvasPageFromDefinition, canvasRunEvent, type CanvasPage, type CanvasPageOperation } from '@gadgets/workshop-shared/canvas-model'
import { CanvasWorkspacePane } from './CanvasWorkspacePane'
import type { CanvasStorage } from './useCanvasWorkspace'

vi.mock('../../GadgetUI', () => ({ default: () => null }))

let root: Root
let container: HTMLDivElement
// The workspace's triggers (FAC-116), none unless a test sets them; `listHooks` answers with this.
let hooks: () => Promise<unknown[]> = async () => []
// The read-only view watches the action log for decided moves and resolves board references;
// nothing else here reaches the workspace.
const overseer = {
  listHooks: () => hooks(),
  subscribeToActions: async () => ({ [Symbol.dispose]: () => {} }),
  listActions: async () => ({ entries: [] }),
  getGatekeeperByResourceUrl: async () => null,
  // The page's configuration and the workspace's settings (FAC-95), unset.
  traceConfiguration: async () => [],
  getWorkspaceConfiguration: async () => ({ revision: '0', settings: {} }),
  // A gadget widget's declared events (FAC-94) come from its head commit's states.json.
  listTree: async () => [],
  getGadget: () => Object.assign(new Promise(() => {}), { [Symbol.dispose]: () => {} }),
  readFilesAtCommit: async (commitId: string, paths: string[]) => paths.map(path => [path,
    commitId === 'fac94-stateful' && path === 'states.json' ? { kind: 'text', text: JSON.stringify({
      version: 1, initial: 'editing', persistence: 'session', states: ['editing', 'submitted'],
      transitions: [{ event: 'submit', from: 'editing', to: 'submitted' }, { event: 'reopen', from: 'submitted', to: 'editing' }],
    }) } : { kind: 'absent' }]),
} as unknown as RpcStub<Overseer>
const onOpenWidgetChange = vi.fn<(widgetId: string | null) => void>()
const render = async (storage: CanvasStorage, catalog: CanvasCatalog = DEFAULT_CANVAS_CATALOG,
    onAskAgent = vi.fn<(request: string) => Promise<void>>(async () => {}), openWidgetId: string | null = null,
    gadgets: ReadonlyMap<WorkpieceId, GadgetSummary> = new Map()) => {
  await act(async () => root.render(<CanvasWorkspacePane storage={storage} overseer={overseer} gadgets={gadgets}
    catalog={catalog} viewId={null} onViewChange={() => {}} openWidgetId={openWidgetId} onOpenWidgetChange={onOpenWidgetChange} onAskAgent={onAskAgent} />))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
const BOARD = 'inferops://demo.local/project/board/DEMO'
/** The page read and page edit of a fake whose saved views are what `listCanvases` returns. */
const withPages = <T extends { listCanvases: () => Promise<CanvasDefinition[]> }>(api: T) => ({
  ...api,
  getCanvasPage: vi.fn<Overseer['getCanvasPage']>(async (id: string) => {
    const view = (await api.listCanvases()).find(item => item.id === id)
    return view ? canvasPageFromDefinition(view) : null
  }),
  editCanvasPage: vi.fn<Overseer['editCanvasPage']>(),
})
const saved: CanvasDefinition = { schemaVersion: 1, id: 'ops', revision: '0', title: 'Ops', sections: [{ id: 'main', title: 'Main', columns: 2,
  widgets: [{ id: 'b', kind: 'inferops.project-board', version: 1, targetRef: BOARD, size: 'wide', params: { workflow: 'software', showCompleted: false } }] }] }
const durable = (): CanvasStorage => ({ kind: 'durable', api: withPages({ listCanvases: async () => [saved], createCanvas: vi.fn<Overseer['createCanvas']>(),
  editCanvas: vi.fn<Overseer['editCanvas']>(), deleteCanvas: vi.fn<Overseer['deleteCanvas']>() }) })
const button = (name: string) => [...container.querySelectorAll('button')].find(item => item.textContent === name)

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  onOpenWidgetChange.mockClear()
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); hooks = async () => [] })

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
  await render({ kind: 'durable', api: withPages({ listCanvases: async () => [], createCanvas: vi.fn<Overseer['createCanvas']>(), editCanvas: vi.fn<Overseer['editCanvas']>(), deleteCanvas: vi.fn<Overseer['deleteCanvas']>() }) })
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
    // One load: the board's own connection, then its organization's account connection.
    await act(async () => observer.report([{ isIntersecting: true }]))
    expect(lookup).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('Not connected')
    await act(async () => observer.report([{ isIntersecting: false }]))
    expect(lookup).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('Not connected')
  } finally { lookup.mockRestore() }
})

// FAC-82: edit mode is a tree of the view and an inspector for the one selected target.
const twoSections: CanvasDefinition = { ...saved, sections: [...saved.sections, { id: 'side', title: 'Side', columns: 1, widgets: [] }] }
const editable = (views: CanvasDefinition[] = [twoSections]) => {
  const api = withPages({ listCanvases: vi.fn<Overseer['listCanvases']>(async () => views), createCanvas: vi.fn<Overseer['createCanvas']>(),
    editCanvas: vi.fn<Overseer['editCanvas']>(), deleteCanvas: vi.fn<Overseer['deleteCanvas']>() })
  return { api, storage: { kind: 'durable', api } as CanvasStorage }
}
const tree = () => container.querySelector('[aria-label="Edit targets"]')!
const pick = async (name: string) => {
  const item = [...tree().querySelectorAll('button')].find(entry => entry.textContent === name)
  if (!item) throw new Error(`No tree item ${name}`)
  await act(async () => item.click())
}
const breadcrumb = () => container.querySelector('[aria-label="Editing"]')!.textContent
const inspector = () => container.querySelector('[aria-label="Selected target"]')!

it('shows the view as a tree, and says exactly which target the controls edit', async () => {
  const { storage } = editable()
  await render(storage)
  await act(async () => { button('Edit layout')!.click() })
  expect([...tree().querySelectorAll('button')].map(item => item.textContent)).toEqual(['Ops', 'Main', `Project board ${BOARD}`, 'Side'])
  expect(breadcrumb()).toContain('Ops')
  expect(breadcrumb()).toContain('page:ops')
  await pick('Main')
  expect(breadcrumb()).toContain('Workspace')
  expect(breadcrumb()).toContain('Ops')
  expect(breadcrumb()).toContain('Main')
  expect(breadcrumb()).toContain('page:ops/node:main')
  expect(tree().querySelector('[aria-current="true"]')?.textContent).toBe('Main')
  // Only the selected section's controls are shown: none of Side's, and no widget's.
  expect(inspector().textContent).toContain('Section')
  expect([...container.querySelectorAll('button')].filter(item => item.textContent === 'Remove section')).toHaveLength(1)
  expect(container.querySelector('[aria-label="Side"]')).toBeNull()
  expect([...container.querySelectorAll('button')].some(item => item.textContent === 'Remove board')).toBe(false)
})

it('edits only the selected section, leaving its siblings and its widgets alone', async () => {
  const { api, storage } = editable()
  api.editCanvas.mockResolvedValue({ ...twoSections, revision: '1' })
  await render(storage)
  await act(async () => { button('Edit layout')!.click() })
  await pick('Main')
  await act(async () => { button('1 column')!.click() })
  expect(api.editCanvas).toHaveBeenCalledOnce()
  expect(api.editCanvas).toHaveBeenCalledWith('ops', '0', [{ type: 'configureSection', sectionId: 'main', title: 'Main', columns: 1 }])
})

it('edits only the selected widget, and selects its section once the widget is removed', async () => {
  const { api, storage } = editable()
  api.editCanvas.mockResolvedValue({ ...twoSections, revision: '1', sections: [{ ...twoSections.sections[0]!, widgets: [] }, twoSections.sections[1]!] })
  await render(storage)
  await act(async () => { button('Edit layout')!.click() })
  await pick(`Project board ${BOARD}`)
  expect(breadcrumb()).toContain('page:ops/node:b')
  expect(breadcrumb()).toContain('Main')
  expect([...container.querySelectorAll('button')].some(item => item.textContent === 'Remove section')).toBe(false)
  await act(async () => { button('Remove board')!.click() })
  expect(api.editCanvas).toHaveBeenCalledWith('ops', '0', [{ type: 'removeWidget', widgetId: 'b' }])
  expect(breadcrumb()).toContain('page:ops/node:main')
  expect(container.textContent).not.toContain('no longer on this view')
})

it('says so when the selected target is no longer on the view, and edits the view instead', async () => {
  const { api, storage } = editable()
  await render(storage)
  await act(async () => { button('Edit layout')!.click() })
  await pick('Side')
  api.listCanvases.mockResolvedValue([{ ...saved, revision: '3' }])
  await act(async () => { button('Reload saved views')!.click() })
  expect(container.querySelector('[role="status"][aria-label="Selection"]')?.textContent).toContain('no longer on this view')
  expect(breadcrumb()).toContain('page:ops')
  expect(breadcrumb()).not.toContain('node:side')
})

it('names the exact target in a request handed to the agent', async () => {
  const onAskAgent = vi.fn<(request: string) => Promise<void>>(async () => {})
  const { storage } = editable()
  await render(storage, { widgetKinds: ['inferos.gadget'],
    blueprints: [{ blueprintId: 'inferops.kanban', label: 'InferOps Kanban', description: 'A project board.' }], screens: [] }, onAskAgent)
  await act(async () => { button('Edit layout')!.click() })
  await pick('Side')
  await act(async () => { button('InferOps Kanban')!.click() })
  expect(onAskAgent.mock.calls[0]![0]).toContain('(target page:ops/node:side)')
})

// FAC-84: a prompt edit names what the controls edit: the canvas, its page revision and the target.
const describeChange = async (text: string) => {
  const area = inspector().querySelector('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, text)
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it("hands the agent the selected target and the page revision with the person's own words", async () => {
  const onAskAgent = vi.fn<(request: string) => Promise<void>>(async () => {})
  const { storage } = editable([{ ...twoSections, revision: '7' }])
  await render(storage, DEFAULT_CANVAS_CATALOG, onAskAgent)
  await act(async () => { button('Edit layout')!.click() })
  await pick('Side')
  expect(button('Ask the agent')!.disabled).toBe(true)
  await describeChange('Put the board here, full width.')
  await act(async () => { button('Ask the agent')!.click() })
  expect(onAskAgent).toHaveBeenCalledOnce()
  const request = onAskAgent.mock.calls[0]![0]
  expect(request).toContain('change the selected target page:ops/node:side: Put the board here, full width.')
  expect(request).toContain('canvasId ops, expectedRevision 7, target page:ops/node:side')
  expect(request).toContain('publish nothing')
  // Sent, the box is empty again.
  expect(inspector().querySelector('textarea')!.value).toBe('')
})

it('says so when the chat could not start, and keeps the words', async () => {
  const onAskAgent = vi.fn<(request: string) => Promise<void>>(async () => { throw new Error('offline') })
  const { storage } = editable()
  await render(storage, DEFAULT_CANVAS_CATALOG, onAskAgent)
  await act(async () => { button('Edit layout')!.click() })
  await describeChange('Rename it Today.')
  await act(async () => { button('Ask the agent')!.click() })
  expect(onAskAgent.mock.calls[0]![0]).toContain('target page:ops:')
  expect(inspector().querySelector('[role="alert"]')?.textContent).toContain('Could not start the chat')
  expect(inspector().querySelector('textarea')!.value).toBe('Rename it Today.')
})

// FAC-83: nested creation, movement and configuration through typed page operations.
const nestedPage = (revision: string, extra: Partial<CanvasPage> = {}): CanvasPage => {
  const base = canvasPageFromDefinition(twoSections)
  return { ...base, revision, nodes: [
    ...base.nodes.map(node => node.id === 'main' && node.nodeType === 'object' ? { ...node, children: ['inner'] } : node),
    { nodeType: 'object', id: 'inner', title: 'Inner', columns: 1, children: ['b'], attachments: [] },
  ], ...extra }
}
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
const choose = async (label: string, option: string) => {
  const field = [...inspector().querySelectorAll<HTMLElement>('[role="combobox"]')]
    .find(item => item.closest('label, div')?.textContent?.includes(label))
  if (!field) throw new Error(`No select ${label}`)
  await act(async () => field.click()); await settle()
  const item = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(entry => entry.textContent === option)
  if (!item) throw new Error(`No option ${option}`)
  // Base UI selects on the press sequence, not a bare click; jsdom has no PointerEvent.
  if (!('PointerEvent' in window)) Object.defineProperty(window, 'PointerEvent', { value: class extends MouseEvent {} })
  await act(async () => {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      item.dispatchEvent(new (type.startsWith('pointer') ? window.PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true }))
    }
  })
  await settle()
}
const submitIn = async (field: string, value: string) => {
  const input = [...inspector().querySelectorAll<HTMLInputElement>('input')].find(item => item.name === field)!
  input.value = value
  await act(async () => { input.form!.requestSubmit() })
}

it('nests an object in the selected section and moves a widget into it, each as one page operation for that target', async () => {
  const { api, storage } = editable()
  api.editCanvasPage.mockImplementation(async (_id, revision, operations) => {
    const added = operations[0]
    if (added?.type === 'addObject') {
      const base = canvasPageFromDefinition(twoSections)
      return { ...base, revision: '1', nodes: [
        ...base.nodes.map(node => node.id === 'main' && node.nodeType === 'object' ? { ...node, children: ['b', added.object.id] } : node),
        { nodeType: 'object', id: added.object.id, title: 'Inner', columns: 1, children: [], attachments: [] },
      ] }
    }
    expect(revision).toBe('1')
    return nestedPage('2')
  })
  await render(storage)
  await act(async () => { button('Edit layout')!.click() })
  await pick('Main')
  await submitIn('child', 'Inner')
  expect(api.editCanvasPage).toHaveBeenLastCalledWith('ops', '0', [
    { type: 'addObject', parent: 'main', index: 1, object: { id: expect.any(String), title: 'Inner', columns: 1 } }])
  expect(api.editCanvas).not.toHaveBeenCalled()
  // The tree shows what the store saved: the new object, in its section.
  await pick('Inner')
  expect(breadcrumb()).toContain('Main')
  await pick(`Project board ${BOARD}`)
  await choose('Move into', 'Inner')
  await act(async () => { button('Move')!.click() })
  const inner = (api.editCanvasPage.mock.calls[0]![2][0] as Extract<CanvasPageOperation, { type: 'addObject' }>).object.id
  expect(api.editCanvasPage).toHaveBeenLastCalledWith('ops', '1', [{ type: 'moveNode', nodeId: 'b', parent: inner, index: 0 }])
  expect(container.textContent).toContain('This view has nested objects')
})

it('reports a conflicting nested edit in the server\'s words, and keeps the view it had', async () => {
  const { api, storage } = editable()
  api.editCanvasPage.mockRejectedValue(new Error('Canvas changed; reload before applying this edit'))
  await render(storage)
  await act(async () => { button('Edit layout')!.click() })
  await pick('Main')
  await submitIn('child', 'Inner')
  const alert = container.querySelector('[role="alert"]')?.textContent ?? ''
  expect(alert).toContain('Canvas changed; reload before applying this edit')
  expect(alert).toContain('Nothing was overwritten')
  expect([...tree().querySelectorAll('button')].some(item => item.textContent === 'Inner')).toBe(false)
})

it('removes a nested object from the view only, saying records stay, and edits its attachments one target at a time', async () => {
  const { api, storage } = editable()
  api.getCanvasPage.mockResolvedValue(nestedPage('0'))
  api.editCanvasPage.mockImplementation(async (_id, _revision, operations) => operations[0]?.type === 'removeNode'
    ? { ...canvasPageFromDefinition(twoSections), revision: '1', nodes: canvasPageFromDefinition(twoSections).nodes
      .filter(node => node.id !== 'b').map(node => node.id === 'main' && node.nodeType === 'object' ? { ...node, children: [] } : node) }
    : nestedPage('1'))
  await render(storage)
  await act(async () => { button('Edit layout')!.click() })
  await pick(`Project board ${BOARD}`)
  await choose('When', 'action-completed')
  await choose('Open', 'Ops')
  await act(async () => { button('Add attachment')!.click() })
  expect(api.editCanvasPage).toHaveBeenLastCalledWith('ops', '0', [{ type: 'setAttachments', target: 'b',
    attachments: [{ id: expect.any(String), version: 1, on: 'action-completed', effect: { kind: 'navigate', page: 'ops' } }] }])
  await pick('Inner')
  expect(inspector().textContent).toContain('Gadgets and InferOps records are unchanged.')
  await act(async () => { button('Remove from view')!.click() })
  expect(api.editCanvasPage).toHaveBeenLastCalledWith('ops', '1', [{ type: 'removeNode', nodeId: 'inner' }])
  // What held it is selected.
  expect(breadcrumb()).toContain('page:ops/node:main')
})

// FAC-94: a gadget widget's attachments listen for the events its states.json declares.
const gadgetView = (gadgetId: number): CanvasDefinition => ({ ...saved, sections: [{ id: 'main', title: 'Main', columns: 1,
  widgets: [{ id: 'g', kind: 'inferos.gadget', version: 1, targetRef: `gadget:${gadgetId}`, size: 'normal', params: {} }] }] })
const gadgetsWith = (commitId: string) => new Map<WorkpieceId, GadgetSummary>([[7, { id: 7, type: 'gadget', title: 'Intake form', commitId } as GadgetSummary]])
const pickWidget = async () => {
  const item = [...tree().querySelectorAll('button')].find(entry => entry.textContent?.includes('Intake form'))
  if (!item) throw new Error('No gadget widget in the tree')
  await act(async () => item.click()); await settle()
}

it('offers a gadget widget\'s own declared events, not action events, and wires one to a view', async () => {
  const { api, storage } = editable([gadgetView(7)])
  api.editCanvasPage.mockImplementation(async () => ({ ...canvasPageFromDefinition(gadgetView(7)), revision: '1' }))
  await render(storage, DEFAULT_CANVAS_CATALOG, undefined, null, gadgetsWith('fac94-stateful'))
  await act(async () => { button('Edit layout')!.click() })
  await pickWidget()
  await choose('When', 'submit')
  // The list offered was the widget's own events, in declaration order, and no action event.
  expect([...document.querySelectorAll('[role="option"]')].map(item => item.textContent)).toEqual(['submit', 'reopen'])
  await choose('Open', 'Ops')
  await act(async () => { button('Add attachment')!.click() })
  expect(api.editCanvasPage).toHaveBeenLastCalledWith('ops', '0', [{ type: 'setAttachments', target: 'g',
    attachments: [{ id: expect.any(String), version: 1, on: 'submit', effect: { kind: 'navigate', page: 'ops' } }] }])
})

it('says a gadget widget with no states declares no events, and offers none', async () => {
  const { storage } = editable([gadgetView(7)])
  await render(storage, DEFAULT_CANVAS_CATALOG, undefined, null, gadgetsWith('fac94-plain'))
  await act(async () => { button('Edit layout')!.click() })
  await pickWidget()
  expect(inspector().textContent).toContain('This widget declares no events and its gadget has no triggers, so nothing on the page can listen for one.')
  expect(button('Add attachment')).toBeUndefined()
})

it('reads the nested page only in edit mode, so viewing (as the use role does) never asks for it', async () => {
  const { api, storage } = editable()
  await render(storage)
  expect(api.getCanvasPage).not.toHaveBeenCalled()
  await act(async () => { button('Edit layout')!.click() })
  await settle()
  expect(api.getCanvasPage).toHaveBeenCalledWith('ops')
})

// FAC-116: a gadget widget's attachment may also hear the run results of a trigger its gadget binds.
const hook = (id: number, gadgetId: number, title: string) =>
  ({ id, gatekeeperId: 2, gadgetId, description: { title }, enabled: true })

it("offers the run results of its own gadget's triggers beside its own events, and wires one to a view", async () => {
  hooks = async () => [hook(11, 7, 'Refunds'), hook(12, 8, 'Another gadget')]
  const { api, storage } = editable([gadgetView(7)])
  api.editCanvasPage.mockImplementation(async () => ({ ...canvasPageFromDefinition(gadgetView(7)), revision: '1' }))
  await render(storage, DEFAULT_CANVAS_CATALOG, undefined, null, gadgetsWith('fac94-stateful'))
  await act(async () => { button('Edit layout')!.click() })
  await pickWidget()
  await choose('When', 'Refunds: Finished')
  // Its own events first, then only its own gadget's trigger, never another gadget's.
  expect([...document.querySelectorAll('[role="option"]')].map(item => item.textContent)).toEqual([
    'submit', 'reopen', 'Refunds: Finished', "Refunds: Didn't finish", 'Refunds: Uncertain'])
  await choose('Open', 'Ops')
  await act(async () => { button('Add attachment')!.click() })
  expect(api.editCanvasPage).toHaveBeenLastCalledWith('ops', '0', [{ type: 'setAttachments', target: 'g',
    attachments: [{ id: expect.any(String), version: 1, on: canvasRunEvent('run-succeeded', 11), effect: { kind: 'navigate', page: 'ops' } }] }])
})

it('offers a run result on a widget that declares no events of its own, and none on one whose gadget has no trigger', async () => {
  hooks = async () => [hook(11, 7, 'Refunds')]
  const { storage } = editable([gadgetView(7)])
  await render(storage, DEFAULT_CANVAS_CATALOG, undefined, null, gadgetsWith('fac94-plain'))
  await act(async () => { button('Edit layout')!.click() })
  await pickWidget()
  await choose('When', 'Refunds: Uncertain')
  expect([...document.querySelectorAll('[role="option"]')].map(item => item.textContent)).toEqual([
    'Refunds: Finished', "Refunds: Didn't finish", 'Refunds: Uncertain'])
})

it("says when the gadget's triggers can't be read, and still offers the widget's own events", async () => {
  hooks = async () => { throw new Error('Workspace unavailable') }
  const { storage } = editable([gadgetView(7)])
  await render(storage, DEFAULT_CANVAS_CATALOG, undefined, null, gadgetsWith('fac94-stateful'))
  await act(async () => { button('Edit layout')!.click() })
  await pickWidget()
  expect(inspector().querySelector('[role="alert"]')?.textContent).toBe("This gadget's triggers couldn't be read: Workspace unavailable")
  await choose('When', 'submit')
  expect([...document.querySelectorAll('[role="option"]')].map(item => item.textContent)).toEqual(['submit', 'reopen'])
})

it("says it's reading the gadget's triggers until they arrive", async () => {
  hooks = () => new Promise(() => {})
  const { storage } = editable([gadgetView(7)])
  await render(storage, DEFAULT_CANVAS_CATALOG, undefined, null, gadgetsWith('fac94-plain'))
  await act(async () => { button('Edit layout')!.click() })
  await pickWidget()
  expect(inspector().textContent).toContain("Reading this gadget's triggers…")
})

it('describes a wired run result in words', async () => {
  hooks = async () => [hook(11, 7, 'Refunds')]
  const wired = canvasPageFromDefinition(gadgetView(7))
  const page = { ...wired, nodes: wired.nodes.map(node => node.nodeType === 'widget'
    ? { ...node, attachments: [{ id: 'r', version: 1 as const, on: canvasRunEvent('run-failed', 11), effect: { kind: 'navigate' as const, page: 'ops' } }] }
    : node) }
  const { api, storage } = editable([gadgetView(7)])
  api.getCanvasPage.mockImplementation(async () => page)
  await render(storage, DEFAULT_CANVAS_CATALOG, undefined, null, gadgetsWith('fac94-plain'))
  await act(async () => { button('Edit layout')!.click() })
  await pickWidget()
  expect(inspector().textContent).toContain("When a Refunds run didn't finish, open Ops")
})
