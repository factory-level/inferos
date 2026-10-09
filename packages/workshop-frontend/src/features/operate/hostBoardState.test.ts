import { beforeEach, describe, expect, it } from 'vitest'
import {
  HOST_BOARD_EXPIRY_MS,
  hostBoardView,
  initialHostBoardState,
  reduceHostBoard,
  type HostBoardCommand,
  type HostBoardEvent,
  type HostBoardState,
} from './hostBoardState'
import type { HostBoardView as HostBoardRead, HostBoardViewSnapshot as BoardSnapshot } from '@gadgets/workshop-shared/operate-console'
import type { HostBoardTarget } from './hostBoardTypes'

const START_WALL = Date.parse('2026-10-08T12:00:00.000Z')
const TARGET: HostBoardTarget = {
  entryId: 'entry-1',
  console: { consoleId: 'console-1', source: 'published', revision: '4' },
}
const BOARD: BoardSnapshot = {
  project: { identifier: 'ENG', name: 'Engineering' },
  columns: [{ label: 'Todo', group: 'unstarted', issues: [] }],
}

// A fake view driver: both clocks are under the test's control, and every command is recorded.
let mono: number
let wall: number
let state: HostBoardState
let commands: HostBoardCommand[]
const at = () => ({ mono, wall })
const advance = (ms: number) => { mono += ms; wall += ms }
type WithoutClock<E> = E extends unknown ? Omit<E, 'at'> : never
const dispatch = (event: WithoutClock<HostBoardEvent>) => {
  const step = reduceHostBoard(state, { ...event, at: at() } as HostBoardEvent)
  state = step.state
  commands.push(...step.commands)
  return step.commands
}
const reads = () => commands.filter(c => c.type === 'read') as Extract<HostBoardCommand, { type: 'read' }>[]
const lastRead = () => reads().at(-1)!
const view = () => hostBoardView(state, at())
const ok = (readAt = new Date(wall).toISOString(), revision = '4'): HostBoardRead =>
  ({ status: 'ok', board: BOARD, readAt, publicationRevision: revision })
const answer = (read: HostBoardRead, token = lastRead().token) => dispatch({ type: 'read-answer', token, read })

/** A mounted, visible view whose subscription delivered `selected`, with its first read sent. */
const mountSelected = () => {
  dispatch({ type: 'context', context: { token: 1, target: TARGET } })
  dispatch({ type: 'selection-subscribed', subscription: 1 })
  dispatch({ type: 'selection', subscription: 1, selection: { state: 'selected', changeSeq: 1, selectionEpoch: 1 } })
}

beforeEach(() => {
  mono = 1_000
  wall = START_WALL
  state = initialHostBoardState(true)
  commands = []
})

describe('authority and the first read', () => {
  it('reads nothing and shows unknown until the selection subscription delivers a snapshot', () => {
    dispatch({ type: 'context', context: { token: 1, target: TARGET } })
    dispatch({ type: 'selection-subscribed', subscription: 1 })
    expect(view()).toEqual({ status: 'unknown' })
    expect(reads()).toHaveLength(0)
    dispatch({ type: 'selection', subscription: 1, selection: { state: 'selected', changeSeq: 1, selectionEpoch: 1 } })
    expect(reads()).toHaveLength(1)
    expect(view()).toEqual({ status: 'loading' })
    answer(ok())
    expect(view()).toMatchObject({ status: 'ok', board: BOARD })
  })

  it('shows not-connected without reading when there is no selection', () => {
    dispatch({ type: 'context', context: { token: 1, target: TARGET } })
    dispatch({ type: 'selection-subscribed', subscription: 1 })
    dispatch({ type: 'selection', subscription: 1, selection: { state: 'none', changeSeq: 1, selectionEpoch: null } })
    expect(view()).toEqual({ status: 'not-connected' })
    expect(reads()).toHaveLength(0)
  })

  it('maps not-connected and unavailable answers to their states', () => {
    mountSelected()
    answer({ status: 'not-connected' })
    expect(view()).toEqual({ status: 'not-connected' })
    dispatch({ type: 'retry' })
    answer({ status: 'unavailable' })
    expect(view()).toEqual({ status: 'unavailable' })
  })
})

