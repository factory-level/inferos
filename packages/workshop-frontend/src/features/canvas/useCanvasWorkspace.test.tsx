// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { CanvasDefinition } from '@gadgets/workshop-shared/canvas'
import { useCanvasWorkspace, type CanvasStorage } from './useCanvasWorkspace'

let root: Root
let container: HTMLDivElement
let canvas: ReturnType<typeof useCanvasWorkspace>
const initial = (): CanvasDefinition => ({ schemaVersion: 1, id: 'saved-view', revision: '0', title: 'Saved', sections: [] })
const api = () => ({
  listCanvases: vi.fn<Overseer['listCanvases']>(async () => [initial()]),
  createCanvas: vi.fn<Overseer['createCanvas']>(async () => initial()),
  editCanvas: vi.fn<Overseer['editCanvas']>(async () => ({ ...initial(), revision: '1', title: 'Edited' })),
  deleteCanvas: vi.fn<Overseer['deleteCanvas']>(async () => {}),
})
const Probe = ({ storage }: { storage: CanvasStorage }) => {
  canvas = useCanvasWorkspace(storage)
  return <div><span>{canvas.active?.title ?? 'No view'}</span><output>{canvas.busy ? 'Busy' : 'Ready'}</output>
    {canvas.error && <p role="alert">{canvas.error}</p>}</div>
}
const render = async (storage: CanvasStorage) => { await act(async () => root.render(<Probe storage={storage} />)) }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

it('keeps temporary edits in memory and undo restores content with a new revision', async () => {
  await render({ kind: 'temporary' })
  await act(async () => { await canvas.create({ title: 'Temporary', sections: [] }) })
  expect(container.textContent).toContain('Temporary')
  await act(async () => { await canvas.edit([{ type: 'rename', title: 'Changed' }]) })
  expect(container.textContent).toContain('Changed')
  expect(canvas.active?.revision).toBe('1')
  await act(async () => { await canvas.undo() })
  expect(container.textContent).toContain('Temporary')
  expect(canvas.active?.revision).toBe('2')
  expect(canvas.canUndo).toBe(false)
})

it('retains the displayed snapshot on a rejected write and reloads authoritative state', async () => {
  const remote = api()
  remote.editCanvas.mockRejectedValueOnce(new Error('Canvas changed'))
  await render({ kind: 'durable', api: remote })
  await act(async () => { await canvas.edit([{ type: 'rename', title: 'Stale edit' }]) })
  expect(container.textContent).toContain('Saved')
  expect(container.querySelector('[role="alert"]')).not.toBeNull()
  expect(canvas.canUndo).toBe(false)
  remote.listCanvases.mockResolvedValueOnce([{ ...initial(), revision: '4', title: 'Other editor' }])
  await act(async () => { await canvas.reload() })
  expect(container.textContent).toContain('Other editor')
  expect(canvas.active?.revision).toBe('4')
})

it('ignores late reads from a previous workspace', async () => {
  const old = api()
  let finish!: (value: CanvasDefinition[]) => void
  old.listCanvases.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  await render({ kind: 'durable', api: old })
  await render({ kind: 'temporary' })
  await act(async () => { finish([initial()]) })
  expect(container.textContent).toContain('No view')
  expect(container.textContent).toContain('Ready')
})

it('does not import into an old workspace after a slow file read', async () => {
  const old = api()
  await render({ kind: 'durable', api: old })
  let finish!: (value: string) => void
  const file = new File(['{}'], 'view.json', { type: 'application/json' })
  Object.defineProperty(file, 'text', { value: () => new Promise<string>(resolve => { finish = resolve }) })
  let importing!: Promise<boolean>
  await act(async () => { importing = canvas.importDefinition(file) })
  await render({ kind: 'temporary' })
  await act(async () => { finish(JSON.stringify(initial())); await importing })
  expect(old.createCanvas).not.toHaveBeenCalled()
  expect(container.textContent).toContain('No view')
})

it('moves a board between sections, undoes the move and imports with a fresh view identity', async () => {
  await render({ kind: 'temporary' })
  await act(async () => { await canvas.create({ title: 'Portable', sections: [
    { id: 'from', title: 'First', columns: 1, widgets: [{ id: 'board', kind: 'inferops.project-board', version: 1,
      targetRef: 'inferops://demo.local/project/board/DEMO', size: 'full', params: { workflow: 'software', showCompleted: false } }] },
    { id: 'to', title: 'Second', columns: 2, widgets: [] },
  ] }) })
  const originalId = canvas.active!.id
  await act(async () => { await canvas.edit([{ type: 'moveWidget', widgetId: 'board', sectionId: 'to', index: 0 }]) })
  expect(canvas.active!.sections.map(section => section.widgets.length)).toEqual([0, 1])
  expect(canvas.active!.sections[1].widgets[0].id).toBe('board')
  await act(async () => { await canvas.undo() })
  expect(canvas.active!.sections.map(section => section.widgets.length)).toEqual([1, 0])
  const portable = JSON.stringify(canvas.active)
  const file = new File([portable], 'canvas.json')
  Object.defineProperty(file, 'text', { value: async () => portable })
  await act(async () => { await canvas.importDefinition(file) })
  expect(canvas.active!.id).not.toBe(originalId)
  expect(canvas.active!.revision).toBe('0')
  expect(canvas.active!.sections).toEqual(JSON.parse(portable).sections)
})
