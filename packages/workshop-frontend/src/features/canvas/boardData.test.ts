import { describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { Board, Issue, IssueChanges, NewIssue } from '@inferos/gatekeeper-inferops/src/types'
import { BoardData, boardRequestKey, canonicalBoardRef, visibleColumns, type BoardRequest } from './boardData'

const DEMO = 'inferops://demo.local/project/board/DEMO'
const request = (targetRef = DEMO, params: BoardRequest['params'] = { workflow: 'software', showCompleted: false }): BoardRequest =>
  ({ kind: 'inferops.project-board', version: 1, targetRef, params })

const issue = (id: string, stateId: string, revision = '1', extra: Partial<Issue> = {}): Issue =>
  ({ id, identifier: `DEMO-${id}`, title: id, priority: 'none', stateId, targetDate: null, workflow: 'software', revision, assigneeId: null, blockedReason: null, ...extra })
const board = (issues: Issue[], identifier = 'DEMO'): Board => ({
  project: { id: 'p', identifier, name: 'Demo' },
  columns: [
    { state: { id: 'todo', name: 'Todo', group: 'unstarted', position: 0, workflow: 'software' }, issues: issues.filter(i => i.stateId === 'todo') },
    { state: { id: 'done', name: 'Done', group: 'completed', position: 1, workflow: 'software' }, issues: issues.filter(i => i.stateId === 'done') },
    { state: { id: 'draft', name: 'Draft', group: 'backlog', position: 0, workflow: 'content' }, issues: [] },
  ],
})

type Deferred<T> = { resolve: (value: T) => void; reject: (error: unknown) => void }
const deferred = <T,>() => {
  let settle!: Deferred<T>
  const promise = new Promise<T>((resolve, reject) => { settle = { resolve, reject } })
  return { promise, ...settle }
}

/** A fake workspace: which references have a connection, each read answered in order by the test. */
const workspace = (connected: Record<string, boolean> = { [DEMO]: true }) => {
  const reads: Deferred<Board>[] = []
  const transitions: { issueId: string; toStateId: string; expectedRevision: string; settle: Deferred<void> }[] = []
  const creates: { issue: NewIssue; settle: Deferred<void> }[] = []
  const updates: { issueId: string; changes: IssueChanges; expectedRevision: string; settle: Deferred<void> }[] = []
  const disposed: string[] = []
  const lookups: string[] = []
  const session = (target: string) => ({
    readBoard: () => { const read = deferred<Board>(); reads.push(read); return read.promise },
    openIssue: (issueId: string) => ({
      transition: (toStateId: string, expectedRevision: string) => {
        const settle = deferred<void>(); transitions.push({ issueId, toStateId, expectedRevision, settle }); return settle.promise
      },
      update: (changes: IssueChanges, expectedRevision: string) => {
        const settle = deferred<void>(); updates.push({ issueId, changes, expectedRevision, settle }); return settle.promise
      },
      [Symbol.dispose]: () => { disposed.push(`issue:${issueId}`) },
    }),
    createIssue: (created: NewIssue) => { const settle = deferred<void>(); creates.push({ issue: created, settle }); return settle.promise },
    [Symbol.dispose]: () => { disposed.push(`session:${target}`) },
  })
  const overseer = {
    getGatekeeperByResourceUrl: vi.fn<(target: string) => Promise<object | null>>(async target => {
      lookups.push(target)
      if (!connected[target]) return null
      return { openSession: async () => session(target), [Symbol.dispose]: () => { disposed.push(`client:${target}`) } }
    }),
  } as unknown as RpcStub<Overseer>
  return { overseer, reads, transitions, creates, updates, disposed, lookups, connected }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))
/** The issue ids per column of a loaded state, or the status when nothing is loaded. */
const columns = (state: ReturnType<BoardData['get']>) =>
  'board' in state ? state.board.columns.map(column => column.issues.map(item => item.id)) : state.status