describe('invalidation', () => {
  const signals: [string, () => void][] = [
    ['an account or picker change', () => dispatch({ type: 'invalidate' })],
    ['a newer selection epoch', () => dispatch({ type: 'selection', subscription: 1, selection: { state: 'selected', changeSeq: 2, selectionEpoch: 2 } })],
    ['a selection removed', () => dispatch({ type: 'selection', subscription: 1, selection: { state: 'none', changeSeq: 2, selectionEpoch: null } })],
    ['a subscription failure', () => dispatch({ type: 'selection-failed', subscription: 1 })],
    ['a handle invalidation', () => dispatch({ type: 'handle-invalidated' })],
    ['a new context', () => dispatch({ type: 'context', context: { token: 2, target: TARGET } })],
    ['unmount', () => dispatch({ type: 'context', context: null })],
  ]
  it.each(signals)('%s clears the board immediately and starts a new generation', (_, signal) => {
    mountSelected()
    answer(ok())
    const generation = state.generation
    signal()
    expect(view().status).not.toBe('ok')
    expect(state.accepted).toBeNull()
    expect(state.generation).toBeGreaterThan(generation)
  })

  it('drops the answer of a read that an invalidation superseded, and sends the coalesced re-read after it', () => {
    mountSelected()
    const first = lastRead().token
    dispatch({ type: 'invalidate' })
    dispatch({ type: 'invalidate' })
    // At most one read in flight: the re-read waits for the superseded one to settle.
    expect(reads()).toHaveLength(1)
    answer(ok(), first)
    expect(state.accepted).toBeNull()
    expect(reads()).toHaveLength(2)
    answer(ok())
    expect(view().status).toBe('ok')
  })

  it('drops a read still in flight when the context changes, so the new context never waits on it', () => {
    mountSelected()
    const old = lastRead().token
    dispatch({ type: 'context', context: { token: 2, target: TARGET } })
    expect(state.inFlight).toBeNull()
    dispatch({ type: 'selection-subscribed', subscription: 2 })
    dispatch({ type: 'selection', subscription: 2, selection: { state: 'selected', changeSeq: 1, selectionEpoch: 1 } })
    expect(lastRead()).toMatchObject({ contextToken: 2 })
    expect(lastRead().token).not.toBe(old)
    answer(ok(), old)
    expect(state.accepted).toBeNull()
    expect(state.inFlight).not.toBeNull()
  })

  it('never reads the old handle again after a guard refusal, and waits for a new context', () => {
    mountSelected()
    dispatch({ type: 'read-failed', token: lastRead().token, failure: 'handle-invalid' })
    expect(view()).toEqual({ status: 'cleared' })
    dispatch({ type: 'retry' })
    dispatch({ type: 'timer', timer: 'refresh' })
    dispatch({ type: 'resume' })
    dispatch({ type: 'invalidate' })
    expect(reads()).toHaveLength(1)
    dispatch({ type: 'context', context: { token: 2, target: TARGET } })
    dispatch({ type: 'selection-subscribed', subscription: 2 })
    dispatch({ type: 'selection', subscription: 2, selection: { state: 'selected', changeSeq: 1, selectionEpoch: 1 } })
    expect(reads()).toHaveLength(2)
    expect(lastRead().contextToken).toBe(2)
  })
})

describe('stale recovery', () => {
  it('makes at most one immediate recovery read per generation, then waits for the cadence or Retry', () => {
    mountSelected()
    answer({ status: 'stale' })
    expect(reads()).toHaveLength(2)
    expect(view()).toEqual({ status: 'loading' })
    answer({ status: 'stale' })
    expect(reads()).toHaveLength(2)
    expect(view()).toEqual({ status: 'unavailable' })
    // A persistent stale is re-read only on the 30 s cadence, never in a loop.
    advance(30_000)
    dispatch({ type: 'timer', timer: 'refresh' })
    expect(reads()).toHaveLength(3)
    answer({ status: 'stale' })
    expect(reads()).toHaveLength(3)
    dispatch({ type: 'retry' })
    expect(reads()).toHaveLength(4)
  })

  it('gives a new generation its own recovery read', () => {
    mountSelected()
    answer({ status: 'stale' })
    answer({ status: 'stale' })
    dispatch({ type: 'invalidate' })
    answer({ status: 'stale' })
    expect(reads()).toHaveLength(4)
  })

  it('does not loop on a persistent ordinary failure either', () => {
    mountSelected()
    dispatch({ type: 'read-failed', token: lastRead().token, failure: 'error' })
    expect(view()).toEqual({ status: 'unavailable' })
    expect(reads()).toHaveLength(1)
  })
})

