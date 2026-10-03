// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Board, Issue, State } from '@inferos/gatekeeper-inferops/src/types'
import type { BoardActivityItem } from './boardActivity'
import type { MoveResult, PendingMove } from './boardData'
import { KanbanBoard, type KanbanLayout } from './KanbanBoard'

// Kumo's menu is a Base UI popup, which jsdom cannot open; the trigger and items are what matter here.
vi.mock('@cloudflare/kumo', async importOriginal => ({
  ...await importOriginal<typeof import('@cloudflare/kumo')>(),
  DropdownMenu: Object.assign(({ children }: { children: ReactNode }) => <div>{children}</div>, {
    Trigger: ({ render }: { render: ReactElement }) => render,
    Content: ({ children }: { children: ReactNode }) => <div role="menu">{children}</div>,
    Item: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => <button type="button" role="menuitem" onClick={onClick}>{children}</button>,
  }),
}))

let root: Root
let container: HTMLDivElement
const state = (id: string, name: string, group: State['group'] = 'started', workflow: State['workflow'] = 'software'): State =>
  ({ id, name, group, position: 0, workflow })
const issue = (id: string, stateId: string, extra: Partial<Issue> = {}): Issue => ({
  id, identifier: `DEMO-${id}`, title: `Issue ${id}`, priority: 'none', stateId, targetDate: null, workflow: 'software', revision: '1',
  assigneeId: null, blockedReason: null, ...extra,
})
const TODO = state('todo', 'Todo', 'unstarted')
const DOING = state('doing', 'Doing')
const DONE = state('done', 'Done', 'completed')
const IDEAS = state('ideas', 'Ideas', 'backlog', 'content')
const board = (...columns: [State, Issue[]][]): Board =>
  ({ project: { id: 'p', identifier: 'DEMO', name: 'Demo' }, columns: columns.map(([s, issues]) => ({ state: s, issues })) })
const basic = board([TODO, [issue('1', 'todo', { priority: 'high', assigneeId: '40000000-0000-4000-8000-000000000001', blockedReason: 'Waiting on access', targetDate: '2026-10-09' })]],
  [DOING, []], [DONE, [issue('2', 'done')]], [IDEAS, [issue('3', 'ideas', { workflow: 'content' })]])
const onMove = vi.fn<(issue: Issue, toState: State) => Promise<MoveResult>>(async () => ({ ok: true }))

const render = async (b: Board, pending: PendingMove[] = [], layout: KanbanLayout = 'embedded', columns = b.columns,
  awaiting: ReadonlyMap<string, BoardActivityItem> = new Map()) => {
  await act(async () => root.render(<KanbanBoard board={b} columns={columns} pending={pending} awaiting={awaiting} layout={layout} onMove={onMove} />))
}
const card = (id: string) => [...container.querySelectorAll<HTMLElement>('[data-issue-id]')].find(item => item.dataset.issueId === id)!
const column = (id: string) => [...container.querySelectorAll<HTMLElement>('[data-state-id]')].find(item => item.dataset.stateId === id)!
const status = () => container.querySelector('[role="status"]')?.textContent
const key = (element: HTMLElement, name: string) => act(async () => { element.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })) })
const menuItems = (id: string) => [...card(id).querySelectorAll('[role="menuitem"]')].map(item => item.textContent)
const dragEvent = (type: string, dataTransfer: object) => Object.assign(new Event(type, { bubbles: true, cancelable: true }), { dataTransfer })

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  onMove.mockClear().mockResolvedValue({ ok: true })
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

it('renders the given columns with their cards: identifier, title, priority, assignee, due date and blocked reason', async () => {
  await render(basic, [], 'embedded', basic.columns.slice(0, 3))
  expect([...container.querySelectorAll('h3')].map(heading => heading.textContent)).toEqual(['Todo1', 'Doing0', 'Done1'])
  expect(column('doing').textContent).toContain('No issues')
  const first = card('1')
  expect(first.getAttribute('aria-label')).toBe('DEMO-1: Issue 1')
  expect(first.textContent).toContain('High')
  expect(first.textContent).toContain('Assignee 40000000')
  expect(first.textContent).toContain('Due Oct 9')
  expect(first.textContent).toContain('Blocked: Waiting on access')
  expect(container.querySelector('[data-issue-id="3"]')).toBeNull()
  // Targets follow the issue's workflow over the whole board, not the shown columns.
  expect(menuItems('1')).toEqual(['Move to Doing', 'Move to Done'])
})

it('moves with the keyboard: arrows choose a column, Enter proposes, Escape cancels; the result is announced', async () => {
  await render(basic)
  const first = card('1')
  await act(async () => first.focus())
  await key(first, 'ArrowRight')
  expect(first.textContent).toContain('Move to Doing? Enter to propose')
  await key(first, 'ArrowRight')
  expect(first.textContent).toContain('Move to Done?')
  await key(first, 'ArrowRight')
  expect(first.textContent).toContain('Move to Doing?')
  await key(first, 'Escape')
  expect(first.textContent).not.toContain('Enter to propose')
  await key(first, 'Enter')
  expect(onMove).not.toHaveBeenCalled()
  await key(first, 'ArrowLeft')
  expect(first.textContent).toContain('Move to Done?')
  await key(first, 'Enter')
  expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ id: '1', revision: '1' }), DONE)
  expect(status()).toBe('DEMO-1 → Done proposed. It is applied in InferOps once approved.')
  expect(document.activeElement).toBe(first)
})

