// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { ActionLogEntry, ActionsSubscriber, Overseer } from '@gadgets/workshop-shared/api'
import type { CanvasProjectBoardWidget } from '@gadgets/workshop-shared/canvas'
import type { Board, Issue, IssueChanges, NewIssue } from '@inferos/gatekeeper-inferops/src/types'
import { CanvasBoardWidget } from './CanvasBoardWidget'
import { CanvasBoardFullView } from './CanvasBoardFullView'
import { dialogField, setFieldValue } from './kumoPopupDoubles'
import { SessionBoard } from '../operate/SessionBoard'

vi.mock('@cloudflare/kumo', async importOriginal =>
  (await import('./kumoPopupDoubles')).withKumoPopupDoubles(await importOriginal<typeof import('@cloudflare/kumo')>()))

let root: Root
let container: HTMLDivElement
const BOARD = 'inferops://demo.local/project/board/DEMO'
const issue = (id: string, stateId: string, revision = '1'): Issue => ({
  id, identifier: `DEMO-${id}`, title: `Issue ${id}`, priority: 'none', stateId, targetDate: null, workflow: 'software', revision, assigneeId: null, blockedReason: null,
})
const demo: Board = {
  project: { id: 'p', identifier: 'DEMO', name: 'Demo' },
  columns: [
    { state: { id: 'todo', name: 'Todo', group: 'unstarted', position: 0, workflow: 'software' }, issues: [issue('1', 'todo', '7')] },
    { state: { id: 'doing', name: 'Doing', group: 'started', position: 0, workflow: 'software' }, issues: [] },
    { state: { id: 'done', name: 'Done', group: 'completed', position: 0, workflow: 'software' }, issues: [] },
  ],
}
const widget = (params: Partial<CanvasProjectBoardWidget['params']> = {}): CanvasProjectBoardWidget =>
  ({ id: 'w', kind: 'inferops.project-board', version: 1, targetRef: BOARD, size: 'wide', params: { workflow: 'software', showCompleted: false, ...params } })
// Like the gatekeeper, a read after a transition simulates the issue in its target state at its unchanged revision.
let current: Board
const readBoard = vi.fn<() => Promise<Board>>(async () => current)
const transition = vi.fn<(toStateId: string, revision: string) => Promise<void>>(async toStateId => {
  const moved = current.columns.flatMap(c => c.issues).find(i => i.id === '1')!
  current = { ...current, columns: current.columns.map(c => ({ ...c, issues: c.state.id === toStateId ? [{ ...moved, stateId: toStateId }] : c.issues.filter(i => i.id !== '1') })) }
})
// Like the gatekeeper, a read after an update overlays the new title at the unchanged revision, marked pending.
const update = vi.fn<(changes: IssueChanges, revision: string) => Promise<void>>(async changes => {
  current = { ...current, columns: current.columns.map(c => ({ ...c, issues: c.issues.map(i => i.id === '1' ? { ...i, ...changes, pending: 'update' as const } : i) })) }
})
const createIssue = vi.fn<(issue: NewIssue) => Promise<void>>(async () => {})
const openIssue = vi.fn<(id: string) => object>((id: string) => ({ transition, update, read: async () => issue(id, 'todo'), [Symbol.dispose]: () => {} }))
const session = { readBoard, openIssue, createIssue, [Symbol.dispose]: () => {} }
const connection = { openSession: async () => session, [Symbol.dispose]: () => {} }
const lookup = vi.fn<(url: string) => Promise<object | null>>(async () => connection)
// A fresh stub per test is a fresh scope, so adapters never leak between tests.
let overseer: RpcStub<Overseer>
let actions: ActionsSubscriber | undefined

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const render = async (element: ReactElement) => { await act(async () => root.render(element)); await settle() }
const article = () => container.querySelector(`[aria-label="Project board ${BOARD}"]`)!
const card = (id: string) => [...container.querySelectorAll<HTMLElement>('[data-issue-id]')].find(item => item.dataset.issueId === id)!

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  overseer = {
    getGatekeeperByResourceUrl: lookup,
    subscribeToActions: async (subscriber: ActionsSubscriber) => { actions = subscriber; return { [Symbol.dispose]: () => {} } },
    listActions: async () => ({ entries: [] }),
  } as unknown as RpcStub<Overseer>
  current = demo; readBoard.mockClear(); transition.mockClear(); openIssue.mockClear(); update.mockClear(); createIssue.mockClear()
  lookup.mockClear().mockResolvedValue(connection)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