describe('coalescing and late answers', () => {
  it('joins requests made while a live read is in flight', () => {
    mountSelected()
    dispatch({ type: 'retry' })
    dispatch({ type: 'retry' })
    dispatch({ type: 'resume' })
    expect(reads()).toHaveLength(1)
    // They were answered by that read: nothing follows it.
    answer(ok())
    expect(reads()).toHaveLength(1)
  })

  it('drops an answer for an older or unknown token before it touches state', () => {
    mountSelected()
    const first = lastRead().token
    answer(ok())
    const before = state
    answer(ok(), first)
    answer(ok(), 999)
    expect(state).toBe(before)
  })

  it('drops an answer from an earlier context even if its token were reused', () => {
    mountSelected()
    const token = lastRead().token
    dispatch({ type: 'context', context: { token: 2, target: TARGET } })
    answer(ok(), token)
    expect(state.accepted).toBeNull()
  })

  it('refuses an answer for another publication revision or with an unparseable readAt', () => {
    mountSelected()
    answer(ok(undefined, '5'))
    expect(view()).toEqual({ status: 'unavailable' })
    dispatch({ type: 'retry' })
    answer(ok('not a time'))
    expect(view()).toEqual({ status: 'unavailable' })
  })

  it('fences a bootstrap read against a selection event with a newer epoch', () => {
    mountSelected()
    const bootstrap = lastRead().token
    dispatch({ type: 'selection', subscription: 1, selection: { state: 'selected', changeSeq: 2, selectionEpoch: 2 } })
    answer(ok(), bootstrap)
    expect(state.accepted).toBeNull()
  })
})

describe('expiry', () => {
  it('fixes the deadline at accept from the send time, so a delayed answer cannot extend it', () => {
    mountSelected()
    advance(9_000)
    answer(ok(new Date(wall).toISOString()))
    // readAt is later than the send, so it is clamped to the send: expiry is t0 + 60 s.
    expect(state.accepted!.deadlineMono).toBe(1_000 + HOST_BOARD_EXPIRY_MS)
    advance(HOST_BOARD_EXPIRY_MS - 9_000 - 1)
    expect(view().status).toBe('ok')
    advance(1)
    expect(view().status).not.toBe('ok')
  })

  it('takes an earlier server readAt as the deadline, and never recomputes it to extend lifetime', () => {
    mountSelected()
    answer(ok(new Date(wall - 20_000).toISOString()))
    const deadline = state.accepted!.deadlineMono
    expect(deadline).toBe(1_000 - 20_000 + HOST_BOARD_EXPIRY_MS)
    dispatch({ type: 'resume' })
    dispatch({ type: 'retry' })
    expect(state.accepted?.deadlineMono).toBe(deadline)
  })

  it('rejects an answer already expired on arrival', () => {
    mountSelected()
    answer(ok(new Date(wall - HOST_BOARD_EXPIRY_MS).toISOString()))
    expect(state.accepted).toBeNull()
    expect(view()).toEqual({ status: 'unavailable' })
  })

  it.each(['visibility', 'focus/pageshow/online', 'render'] as const)(
    'catches a suppressed expiry timer on %s', (trigger) => {
      mountSelected()
      answer(ok())
      dispatch({ type: 'visibility', visible: false })
      advance(HOST_BOARD_EXPIRY_MS)
      if (trigger === 'visibility') dispatch({ type: 'visibility', visible: true })
      if (trigger === 'focus/pageshow/online') dispatch({ type: 'resume' })
      expect(view().status).not.toBe('ok')
    })

  it('clears an expired board on its timer while hidden, reads nothing until shown, then re-reads', () => {
    mountSelected()
    answer(ok())
    dispatch({ type: 'visibility', visible: false })
    advance(HOST_BOARD_EXPIRY_MS)
    const before = reads().length
    dispatch({ type: 'timer', timer: 'expiry' })
    expect(state.accepted).toBeNull()
    expect(view().status).not.toBe('ok')
    expect(reads()).toHaveLength(before)
    dispatch({ type: 'visibility', visible: true })
    expect(reads()).toHaveLength(before + 1)
  })

  it('expires on a forward wall-clock jump while the monotonic clock paused in sleep', () => {
    mountSelected()
    answer(ok())
    wall += HOST_BOARD_EXPIRY_MS
    expect(view().status).not.toBe('ok')
    dispatch({ type: 'resume' })
    expect(state.accepted).toBeNull()
  })

  it('cannot be extended by moving the wall clock back', () => {
    mountSelected()
    answer(ok())
    wall -= 3_600_000
    mono += HOST_BOARD_EXPIRY_MS
    expect(view().status).not.toBe('ok')
    dispatch({ type: 'timer', timer: 'expiry' })
    expect(state.accepted).toBeNull()
  })

  it('clears an overdue board before re-reading on resume, and stays blank if that read fails', () => {
    mountSelected()
    answer(ok())
    dispatch({ type: 'visibility', visible: false })
    advance(31_000)
    const before = reads().length
    dispatch({ type: 'visibility', visible: true })
    expect(state.accepted).toBeNull()
    expect(reads()).toHaveLength(before + 1)
    expect(view()).toEqual({ status: 'loading' })
    dispatch({ type: 'read-failed', token: lastRead().token, failure: 'error' })
    expect(view().status).not.toBe('ok')
    expect(state.accepted).toBeNull()
  })

  it('keeps a board read less than 30 s ago on resume', () => {
    mountSelected()
    answer(ok())
    advance(10_000)
    dispatch({ type: 'resume' })
    expect(view().status).toBe('ok')
  })
})

