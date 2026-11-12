// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// FAC-137: the person's temporary canvases in their Operate session. Each says it is temporary and
// when it expires, as the server set it; saving and removing are the person's own actions; an
// expired one can no longer be opened or saved; every state is drawn.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, OperateSession } from '@gadgets/workshop-shared/api'
import { TEMPORARY_CANVAS_EXPIRED, type TemporaryCanvas } from '@gadgets/workshop-shared/temporary-canvas'
import type { WidgetPlacement } from '@gadgets/workshop-shared/widget-placements'
import { TemporaryCanvases } from './TemporaryCanvases'

const seen = vi.hoisted(() => ({ placed: [] as { placementId: string; editable: boolean }[] }))
vi.mock('./PlacedWidget', () => ({
  CANVAS_ROW_PX: 80,
  PlacedWidget: ({ placement, edit }: { placement: WidgetPlacement; edit?: unknown }) => {
    seen.placed.push({ placementId: placement.placementId, editable: edit !== undefined })
    return <p>placed {placement.placementId}</p>
  },
}))

const NOW = new Date('2026-11-12T12:00:00Z').getTime()
const placement: WidgetPlacement = {
  placementId: 'p-1', ref: { type: 'builtin', kind: 'project/board', target: 'inferops://acme.operations/project/board/JOB' },
  layout: { x: 0, y: 0, w: 12, h: 8 }, filters: {}, updatedAt: NOW - 60_000,
}
const canvas = (extra: Partial<TemporaryCanvas> = {}): TemporaryCanvas => ({
  id: 'tc-1', title: 'Kitchen rewire', placements: [placement], revision: 1, createdAt: new Date(NOW - 60_000),
  expiresAt: new Date(NOW + 60 * 60 * 1000), ...extra,
})

const listTemporaryCanvases = vi.fn<() => Promise<TemporaryCanvas[]>>()
const getTemporaryCanvas = vi.fn<(id: string) => Promise<TemporaryCanvas>>()
const saveTemporaryCanvas = vi.fn<(id: string, revision: number) => Promise<TemporaryCanvas>>()
const removeTemporaryCanvas = vi.fn<(id: string, revision: number) => Promise<void>>()
const session = { listTemporaryCanvases, getTemporaryCanvas, saveTemporaryCanvas, removeTemporaryCanvas } as unknown as RpcStub<OperateSession>
const refused = (code: string) => new Error(`${code}: refused`)

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(NOW)
  seen.placed = []
  for (const fn of [listTemporaryCanvases, getTemporaryCanvas, saveTemporaryCanvas, removeTemporaryCanvas]) fn.mockReset()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals() })

const render = () => act(async () => root.render(<TemporaryCanvases session={session} api={{} as RpcStub<AuthenticatedApi>}
  viewer={null} sessionWorkspace={null} />))
const button = (text: string) => [...container.querySelectorAll('button')].find(b => b.textContent === text)
const click = (text: string) => act(async () => { button(text)!.click() })
const buttons = () => [...container.querySelectorAll('button')].map(b => b.textContent)

it('says it is loading, then lists each canvas as temporary with the expiry the server set', async () => {
  let answer!: (canvases: TemporaryCanvas[]) => void
  listTemporaryCanvases.mockReturnValue(new Promise(resolve => { answer = resolve }))
  await render()
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Loading your temporary canvases…')
  const expiresAt = new Date(NOW + 60 * 60 * 1000)
  await act(async () => answer([canvas({ expiresAt })]))
  expect(container.textContent).toContain('Kitchen rewire')
  expect(container.textContent).toContain('1 widget')
  expect(container.textContent).toContain(`Temporary · expires ${expiresAt.toLocaleString()} unless saved`)
  expect(container.querySelector('time')?.getAttribute('dateTime')).toBe(expiresAt.toISOString())
  expect(buttons()).toEqual(['Refresh', 'Open', 'Save', 'Remove…'])
})

it('draws the empty, error and unavailable states, with a retry after an error', async () => {
  listTemporaryCanvases.mockResolvedValue([])
  await render()
  expect(container.textContent).toContain('No temporary canvases. Ask your Dot to compose one')

  vi.spyOn(console, 'error').mockImplementation(() => {})
  listTemporaryCanvases.mockReset().mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce([canvas()])
  act(() => root.unmount()); root = createRoot(container)
  await render()
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Couldn’t load your temporary canvases.')
  await click('Try again')
  expect(container.textContent).toContain('Kitchen rewire')

  listTemporaryCanvases.mockReset().mockRejectedValue(refused('TEMPORARY_CANVASES_UNAVAILABLE'))
  act(() => root.unmount()); root = createRoot(container)
  await render()
  expect(container.querySelector('[role="status"]')?.textContent).toContain('kept in your own Operate session')
  expect(buttons()).toEqual([])
})

