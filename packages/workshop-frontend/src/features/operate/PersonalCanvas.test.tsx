// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// FAC-13: a person's own Operate canvas. Its four states (loading, an error to retry, empty,
// placed), changes made only at the revision read, and a refused change told apart: after a
// company switch the canvas was cleared and it says so; another tab's change reloads and says
// that; any other refusal is the kernel's words. Each placement is drawn by PlacedWidget and the
// search by WidgetFinder, which have their own tests.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, OperateSession } from '@gadgets/workshop-shared/api'
import type { OperateEventRecord } from '@gadgets/workshop-shared/operate-session'
import type { WidgetPlacement, WidgetPlacementRef, WidgetPlacements } from '@gadgets/workshop-shared/widget-placements'
import type { LayoutChange } from './personalCanvas'

vi.mock('./PlacedWidget', () => ({
  CANVAS_ROW_PX: 80,
  PlacedWidget: ({ placement, edit }: {
    placement: WidgetPlacement
    edit: { canChange: (change: LayoutChange) => boolean; onChange: (change: LayoutChange) => void; onRemove: () => void }
  }) => <article aria-label={`Placed ${placement.placementId}`}>
    <button type="button" disabled={!edit.canChange('right')} onClick={() => edit.onChange('right')}>Move right</button>
    <button type="button" onClick={edit.onRemove}>Remove</button>
  </article>,
}))
vi.mock('./WidgetFinder', () => ({
  WidgetFinder: ({ onPlace }: { onPlace: (ref: WidgetPlacementRef) => Promise<string | null> }) =>
    <button type="button" onClick={() => void onPlace(BOARD)}>Place a board</button>,
}))
import { COMPANY_CHANGED_TEXT, CHANGED_ELSEWHERE_TEXT } from './usePlacements'
import { PersonalCanvas } from './PersonalCanvas'

const BOARD: WidgetPlacementRef = { type: 'builtin', kind: 'project/board', target: 'inferops://acme.operations/project/board/ENG' }
const placed = (placementId: string, x: number, w = 6): WidgetPlacement =>
  ({ placementId, ref: BOARD, layout: { x, y: 0, w, h: 5 }, filters: {}, updatedAt: 0 })
const of = (revision: number, placements: WidgetPlacement[]): WidgetPlacements => ({ revision, placements })
const conflict = () => new Error('WidgetPlacementError: WIDGET_PLACEMENTS_CONFLICT: Your placements changed.')

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

const button = (label: string) => [...container.querySelectorAll('button')].find(b => b.textContent === label)
const render = async (session: Partial<OperateSession>, recentEvents: OperateEventRecord[] = []) => {
  await act(async () => root.render(<PersonalCanvas api={{} as RpcStub<AuthenticatedApi>} viewer={null}
    session={session as RpcStub<OperateSession>} sessionWorkspace={null} recentEvents={recentEvents}
    screens={{ status: 'ready', workspaces: [] }} currentBoard={null} />))
}

it('says it is loading, then that the canvas is empty, and offers to add a widget', async () => {
  let answer!: (placements: WidgetPlacements) => void
  await render({ listWidgetPlacements: () => new Promise(resolve => { answer = resolve }) })
  expect(container.textContent).toContain('Loading your canvas…')
  await act(async () => answer(of(0, [])))
  expect(container.textContent).toContain('Nothing on your canvas yet.')
  expect(button('Add a widget')?.disabled).toBe(false)
})

it("says it couldn't load the canvas, and tries again", async () => {
  const listWidgetPlacements = vi.fn<OperateSession['listWidgetPlacements']>()
    .mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(of(1, [placed('p1', 0)]))
  await render({ listWidgetPlacements })
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load your canvas.")
  await act(async () => button('Try again')!.click())
  expect(container.querySelector('[aria-label="Placed p1"]')).not.toBeNull()
})

