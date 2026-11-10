// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// FAC-13: finding a widget by intent and choosing what to place. A search that asked nothing says
// why, a partial one says what it couldn't search, and an empty one says nothing matched; the three
// never read alike. A definition is looked for only in workspaces whose published consoles offer
// it, each asked through its own listWidgetInstances; a board is placed by a reference, the one
// open or one typed; a kind this canvas can't show says so.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, Overseer } from '@gadgets/workshop-shared/api'
import type { WidgetSearchAnswer } from '@gadgets/workshop-shared/gatekeeper'
import type { ConsoleWidgetInstance } from '@gadgets/workshop-shared/operate-console'
import type { WidgetPlacementRef } from '@gadgets/workshop-shared/widget-placements'
import type { WorkspaceScreensState } from '../../pages/inferops-canvas/useWorkspaceScreens'
import { SEARCH_UNAVAILABLE, WidgetFinder } from './WidgetFinder'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

const button = (label: string) => [...container.querySelectorAll('button')].find(b => b.textContent === label)
const type = async (label: string, text: string) => {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const searchFor = async (text: string) => {
  await type('What do you want a widget for?', text)
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
}
const searched = (parts: Partial<Extract<WidgetSearchAnswer, { status: 'searched' }>> = {}): WidgetSearchAnswer =>
  ({ status: 'searched', hits: [], definitions: [], ranking: 'semantic', denied: 0, unsearched: 0, ...parts })

const REFUNDS = { sourceId: 'bp-refunds', sourceVersion: 2, title: 'Refunds', purpose: 'Open refunds this week', score: 0.9 }
const workspace = (id: string, title: string, widgets: { blueprintId: string; version: number }[]) => ({
  workspace: { id, title, created: new Date(0), lastActive: new Date(0) }, screens: [], flows: [], publishedScreens: {},
  consoles: [{ id: `c-${id}`, published: widgets.length ? { content: { widgets } } : null }],
}) as never
const instance = (consoleId: string): ConsoleWidgetInstance => ({
  consoleId, consoleTitle: 'Refund desk', revision: '4', sourceGadgetId: 12, gadgetId: 40, label: 'Refunds', blueprintId: 'bp-refunds', version: 2,
})

const render = async (api: Partial<AuthenticatedApi>, screens: WorkspaceScreensState = { status: 'ready', workspaces: [] },
    onPlace = vi.fn<(ref: WidgetPlacementRef) => Promise<string | null>>(async () => null), currentBoard: string | null = null) => {
  await act(async () => root.render(<WidgetFinder api={api as RpcStub<AuthenticatedApi>} screens={screens}
    currentBoard={currentBoard} onPlace={onPlace} />))
  return onPlace
}

it('says why a search asked nothing, never that there are no widgets', async () => {
  for (const reason of ['not-configured', 'not-connected', 'reconnect', 'no-workspace'] as const) {
    await render({ searchWidgets: async () => ({ status: 'unavailable', reason }) })
    await searchFor('refunds')
    expect(container.textContent).toContain(SEARCH_UNAVAILABLE[reason])
    expect(container.textContent).not.toContain('No widgets')
  }
})

it('says nothing matched, and when it is only part of the answer, what it could not search', async () => {
  await render({ searchWidgets: async () => searched({ unsearched: 2, denied: 1 }) })
  await searchFor('refunds')
  expect(container.textContent).toContain('No widgets you may use match “refunds”.')
  expect(container.textContent).toContain("2 places couldn't be searched just now, so this may be incomplete.")
  expect(container.textContent).toContain('You may not search 1 place.')
})

it("says it couldn't search, and searches again", async () => {
  const searchWidgets = vi.fn<AuthenticatedApi['searchWidgets']>()
    .mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(searched({ definitions: [REFUNDS] }))
  await render({ searchWidgets })
  await searchFor('refunds')
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn't search for widgets just now.")
  await act(async () => button('Try again')!.click())
  expect(searchWidgets).toHaveBeenLastCalledWith('refunds')
  expect(container.textContent).toContain('Open refunds this week')
})

it('looks for a definition only where a published console offers it, and places the one chosen', async () => {
  const asked: string[] = []
  const dispose = vi.fn<() => void>()
  const openGadget = vi.fn<(id: string) => RpcStub<Overseer>>((id: string) => ({
    listWidgetInstances: async (blueprintId: string, version: number) => { asked.push(`${id}:${blueprintId}@${version}`); return [instance(`c-${id}`)] },
    [Symbol.dispose]: dispose,
  }) as unknown as RpcStub<Overseer>)
  const screens: WorkspaceScreensState = { status: 'ready', workspaces: [
    workspace('ops', 'Operations', [{ blueprintId: 'bp-refunds', version: 2 }]),
    workspace('old', 'Old version', [{ blueprintId: 'bp-refunds', version: 1 }]),
    workspace('none', 'Unpublished', []),
  ] }
  const onPlace = await render({ searchWidgets: async () => searched({ definitions: [REFUNDS] }), openGadget: openGadget as never }, screens)
  await searchFor('refunds')
  await act(async () => button('Choose')!.click())
  expect(asked).toEqual(['ops:bp-refunds@2'])
  expect(dispose).toHaveBeenCalledOnce()
  expect(container.textContent).toContain('Refund desk · Operations')
  await act(async () => button('Place')!.click())
  expect(onPlace).toHaveBeenCalledWith({ type: 'console-widget', workspaceId: 'ops', consoleId: 'c-ops', sourceGadgetId: 12, blueprintId: 'bp-refunds', version: 2 })
})

it('says no console offers it, and that only recent workspaces are looked in', async () => {
  await render({ searchWidgets: async () => searched({ definitions: [REFUNDS] }) })
  await searchFor('refunds')
  await act(async () => button('Choose')!.click())
  expect(container.textContent).toContain('No published console you can open offers it.')
  expect(container.textContent).toContain('Only the workspaces you used most recently are looked in.')
})

it('places a board by the one open or a typed reference, and says a kind it cannot show', async () => {
  const hits = [{ kind: 'project/board', description: 'A project board', score: 0.8 }, { kind: 'project/roadmap', description: 'A roadmap', score: 0.5 }]
  const onPlace = await render({ searchWidgets: async () => searched({ hits }) }, undefined, undefined, 'inferops://acme.operations/project/board/ENG')
  await searchFor('board')
  expect(container.textContent).toContain("Can't be placed here yet")
  await act(async () => button('Choose')!.click())
  await act(async () => button('The board you have open (ENG)')!.click())
  expect(onPlace).toHaveBeenLastCalledWith({ type: 'builtin', kind: 'project/board', target: 'inferops://acme.operations/project/board/ENG' })
  const place = () => [...container.querySelectorAll('button')].filter(b => b.textContent === 'Place').at(-1)!
  await type('Board reference', 'not a board')
  expect(place().disabled).toBe(true)
  await type('Board reference', 'inferops://ACME.operations/project/board/OPS')
  await act(async () => place().click())
  expect(onPlace).toHaveBeenLastCalledWith({ type: 'builtin', kind: 'project/board', target: 'inferops://acme.operations/project/board/OPS' })
})

it("shows a refused placement in the kernel's words", async () => {
  const onPlace = vi.fn<(ref: WidgetPlacementRef) => Promise<string | null>>(async () => 'You keep 64 placements.')
  await render({ searchWidgets: async () => searched({ hits: [{ kind: 'project/board', description: 'A board', score: 1 }] }) },
    undefined, onPlace, 'inferops://acme.operations/project/board/ENG')
  await searchFor('board')
  await act(async () => button('Choose')!.click())
  await act(async () => button('The board you have open (ENG)')!.click())
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('You keep 64 placements.')
})