it('opens a canvas as it is now, with its widgets shown as placed and nothing to arrange', async () => {
  listTemporaryCanvases.mockResolvedValue([canvas()])
  getTemporaryCanvas.mockResolvedValue(canvas({ revision: 2 }))
  await render()
  await click('Open')
  expect(getTemporaryCanvas).toHaveBeenCalledWith('tc-1')
  expect(container.querySelector('[role="region"]')?.getAttribute('aria-label')).toBe('Kitchen rewire canvas')
  expect(seen.placed.at(-1)).toEqual({ placementId: 'p-1', editable: false })
  await click('Close')
  expect(container.querySelector('[role="region"]')).toBeNull()
})

it('saves a canvas at the revision it read, after which it no longer expires', async () => {
  listTemporaryCanvases.mockResolvedValue([canvas({ revision: 3 })])
  saveTemporaryCanvas.mockResolvedValue(canvas({ revision: 4, expiresAt: undefined }))
  await render()
  await click('Save')
  expect(saveTemporaryCanvas).toHaveBeenCalledWith('tc-1', 3)
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Saved “Kitchen rewire”. It no longer expires.')
  expect(container.textContent).toContain('Saved')
  expect(container.textContent).not.toContain('Temporary · expires')
  expect(buttons()).toEqual(['Refresh', 'Dismiss', 'Open', 'Remove…'])
})

it('says a save the server refused because the canvas expired first, and reads the list again', async () => {
  listTemporaryCanvases.mockResolvedValueOnce([canvas()]).mockResolvedValueOnce([])
  saveTemporaryCanvas.mockRejectedValue(refused('TEMPORARY_CANVAS_EXPIRED'))
  await render()
  await click('Save')
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(TEMPORARY_CANVAS_EXPIRED)
  expect(listTemporaryCanvases).toHaveBeenCalledTimes(2)
  expect(container.textContent).toContain('No temporary canvases.')
})

it('says a conflicting or missing canvas plainly, and shows it as it is now', async () => {
  listTemporaryCanvases.mockResolvedValueOnce([canvas()]).mockResolvedValueOnce([canvas({ revision: 2, title: 'Kitchen rewire v2' })])
  saveTemporaryCanvas.mockRejectedValue(refused('TEMPORARY_CANVAS_CONFLICT'))
  await render()
  await click('Save')
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('It changed since this page read it.')
  expect(container.textContent).toContain('Kitchen rewire v2')

  listTemporaryCanvases.mockReset().mockResolvedValue([])
  getTemporaryCanvas.mockRejectedValue(refused('TEMPORARY_CANVAS_NOT_FOUND'))
  await click('Open')
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('It is gone: removed, expired, or your company changed.')
})

it('removes a canvas only after the person confirms, and changes nothing it shows', async () => {
  listTemporaryCanvases.mockResolvedValue([canvas({ revision: 5 })])
  removeTemporaryCanvas.mockResolvedValue()
  await render()
  await click('Remove…')
  expect(removeTemporaryCanvas).not.toHaveBeenCalled()
  expect(container.textContent).toContain('Remove “Kitchen rewire”? Nothing it shows is changed.')
  await click('Keep it')
  expect(removeTemporaryCanvas).not.toHaveBeenCalled()
  await click('Remove…')
  await click('Remove')
  expect(removeTemporaryCanvas).toHaveBeenCalledWith('tc-1', 5)
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Removed “Kitchen rewire”.')
  expect(container.textContent).toContain('No temporary canvases.')
})

it('reads as expired once its server time passes while open: closed, and no longer offered to open or save', async () => {
  listTemporaryCanvases.mockResolvedValue([canvas({ expiresAt: new Date(NOW + 5_000) })])
  getTemporaryCanvas.mockResolvedValue(canvas({ expiresAt: new Date(NOW + 5_000) }))
  await render()
  await click('Open')
  expect(container.querySelector('[role="region"]')).not.toBeNull()
  await act(async () => { vi.advanceTimersByTime(5_000) })
  expect(container.textContent).toContain('Expired')
  expect(container.textContent).toContain(TEMPORARY_CANVAS_EXPIRED)
  expect(container.querySelector('[role="region"]')).toBeNull()
  expect(buttons()).toEqual(['Refresh'])
  expect(saveTemporaryCanvas).not.toHaveBeenCalled()
})
