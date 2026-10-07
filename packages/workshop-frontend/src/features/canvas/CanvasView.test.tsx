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
const disposed: (WorkpieceId | string)[] = []
const BOARD = 'inferops://demo.local/project/board/DEMO'
const issue = (id: string, stateId: string) => ({ id, identifier: `DEMO-${id}`, title: `Issue ${id}`, priority: 'none', stateId, targetDate: null,
  workflow: 'software', revision: '1', assigneeId: null, blockedReason: null })
const demoBoard = {
  project: { id: 'p', identifier: 'DEMO', name: 'Demo' },
  columns: [
    { state: { id: 'todo', name: 'Todo', group: 'unstarted', position: 0, workflow: 'software' }, issues: [issue('1', 'todo'), issue('2', 'todo')] },
    { state: { id: 'done', name: 'Done', group: 'completed', position: 1, workflow: 'software' }, issues: [issue('3', 'done')] },
  ],
}
const readBoard = vi.fn<() => Promise<typeof demoBoard>>(async () => demoBoard)
const connection = {
  openSession: async () => ({ readBoard, [Symbol.dispose]: () => { disposed.push('session') } }),
  [Symbol.dispose]: () => { disposed.push('client') },
}
let actions: { entry: (record: object) => void } | undefined
const lookup = vi.fn<(url: string) => Promise<object | null>>(async () => null)
const overseer = {
  getGadget: vi.fn<(id: WorkpieceId) => object>((id: WorkpieceId) => ({ [Symbol.dispose]: () => { disposed.push(id) } })),
  getConsoleWidget: vi.fn<(consoleId: string, revision: string, id: WorkpieceId) => object>(
      (_consoleId: string, _revision: string, id: WorkpieceId) => ({ [Symbol.dispose]: () => { disposed.push(`console ${id}`) } })),
  getGatekeeperByResourceUrl: lookup,
  subscribeToActions: async (subscriber: typeof actions) => { actions = subscriber; return { [Symbol.dispose]: () => {} } },
  listActions: async () => ({ entries: [] }),
} as unknown as RpcStub<Overseer>
const gadgetWidget = (id: string, ref: string): CanvasWidget => ({ id, kind: 'inferos.gadget', version: 1, targetRef: ref, size: 'normal', params: {} })
const definition = (widgets: CanvasWidget[]): CanvasDefinition => ({ schemaVersion: 1, id: 'ops', revision: '0', title: 'Ops',
  sections: [{ id: 'main', title: 'Main', columns: 2, widgets }] })
const summaries = (...gadgets: GadgetSummary[]) => new Map(gadgets.map(gadget => [gadget.id, gadget]))
const action = (resourceUrl: string, state: string) => ({ id: 1, type: 'action', state, resourceUrl, resourceTitle: 'Board', createdAt: new Date(), description: { title: 'Move DEMO-1 to Doing', description: '' } })
const boardWidget = (id: string, showCompleted = false): CanvasWidget => ({ id, kind: 'inferops.project-board', version: 1,
  targetRef: BOARD, size: 'wide', params: { workflow: 'software', showCompleted } })