const expiryTimers = () => commands.filter((c): c is Extract<HostBoardCommand, { type: 'set-timer' }> => c.type === 'set-timer' && c.timer === 'expiry')

describe('expiry scheduling on both clocks', () => {
  it('arms the expiry timer for the smaller remaining lifetime: an answer delayed across a sleep expires 10 s later', () => {
    mountSelected()
    const t0 = new Date(wall).toISOString()
    // The request slept: 5 s passed on the monotonic clock, 50 s on the wall clock.
    mono += 5_000
    wall += 50_000
    answer(ok(t0))
    expect(view().status).toBe('ok')
    expect(expiryTimers().at(-1)).toEqual({ type: 'set-timer', timer: 'expiry', delayMs: 10_000 })
    advance(10_000)
    dispatch({ type: 'timer', timer: 'expiry' })
    expect(state.accepted).toBeNull()
  })

  it('rearms on a resume when the wall clock ran ahead: mono 5 s / wall 25 s leaves 35 s', () => {
    mountSelected()
    answer(ok())
    mono += 5_000
    wall += 25_000
    dispatch({ type: 'resume' })
    expect(view().status).toBe('ok')
    expect(expiryTimers().at(-1)).toEqual({ type: 'set-timer', timer: 'expiry', delayMs: 35_000 })
  })

  it('clears and re-reads when the wall clock moved back, since the age can no longer be bounded', () => {
    mountSelected()
    answer(ok())
    const before = reads().length
    // A paused monotonic clock across a sleep, and a wall clock set back.
    mono += 1_000
    wall -= 600_000
    expect(view().status).not.toBe('ok')
    dispatch({ type: 'resume' })
    expect(state.accepted).toBeNull()
    expect(reads()).toHaveLength(before + 1)
  })
})

describe('a rejected replacement', () => {
  it.each([
    ['an unparseable readAt', () => ok('not a date')],
    ['another publication revision', () => ok(undefined, '5')],
    ['an answer already expired', () => ok(new Date(wall - HOST_BOARD_EXPIRY_MS).toISOString())],
  ])('clears the board it would have replaced (%s)', (_, replacement) => {
    mountSelected()
    answer(ok())
    advance(30_000)
    dispatch({ type: 'timer', timer: 'refresh' })
    answer(replacement())
    expect(state.accepted).toBeNull()
    expect(view()).toEqual({ status: 'unavailable' })
  })
})

