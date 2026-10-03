import { expect, it } from 'vitest'
import type { Board, Issue, State } from '@inferos/gatekeeper-inferops/src/types'
import type { PendingMove } from './boardData'
import { decidedMoves, isOverdue, moveTargets, sortIssues } from './kanbanBoard'

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

it('reads a dropped awaiting move as rejected when the issue sits elsewhere at its old revision, else applied', () => {
  const proposing: PendingMove = { ...awaiting('3'), phase: 'proposing' }
  const decided = board([[state('todo'), [issue('1', 'todo'), issue('3', 'todo')]], [state('doing'), [issue('2', 'doing', { revision: '2' })]]])
  expect(decidedMoves([awaiting('1'), awaiting('2'), proposing], [], decided)).toEqual([
    { issueId: '1', toStateId: 'doing', outcome: 'rejected', revision: '1' },
    { issueId: '2', toStateId: 'doing', outcome: 'applied', revision: '2' },
  ])
  // Still pending: no decision. Gone from the board: applied.
  expect(decidedMoves([awaiting('1')], [awaiting('1')], decided)).toEqual([])
  expect(decidedMoves([awaiting('9')], [], decided)).toEqual([{ issueId: '9', toStateId: 'doing', outcome: 'applied', revision: '1' }])
})
