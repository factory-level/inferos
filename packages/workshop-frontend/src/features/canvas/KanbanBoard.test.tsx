// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Board, Issue, State } from '@inferos/gatekeeper-inferops/src/types'
import type { BoardActivityItem } from './boardActivity'
import type { IssueChanges, NewIssue } from '@inferos/gatekeeper-inferops/src/types'
import type { PendingChange, PendingMove, ProposalResult } from './boardData'
import { KanbanBoard, type KanbanLayout } from './KanbanBoard'
import { dialogField, setFieldValue } from './kumoPopupDoubles'

vi.mock('@cloudflare/kumo', async importOriginal =>
  (await import('./kumoPopupDoubles')).withKumoPopupDoubles(await importOriginal<typeof import('@cloudflare/kumo')>()))

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
const onMove = vi.fn<(issue: Issue, toState: State) => Promise<ProposalResult>>(async () => ({ ok: true }))
const onCreate = vi.fn<(issue: NewIssue) => Promise<ProposalResult>>(async () => ({ ok: true }))
const onUpdate = vi.fn<(issue: Issue, changes: IssueChanges) => Promise<ProposalResult>>(async () => ({ ok: true }))

const render = async (b: Board, pending: PendingMove[] = [], layout: KanbanLayout = 'embedded', columns = b.columns,
  awaiting: ReadonlyMap<string, BoardActivityItem> = new Map(), changes: PendingChange[] = [], decided: BoardActivityItem[] = []) => {
  await act(async () => root.render(<KanbanBoard board={b} columns={columns} pending={pending} changes={changes} awaiting={awaiting} decided={decided} layout={layout}
    onMove={onMove} onCreate={onCreate} onUpdate={onUpdate} />))
}
const card = (id: string) => [...container.querySelectorAll<HTMLElement>('[data-issue-id]')].find(item => item.dataset.issueId === id)!
const column = (id: string) => [...container.querySelectorAll<HTMLElement>('[data-state-id]')].find(item => item.dataset.stateId === id)!
const status = () => container.querySelector('[role="status"]')?.textContent
const key = (element: HTMLElement, name: string) => act(async () => { element.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })) })
const menuItems = (id: string) => [...card(id).querySelectorAll('[role="menuitem"]')].map(item => item.textContent)
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
const dialog = () => container.querySelector<HTMLElement>('[role="dialog"]')
const field = <T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(label: string) => dialogField<T>(container, label)
const enter = (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) => act(async () => setFieldValue(element, value))
const submit = () => act(async () => { dialog()!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click() })
/** A decided action in the board's log, as `BoardActivity.decided` lists it. */
const logged = (id: number, kind: 'applied' | 'rejected', target: { issue: string } | { creates: string }): BoardActivityItem =>
  ({ id, kind, actor: 'Person', title: `Action ${id}`, at: new Date(), ...target })
/** Re-render with the board as it is and the given decided actions, as when the log's entries arrive. */
const withLog = (b: Board, decided: BoardActivityItem[], pending: PendingMove[] = []) => render(b, pending, 'embedded', b.columns, new Map(), [], decided)
const dragEvent = (type: string, dataTransfer: object) => Object.assign(new Event(type, { bubbles: true, cancelable: true }), { dataTransfer })

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  onMove.mockClear().mockResolvedValue({ ok: true })
  onCreate.mockClear().mockResolvedValue({ ok: true })
  onUpdate.mockClear().mockResolvedValue({ ok: true })
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