const listen = (data: BoardData, req: BoardRequest) => {
  const changes: string[] = []
  const unsubscribe = data.subscribe(req, () => changes.push(data.get(req).status))
  return { changes, unsubscribe }
}

describe('BoardData', () => {
  it('serves duplicate widgets of one board, whatever their presentation params, from one read', async () => {
    const ws = workspace()
    const data = new BoardData(ws.overseer)
    const a = listen(data, request())
    const b = listen(data, request())
    const c = listen(data, request(DEMO, { workflow: 'content', showCompleted: true }))
    await flush()
    expect(ws.lookups).toEqual([DEMO])
    expect(ws.reads).toHaveLength(1)
    ws.reads[0]!.resolve(board([issue('1', 'todo')]))
    await flush()
    for (const card of [a, b, c]) expect(card.changes).toEqual(['ready'])
    expect(data.get(request())).toBe(data.get(request()))
    expect(data.get(request(DEMO, { workflow: 'content', showCompleted: true }))).toMatchObject({ status: 'ready' })
    a.unsubscribe(); b.unsubscribe(); c.unsubscribe()
  })

  it('reports an unconnected reference as unbound without reading anything, and retries the lookup later', async () => {
    const ws = workspace({ [DEMO]: false })
    const data = new BoardData(ws.overseer)
    const card = listen(data, request())
    await flush()
    expect(card.changes).toEqual(['unbound'])
    expect(ws.reads).toHaveLength(0)
    ws.connected[DEMO] = true
    data.refresh(request())
    await flush()
    expect(ws.lookups).toEqual([DEMO, DEMO])
    expect(ws.reads).toHaveLength(1)
  })

  it('keys the cache by canonical target, so a differently cased host is the same board', () => {
    expect(canonicalBoardRef('inferops://Demo.LOCAL/project/board/DEMO')).toBe(DEMO)
    expect(boardRequestKey(request('inferops://DEMO.local/project/board/DEMO'))).toBe(boardRequestKey(request()))
    expect(boardRequestKey(request(DEMO, { workflow: 'content', showCompleted: false }))).not.toBe(boardRequestKey(request()))
  })

  it('keeps the last good board through a failed refresh, but drops it when the connection is revoked', async () => {
    const ws = workspace()
    const data = new BoardData(ws.overseer)
    listen(data, request())
    await flush()
    ws.reads[0]!.resolve(board([issue('1', 'todo')]))
    await flush()
    data.refresh(request())
    expect(data.get(request())).toMatchObject({ status: 'stale' })
    await flush()
    ws.reads[1]!.reject(new Error('UNAVAILABLE: InferOps could not be reached.'))
    await flush()
    expect(data.get(request())).toMatchObject({ status: 'stale', error: 'InferOps could not be reached.', board: { project: { identifier: 'DEMO' } } })
    // A failed session is not reused: the next read resolves the connection again.
    expect(ws.disposed).toEqual([`client:${DEMO}`, `session:${DEMO}`])
    data.refresh(request())
    await flush()
    expect(ws.lookups).toEqual([DEMO, DEMO])
    ws.reads[2]!.reject(new Error('UNAUTHORIZED: InferOps rejected the connection.'))
    await flush()
    expect(data.get(request())).toEqual({ status: 'error', message: 'InferOps rejected the connection.' })
    // The connection removed from the workspace: the reference is unbound and nothing stale is shown.
    ws.connected[DEMO] = false
    data.refresh(request())
    await flush()
    expect(data.get(request())).toEqual({ status: 'unbound' })
  })

  it('reports InferOps turned off distinctly, drops the held board, and shows it again once it is back on', async () => {
    const ws = workspace()
    const data = new BoardData(ws.overseer)
    listen(data, request())
    await flush()
    ws.reads[0]!.resolve(board([issue('1', 'todo')]))
    await flush()
    data.refresh(request())
    await flush()
    // The gatekeeper's code survives RPC as the message prefix, after any error-class name.
    ws.reads[1]!.reject(new Error('Error: DISABLED: InferOps is turned off for this deployment.'))
    await flush()
    expect(data.get(request())).toEqual({ status: 'disabled', message: 'InferOps is turned off for this deployment.' })
    data.refresh(request())
    await flush()
    ws.reads[2]!.resolve(board([issue('1', 'todo')]))
    await flush()
    expect(columns(data.get(request()))).toEqual([['1'], [], []])
  })

  it('never lets a stale response overwrite a newer one', async () => {
    const ws = workspace()
    const data = new BoardData(ws.overseer)
    listen(data, request())
    await flush()
    data.refresh(request())
    await flush()
    expect(ws.reads).toHaveLength(2)
    ws.reads[1]!.resolve(board([issue('1', 'done')]))
    await flush()
    expect(data.get(request())).toMatchObject({ status: 'ready' })
    expect(columns(data.get(request()))).toEqual([[], ['1'], []])
    ws.reads[0]!.resolve(board([issue('1', 'todo')]))
    await flush()
    expect(columns(data.get(request()))).toEqual([[], ['1'], []])
  })

  it('gives a card arriving while an older and a newer read are in flight only the newer result', async () => {
    const ws = workspace()
    const data = new BoardData(ws.overseer)
    listen(data, request())
    await flush()
    data.refresh(request())
    await flush()
    const late = request(DEMO, { workflow: 'content', showCompleted: true })
    listen(data, late)
    await flush()
    expect(ws.reads).toHaveLength(2)
    ws.reads[1]!.resolve(board([issue('1', 'done')]))
    await flush()
    expect(columns(data.get(late))).toEqual([[], ['1'], []])
    ws.reads[0]!.resolve(board([issue('1', 'todo')]))
    await flush()
    expect(columns(data.get(late))).toEqual([[], ['1'], []])
  })

  it('bounds concurrent reads and never starts a load nobody wants any more', async () => {
    const targets = ['A', 'B', 'C', 'D', 'E'].map(key => `inferops://demo.local/project/board/${key}`)
    const ws = workspace(Object.fromEntries(targets.map(t => [t, true])))
    const data = new BoardData(ws.overseer, { maxConcurrent: 2 })
    const cards = targets.map(target => listen(data, request(target)))
    await flush()
    expect(ws.reads).toHaveLength(2)
    cards[2]!.unsubscribe()
    ws.reads[0]!.resolve(board([], 'A'))
    await flush()
    expect(ws.reads).toHaveLength(3)
    expect(ws.lookups).toEqual([targets[0], targets[1], targets[3]])
    // A result for a card that left is discarded, not applied to anyone.
    cards[1]!.unsubscribe()
    ws.reads[1]!.resolve(board([], 'B'))
    await flush()
    expect(data.get(request(targets[1]!))).toEqual({ status: 'loading' })
    expect(ws.reads).toHaveLength(4)
  })

  it('shares nothing across scopes and disposes a scope with its sessions', async () => {
    const one = workspace()
    const two = workspace()
    const first = new BoardData(one.overseer)
    const second = new BoardData(two.overseer)
    listen(first, request())
    await flush()
    one.reads[0]!.resolve(board([issue('1', 'todo')]))
    await flush()
    listen(second, request())
    expect(second.get(request())).toEqual({ status: 'loading' })
    await flush()
    expect(two.reads).toHaveLength(1)
    first.dispose()
    await flush()
    expect(one.disposed).toContain(`session:${DEMO}`)
    expect(first.get(request())).toEqual({ status: 'loading' })
    two.reads[0]!.resolve(board([issue('2', 'todo')]))
    await flush()
    expect(columns(second.get(request()))).toEqual([['2'], [], []])
  })

  it('shows a proposed move as pending until the authoritative board decides it, and re-reads around it', async () => {
    const ws = workspace()
    const data = new BoardData(ws.overseer)
    const card = listen(data, request())
    await flush()
    ws.reads[0]!.resolve(board([issue('1', 'todo', '7')]))
    await flush()
    // A read started before the move must not land over the pending move.
    data.refresh(request())
    await flush()
    const result = data.move(request(), '1', 'done', '7')
    await flush()
    expect(data.get(request())).toMatchObject({ pending: [{ issueId: '1', fromStateId: 'todo', toStateId: 'done', phase: 'proposing' }] })
    expect(ws.transitions).toMatchObject([{ issueId: '1', toStateId: 'done', expectedRevision: '7' }])
    ws.transitions[0]!.settle.resolve()
    expect(await result).toEqual({ ok: true })
    expect(ws.disposed).toContain('issue:1')
    expect(data.get(request())).toMatchObject({ status: 'stale', pending: [{ issueId: '1', phase: 'awaiting' }] })
    await flush()
    expect(ws.reads).toHaveLength(3)
    ws.reads[1]!.resolve(board([issue('1', 'todo', '7')]))
    await flush()
    expect(data.get(request())).toMatchObject({ status: 'stale', pending: [{ phase: 'awaiting' }] })
    // The gatekeeper simulates the undecided move; the card still marks it pending.
    ws.reads[2]!.resolve(board([issue('1', 'done', '7')]))
    await flush()
    expect(data.get(request())).toMatchObject({ status: 'ready', pending: [{ phase: 'awaiting' }] })
    expect(columns(data.get(request()))).toEqual([[], ['1'], []])
    expect(await data.move(request(), '1', 'todo', '7')).toMatchObject({ ok: false, code: 'CONFLICT' })
    // Approved: the revision changed, so the move is no longer pending.
    data.invalidate(DEMO)
    await flush()
    ws.reads[3]!.resolve(board([issue('1', 'done', '9')]))
    await flush()
    expect(data.get(request())).toMatchObject({ status: 'ready', pending: [] })
    expect(card.changes.at(-1)).toBe('ready')
  })

  it('drops a refused move, reports its code, and reloads the board', async () => {
    const ws = workspace()
    const data = new BoardData(ws.overseer)
    listen(data, request())
    await flush()
    ws.reads[0]!.resolve(board([issue('1', 'todo', '7')]))
    await flush()
    const result = data.move(request(), '1', 'done', '6')
    await flush()
    ws.transitions[0]!.settle.reject(new Error('STALE_REVISION: DEMO-1 is at revision 7, not 6. Read it again.'))
    expect(await result).toEqual({ ok: false, code: 'STALE_REVISION', message: 'DEMO-1 is at revision 7, not 6. Read it again.' })
    expect(data.get(request())).toMatchObject({ status: 'stale', pending: [] })
    await flush()
    expect(ws.reads).toHaveLength(2)
    expect(await data.move(request(), 'missing', 'done', '1')).toMatchObject({ ok: false, code: 'NOT_FOUND' })
  })

  it('queues a new issue through the session with its state, lists it until the board shows the provisional card, and reports refusals', async () => {
    const ws = workspace()
    const data = new BoardData(ws.overseer)
    listen(data, request())
    await flush()
    ws.reads[0]!.resolve(board([issue('1', 'todo')]))
    await flush()
    const result = data.create(request(), { title: ' Write docs ', priority: 'high', stateId: 'todo' })
    await flush()
    expect(ws.creates.map(c => c.issue)).toEqual([{ title: ' Write docs ', priority: 'high', stateId: 'todo' }])
    expect(data.get(request())).toMatchObject({ changes: [{ kind: 'create', title: 'Write docs', stateId: 'todo', phase: 'proposing' }] })
    ws.creates[0]!.settle.resolve()
    expect(await result).toEqual({ ok: true })
    expect(data.get(request())).toMatchObject({ status: 'stale', changes: [{ kind: 'create', phase: 'awaiting' }] })
    await flush()
    // The gatekeeper's read overlays the queued create itself; the adapter stops listing it.
    ws.reads[1]!.resolve(board([issue('1', 'todo'), issue('pending-9', 'todo', '0', { identifier: 'DEMO-new', title: 'Write docs', pending: 'create' })]))
    await flush()
    expect(data.get(request())).toMatchObject({ status: 'ready', changes: [] })
    expect(columns(data.get(request()))).toEqual([['1', 'pending-9'], [], []])
    const refused = data.create(request(), { title: 'Nope', stateId: 'elsewhere' })
    await flush()
    ws.creates[1]!.settle.reject(new Error('INVALID_STATE: That state is not part of this project.'))
    expect(await refused).toEqual({ ok: false, code: 'INVALID_STATE', message: 'That state is not part of this project.' })
    expect(data.get(request())).toMatchObject({ changes: [] })
  })

  it('queues an edit at the revision read, and refuses one locally while anything about the issue is pending', async () => {
    const ws = workspace()
    const data = new BoardData(ws.overseer)
    listen(data, request())
    await flush()
    ws.reads[0]!.resolve(board([issue('1', 'todo', '7'), issue('2', 'todo', '3', { pending: 'transition' }),
      issue('pending-9', 'todo', '0', { identifier: 'DEMO-new', pending: 'create' })]))
    await flush()
    const result = data.update(request(), '1', { title: 'Renamed' }, '7')
    await flush()
    expect(ws.updates).toMatchObject([{ issueId: '1', changes: { title: 'Renamed' }, expectedRevision: '7' }])
    expect(data.get(request())).toMatchObject({ changes: [{ kind: 'update', issueId: '1', phase: 'proposing' }] })
    expect(await data.update(request(), '1', { priority: 'low' }, '7')).toMatchObject({ ok: false, code: 'CONFLICT' })
    expect(await data.move(request(), '1', 'done', '7')).toMatchObject({ ok: false, code: 'CONFLICT' })
    ws.updates[0]!.settle.resolve()
    expect(await result).toEqual({ ok: true })
    expect(ws.disposed).toContain('issue:1')
    expect(await data.update(request(), '2', { title: 'x' }, '3')).toMatchObject({ ok: false, code: 'CONFLICT' })
    // A provisional card has no issue behind it: no edit, and no move (which used to fail NOT_FOUND remotely).
    expect(await data.update(request(), 'pending-9', { title: 'x' }, '0')).toMatchObject({ ok: false, code: 'PENDING_CREATE' })
    expect(await data.move(request(), 'pending-9', 'done', '0')).toMatchObject({ ok: false, code: 'PENDING_CREATE' })
    expect(ws.updates).toHaveLength(1)
    expect(ws.transitions).toHaveLength(0)
  })

  it('reports a stale edit with its code, drops it and re-reads the board', async () => {
    const ws = workspace()
    const data = new BoardData(ws.overseer)
    listen(data, request())
    await flush()
    ws.reads[0]!.resolve(board([issue('1', 'todo', '7')]))
    await flush()
    const result = data.update(request(), '1', { priority: 'high' }, '7')
    await flush()
    ws.updates[0]!.settle.reject(new Error('Error: STALE_REVISION: DEMO-1 is at revision 8, not 7. Read it again.'))
    expect(await result).toEqual({ ok: false, code: 'STALE_REVISION', message: 'DEMO-1 is at revision 8, not 7. Read it again.' })
    expect(data.get(request())).toMatchObject({ status: 'stale', changes: [] })
    await flush()
    expect(ws.reads).toHaveLength(2)
  })

  it('filters columns for presentation only', () => {
    const full = board([issue('1', 'todo'), issue('2', 'done')])
    expect(visibleColumns(full, { workflow: 'software', showCompleted: false }).map(c => c.state.id)).toEqual(['todo'])
    expect(visibleColumns(full, { workflow: 'software', showCompleted: true }).map(c => c.state.id)).toEqual(['todo', 'done'])
    expect(visibleColumns(full, { workflow: 'content', showCompleted: true }).map(c => c.state.id)).toEqual(['draft'])
  })
})