it('shows loading, then the board; not connected when no connection covers the reference', async () => {
  let resolve!: (board: Board) => void
  readBoard.mockReturnValueOnce(new Promise(r => { resolve = r }))
  await render(<CanvasBoardWidget widget={widget()} overseer={overseer} presentation="card" />)
  expect(article().querySelector('[aria-busy="true"]')?.textContent).toContain('Loading the board')
  await act(async () => { resolve(demo); await settle() })
  expect(article().querySelector('h4')?.textContent).toBe('Demo (DEMO)')
  expect([...article().querySelectorAll('h3')].map(h => h.textContent)).toEqual(['Todo1', 'Doing0'])
  lookup.mockResolvedValue(null)
  await render(<CanvasBoardWidget widget={{ ...widget(), targetRef: 'inferops://demo.local/project/board/OTHER' }} overseer={overseer} presentation="card" />)
  expect(container.textContent).toContain('Not connected')
})

it('reports a failed read with a retry, keeps the last board as stale when a refresh fails, and says when nothing matches the params', async () => {
  readBoard.mockRejectedValueOnce(new Error('Error: INTERNAL: boom'))
  await render(<CanvasBoardWidget widget={widget()} overseer={overseer} presentation="card" />)
  expect(article().querySelector('[role="alert"]')?.textContent).toBe('Could not read the board: boom')
  await act(async () => { [...article().querySelectorAll('button')].find(b => b.textContent === 'Try again')!.click(); await settle() })
  expect(readBoard).toHaveBeenCalledTimes(2)
  expect(card('1')).toBeDefined()
  readBoard.mockRejectedValueOnce(new Error('Error: INTERNAL: later'))
  await act(async () => { article().querySelector<HTMLButtonElement>('[aria-label="Refresh board"]')!.click(); await settle() })
  expect(article().textContent).toContain('Refresh failed')
  expect(article().querySelector('[role="alert"]')?.textContent).toContain('refresh failed: later')
  expect(card('1')).toBeDefined()
  await render(<CanvasBoardWidget widget={widget({ workflow: 'content' })} overseer={overseer} presentation="card" />)
  expect(container.textContent).toContain('No content states to show')
})

it('says InferOps is turned off, not that the read failed, and shows the board again once it is on', async () => {
  await render(<CanvasBoardWidget widget={widget()} overseer={overseer} presentation="card" />)
  expect(card('1')).toBeDefined()
  readBoard.mockRejectedValueOnce(new Error('Error: DISABLED: InferOps is turned off for this deployment.'))
  await act(async () => { article().querySelector<HTMLButtonElement>('[aria-label="Refresh board"]')!.click(); await settle() })
  const statuses = [...article().querySelectorAll('[role="status"]')].map(s => s.textContent)
  expect(statuses).toContainEqual(expect.stringContaining('InferOps is turned off for this deployment.'))
  expect(article().querySelector('[role="alert"]')).toBeNull()
  expect(article().querySelector('[data-issue-id]')).toBeNull()
  await act(async () => { article().querySelector<HTMLButtonElement>('[aria-label="Refresh board"]')!.click(); await settle() })
  expect(article().textContent).not.toContain('turned off')
  expect(card('1')).toBeDefined()
})