it('reverts a rejected move visibly and announces it; an applied move is marked and announced, as the action log decides', async () => {
  const awaiting: PendingMove = { issueId: '1', fromStateId: 'todo', toStateId: 'doing', expectedRevision: '1', phase: 'awaiting' }
  await render(board([TODO, []], [DOING, [issue('1', 'doing')]], [DONE, []]), [awaiting])
  const back = board([TODO, [issue('1', 'todo')]], [DOING, []], [DONE, []])
  await render(back, [])
  // The board alone says nothing about how it ended.
  expect(status()).toBe('')
  await withLog(back, [logged(4, 'rejected', { issue: 'DEMO-1' })])
  expect(column('todo').contains(card('1'))).toBe(true)
  expect(card('1').textContent).toContain('Move to Doing rejected')
  expect(status()).toBe('Move of DEMO-1 to Doing was rejected; it stays where it was.')
  expect(menuItems('1')).toEqual(['Move to Doing', 'Move to Done'])

  const decided = [logged(4, 'rejected', { issue: 'DEMO-1' })]
  await withLog(board([TODO, []], [DOING, [issue('2', 'doing')]], [DONE, []]), decided, [{ ...awaiting, issueId: '2' }])
  // The log may decide first; the board's drop then announces it.
  await withLog(board([TODO, []], [DOING, [issue('2', 'doing')]], [DONE, []]), [...decided, logged(5, 'applied', { issue: 'DEMO-2' })], [{ ...awaiting, issueId: '2' }])
  await withLog(board([TODO, []], [DOING, [issue('2', 'doing', { revision: '2' })]], [DONE, []]), [...decided, logged(5, 'applied', { issue: 'DEMO-2' })])
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

it('proposes a new issue in a column\'s state from its New issue control, and announces it queued', async () => {
  await render(basic)
  await act(async () => button('New issue in Doing')!.click())
  expect(dialog()?.querySelector('h2')?.textContent).toBe('New issue in Doing')
  // A title is required.
  expect(dialog()!.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)
  await enter(field('Title'), 'Write the runbook')
  await enter(field('Description'), 'Steps for on-call.')
  await enter(field('Priority'), 'high')
  await submit()
  expect(onCreate).toHaveBeenCalledWith({ title: 'Write the runbook', description: 'Steps for on-call.', priority: 'high', stateId: 'doing' })
  expect(dialog()).toBeNull()
  expect(status()).toBe('New issue "Write the runbook" proposed in Doing. Waiting for approval.')
})

it('edits an issue sending only the fields that changed, and nothing at all when nothing did', async () => {
  await render(basic)
  await act(async () => button('Edit DEMO-1')!.click())
  expect(dialog()?.querySelector('h2')?.textContent).toBe('Edit DEMO-1')
  expect(field<HTMLInputElement>('Title').value).toBe('Issue 1')
  expect(field<HTMLSelectElement>('Priority').value).toBe('high')
  expect(dialog()!.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)
  expect(dialog()!.textContent).toContain('Nothing changed yet.')
  await enter(field('Priority'), 'low')
  await submit()
  expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: '1', revision: '1' }), { priority: 'low' })
  expect(dialog()).toBeNull()
  expect(status()).toBe('Changes to DEMO-1 proposed. Waiting for approval.')
  await act(async () => button('Edit DEMO-1')!.click())
  await enter(field('Title'), '  Renamed  ')
  await enter(field('Description'), 'More detail.')
  await submit()
  expect(onUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ id: '1' }), { title: 'Renamed', description: 'More detail.' })
})

it('keeps the form open with the reason when a proposal is refused: a stale revision, or the gatekeeper\'s own message', async () => {
  await render(basic)
  onUpdate.mockResolvedValueOnce({ ok: false, code: 'STALE_REVISION', message: 'DEMO-1 is at revision 2, not 1.' })
  await act(async () => button('Edit DEMO-1')!.click())
  await enter(field('Title'), 'Renamed')
  await submit()
  expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe('This issue changed; refresh and try again.')
  onUpdate.mockResolvedValueOnce({ ok: false, code: 'FORBIDDEN', message: 'The workflow policy does not allow this change.' })
  await submit()
  expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe('The workflow policy does not allow this change.')
  await act(async () => { [...dialog()!.querySelectorAll('button')].find(b => b.textContent === 'Cancel')!.click() })
  expect(dialog()).toBeNull()
  onCreate.mockResolvedValueOnce({ ok: false, code: 'FORBIDDEN', message: 'You may not create issues in this project.' })
  await act(async () => button('New issue in Todo')!.click())
  await enter(field('Title'), 'New')
  await submit()
  expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe('You may not create issues in this project.')
})

