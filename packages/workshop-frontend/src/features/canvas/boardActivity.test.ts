import { expect, it } from 'vitest'
import type { ActionLogEntry, ActionRequester } from '@gadgets/workshop-shared/api'
import {
  RECENT_ACTIVITY_LIMIT, RECENT_ACTIVITY_MS, actionsOnly, awaitingByIssue, combineActivity, describeActivity, foldBoardActivity,
  nextActivityChange,
} from './boardActivity'

const BOARD = 'inferops://demo.local/project/board/DEMO'
const T0 = Date.UTC(2026, 9, 2, 12)
const at = (seconds: number) => new Date(T0 + seconds * 1000)

const move = (id: number, state: ActionLogEntry['state'], extra: Partial<ActionLogEntry> = {}, issue = 'DEMO-1'): ActionLogEntry => ({
  id, type: 'action', state, resourceUrl: BOARD, resourceTitle: 'InferOps board DEMO', createdAt: at(0), requestedBy: 'agent',
  description: {
    title: `Move ${issue} to Done`, description: 'Secret approver prose',
    fields: [{ label: 'Issue', kind: 'inline', value: issue }, { label: 'Title', kind: 'inline', value: 'Payload title' }],
  },
  ...extra,
} as ActionLogEntry)
const read = (id: number, seconds: number, extra: Partial<ActionLogEntry> = {}): ActionLogEntry => ({
  id, type: 'observation', state: 'approved', resourceUrl: BOARD, resourceTitle: 'InferOps board DEMO', createdAt: at(seconds),
  requestedBy: 'agent', description: { title: 'Read InferOps board DEMO', description: 'Read the board: 3 issues.' }, ...extra,
} as ActionLogEntry)

it('folds reads and decided actions into recent activity, newest first, and pending actions into active', () => {
  const activity = foldBoardActivity([read(1, 0), move(2, 'pending', { createdAt: at(5) }), read(3, 10), move(4, 'rejected', { appliedAt: at(20) }, 'DEMO-2')], BOARD, T0 + 30_000, true)
  expect(activity.active.map(item => [item.id, item.kind, item.title, item.issue])).toEqual([[2, 'awaiting', 'Move DEMO-1 to Done', 'DEMO-1']])
  expect(activity.recent.map(item => [item.id, item.kind])).toEqual([[4, 'rejected'], [3, 'read'], [1, 'read']])
  expect(activity.recent[0]?.at).toEqual(at(20))
})

it('moves an action from active to recent once decided, the later record replacing the pending one', () => {
  const pending = move(2, 'pending')
  expect(foldBoardActivity([pending], BOARD, T0, true).active).toHaveLength(1)
  const decided = foldBoardActivity([pending, move(2, 'approved', { appliedAt: at(40) })], BOARD, T0 + 41_000, true)
  expect(decided.active).toEqual([])
  expect(decided.recent.map(item => [item.id, item.kind])).toEqual([[2, 'applied']])
})

it('fades recent items after the window, keeps awaiting ones until decided, and caps the recent list', () => {
  const records = [move(1, 'pending'), ...Array.from({ length: 8 }, (_, i) => read(10 + i, i))]
  const soon = foldBoardActivity(records, BOARD, T0 + 10_000, true)
  expect(soon.recent).toHaveLength(RECENT_ACTIVITY_LIMIT)
  expect(soon.recent.map(item => item.id)).toEqual([17, 16, 15, 14, 13])
  const later = foldBoardActivity(records, BOARD, T0 + 7_000 + RECENT_ACTIVITY_MS, true)
  expect(later.recent).toEqual([])
  expect(later.active.map(item => item.id)).toEqual([1])
})

it('shows nothing as awaiting while the board connection is not usable', () => {
  const activity = foldBoardActivity([move(1, 'pending'), read(2, 0)], BOARD, T0, false)
  expect(activity.active).toEqual([])
  expect(activity.recent.map(item => item.id)).toEqual([2])
})