describe('cadence', () => {
  it('refreshes every 30 s while visible and pauses while hidden', () => {
    mountSelected()
    answer(ok())
    expect(commands).toContainEqual({ type: 'set-timer', timer: 'refresh', delayMs: 30_000 })
    advance(30_000)
    dispatch({ type: 'timer', timer: 'refresh' })
    expect(reads()).toHaveLength(2)
    answer(ok())
    expect(dispatch({ type: 'visibility', visible: false })).toContainEqual({ type: 'clear-timer', timer: 'refresh' })
    advance(30_000)
    dispatch({ type: 'timer', timer: 'refresh' })
    expect(reads()).toHaveLength(2)
  })

  it('expires a board whose refresh hangs', () => {
    mountSelected()
    answer(ok())
    advance(30_000)
    dispatch({ type: 'timer', timer: 'refresh' })
    advance(30_000)
    dispatch({ type: 'timer', timer: 'expiry' })
    expect(view()).toEqual({ status: 'loading' })
    expect(reads()).toHaveLength(2)
  })
})

// The kernel's selection states (`HostBoardDesk.selectionState`, host-boards.ts:396-405): `none`
// always has a null epoch (never selected, or the connection removed, :389), `pending` carries
// the committed selection's epoch or null, and every change raises `changeSeq` (:258/:330/:361/:389).
const kernel = {
  none: (changeSeq: number) => ({ state: 'none', changeSeq, selectionEpoch: null }) as const,
  pending: (changeSeq: number, selectionEpoch: number | null) => ({ state: 'pending', changeSeq, selectionEpoch }) as const,
  selected: (changeSeq: number, selectionEpoch: number) => ({ state: 'selected', changeSeq, selectionEpoch }) as const,
}
const deliver = (selection: ReturnType<(typeof kernel)[keyof typeof kernel]>, subscription = 1) =>
  dispatch({ type: 'selection', subscription, selection })

describe('selection removed and picked again, in the kernel\'s shapes', () => {
  it('clears at a removal (none, null epoch), shows nothing restored by a late read, and reads again only once re-selected', () => {
    mountSelected()
    answer(ok())
    advance(30_000)
    dispatch({ type: 'timer', timer: 'refresh' })
    const late = lastRead().token
    deliver(kernel.none(2))
    expect(state.accepted).toBeNull()
    expect(view()).toEqual({ status: 'not-connected' })
    answer(ok(), late)
    expect(state.accepted).toBeNull()
    expect(view()).toEqual({ status: 'not-connected' })
    const before = reads().length
    deliver(kernel.pending(3, null))
    expect(view()).toEqual({ status: 'loading' })
    expect(reads()).toHaveLength(before)
    deliver(kernel.selected(4, 2))
    expect(reads()).toHaveLength(before + 1)
    answer(ok())
    expect(view().status).toBe('ok')
  })

  it('orders deliveries by changeSeq alone: an epoch never makes an older or repeated one current', () => {
    mountSelected()
    answer(ok())
    const before = state
    deliver(kernel.selected(1, 7))
    deliver(kernel.none(0))
    expect(state).toBe(before)
  })

  it('treats a change of epoch alone, to null included, as an invalidation', () => {
    mountSelected()
    answer(ok())
    deliver(kernel.pending(2, null))
    expect(state.accepted).toBeNull()
  })
})