it('places a widget in the first free place, at the revision read', async () => {
  const saveWidgetPlacement = vi.fn<OperateSession['saveWidgetPlacement']>(async () => of(4, [placed('p1', 0), placed('p2', 0, 12)]))
  await render({ listWidgetPlacements: async () => of(3, [placed('p1', 0)]), saveWidgetPlacement })
  await act(async () => button('Add a widget')!.click())
  await act(async () => button('Place a board')!.click())
  // A board takes the whole width, so it goes below the half-width widget already there.
  expect(saveWidgetPlacement).toHaveBeenCalledWith({ ref: BOARD, layout: { x: 0, y: 5, w: 12, h: 6 } }, 3)
  expect(container.querySelector('[aria-label="Placed p2"]')).not.toBeNull()
})

it('moves a placement only where nothing else is, keeping its filters', async () => {
  const saveWidgetPlacement = vi.fn<OperateSession['saveWidgetPlacement']>(async () => of(2, [placed('p1', 1)]))
  await render({ listWidgetPlacements: async () => of(1, [placed('p1', 0), placed('p2', 6)]), saveWidgetPlacement })
  const [first, second] = [...container.querySelectorAll('article')]
  // p1 would overlap p2 by moving right; p2 would leave the grid.
  expect(first!.querySelector('button')!.disabled).toBe(true)
  expect(second!.querySelector('button')!.disabled).toBe(true)
  await act(async () => root.unmount())
  root = createRoot(container)
  await render({ listWidgetPlacements: async () => of(1, [placed('p1', 0)]), saveWidgetPlacement })
  await act(async () => button('Move right')!.click())
  expect(saveWidgetPlacement).toHaveBeenCalledWith({ placementId: 'p1', ref: BOARD, layout: { x: 1, y: 0, w: 6, h: 5 }, filters: {} }, 1)
})

it('reads the canvas again after a company switch, and says it was cleared', async () => {
  const listWidgetPlacements = vi.fn<OperateSession['listWidgetPlacements']>()
    .mockResolvedValueOnce(of(1, [placed('p1', 0)])).mockResolvedValueOnce(of(2, []))
  const session = { listWidgetPlacements }
  await render(session)
  // The person moved to another company in another tab: the session's log records it.
  const switched = [{ seq: 9, event: { type: 'companyChanged' }, actor: 'person', at: new Date(Date.now() + 1000) }] as unknown as OperateEventRecord[]
  await render(session, switched)
  expect(listWidgetPlacements).toHaveBeenCalledTimes(2)
  expect(container.textContent).toContain(COMPANY_CHANGED_TEXT)
  expect(container.textContent).toContain('Nothing on your canvas yet.')
})

it("reloads when another tab changed the canvas first, and says so, never writing over it", async () => {
  const listWidgetPlacements = vi.fn<OperateSession['listWidgetPlacements']>()
    .mockResolvedValueOnce(of(1, [placed('p1', 0)])).mockResolvedValueOnce(of(2, [placed('p1', 3)]))
  const saveWidgetPlacement = vi.fn<OperateSession['saveWidgetPlacement']>(async () => { throw conflict() })
  await render({ listWidgetPlacements, saveWidgetPlacement })
  await act(async () => button('Move right')!.click())
  expect(saveWidgetPlacement).toHaveBeenCalledOnce()
  expect(listWidgetPlacements).toHaveBeenCalledTimes(2)
  expect(container.textContent).toContain(CHANGED_ELSEWHERE_TEXT)
  expect(container.textContent).not.toContain(COMPANY_CHANGED_TEXT)
})

it("shows any other refusal in the kernel's words, changing nothing", async () => {
  const saveWidgetPlacement = vi.fn<OperateSession['saveWidgetPlacement']>(async () => {
    throw new Error('WidgetPlacementError: WIDGET_PLACEMENT_INVALID: A placement fits within 12 columns.')
  })
  await render({ listWidgetPlacements: async () => of(1, [placed('p1', 0)]), saveWidgetPlacement })
  await act(async () => button('Move right')!.click())
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('A placement fits within 12 columns.')
  expect(container.querySelector('[aria-label="Placed p1"]')).not.toBeNull()
})