it('counts only entries for this board: other boards, no resource, and hooks are ignored; the host is case-insensitive', () => {
  const activity = foldBoardActivity([
    read(1, 0, { resourceUrl: 'inferops://demo.local/project/board/OTHER' }),
    read(2, 0, { resourceUrl: undefined }),
    read(3, 0, { resourceUrl: 'inferops://DEMO.local/project/board/DEMO' }),
    read(4, 0, { resourceUrl: 'inferops://demo.local/project/board/demo' }),
    { ...read(5, 0), type: 'bindHook', enabled: true, description: { title: 'Hook' } } as unknown as ActionLogEntry,
  ], BOARD, T0, true)
  expect(activity.recent.map(item => item.id)).toEqual([3])
})

it('labels who asked, and shows only the rendered title, never the description or fields', () => {
  const labels = (['agent', 'person', 'gadget', 'hook'] as ActionRequester[]).map((requestedBy, i) =>
    foldBoardActivity([read(i, 0, { requestedBy })], BOARD, T0, true).recent[0]?.actor)
  expect(labels).toEqual(['Agent', 'Person', 'Gadget', 'Automation'])
  expect(foldBoardActivity([read(1, 0, { requestedBy: undefined })], BOARD, T0, true).recent[0]?.actor).toBeNull()

  const { active, recent } = foldBoardActivity([move(1, 'pending'), read(2, 0)], BOARD, T0 + 90_000, true)
  const sentences = [...active, ...recent].map(item => describeActivity(item, T0 + 90_000))
  expect(sentences).toEqual(['Agent is waiting for approval: Move DEMO-1 to Done', 'Agent: Read InferOps board DEMO, 1m ago'])
  expect(JSON.stringify([active, recent])).not.toMatch(/Secret approver prose|Payload title/)
})

it('links an awaiting move to its issue only through a whole "Issue" field', () => {
  const truncated = move(2, 'pending', {}, 'DEMO-2')
  if (truncated.type === 'action') truncated.description.fields = [{ label: 'Issue', kind: 'inline', value: 'DEMO-', truncated: { shownBytes: 5, totalBytes: 6 } }]
  const activity = foldBoardActivity([move(1, 'pending'), truncated], BOARD, T0, true)
  expect([...awaitingByIssue(activity).keys()]).toEqual(['DEMO-1'])
})

it('says when the display next changes: an item crossing a minute of age, or fading', () => {
  const activity = foldBoardActivity([read(1, 0), read(2, 50)], BOARD, T0 + 70_000, true)
  // Item 1 fades at 120s; item 2 turns one minute old at 110s.
  expect(nextActivityChange(activity, T0 + 70_000)).toBe(T0 + 110_000)
  expect(nextActivityChange(foldBoardActivity([move(1, 'pending')], BOARD, T0, true), T0)).toBeNull()
})

it("combines a board's activity with its coding dispatch's actions, keeping each action's kind tag and leaving out the dispatch reads", () => {
  const DISPATCH = 'inferops://demo.local/project/dispatch/DEMO'
  const dispatch = move(6, 'pending', { resourceUrl: DISPATCH, createdAt: at(8), description: { title: 'Dispatch DEMO-1 to app', description: '',
    fields: [{ label: 'Issue', kind: 'inline', value: 'DEMO-1' }], actionKind: { tag: 'inferops.code-dispatch', label: 'Dispatch' } } } as Partial<ActionLogEntry>)
  const coding = foldBoardActivity([dispatch, read(7, 9, { resourceUrl: DISPATCH })], DISPATCH, T0 + 30_000, true)
  expect(coding.active[0]).toMatchObject({ id: 6, issue: 'DEMO-1', tag: 'inferops.code-dispatch' })
  const shown = combineActivity(foldBoardActivity([move(2, 'pending', { createdAt: at(5) }), read(3, 10)], BOARD, T0 + 30_000, true), actionsOnly(coding))
  expect(shown.active.map(item => item.id)).toEqual([6, 2])
  expect(shown.recent.map(item => item.id)).toEqual([3])
})

it('keeps a failed decision distinct from a rejection, as approved but not applied', () => {
  const activity = foldBoardActivity([move(2, 'pending'), move(2, 'failed', { lastAttempt: { outcome: 'notApplied', message: 'Policy denies it.', at: at(40) } })],
    BOARD, T0 + 41_000, true)
  expect(activity.recent.map(item => [item.id, item.kind])).toEqual([[2, 'failed']])
  expect(describeActivity(activity.recent[0]!, T0 + 41_000)).toContain('approved but not applied')
})