describe('selection subscription', () => {
  it('ignores duplicate and older deliveries', () => {
    mountSelected()
    answer(ok())
    const before = state
    dispatch({ type: 'selection', subscription: 1, selection: { state: 'selected', changeSeq: 1, selectionEpoch: 1 } })
    dispatch({ type: 'selection', subscription: 1, selection: { state: 'none', changeSeq: 0, selectionEpoch: null } })
    expect(state).toBe(before)
  })

  it('clears the board and reads nothing while a selection is pending, then reads once it commits', () => {
    mountSelected()
    answer(ok())
    const sent = reads().length
    dispatch({ type: 'selection', subscription: 1, selection: { state: 'pending', changeSeq: 2, selectionEpoch: 1 } })
    expect(view()).toEqual({ status: 'loading' })
    expect(reads()).toHaveLength(sent)
    dispatch({ type: 'selection', subscription: 1, selection: { state: 'selected', changeSeq: 3, selectionEpoch: 2 } })
    expect(reads()).toHaveLength(sent + 1)
    answer(ok())
    expect(view().status).toBe('ok')
  })

  it('orders a first selection after a delivery with no epoch yet', () => {
    dispatch({ type: 'context', context: { token: 1, target: TARGET } })
    dispatch({ type: 'selection-subscribed', subscription: 1 })
    dispatch({ type: 'selection', subscription: 1, selection: { state: 'none', changeSeq: 1, selectionEpoch: null } })
    expect(view()).toEqual({ status: 'not-connected' })
    dispatch({ type: 'selection', subscription: 1, selection: { state: 'selected', changeSeq: 2, selectionEpoch: 1 } })
    expect(view()).toEqual({ status: 'loading' })
    expect(reads()).toHaveLength(1)
  })

  it('ignores deliveries from a subscription it no longer holds', () => {
    mountSelected()
    answer(ok())
    const before = state
    dispatch({ type: 'selection', subscription: 7, selection: { state: 'none', changeSeq: 5, selectionEpoch: null } })
    dispatch({ type: 'selection-failed', subscription: 7 })
    expect(state).toBe(before)
  })

  it('treats a failure as unknown authority and restores only after a fresh snapshot and a fenced read', () => {
    mountSelected()
    answer(ok())
    const inFlightBefore = reads().length
    dispatch({ type: 'selection-failed', subscription: 1 })
    expect(view()).toEqual({ status: 'unknown' })
    // A replayed `credentialsValid: true` account event only invalidates; it never restores data.
    dispatch({ type: 'invalidate' })
    dispatch({ type: 'retry' })
    expect(view()).toEqual({ status: 'unknown' })
    expect(reads()).toHaveLength(inFlightBefore)
    dispatch({ type: 'selection-subscribed', subscription: 2 })
    dispatch({ type: 'selection', subscription: 2, selection: { state: 'selected', changeSeq: 1, selectionEpoch: 1 } })
    expect(view()).toEqual({ status: 'loading' })
    answer(ok())
    expect(view().status).toBe('ok')
  })
})

describe('the accepted read\'s identity and deadlines', () => {
  const shown = () => {
    const current = view()
    if (current.status !== 'ok') throw new Error(`expected ok, got ${current.status}`)
    return current.read
  }

  it('names the read it shows, with a new token across a refresh and a new generation across an invalidation', () => {
    mountSelected()
    answer(ok())
    const first = shown()
    expect(first).toMatchObject({ token: lastRead().token, generation: state.generation })
    advance(30_000)
    dispatch({ type: 'timer', timer: 'refresh' })
    answer(ok())
    const refreshed = shown()
    expect(refreshed.token).toBe(lastRead().token)
    expect(refreshed.token).not.toBe(first.token)
    expect(refreshed.generation).toBe(first.generation)
    dispatch({ type: 'invalidate' })
    answer(ok())
    expect(shown().token).toBe(lastRead().token)
    expect(shown().generation).toBeGreaterThan(refreshed.generation)
  })

  it('exposes the deadlines its expiry timer is armed for, and expires exactly at the earlier one', () => {
    mountSelected()
    const t0 = new Date(wall).toISOString()
    const sent = at()
    // The request slept: 5 s passed on the monotonic clock, 50 s on the wall clock.
    mono += 5_000
    wall += 50_000
    answer(ok(t0))
    const { deadlineMono, deadlineWall } = shown()
    expect(deadlineMono).toBe(sent.mono + HOST_BOARD_EXPIRY_MS)
    expect(deadlineWall).toBe(sent.wall + HOST_BOARD_EXPIRY_MS)
    expect(expiryTimers().at(-1)).toEqual({
      type: 'set-timer', timer: 'expiry', delayMs: Math.min(deadlineMono - mono, deadlineWall - wall),
    })
    // The tick's expiry recheck, with the wall clock ahead, rearms from the same, unchanged deadlines.
    mono += 1_000
    wall += 2_000
    dispatch({ type: 'timer', timer: 'expiry' })
    expect(shown()).toMatchObject({ deadlineMono, deadlineWall })
    expect(expiryTimers().at(-1)).toEqual({
      type: 'set-timer', timer: 'expiry', delayMs: Math.min(deadlineMono - mono, deadlineWall - wall),
    })
    wall = deadlineWall - 1
    expect(view().status).toBe('ok')
    wall = deadlineWall
    expect(view().status).not.toBe('ok')
  })
})
