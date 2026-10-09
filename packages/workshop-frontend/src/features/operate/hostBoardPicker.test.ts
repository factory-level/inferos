import { describe, expect, it } from 'vitest'
import { initialHostBoardPickerState, reduceHostBoardPicker, type HostBoardPickerState } from './hostBoardPicker'
import type { HostBoardTarget } from './hostBoardTypes'

const TARGET: HostBoardTarget = {
  entryId: 'entry-1',
  console: { consoleId: 'console-1', source: 'published', revision: '4' },
}

const submit = (state: HostBoardPickerState, accountId: number, freshKey: string, target = TARGET) =>
  reduceHostBoardPicker(state, { type: 'submit', target, accountId, freshKey })

describe('host-board picker intent', () => {
  it('latches synchronously, so a second submit before completion sends nothing', () => {
    const first = submit(initialHostBoardPickerState(1), 7, 'k1')
    expect(first.commands).toEqual([{ type: 'select', requestKey: 'k1', contextToken: 1, intent: {
      consoleId: 'console-1', source: 'published', revision: '4', entryId: 'entry-1', accountId: 7,
    } }])
    expect(submit(first.state, 7, 'k2').commands).toEqual([])
    expect(submit(first.state, 8, 'k3').commands).toEqual([])
  })

  it('reuses the requestKey when the same intent is retried after a failure', () => {
    const sent = submit(initialHostBoardPickerState(1), 7, 'k1')
    const failed = reduceHostBoardPicker(sent.state, { type: 'completed', contextToken: 1, requestKey: 'k1', ok: false })
    expect(failed.state.failed).toBe(true)
    expect(submit(failed.state, 7, 'k2').commands).toMatchObject([{ requestKey: 'k1' }])
  })

  it.each([
    ['another account', 8, TARGET],
    ['another revision', 7, { ...TARGET, console: { ...TARGET.console, revision: '5' } }],
    ['the draft instead', 7, { ...TARGET, console: { ...TARGET.console, source: 'draft' as const } }],
    ['another entry', 7, { ...TARGET, entryId: 'entry-2' }],
  ])('takes a new requestKey for %s', (_, accountId, target) => {
    const sent = submit(initialHostBoardPickerState(1), 7, 'k1')
    const failed = reduceHostBoardPicker(sent.state, { type: 'completed', contextToken: 1, requestKey: 'k1', ok: false })
    expect(submit(failed.state, accountId, 'k2', target).commands).toMatchObject([{ requestKey: 'k2' }])
  })

  it('reports a commit once, and a later click is a new intent', () => {
    const sent = submit(initialHostBoardPickerState(1), 7, 'k1')
    const done = reduceHostBoardPicker(sent.state, { type: 'completed', contextToken: 1, requestKey: 'k1', ok: true })
    expect(done.commands).toEqual([{ type: 'connected' }])
    expect(submit(done.state, 7, 'k2').commands).toMatchObject([{ requestKey: 'k2' }])
  })

  it('ignores a late completion after a context change', () => {
    const sent = submit(initialHostBoardPickerState(1), 7, 'k1')
    const moved = reduceHostBoardPicker(sent.state, { type: 'context', contextToken: 2 })
    const late = reduceHostBoardPicker(moved.state, { type: 'completed', contextToken: 1, requestKey: 'k1', ok: true })
    expect(late.commands).toEqual([])
    expect(late.state).toBe(moved.state)
  })

  it('ignores a late completion after unmount, and submits nothing once unmounted', () => {
    const sent = submit(initialHostBoardPickerState(1), 7, 'k1')
    const unmounted = reduceHostBoardPicker(sent.state, { type: 'context', contextToken: null })
    expect(reduceHostBoardPicker(unmounted.state, { type: 'completed', contextToken: 1, requestKey: 'k1', ok: true }).commands).toEqual([])
    expect(submit(unmounted.state, 7, 'k2').commands).toEqual([])
  })
})
