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

  it('reuses the requestKey when the same intent is retried after a lost answer', () => {
    const sent = submit(initialHostBoardPickerState(1), 7, 'k1')
    const failed = reduceHostBoardPicker(sent.state, { type: 'completed', contextToken: 1, requestKey: 'k1', outcome: 'lost' })
    expect(failed.state.failed).toBe(true)
    expect(submit(failed.state, 7, 'k2').commands).toMatchObject([{ requestKey: 'k1' }])
  })

  it('takes a fresh requestKey after a settled superseded or failed answer, which that key would only repeat', () => {
    const sent = submit(initialHostBoardPickerState(1), 7, 'k1')
    const settled = reduceHostBoardPicker(sent.state, { type: 'completed', contextToken: 1, requestKey: 'k1', outcome: 'settled' })
    expect(settled.state.failed).toBe(true)
    expect(settled.commands).toEqual([])
    expect(submit(settled.state, 7, 'k2').commands).toMatchObject([{ requestKey: 'k2' }])
  })

  it.each([
    ['another account', 8, TARGET],
    ['another revision', 7, { ...TARGET, console: { ...TARGET.console, revision: '5' } }],
    ['the draft instead', 7, { ...TARGET, console: { ...TARGET.console, source: 'draft' as const } }],
    ['another entry', 7, { ...TARGET, entryId: 'entry-2' }],
  ])('takes a new requestKey for %s', (_, accountId, target) => {
    const sent = submit(initialHostBoardPickerState(1), 7, 'k1')
    const failed = reduceHostBoardPicker(sent.state, { type: 'completed', contextToken: 1, requestKey: 'k1', outcome: 'lost' })
    expect(submit(failed.state, accountId, 'k2', target).commands).toMatchObject([{ requestKey: 'k2' }])
  })

  it('retries only a lost answer, with its intent and key, and nothing after a settled one', () => {
    const sent = submit(initialHostBoardPickerState(1), 7, 'k1')
    const lost = reduceHostBoardPicker(sent.state, { type: 'completed', contextToken: 1, requestKey: 'k1', outcome: 'lost' })
    const retried = reduceHostBoardPicker(lost.state, { type: 'retry' })
    expect(retried.commands).toMatchObject([{ type: 'select', requestKey: 'k1', intent: { accountId: 7 } }])
    expect(reduceHostBoardPicker(retried.state, { type: 'retry' }).commands).toEqual([])
    const settled = reduceHostBoardPicker(sent.state, { type: 'completed', contextToken: 1, requestKey: 'k1', outcome: 'settled' })
    expect(reduceHostBoardPicker(settled.state, { type: 'retry' }).commands).toEqual([])
  })

  it('reports a commit once, and a later click is a new intent', () => {
    const sent = submit(initialHostBoardPickerState(1), 7, 'k1')
    const done = reduceHostBoardPicker(sent.state, { type: 'completed', contextToken: 1, requestKey: 'k1', outcome: 'selected' })
    expect(done.commands).toEqual([{ type: 'connected' }])
    expect(submit(done.state, 7, 'k2').commands).toMatchObject([{ requestKey: 'k2' }])
  })

  it('ignores a late completion after a context change', () => {
    const sent = submit(initialHostBoardPickerState(1), 7, 'k1')
    const moved = reduceHostBoardPicker(sent.state, { type: 'context', contextToken: 2 })
    const late = reduceHostBoardPicker(moved.state, { type: 'completed', contextToken: 1, requestKey: 'k1', outcome: 'selected' })
    expect(late.commands).toEqual([])
    expect(late.state).toBe(moved.state)
  })

  it('ignores a late completion after unmount, and submits nothing once unmounted', () => {
    const sent = submit(initialHostBoardPickerState(1), 7, 'k1')
    const unmounted = reduceHostBoardPicker(sent.state, { type: 'context', contextToken: null })
    expect(reduceHostBoardPicker(unmounted.state, { type: 'completed', contextToken: 1, requestKey: 'k1', outcome: 'selected' }).commands).toEqual([])
    expect(submit(unmounted.state, 7, 'k2').commands).toEqual([])
  })
})
