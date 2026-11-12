// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// FAC-13: one placement on a person's canvas. A console widget is opened through the Wiki embed's
// checked path every time; one that can't be opened (withdrawn, no longer offered, access ended)
// says it is no longer available and why, never empty, and stays on the canvas as a reference to
// remove. A shown one keeps its own state, keyed by the placement. A board keeps its one filter
// on the placement. Each arrangement control is offered only when the grid would take it.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { OperateSession, Overseer } from '@gadgets/workshop-shared/api'
import type { OperateWidgetRef } from '@gadgets/workshop-shared/widget-state'
import type { WidgetPlacement } from '@gadgets/workshop-shared/widget-placements'
import type { EmbeddedWidgetShown } from '../canvas/useEmbeddedConsoleWidget'

const embed = vi.hoisted(() => ({ shown: { status: 'loading' } as EmbeddedWidgetShown }))
const seen = vi.hoisted(() => ({ stateRefs: [] as OperateWidgetRef[], boards: [] as { showCompleted: boolean }[] }))
vi.mock('../canvas/useEmbeddedConsoleWidget', async (importActual) => ({
  ...(await importActual<typeof import('../canvas/useEmbeddedConsoleWidget')>()),
  useEmbeddedConsoleWidget: () => embed.shown,
}))
vi.mock('../canvas/WidgetStateBar', () => ({
  WidgetStateBar: ({ widgetRef }: { widgetRef: OperateWidgetRef }) => { seen.stateRefs.push(widgetRef); return <p>state bar</p> },
}))
vi.mock('../../GadgetUI', () => ({ default: () => <iframe title="widget" sandbox="" /> }))
vi.mock('../canvas/CanvasBoardWidget', () => ({
  CanvasBoardWidget: ({ widget }: { widget: { params: { showCompleted: boolean } } }) => { seen.boards.push(widget.params); return <p>board</p> },
}))
vi.mock('./BoardConnectPrompt', () => ({ BoardConnectPrompt: () => null }))
import { PlacedWidget } from './PlacedWidget'

const CONSOLE_REF = { type: 'console-widget' as const, workspaceId: 'ops', consoleId: 'desk', sourceGadgetId: 12, blueprintId: 'bp-refunds', version: 2 }
const placement = (ref: WidgetPlacement['ref'], filters: Record<string, string> = {}): WidgetPlacement =>
  ({ placementId: 'p1', ref, layout: { x: 0, y: 0, w: 6, h: 5 }, filters, updatedAt: 0 })

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  seen.stateRefs = []; seen.boards = []
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

const render = async (shown: WidgetPlacement, handlers: { onRemove?: () => void; onFilters?: (f: Record<string, string>) => void } = {},
    canChange: (change: string) => boolean = () => true) => {
  await act(async () => root.render(<PlacedWidget placement={shown} api={undefined} viewer={null}
    session={{} as RpcStub<OperateSession>} sessionWorkspace={{} as RpcStub<Overseer>} focused={false}
    edit={{ busy: false, canChange, onChange: () => {}, onFilters: handlers.onFilters ?? (() => {}), onRemove: handlers.onRemove ?? (() => {}) }} />))
}
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!

it('says a widget that can no longer be opened is no longer available, and why, and keeps it to remove', async () => {
  const cases: [EmbeddedWidgetShown, string][] = [
    [{ status: 'no-access' }, 'You can no longer open the workspace it is in.'],
    [{ status: 'unavailable', reason: 'not-offered' }, 'Its console no longer offers this widget.'],
    [{ status: 'unavailable', reason: 'not-published' }, 'Its console is not published'],
    [{ status: 'revoked' }, 'Its console changed, or your access to it ended.'],
  ]
  const onRemove = vi.fn<() => void>()
  for (const [shown, why] of cases) {
    embed.shown = shown
    await render(placement(CONSOLE_REF), { onRemove })
    const text = container.textContent ?? ''
    expect(text).toContain('No longer available.')
    expect(text).toContain(why)
    expect(text).toContain('It stays on your canvas until you remove it.')
    expect(container.querySelector('iframe')).toBeNull()
  }
  await act(async () => button('Remove from canvas').click())
  expect(onRemove).toHaveBeenCalledOnce()
})