const render = async (view: CanvasDefinition, gadgets: Map<WorkpieceId, GadgetSummary>) => {
  await act(async () => root.render(<CanvasView definition={view} gadgets={gadgets} overseer={overseer} />))
  // Let the adapter's lookup and read settle.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  disposed.length = 0; vi.mocked(overseer.getGadget).mockClear(); vi.mocked(overseer.getConsoleWidget).mockClear(); readBoard.mockClear(); actions = undefined
  lookup.mockClear().mockResolvedValue(null)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

it('renders accepted gadgets live beside boards the workspace has no connection for', async () => {
  await render(definition([gadgetWidget('g', 'gadget:3'), boardWidget('b')]),
    summaries({ id: 3, type: 'gadget', title: 'Shift report', commitId: 'c1' }))
  expect(container.querySelector('[aria-label="Shift report"] [data-testid="gadget-ui"]')?.textContent).toBe('visible')
  expect(overseer.getGadget).toHaveBeenCalledWith(3)
  expect(lookup).toHaveBeenCalledWith(BOARD)
  expect(container.querySelector(`[aria-label="Project board ${BOARD}"]`)?.textContent).toContain('Not connected')
})

it('shows a connected board\'s columns, reading it once for every card of it, and releases the session', async () => {
  lookup.mockResolvedValue(connection)
  await render(definition([boardWidget('b'), boardWidget('all', true)]), summaries())
  expect(lookup).toHaveBeenCalledTimes(1)
  const cards = [...container.querySelectorAll(`[aria-label="Project board ${BOARD}"]`)]
  expect(cards.map(card => [...card.querySelectorAll('section')].map(column => [column.querySelector('h3')?.textContent, column.querySelectorAll('[data-issue-id]').length])))
    .toEqual([[['Todo2', 2]], [['Todo2', 2], ['Done1', 1]]])
  expect(cards[0]?.textContent).toContain('Demo (DEMO)')
  expect(cards[0]?.querySelector('button[aria-label="Refresh board"]')).not.toBeNull()
  expect(readBoard).toHaveBeenCalledTimes(1)
  // A move decided on this board's connection, by anyone, re-reads the board; other actions do not.
  await act(async () => { actions?.entry(action('inferops://demo.local/project/board/OTHER', 'approved')); actions?.entry(action(BOARD, 'pending')) })
  expect(readBoard).toHaveBeenCalledTimes(1)
  await act(async () => { actions?.entry(action(BOARD, 'approved')); await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(readBoard).toHaveBeenCalledTimes(2)
  await render(definition([]), summaries())
  expect(disposed).toEqual(['client', 'session'])
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

// One IntersectionObserver per card, as the browser gives each card its own; `show` reports the
// named cards near the screen, `hide` reports them gone again.
const observeCards = () => {
  const observers: { callback: (entries: { isIntersecting: boolean }[]) => void; elements: Element[] }[] = []
  vi.stubGlobal('IntersectionObserver', class {
    readonly entry: (typeof observers)[number]
    constructor(callback: (typeof observers)[number]['callback']) { this.entry = { callback, elements: [] }; observers.push(this.entry) }
    observe(element: Element) { this.entry.elements.push(element) }
    disconnect() { observers.splice(observers.indexOf(this.entry), 1) }
  })
  const report = async (isIntersecting: boolean, cards: Element[]) => {
    await act(async () => {
      for (const observer of observers) if (observer.elements.some(element => cards.includes(element))) observer.callback([{ isIntersecting }])
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  }
  return { show: (cards: Element[]) => report(true, cards), hide: (cards: Element[]) => report(false, cards) }
}
const boardCards = () => [...container.querySelectorAll(`[aria-label="Project board ${BOARD}"]`)]
const issueCount = (card: Element | undefined) => card?.querySelectorAll('[data-issue-id]').length

// #28: a board card reads nothing until it first comes near the screen, as a gadget card loads
// nothing; duplicates still share one read, and a card arriving after the board landed takes it.
it('reads an offscreen board card only once it comes near the screen, sharing one read among its cards', async () => {
  lookup.mockResolvedValue(connection)
  const cards = observeCards()
  await render(definition([boardWidget('b1'), boardWidget('b2'), boardWidget('all', true), gadgetWidget('g', 'gadget:3')]),
    summaries({ id: 3, type: 'gadget', title: 'Report' }))
  expect(lookup).not.toHaveBeenCalled()
  expect(readBoard).not.toHaveBeenCalled()
  expect(boardCards().map(card => card.querySelector('[aria-busy="true"]') !== null)).toEqual([true, true, true])

  const [b1, b2, all] = boardCards()
  await cards.show([b1!, b2!])
  expect(readBoard).toHaveBeenCalledTimes(1)
  expect(boardCards().map(issueCount)).toEqual([2, 2, 0])

  await cards.show([all!])
  expect(readBoard).toHaveBeenCalledTimes(1)
  expect(boardCards().map(issueCount)).toEqual([2, 2, 3])
  expect(container.querySelector('[data-testid="gadget-ui"]')?.textContent).toBe('deferred')
})

it('keeps a board card that scrolled away subscribed, so a decided action still re-reads the board once', async () => {
  lookup.mockResolvedValue(connection)
  const cards = observeCards()
  await render(definition([boardWidget('b'), boardWidget('all', true)]), summaries())
  await cards.show(boardCards())
  await cards.hide(boardCards())
  expect(readBoard).toHaveBeenCalledTimes(1)
  expect(boardCards().map(issueCount)).toEqual([2, 3])
  await act(async () => { actions?.entry(action(BOARD, 'approved')); await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(readBoard).toHaveBeenCalledTimes(2)
  expect(boardCards().map(issueCount)).toEqual([2, 3])
})

it('opens a published console\'s widgets through that console revision, never as plain gadgets', async () => {
  await act(async () => root.render(<CanvasView definition={definition([gadgetWidget('g', 'gadget:9')])}
    gadgets={summaries({ id: 9, type: 'gadget', title: 'Status', commitId: 'c9' })} overseer={overseer}
    offeredBy={{ consoleId: 'floor', revision: '4' }} />))
  expect(overseer.getConsoleWidget).toHaveBeenCalledWith('floor', '4', 9)
  expect(overseer.getGadget).not.toHaveBeenCalled()
  await act(async () => root.render(<CanvasView definition={definition([])} gadgets={summaries()} overseer={overseer} />))
  expect(disposed).toEqual(['console 9'])
})
