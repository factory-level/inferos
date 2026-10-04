import { expect, it } from 'vitest'
import type { Board, Issue, State } from '@inferos/gatekeeper-inferops/src/types'
import type { PendingMove } from './boardData'
import type { BoardActivityItem } from './boardActivity'
import { advanceDecisions, isOverdue, moveTargets, sortIssues, startDecisions } from './kanbanBoard'

const state = (id: string, workflow: State['workflow'] = 'software', group: State['group'] = 'started'): State =>
  ({ id, name: id, group, position: 0, workflow })
const issue = (id: string, stateId: string, extra: Partial<Issue> = {}): Issue => ({
  id, identifier: `DEMO-${id}`, title: id, priority: 'none', stateId, targetDate: null, workflow: 'software', revision: '1',
  assigneeId: null, blockedReason: null, ...extra,
})
const board = (columns: [State, Issue[]][]): Board =>
  ({ project: { id: 'p', identifier: 'DEMO', name: 'Demo' }, columns: columns.map(([s, issues]) => ({ state: s, issues })) })

it('offers every state of the issue\'s workflow but its own, in board order, hidden ones included', () => {
  const b = board([[state('todo'), [issue('1', 'todo')]], [state('ideas', 'content'), []], [state('doing'), []], [state('done', 'software', 'completed'), []]])
  expect(moveTargets(b, issue('1', 'todo')).map(s => s.id)).toEqual(['doing', 'done'])
})

it('sorts cards by priority, then identifier number', () => {
  const sorted = sortIssues([issue('10', 's', { priority: 'low' }), issue('2', 's', { priority: 'urgent' }), issue('3', 's'), issue('1', 's', { priority: 'low' })])
  expect(sorted.map(i => i.id)).toEqual(['2', '1', '10', '3'])
})

it('marks an open issue overdue only once its target date has passed', () => {
  expect(isOverdue(issue('1', 's', { targetDate: '2026-10-01' }), state('s'), '2026-10-02')).toBe(true)
  expect(isOverdue(issue('1', 's', { targetDate: '2026-10-02' }), state('s'), '2026-10-02')).toBe(false)
  expect(isOverdue(issue('1', 's', { targetDate: '2026-10-01' }), state('s', 'software', 'completed'), '2026-10-02')).toBe(false)
})

const awaiting = (id: string): PendingMove => ({ issueId: id, fromStateId: 'todo', toStateId: 'doing', expectedRevision: '1', phase: 'awaiting' })
const logged = (id: number, kind: BoardActivityItem['kind'], target: { issue: string } | { creates: string }): BoardActivityItem =>
  ({ id, kind, actor: 'Person', title: `Action ${id}`, at: new Date(0), ...target })

it('takes a dropped edit\'s outcome from the action log, never from the board\'s revision', () => {
  const pendingEdit = board([[state('todo'), [issue('1', 'todo', { title: 'Proposed', pending: 'update', revision: '530' })]]])
  // An outside edit moved the revision and the gatekeeper stopped overlaying the stale edit; its
  // action is still pending, so nothing is decided yet.
  const outside = board([[state('todo'), [issue('1', 'todo', { title: 'Changed elsewhere', revision: '531' })]]])
  const start = startDecisions(pendingEdit, [], [])
  const dropped = advanceDecisions(start, outside, [], [])
  expect(dropped.decisions).toEqual([])
  // Then the person denies it: the log's rejection is the outcome, though the revision is new.
  const denied = advanceDecisions(dropped.tracker, outside, [], [logged(16, 'rejected', { issue: 'DEMO-1' })])
  expect(denied.decisions).toEqual([{ change: { kind: 'update', issueId: '1', identifier: 'DEMO-1' }, outcome: 'rejected', actionId: 16 }])
  // Used once: the same record decides nothing more.
  expect(advanceDecisions(denied.tracker, outside, [], [logged(16, 'rejected', { issue: 'DEMO-1' })]).decisions).toEqual([])
})

it('holds a log decision that arrives before the board drops its change, and ignores history and untracked issues', () => {
  const simulated = board([[state('todo'), []], [state('doing'), [issue('1', 'doing'), issue('2', 'doing')]]])
  const history = [logged(3, 'applied', { issue: 'DEMO-1' })]
  const start = startDecisions(simulated, [awaiting('1')], history)
  // DEMO-2 was never pending here; its decision is not this board's to announce.
  const early = advanceDecisions(start, simulated, [awaiting('1')], [...history, logged(7, 'rejected', { issue: 'DEMO-1' }), logged(8, 'applied', { issue: 'DEMO-2' })])
  expect(early.decisions).toEqual([])
  const back = board([[state('todo'), [issue('1', 'todo')]], [state('doing'), [issue('2', 'doing')]]])
  expect(advanceDecisions(early.tracker, back, [], []).decisions).toEqual([
    { change: { kind: 'move', issueId: '1', identifier: 'DEMO-1', toStateId: 'doing' }, outcome: 'rejected', actionId: 7 },
  ])
})

it('decides a provisional card by the logged action that creates its title', () => {
  const provisional = board([[state('todo'), [issue('pending-4', 'todo', { identifier: 'DEMO-new', title: 'Write docs', pending: 'create' })]]])
  const gone = board([[state('todo'), [issue('9', 'todo', { title: 'Write docs' })]]])
  const dropped = advanceDecisions(startDecisions(provisional, [], []), gone, [], [logged(5, 'rejected', { creates: 'Other' })])
  expect(dropped.decisions).toEqual([])
  expect(advanceDecisions(dropped.tracker, gone, [], [logged(6, 'applied', { creates: 'Write docs' })]).decisions)
    .toEqual([{ change: { kind: 'create', title: 'Write docs' }, outcome: 'applied', actionId: 6 }])
})