it('says it could not open a widget, in the words it was refused with', async () => {
  embed.shown = { status: 'error', message: 'This widget has no UI.' }
  await render(placement(CONSOLE_REF))
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Couldn’t open this widget: This widget has no UI.')
})

it("shows an open widget with its own state, keyed by the placement, and says when it was updated since", async () => {
  embed.shown = { status: 'ready', stub: {} as never, widget: {
    status: 'available', consoleId: 'desk', revision: '5', gadgetId: 41, label: 'Refunds', blueprintId: 'bp-refunds', version: 3,
  } as never }
  await render(placement(CONSOLE_REF))
  expect(container.querySelector('iframe')).not.toBeNull()
  expect(seen.stateRefs.at(-1)).toEqual({ workspaceId: 'ops', consoleId: 'desk', revision: '5', gadgetId: 41, placementId: 'p1' })
  expect(container.textContent).toContain('Updated since it was placed')
})

it("keeps a board's completed-issues filter on the placement", async () => {
  const onFilters = vi.fn<(filters: Record<string, string>) => void>()
  await render(placement({ type: 'builtin', kind: 'project/board', target: 'inferops://acme.operations/project/board/ENG' }, { showCompleted: 'true' }), { onFilters })
  expect(seen.boards.at(-1)).toEqual({ workflow: 'software', showCompleted: true })
  // The checkbox's own input, as the person's click on its label reaches it.
  const box = container.querySelector<HTMLInputElement>('label input[type="checkbox"]')!
  await act(async () => box.click())
  expect(onFilters).toHaveBeenCalledWith({ showCompleted: 'false' })
})

// #489's review: the board's "Show completed" control is the arranging person's own, shown only with edit.
it('offers the Show completed filter on a board only when the placement can be edited', async () => {
  const board = placement({ type: 'builtin', kind: 'project/board', target: 'inferops://acme.operations/project/board/ENG' })
  await render(board)
  const box = container.querySelector<HTMLInputElement>('label input[type="checkbox"]')
  expect(box?.closest('label')?.textContent).toContain('Show completed')
  await act(async () => root.render(<PlacedWidget placement={board} api={undefined} viewer={null}
    session={{} as RpcStub<OperateSession>} sessionWorkspace={{} as RpcStub<Overseer>} focused={false} />))
  expect(container.textContent).not.toContain('Show completed')
  expect(container.querySelector('input[type="checkbox"]')).toBeNull()
})

// FAC-137: a temporary canvas shows its placements as placed, with nothing to arrange or filter.
it('shows a placement with nothing to arrange when it is given no edit controls', async () => {
  await act(async () => root.render(<PlacedWidget placement={placement({ type: 'builtin', kind: 'project/board',
    target: 'inferops://acme.operations/project/board/ENG' }, { showCompleted: 'true' })} api={undefined} viewer={null}
    session={{} as RpcStub<OperateSession>} sessionWorkspace={{} as RpcStub<Overseer>} focused={false} />))
  expect(seen.boards.at(-1)).toEqual({ workflow: 'software', showCompleted: true })
  expect(container.querySelector('[role="toolbar"]')).toBeNull()
  expect(container.querySelector('input[type="checkbox"]')).toBeNull()
  expect(container.querySelectorAll('button')).toHaveLength(0)
})

it('offers only the arrangement the grid would take', async () => {
  embed.shown = { status: 'loading' }
  await render(placement(CONSOLE_REF), {}, change => change !== 'left' && change !== 'up')
  expect(button('Move left').disabled).toBe(true)
  expect(button('Move up').disabled).toBe(true)
  expect(button('Move right').disabled).toBe(false)
  expect(button('Taller').disabled).toBe(false)
})
