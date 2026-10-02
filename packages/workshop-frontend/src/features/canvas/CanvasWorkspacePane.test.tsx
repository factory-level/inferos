// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { DEFAULT_CANVAS_CATALOG, type CanvasCatalog } from '@gadgets/workshop-shared/canvas'
import { CanvasWorkspacePane } from './CanvasWorkspacePane'
import type { CanvasStorage } from './useCanvasWorkspace'

vi.mock('../../GadgetUI', () => ({ default: () => null }))

let root: Root
let container: HTMLDivElement
const overseer = {} as RpcStub<Overseer>
const render = async (storage: CanvasStorage, catalog: CanvasCatalog = DEFAULT_CANVAS_CATALOG,
    onAskAgent = vi.fn<(request: string) => Promise<void>>(async () => {})) => {
  await act(async () => root.render(<CanvasWorkspacePane storage={storage} overseer={overseer} gadgets={new Map()}
    catalog={catalog} viewId={null} onViewChange={() => {}} onAskAgent={onAskAgent} />))
}
const button = (name: string) => [...container.querySelectorAll('button')].find(item => item.textContent === name)

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
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