it('shows an issue not created yet as a provisional card that cannot be dragged, moved or edited', async () => {
  const provisional = issue('pending-9', 'todo', { identifier: 'DEMO-new', title: 'Write docs', revision: '0', pending: 'create', priority: 'urgent' })
  await render(board([TODO, [issue('1', 'todo'), provisional]], [DOING, []]))
  const card9 = card('pending-9')
  expect(card9.getAttribute('aria-label')).toBe('DEMO-new: Write docs (not created yet)')
  expect(card9.textContent).toContain('New issue, waiting for approval')
  expect(card9.getAttribute('draggable')).toBe('false')
  expect(menuItems('pending-9')).toEqual([])
  expect(button('Edit DEMO-new')).toBeNull()
  // Listed after the issues that exist, whatever its priority.
  expect([...column('todo').querySelectorAll('[data-issue-id]')].map(c => c.getAttribute('data-issue-id'))).toEqual(['1', 'pending-9'])
  await act(async () => card9.focus())
  await key(card9, 'ArrowRight')
  await key(card9, 'Enter')
  expect(onMove).not.toHaveBeenCalled()
  const transfer = { setData: vi.fn<(type: string, data: string) => void>(), effectAllowed: '', dropEffect: '' }
  await act(async () => { card9.dispatchEvent(dragEvent('dragstart', transfer)) })
  const over = dragEvent('dragover', transfer)
  await act(async () => { column('doing').dispatchEvent(over) })
  expect(over.defaultPrevented).toBe(false)
})

it('marks a pending edit, proposing or waiting for approval, and withholds edits and moves meanwhile', async () => {
  const proposing: PendingChange = { kind: 'update', issueId: '1', changes: { title: 'x' }, expectedRevision: '1', phase: 'proposing' }
  await render(basic, [], 'embedded', basic.columns, new Map(), [proposing])
  expect(card('1').textContent).toContain('Proposing edit…')
  expect(card('1').getAttribute('aria-busy')).toBe('true')
  expect(button('Edit DEMO-1')).toBeNull()
  expect(menuItems('1')).toEqual([])
  // Queued, the gatekeeper's read overlays the new values at the unchanged revision.
  await render(board([TODO, [issue('1', 'todo', { title: 'x', pending: 'update' })]], [DOING, []]))
  expect(card('1').textContent).toContain('Edit waiting for approval')
  expect(card('1').getAttribute('draggable')).toBe('false')
  expect(button('Edit DEMO-1')).toBeNull()
  expect(menuItems('1')).toEqual([])
})

it('announces creates and edits once the board stops marking them pending, with the outcome the action log records', async () => {
  const provisional = issue('pending-9', 'todo', { identifier: 'DEMO-new', title: 'Write docs', revision: '0', pending: 'create' })
  await render(board([TODO, [issue('1', 'todo', { title: 'New title', pending: 'update' }), provisional]], [DOING, []]))
  const applied = board([TODO, [issue('1', 'todo', { title: 'New title', revision: '2' }), issue('4', 'todo', { title: 'Write docs', revision: '3' })]], [DOING, []])
  const decided = [logged(1, 'applied', { issue: 'DEMO-1' }), logged(2, 'applied', { creates: 'Write docs' })]
  await withLog(applied, decided)
  expect(status()).toBe('Edit of DEMO-1 applied. New issue "Write docs" created.')
  expect(card('1').textContent).toContain('Edit applied')
  expect(button('Edit DEMO-1')).not.toBeNull()

  const another = issue('pending-10', 'todo', { identifier: 'DEMO-new', title: 'Nope', revision: '0', pending: 'create' })
  await withLog(board([TODO, [issue('5', 'todo', { title: 'Overlaid', pending: 'update' }), another]], [DOING, []]), decided)
  await withLog(board([TODO, [issue('5', 'todo', { title: 'Old title' })]], [DOING, []]),
    [...decided, logged(3, 'rejected', { issue: 'DEMO-5' }), logged(4, 'rejected', { creates: 'Nope' })])
  expect(status()).toBe('Edit of DEMO-5 was rejected; it keeps its previous values. New issue "Nope" was rejected.')
  expect(card('5').textContent).toContain('Edit rejected')
})

it('announces a denied edit as rejected though an outside edit moved the issue\'s revision', async () => {
  await render(board([TODO, [issue('13', 'todo', { title: 'Proposed', priority: 'low', pending: 'update', revision: '530' })]], [DOING, []]))
  // A concurrent edit in InferOps: the gatekeeper stops overlaying the stale edit, still pending.
  const outside = board([TODO, [issue('13', 'todo', { title: 'Changed elsewhere', revision: '531' })]], [DOING, []])
  await withLog(outside, [])
  expect(status()).not.toContain('applied')
  // Denied: the log records it rejected, and so is it announced.
  await withLog(outside, [logged(16, 'rejected', { issue: 'DEMO-13' })])
  expect(status()).toBe('Edit of DEMO-13 was rejected; it keeps its previous values.')
  expect(card('13').textContent).toContain('Edit rejected')
})