it('moves from the card\'s menu and announces a refused move', async () => {
  onMove.mockResolvedValue({ ok: false, code: 'STALE_REVISION', message: 'changed' })
  await render(basic)
  await act(async () => { card('1').querySelector<HTMLButtonElement>('[role="menuitem"]')!.click() })
  expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ id: '1' }), DOING)
  expect(status()).toContain('DEMO-1 changed in InferOps since the board loaded')
  onMove.mockResolvedValue({ ok: false, code: 'WORKFLOW_MISMATCH', message: 'Not that workflow.' })
  await act(async () => { card('1').querySelector<HTMLButtonElement>('[role="menuitem"]')!.click() })
  expect(status()).toBe('DEMO-1 was not moved: Not that workflow.')
})

it('shows a pending move on its card with the target state and withholds move controls until it is decided', async () => {
  const move: PendingMove = { issueId: '1', fromStateId: 'todo', toStateId: 'doing', expectedRevision: '1', phase: 'proposing' }
  await render(basic, [move])
  expect(card('1').textContent).toContain('Proposing move to Doing')
  expect(card('1').getAttribute('aria-busy')).toBe('true')
  expect(card('1').querySelector('[role="menuitem"]')).toBeNull()
  expect(card('1').getAttribute('draggable')).toBe('false')
  await key(card('1'), 'ArrowRight')
  expect(card('1').textContent).not.toContain('Enter to propose')
  // Queued for approval, the gatekeeper's read now simulates the issue in its target column.
  const simulated = board([TODO, []], [DOING, [issue('1', 'doing')]], [DONE, []])
  await render(simulated, [{ ...move, phase: 'awaiting' }])
  expect(column('doing').contains(card('1'))).toBe(true)
  expect(card('1').textContent).toContain('Awaiting approval: Doing')
})

it('reverts a rejected move visibly and announces it; an applied move is marked and announced', async () => {
  const awaiting: PendingMove = { issueId: '1', fromStateId: 'todo', toStateId: 'doing', expectedRevision: '1', phase: 'awaiting' }
  await render(board([TODO, []], [DOING, [issue('1', 'doing')]], [DONE, []]), [awaiting])
  await render(board([TODO, [issue('1', 'todo')]], [DOING, []], [DONE, []]), [])
  expect(column('todo').contains(card('1'))).toBe(true)
  expect(card('1').textContent).toContain('Move to Doing rejected')
  expect(status()).toBe('Move of DEMO-1 to Doing was rejected; it stays where it was.')
  expect(menuItems('1')).toEqual(['Move to Doing', 'Move to Done'])

  await render(board([TODO, []], [DOING, [issue('2', 'doing')]], [DONE, []]), [{ ...awaiting, issueId: '2' }])
  await render(board([TODO, []], [DOING, [issue('2', 'doing', { revision: '2' })]], [DONE, []]), [])
  expect(card('2').textContent).toContain('Move to Doing applied')
  expect(status()).toBe('DEMO-2 moved to Doing.')
})

it('keeps focus on a card the board moves to another column, and leaves focus alone elsewhere', async () => {
  await render(basic)
  await act(async () => card('1').focus())
  const moved = board([TODO, []], [DOING, [issue('1', 'doing')]], [DONE, [issue('2', 'done')]])
  await render(moved)
  expect(column('doing').contains(card('1'))).toBe(true)
  expect(document.activeElement).toBe(card('1'))
  const outside = document.createElement('button'); document.body.append(outside)
  await act(async () => outside.focus())
  await render(board([TODO, [issue('1', 'todo')]], [DOING, []], [DONE, [issue('2', 'done')]]))
  expect(document.activeElement).toBe(outside)
  outside.remove()
})

it('drops a dragged card on an allowed column only', async () => {
  await render(basic)
  const transfer = { setData: vi.fn<(type: string, data: string) => void>(), effectAllowed: '', dropEffect: '' }
  await act(async () => { card('1').dispatchEvent(dragEvent('dragstart', transfer)) })
  expect(transfer.setData).toHaveBeenCalledWith('text/plain', '1')
  const over = dragEvent('dragover', transfer)
  await act(async () => { column('ideas').dispatchEvent(over) })
  expect(over.defaultPrevented).toBe(false)
  await act(async () => { column('ideas').dispatchEvent(dragEvent('drop', transfer)) })
  expect(onMove).not.toHaveBeenCalled()
  const allowed = dragEvent('dragover', transfer)
  await act(async () => { column('doing').dispatchEvent(allowed) })
  expect(allowed.defaultPrevented).toBe(true)
  expect(column('doing').className).toContain('border-kumo-brand')
  await act(async () => { column('doing').dispatchEvent(dragEvent('drop', transfer)) })
  expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ id: '1' }), DOING)
})

it('lays columns out to scroll sideways when embedded and to share the width in the full view', async () => {
  await render(basic, [], 'embedded')
  expect(container.firstElementChild?.className).toContain('overflow-x-auto')
  expect(column('todo').className).toContain('shrink-0')
  await render(basic, [], 'full')
  expect(container.firstElementChild?.getAttribute('data-layout')).toBe('full')
  expect(column('todo').className).toContain('flex-1')
})

it("marks a card whose move another caller proposed as awaiting approval, with who asked, and offers no move", async () => {
  const proposed: BoardActivityItem = { id: 9, kind: 'awaiting', actor: 'Agent', title: 'Move DEMO-1 to Doing', at: new Date(0), issue: 'DEMO-1' }
  await render(basic, [], 'embedded', basic.columns, new Map([['DEMO-1', proposed]]))
  expect(card('1').textContent).toContain('Awaiting approval (Agent): Move DEMO-1 to Doing')
  expect(card('1').getAttribute('draggable')).toBe('false')
  expect(menuItems('1')).toEqual([])
  expect(menuItems('2').length).toBeGreaterThan(0)
})