it('proposes a keyboard move through the adapter with the issue id, target state and the revision read', async () => {
  await render(<CanvasBoardWidget widget={widget()} overseer={overseer} presentation="card" />)
  const first = card('1')
  await act(async () => first.focus())
  await act(async () => { first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
  await act(async () => { first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await settle() })
  expect(openIssue).toHaveBeenCalledWith('1')
  expect(transition).toHaveBeenCalledWith('doing', '7')
  expect(article().textContent).toContain('1 move pending approval')
  expect(card('1').textContent).toContain('Awaiting approval: Doing')
  expect(document.activeElement).toBe(card('1'))
  expect(readBoard).toHaveBeenCalledTimes(2)
})

it('serves the card and the full view of one reference from one read, with the same pending moves', async () => {
  await render(<>
    <CanvasBoardWidget widget={widget()} overseer={overseer} presentation="card" />
    <CanvasBoardFullView widget={widget({ showCompleted: true })} viewTitle="Ops" overseer={overseer} onBack={() => {}} />
  </>)
  const boards = [...container.querySelectorAll('[data-presentation]')]
  expect(boards.map(b => b.getAttribute('data-presentation'))).toEqual(['card', 'full'])
  expect(boards.map(b => [...b.querySelectorAll('h3')].map(h => h.textContent))).toEqual([['Todo1', 'Doing0'], ['Todo1', 'Doing0', 'Done0']])
  expect(readBoard).toHaveBeenCalledTimes(1)
  expect(lookup).toHaveBeenCalledTimes(1)
  expect(boards[1]?.querySelector('[data-layout]')?.getAttribute('data-layout')).toBe('full')
  await act(async () => { boards[1]!.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click(); await settle() })
  expect(transition).toHaveBeenCalledWith('doing', '7')
  expect(boards.map(b => b.textContent?.includes('1 move pending approval'))).toEqual([true, true])
  expect(readBoard).toHaveBeenCalledTimes(2)
})

const agentMove = (id: number, state: ActionLogEntry['state']): ActionLogEntry => ({
  id, type: 'action', state, resourceUrl: BOARD, resourceTitle: 'InferOps board DEMO', createdAt: new Date(), requestedBy: 'agent',
  description: { title: 'Move DEMO-1 to Done', description: '', fields: [{ label: 'Issue', kind: 'inline', value: 'DEMO-1' }] },
} as ActionLogEntry)
const activityLine = () => article().querySelector('[aria-label="Board activity"]')

it("shows the agent's awaiting move in the header and on its card, announced once, and its read as recent", async () => {
  await render(<CanvasBoardWidget widget={widget()} overseer={overseer} presentation="card" />)
  expect(activityLine()).toBeNull()
  await act(async () => {
    actions?.entry({ id: 1, type: 'observation', state: 'approved', resourceUrl: BOARD, resourceTitle: 'InferOps board DEMO', createdAt: new Date(), requestedBy: 'agent', description: { title: 'Read InferOps board DEMO', description: '' } } as ActionLogEntry)
  })
  expect(activityLine()?.textContent).toContain('Agent: Read InferOps board DEMO, just now')
  expect(article().querySelector('[aria-live="polite"]')?.textContent).toBe('')
  await act(async () => { actions?.entry(agentMove(2, 'pending')) })
  // The card shows the newest awaiting action first and counts the rest.
  expect(activityLine()?.textContent).toContain('Agent is waiting for approval: Move DEMO-1 to Done')
  expect(activityLine()?.textContent).toContain('+1 more')
  expect(article().querySelector('[aria-live="polite"]')?.textContent).toBe('Agent is waiting for approval: Move DEMO-1 to Done')
  expect(card('1').textContent).toContain('Awaiting approval (Agent): Move DEMO-1 to Done')
  expect(card('1').getAttribute('draggable')).toBe('false')
})

it('drops awaiting activity once the connection is revoked', async () => {
  await render(<CanvasBoardWidget widget={widget()} overseer={overseer} presentation="full" />)
  await act(async () => { actions?.entry(agentMove(2, 'pending')) })
  expect(activityLine()?.textContent).toContain('waiting for approval')
  readBoard.mockRejectedValueOnce(new Error('Error: UNAUTHORIZED: credential refused'))
  await act(async () => { article().querySelector<HTMLButtonElement>('[aria-label="Refresh board"]')!.click(); await settle() })
  expect(article().querySelector('[role="alert"]')?.textContent).toContain('credential refused')
  expect(activityLine()).toBeNull()
  expect(article().querySelector('[aria-live="polite"]')?.textContent).toBe('')
})

const dialogButton = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b => b.textContent === text)!

it('creates in the column\'s state and edits at the revision read; an edit waits for approval and is applied once a decided action re-reads the board', async () => {
  await render(<CanvasBoardFullView widget={widget()} viewTitle="Ops" overseer={overseer} onBack={() => {}} />)
  await act(async () => { article().querySelector<HTMLButtonElement>('[aria-label="New issue in Doing"]')!.click() })
  await act(async () => setFieldValue(dialogField(container, 'Title'), 'Write docs'))
  await act(async () => { dialogButton('Propose issue').click(); await settle() })
  expect(createIssue).toHaveBeenCalledWith({ title: 'Write docs', priority: 'none', stateId: 'doing' })

  await act(async () => { article().querySelector<HTMLButtonElement>('[aria-label="Edit DEMO-1"]')!.click() })
  await act(async () => setFieldValue(dialogField(container, 'Title'), 'Renamed'))
  await act(async () => { dialogButton('Propose changes').click(); await settle() })
  expect(openIssue).toHaveBeenLastCalledWith('1')
  expect(update).toHaveBeenCalledWith({ title: 'Renamed' }, '7')
  expect(card('1').textContent).toContain('Renamed')
  expect(card('1').textContent).toContain('Edit waiting for approval')
  expect(article().querySelector('[aria-label="Edit DEMO-1"]')).toBeNull()

  // Approved in the chat's action list: InferOps applies it at a new revision.
  current = { ...current, columns: current.columns.map(c => ({ ...c, issues: c.issues.map(i => i.id === '1' ? { ...i, pending: undefined, revision: '8' } : i) })) }
  await act(async () => { actions?.entry({ ...agentMove(3, 'approved'), requestedBy: 'person' }); await settle() })
  expect(card('1').textContent).toContain('Edit applied')
  expect(article().querySelector('[aria-label="Edit DEMO-1"]')).not.toBeNull()
  expect([...article().querySelectorAll('[role="status"]')].map(s => s.textContent)).toContain('Edit of DEMO-1 applied.')
})

it('opens and closes the edit form from the issue its owner holds, and says when that issue is gone', async () => {
  const onChange = vi.fn<(issueId: string | null) => void>()
  await render(<CanvasBoardFullView widget={widget()} viewTitle="Ops" overseer={overseer} onBack={() => {}} openIssue={{ issueId: null, onChange }} />)
  await act(async () => { article().querySelector<HTMLButtonElement>('[aria-label="Edit DEMO-1"]')!.click() })
  expect(onChange).toHaveBeenLastCalledWith('1')
  expect(container.querySelector('[role="dialog"]')).toBeNull()

  // The held issue opens its form, as after a reload; Cancel hands Back to the owner.
  await render(<CanvasBoardFullView widget={widget()} viewTitle="Ops" overseer={overseer} onBack={() => {}} openIssue={{ issueId: '1', onChange }} />)
  expect(dialogField<HTMLInputElement>(container, 'Title').value).toBe('Issue 1')
  await act(async () => { dialogButton('Cancel').click() })
  expect(onChange).toHaveBeenLastCalledWith(null)

  // An issue the board no longer has is explicit, with the way back, never another issue.
  await render(<CanvasBoardFullView widget={widget()} viewTitle="Ops" overseer={overseer} onBack={() => {}} openIssue={{ issueId: 'deleted', onChange }} />)
  expect(article().querySelector('[role="alert"]')?.textContent).toContain('no longer on this board')
  expect(container.querySelector('[role="dialog"]')).toBeNull()
  await act(async () => { [...article().querySelectorAll('button')].find(b => b.textContent === 'Back to the board')!.click() })
  expect(onChange).toHaveBeenLastCalledWith(null)
})

it('proposes a new issue once however often it is submitted while the proposal is in flight', async () => {
  let release!: () => void
  createIssue.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
  await render(<CanvasBoardFullView widget={widget()} viewTitle="Ops" overseer={overseer} onBack={() => {}} />)
  await act(async () => { article().querySelector<HTMLButtonElement>('[aria-label="New issue in Doing"]')!.click() })
  await act(async () => setFieldValue(dialogField(container, 'Title'), 'Only once'))
  const form = dialogButton('Propose issue').closest('form')!
  await act(async () => { form.requestSubmit(); form.requestSubmit(); form.requestSubmit() })
  await act(async () => { release(); await settle() })
  expect(createIssue).toHaveBeenCalledTimes(1)
})

it('offers what its scope supplies when the board is not connected there', async () => {
  lookup.mockResolvedValue(null)
  await render(<CanvasBoardWidget widget={widget()} overseer={overseer} presentation="card"
    unboundAction={retry => <button type="button" onClick={retry}>Connect yours</button>} />)
  expect(container.textContent).not.toContain('This workspace has no connection')
  lookup.mockResolvedValue(connection)
  await act(async () => { [...container.querySelectorAll('button')].find(b => b.textContent === 'Connect yours')!.click(); await settle() })
  expect(card('1')).toBeDefined()
})

it('never paints a board read that lands after the session switched to another board', async () => {
  const OTHER = 'inferops://demo.local/project/board/OTHER'
  const other: Board = { ...demo, project: { id: 'q', identifier: 'OTHER', name: 'Other' }, columns: demo.columns.map(c => ({ ...c, issues: [] })) }
  let resolveFirst!: (board: Board) => void
  readBoard.mockReturnValueOnce(new Promise(r => { resolveFirst = r })).mockResolvedValueOnce(other)
  const onEvent = vi.fn<(event: unknown) => void>()
  await render(<SessionBoard board={{ workspaceId: 'ws', boardRef: BOARD, issueId: null }} overseer={overseer} backLabel="Ops" onEvent={onEvent} />)
  await render(<SessionBoard board={{ workspaceId: 'ws', boardRef: OTHER, issueId: null }} overseer={overseer} backLabel="Ops" onEvent={onEvent} />)
  expect(container.querySelector('h4')?.textContent).toBe('Other (OTHER)')
  await act(async () => { resolveFirst(demo); await settle() })
  expect(container.querySelector('h4')?.textContent).toBe('Other (OTHER)')
  expect(card('1')).toBeUndefined()
})
