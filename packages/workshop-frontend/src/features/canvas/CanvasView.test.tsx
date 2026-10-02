// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { GadgetSummary, Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'
import type { CanvasDefinition, CanvasWidget } from '@gadgets/workshop-shared/canvas'
import { CanvasView } from './CanvasView'

vi.mock('../../GadgetUI', () => ({
  default: ({ isVisible }: { isVisible: boolean }) => <div data-testid="gadget-ui">{isVisible ? 'visible' : 'deferred'}</div>,
}))

let root: Root
let container: HTMLDivElement
const disposed: WorkpieceId[] = []
const overseer = {
  getGadget: vi.fn<(id: WorkpieceId) => object>((id: WorkpieceId) => ({ [Symbol.dispose]: () => { disposed.push(id) } })),
} as unknown as RpcStub<Overseer>
const gadgetWidget = (id: string, ref: string): CanvasWidget => ({ id, kind: 'inferos.gadget', version: 1, targetRef: ref, size: 'normal', params: {} })
const definition = (widgets: CanvasWidget[]): CanvasDefinition => ({ schemaVersion: 1, id: 'ops', revision: '0', title: 'Ops',
  sections: [{ id: 'main', title: 'Main', columns: 2, widgets }] })
const summaries = (...gadgets: GadgetSummary[]) => new Map(gadgets.map(gadget => [gadget.id, gadget]))
const render = async (view: CanvasDefinition, gadgets: Map<WorkpieceId, GadgetSummary>) => {
  await act(async () => root.render(<CanvasView definition={view} gadgets={gadgets} overseer={overseer} />))
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  disposed.length = 0; vi.mocked(overseer.getGadget).mockClear()
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

it('renders accepted gadgets live beside boards that stay explicitly unconnected', async () => {
  await render(definition([gadgetWidget('g', 'gadget:3'), { id: 'b', kind: 'inferops.project-board', version: 1,
    targetRef: 'inferops://demo.local/project/board/DEMO', size: 'wide', params: { workflow: 'software', showCompleted: false } }]),
  summaries({ id: 3, type: 'gadget', title: 'Shift report', commitId: 'c1' }))
  expect(container.querySelector('[aria-label="Shift report"] [data-testid="gadget-ui"]')?.textContent).toBe('visible')
  expect(overseer.getGadget).toHaveBeenCalledWith(3)
  expect(container.querySelector('[aria-label="Project board inferops://demo.local/project/board/DEMO"]')?.textContent).toContain('Not connected')
})

it('never opens a draft or a missing gadget, and disposes stubs when a widget goes away', async () => {
  await render(definition([gadgetWidget('draft', 'gadget:4'), gadgetWidget('gone', 'gadget:5')]),
    summaries({ id: 4, type: 'gadget', title: 'Draft', chatId: 2 }))
  expect(container.textContent).toContain('still a draft')
  expect(container.textContent).toContain('no longer in the workspace')
  expect(overseer.getGadget).not.toHaveBeenCalled()
  await render(definition([gadgetWidget('g', 'gadget:3')]), summaries({ id: 3, type: 'gadget', title: 'Report' }))
  await render(definition([]), summaries({ id: 3, type: 'gadget', title: 'Report' }))
  expect(disposed).toEqual([3])
})

it('defers loading a gadget until it scrolls near the screen', async () => {
  let observed: ((entries: { isIntersecting: boolean }[]) => void) | undefined
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: typeof observed) { observed = callback }
    observe() {}
    disconnect() {}
  })
  await render(definition([gadgetWidget('g', 'gadget:3')]), summaries({ id: 3, type: 'gadget', title: 'Report' }))
  expect(container.querySelector('[data-testid="gadget-ui"]')?.textContent).toBe('deferred')
  await act(async () => observed?.([{ isIntersecting: true }]))
  expect(container.querySelector('[data-testid="gadget-ui"]')?.textContent).toBe('visible')
})
