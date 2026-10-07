// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CanvasDefinition } from '@gadgets/workshop-shared/canvas'

const state = vi.hoisted(() => {
  const getConsoleScreen = vi.fn<(consoleId: string, screenId: string, source: string) => Promise<CanvasDefinition>>()
  // One workspace capability across renders, as the real hook keeps it.
  return { getConsoleScreen, opened: { overseer: { stub: { getConsoleScreen } } } }
})
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: {} }) }))
vi.mock('../../useWorkspaceOpen', () => ({ useWorkspaceOpen: () => state.opened }))
vi.mock('../../hooks/useWorkspaceWorkpieces', () => ({ useWorkspaceWorkpieces: () => ({ workpieces: new Map(), ready: true }) }))
vi.mock('../canvas/useBoardData', () => ({ useDecidedActionInvalidationInEveryScope: () => {} }))
vi.mock('../canvas/CanvasGadgetWidget', () => ({
  CanvasGadgetWidget: ({ widget, offeredBy }: { widget: { targetRef: string }; offeredBy?: { revision: string } }) =>
    <p data-testid="gadget">{widget.targetRef} at {offeredBy?.revision}</p>,
}))
import { ConsoleWidgetView } from './ConsoleWidgetView'

let container: HTMLDivElement
let root: Root
const screenFor = (gadgetId: number): CanvasDefinition => ({ schemaVersion: 1, id: 's1', revision: '1', title: 'Floor',
  sections: [{ id: 'main', title: 'Now', columns: 1, widgets: [{ id: 'status', kind: 'inferos.gadget', version: 1,
    targetRef: `gadget:${gadgetId}`, size: 'normal', params: {} }] }] })

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  state.getConsoleScreen.mockReset()
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

const render = (revision: string) => act(async () => root.render(<ConsoleWidgetView workspaceId="w1" source="published" revision={revision}
  target={{ consoleId: 'c1', screenId: 's1', widgetId: 'status', presentation: 'page' }} onClose={() => {}} />))

it('reads the screen again when another tab moves the session to a new published revision', async () => {
  state.getConsoleScreen.mockResolvedValueOnce(screenFor(40)).mockResolvedValueOnce(screenFor(41))
  await render('4')
  expect(container.querySelector('[data-testid="gadget"]')?.textContent).toBe('gadget:40 at 4')
  await render('5')
  expect(state.getConsoleScreen).toHaveBeenCalledTimes(2)
  expect(container.querySelector('[data-testid="gadget"]')?.textContent).toBe('gadget:41 at 5')
})
