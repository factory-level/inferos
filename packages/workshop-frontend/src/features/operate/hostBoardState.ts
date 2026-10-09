import type { HostBoardView as HostBoardRead, HostBoardViewSnapshot as BoardSnapshot } from '@gadgets/workshop-shared/operate-console'
import type { HostBoardSelectionEvent, HostBoardTarget } from './hostBoardTypes'

// The freshness rules of a host-rendered board, as a pure reducer: every effect (a read, a timer)
// is returned as a command for the caller to run, and every event carries the clocks it happened
// at, so the rules can be driven with fake clocks. Nothing here holds board data beyond the one
// accepted snapshot in state; nothing is logged or persisted.

/** A 30 s refresh while visible. */
export const HOST_BOARD_REFRESH_MS = 30_000
/** A rendered snapshot never outlives its read's start by more than 60 s. */
export const HOST_BOARD_EXPIRY_MS = 60_000
/** On resume, a snapshot read more than 30 s ago is cleared before re-reading. */
export const HOST_BOARD_RESUME_MS = 30_000

/**
 * The two clocks of an event: `mono` is monotonic (`performance.now()`), `wall` is
 * `Date.now()`. Both are checked because a monotonic clock may pause while the device sleeps.
 */
export type HostBoardClock = { mono: number; wall: number }

/** One acquired host-board handle. `token` is new for every handle, even for the same target. */
export type HostBoardContext = { token: number; target: HostBoardTarget }

type AcceptedBoard = {
  board: BoardSnapshot
  readAt: string
  /** The accepted read's identity: its context, its token (new for every read) and the generation it was sent in. */
  contextToken: number
  readToken: number
  generation: number
  /** The read's start mapped to each clock; fixed once at accept. */
  readAtMono: number
  readAtWall: number
  deadlineMono: number
  deadlineWall: number
  /**
   * The latest wall time seen since accept. It does not prove how much time passed: a wall time
   * below it means the clock moved back, so the board's age can no longer be bounded and it is
   * treated as expired (cleared and read again).
   */
  wallSeen: number
}

type InFlightRead = {
  token: number
  contextToken: number
  generation: number
  t0Mono: number
  t0Wall: number
  /** False once an invalidation superseded it: its answer is then dropped unread. */
  live: boolean
}

/** The full state of one host-board view. Opaque to callers apart from {@link hostBoardView}. */
export type HostBoardState = {
  context: HostBoardContext | null
  /** `invalid` after a guard refusal: the handle is never read again; wait for a new context. */
  handle: 'valid' | 'invalid'
  /** Rises on every invalidation signal. */
  generation: number
  /** The generation that already spent its one immediate recovery read after a `stale`. */
  recoveryUsedIn: number | null
  subscription: number | null
  /** The last selection delivery; null while authority is unknown. */
  selection: HostBoardSelectionEvent | null
  outcome: 'none' | 'not-connected' | 'unavailable'
  accepted: AcceptedBoard | null
  inFlight: InFlightRead | null
  /** A read requested while a superseded one is still in flight; sent when it settles. */
  queued: boolean
  visible: boolean
  nextToken: number
  nextRefreshMono: number | null
}

/** The timers a view keeps; setting one replaces any earlier timer of that name. */
export type HostBoardTimer = 'refresh' | 'expiry'

/** An effect for the caller to run. */
export type HostBoardCommand =
  | { type: 'read'; token: number; contextToken: number }
  | { type: 'set-timer'; timer: HostBoardTimer; delayMs: number }
  | { type: 'clear-timer'; timer: HostBoardTimer }

/** What can happen to a view. */
export type HostBoardEvent =
  /** A new handle was acquired, or (null) the view lost its handle or unmounted. */
  | { type: 'context'; context: HostBoardContext | null; at: HostBoardClock }
  /** A guard refusal (`not open`, `changed`, `OPERATE_SESSION_CONSOLE_CHANGED`) or lost authority. */
  | { type: 'handle-invalidated'; at: HostBoardClock }
  /** An account add/remove for the chosen account, a picker selection, an off-console session move. */
  | { type: 'invalidate'; at: HostBoardClock }
  | { type: 'selection-subscribed'; subscription: number; at: HostBoardClock }
  | { type: 'selection'; subscription: number; selection: HostBoardSelectionEvent; at: HostBoardClock }
  /** The selection subscription failed, was disposed, or its transport broke. */
  | { type: 'selection-failed'; subscription: number; at: HostBoardClock }
  | { type: 'read-answer'; token: number; read: HostBoardRead; at: HostBoardClock }
  /** A read that threw: `handle-invalid` for a guard refusal, `error` for anything else. */
  | { type: 'read-failed'; token: number; failure: 'handle-invalid' | 'error'; at: HostBoardClock }
  | { type: 'retry'; at: HostBoardClock }
  | { type: 'visibility'; visible: boolean; at: HostBoardClock }
  /** `focus`, `pageshow` or `online`: recheck expiry as on a resume. */
  | { type: 'resume'; at: HostBoardClock }
  | { type: 'timer'; timer: HostBoardTimer; at: HostBoardClock }

/** The reducer's result. */
export type HostBoardStep = { state: HostBoardState; commands: HostBoardCommand[] }

/**
 * The identity and lifetime of the read an `ok` view shows. `contextToken` is the handle's context
 * (unique per acquired handle, across remounts too, as the caller mints it). `token` is new for
 * every read within a context, so a refresh at the same generation still carries a new one;
 * `generation` is the invalidation generation the read was sent in. Together the three are unique
 * for the page's lifetime. The deadlines are the ones its expiry is scheduled from, fixed
 * at accept: the board is expired once either clock reaches its deadline (or the wall clock moves
 * back), so a consumer can run its own expiry timer.
 */
export type HostBoardReadIdentity = {
  contextToken: number
  token: number
  generation: number
  deadlineMono: number
  deadlineWall: number
}

/** What `HostBoardView` renders. */
export type HostBoardViewState =
  | { status: 'ok'; board: BoardSnapshot; readAt: string; read: HostBoardReadIdentity }
  | { status: 'loading' }
  | { status: 'not-connected' }
  | { status: 'unavailable' }
  /** Authority is not established (no subscription snapshot yet, or it failed). */
  | { status: 'unknown' }
  /** No handle, an invalid handle, or data cleared with no read under way. */
  | { status: 'cleared' }

/** The state of a view with no handle yet. */
export const initialHostBoardState = (visible: boolean): HostBoardState => ({
  context: null,
  handle: 'valid',
  generation: 0,
  recoveryUsedIn: null,
  subscription: null,
  selection: null,
  outcome: 'none',
  accepted: null,
  inFlight: null,
  queued: false,
  visible,
  nextToken: 1,
  nextRefreshMono: null,
})

/** The board's remaining lifetime: the smaller of the two clocks' (never extended by either). */
const remaining = (accepted: AcceptedBoard, at: HostBoardClock) =>
  Math.min(accepted.deadlineMono - at.mono, accepted.deadlineWall - at.wall)

const isExpired = (accepted: AcceptedBoard, at: HostBoardClock) =>
  at.wall < accepted.wallSeen || remaining(accepted, at) <= 0

const isOverdue = (accepted: AcceptedBoard, at: HostBoardClock) =>
  at.mono > accepted.readAtMono + HOST_BOARD_RESUME_MS
  || Math.max(accepted.wallSeen, at.wall) > accepted.readAtWall + HOST_BOARD_RESUME_MS

/**
 * What to render now. Expiry is rechecked here too, so a timer the browser suppressed can never
 * leave an expired board on screen.
 */
export const hostBoardView = (state: HostBoardState, at: HostBoardClock): HostBoardViewState => {
  if (!state.context || state.handle === 'invalid') return { status: 'cleared' }
  if (!state.selection) return { status: 'unknown' }
  const accepted = state.accepted
  if (accepted && !isExpired(accepted, at)) {
    const { contextToken, readToken: token, generation, deadlineMono, deadlineWall } = accepted
    return { status: 'ok', board: accepted.board, readAt: accepted.readAt, read: { contextToken, token, generation, deadlineMono, deadlineWall } }
  }
  if (state.selection.state === 'none') return { status: 'not-connected' }
  // A selection is being made: nothing is read until it commits.
  if (state.selection.state === 'pending') return { status: 'loading' }
  if (state.inFlight || state.queued) return { status: 'loading' }
  if (state.outcome === 'not-connected') return { status: 'not-connected' }
  if (state.outcome === 'unavailable') return { status: 'unavailable' }
  return { status: 'cleared' }
}

type Draft = { state: HostBoardState; commands: HostBoardCommand[] }

const canRead = (s: HostBoardState) =>
  s.context !== null && s.handle === 'valid' && s.selection?.state === 'selected' && s.visible

/** Drops the shown data and supersedes any read in flight, without starting a generation. */
const clearData = (d: Draft) => {
  if (d.state.accepted) d.commands.push({ type: 'clear-timer', timer: 'expiry' })
  d.state = { ...d.state, accepted: null, outcome: 'none' }
}

/** One invalidation signal: a new generation, the data cleared, the read in flight superseded. */
const invalidate = (d: Draft) => {
  clearData(d)
  const inFlight = d.state.inFlight && { ...d.state.inFlight, live: false }
  d.state = { ...d.state, generation: d.state.generation + 1, inFlight, queued: false }
}

const send = (d: Draft, at: HostBoardClock) => {
  const s = d.state
  const token = s.nextToken
  d.state = {
    ...s,
    nextToken: token + 1,
    queued: false,
    inFlight: { token, contextToken: s.context!.token, generation: s.generation, t0Mono: at.mono, t0Wall: at.wall, live: true },
  }
  d.commands.push({ type: 'read', token, contextToken: s.context!.token })
}

/** Coalesces: a request while a live read is in flight joins it; behind a superseded one it queues. */
const requestRead = (d: Draft, at: HostBoardClock) => {
  if (!canRead(d.state)) return
  const inFlight = d.state.inFlight
  if (inFlight?.live) return
  if (inFlight) { d.state = { ...d.state, queued: true }; return }
  send(d, at)
}

const scheduleRefresh = (d: Draft, at: HostBoardClock) => {
  if (!d.state.visible || d.state.handle === 'invalid' || !d.state.context) return
  d.state = { ...d.state, nextRefreshMono: at.mono + HOST_BOARD_REFRESH_MS }
  d.commands.push({ type: 'set-timer', timer: 'refresh', delayMs: HOST_BOARD_REFRESH_MS })
}

/** Clears an expired board, and on a resume also one read more than 30 s ago, then re-reads. */
const recheck = (d: Draft, at: HostBoardClock, resume: boolean) => {
  const accepted = d.state.accepted
  if (accepted) {
    if (isExpired(accepted, at) || (resume && isOverdue(accepted, at))) {
      clearData(d)
      requestRead(d, at)
      return
    }
    // Either clock may have run ahead (a sleep pauses the monotonic one), so the timer is rearmed
    // for whatever lifetime is left now.
    d.state = { ...d.state, accepted: { ...accepted, wallSeen: at.wall } }
    d.commands.push({ type: 'set-timer', timer: 'expiry', delayMs: remaining(accepted, at) })
  }
  if (resume && d.state.nextRefreshMono !== null && at.mono >= d.state.nextRefreshMono) requestRead(d, at)
}

/**
 * Whether read `token` is the one in flight and its answer may still touch state: not superseded
 * by an invalidation, a new context or a refused handle.
 */
export const isCurrentRead = (state: HostBoardState, token: number): boolean => {
  const inFlight = state.inFlight
  return !!inFlight && inFlight.token === token && inFlight.live && inFlight.contextToken === state.context?.token
    && inFlight.generation === state.generation && state.handle === 'valid'
}

/** Takes the answer's read out of flight; returns it only when its answer may touch state. */
const settle = (d: Draft, token: number): InFlightRead | null => {
  const inFlight = d.state.inFlight
  if (!inFlight || inFlight.token !== token) return null
  const current = isCurrentRead(d.state, token)
  d.state = { ...d.state, inFlight: null }
  return current ? inFlight : null
}

const accept = (d: Draft, read: Extract<HostBoardRead, { status: 'ok' }>, sent: InFlightRead, at: HostBoardClock) => {
  const readAtMs = Date.parse(read.readAt)
  // A replacement that cannot be accepted also clears the board it would have replaced.
  if (Number.isNaN(readAtMs) || read.publicationRevision !== d.state.context!.target.console.revision) {
    clearData(d)
    d.state = { ...d.state, outcome: 'unavailable' }
    return
  }
  // A `readAt` later than the send is clamped to it, so a skewed server clock cannot extend
  // freshness; an earlier one shortens it on both clocks. Fixed here once, never recomputed.
  // Open question (docs/architecture/inferops-canvas.md, "Open questions"): this compares the
  // server's `readAt` with the client's wall clock, so a client clock 60 s or more ahead of the
  // server refuses every answer (the board stays unavailable, with no reason given), and a smaller
  // skew shortens the lifetime; at 30 s or more, every focus clears the board as overdue.
  const readAtWall = Math.min(readAtMs, sent.t0Wall)
  const readAtMono = sent.t0Mono - (sent.t0Wall - readAtWall)
  const accepted: AcceptedBoard = {
    board: read.board,
    readAt: read.readAt,
    contextToken: sent.contextToken,
    readToken: sent.token,
    generation: sent.generation,
    readAtMono,
    readAtWall,
    deadlineMono: readAtMono + HOST_BOARD_EXPIRY_MS,
    deadlineWall: readAtWall + HOST_BOARD_EXPIRY_MS,
    wallSeen: Math.max(sent.t0Wall, at.wall),
  }
  if (isExpired(accepted, at)) {
    clearData(d)
    d.state = { ...d.state, outcome: 'unavailable' }
    return
  }
  d.state = { ...d.state, accepted, outcome: 'none' }
  d.commands.push({ type: 'set-timer', timer: 'expiry', delayMs: remaining(accepted, at) })
}

const afterSettle = (d: Draft, at: HostBoardClock) => {
  if (d.state.queued) { d.state = { ...d.state, queued: false }; requestRead(d, at) }
}

/**
 * The fixed safe state after an event the reducer could not apply (it threw). The board is cleared
 * and shown as *unavailable*, like an ordinary failed read: the generation rises, so any late answer
 * is dropped, and the read in flight is dropped outright rather than left to settle, so later
 * requests are not stuck joining it. The 30 s cadence (while visible) or Retry reads again. The
 * handle is kept as it was; a guard refusal still arrives as its own event.
 */
export const faultHostBoard = (state: HostBoardState, at: HostBoardClock): HostBoardStep => {
  const d: Draft = { state, commands: [] }
  invalidate(d)
  d.state = { ...d.state, inFlight: null, queued: false, outcome: 'unavailable' }
  d.commands.push({ type: 'clear-timer', timer: 'expiry' })
  scheduleRefresh(d, at)
  return d
}

/** Applies one event. Never throws; an event that does not apply leaves the state unchanged. */
export const reduceHostBoard = (state: HostBoardState, event: HostBoardEvent): HostBoardStep => {
  const d: Draft = { state, commands: [] }
  const { at } = event
  switch (event.type) {
    case 'context': {
      invalidate(d)
      // A read of the previous context is dropped outright, not left to settle: its caller may be
      // gone (an unmounted view never reports it), and the new context must not queue behind it.
      // Its answer, if one still arrives, names a token no longer in flight and is ignored.
      d.state = {
        ...d.state,
        inFlight: null,
        queued: false,
        context: event.context,
        handle: 'valid',
        recoveryUsedIn: null,
        subscription: null,
        selection: null,
        nextRefreshMono: null,
      }
      d.commands.push({ type: 'clear-timer', timer: 'refresh' }, { type: 'clear-timer', timer: 'expiry' })
      break
    }
    case 'handle-invalidated': {
      if (!d.state.context) break
      invalidate(d)
      d.state = { ...d.state, handle: 'invalid', nextRefreshMono: null }
      d.commands.push({ type: 'clear-timer', timer: 'refresh' })
      break
    }
    case 'invalidate': {
      invalidate(d)
      requestRead(d, at)
      break
    }
    case 'selection-subscribed': {
      invalidate(d)
      d.state = { ...d.state, subscription: event.subscription, selection: null }
      break
    }
    case 'selection': {
      if (event.subscription !== d.state.subscription) break
      const previous = d.state.selection
      const next = event.selection
      // Ordered by `changeSeq` alone, which the kernel raises on every change of a target's
      // selection and never resets (host-boards.ts:258/:330/:361/:389; slots are never deleted).
      // The epoch is not an order: a removal and a re-pick's `pending` carry a null one.
      if (previous && next.changeSeq <= previous.changeSeq) break
      // Any change of state or epoch (to null included) invalidates. A first snapshot after unknown
      // authority restores nothing by itself: only the fenced read it starts can show data again.
      const changed = !previous || next.selectionEpoch !== previous.selectionEpoch || next.state !== previous.state
      if (changed) invalidate(d)
      d.state = { ...d.state, selection: next }
      if (changed) requestRead(d, at)
      break
    }
    case 'selection-failed': {
      if (event.subscription !== d.state.subscription) break
      invalidate(d)
      d.state = { ...d.state, subscription: null, selection: null }
      break
    }
    case 'read-answer': {
      const sent = settle(d, event.token)
      if (sent) {
        const { read } = event
        if (read.status === 'ok') {
          accept(d, read, sent, at)
          scheduleRefresh(d, at)
        } else if (read.status === 'stale') {
          clearData(d)
          if (d.state.recoveryUsedIn !== d.state.generation) {
            d.state = { ...d.state, recoveryUsedIn: d.state.generation }
            requestRead(d, at)
          } else {
            d.state = { ...d.state, outcome: 'unavailable' }
            scheduleRefresh(d, at)
          }
        } else {
          clearData(d)
          d.state = { ...d.state, outcome: read.status }
          scheduleRefresh(d, at)
        }
      }
      afterSettle(d, at)
      break
    }
    case 'read-failed': {
      const sent = settle(d, event.token)
      if (sent && event.failure === 'handle-invalid') {
        invalidate(d)
        d.state = { ...d.state, handle: 'invalid', nextRefreshMono: null }
        d.commands.push({ type: 'clear-timer', timer: 'refresh' })
      } else if (sent) {
        clearData(d)
        d.state = { ...d.state, outcome: 'unavailable' }
        scheduleRefresh(d, at)
      }
      afterSettle(d, at)
      break
    }
    case 'retry': {
      requestRead(d, at)
      break
    }
    case 'visibility': {
      d.state = { ...d.state, visible: event.visible }
      if (!event.visible) {
        d.state = { ...d.state, nextRefreshMono: null }
        d.commands.push({ type: 'clear-timer', timer: 'refresh' })
        break
      }
      const hadData = d.state.accepted !== null
      recheck(d, at, true)
      // Coming back with nothing scheduled: read now rather than wait out a fresh cadence.
      if (!hadData && !d.state.inFlight) requestRead(d, at)
      if (!d.state.inFlight && d.state.nextRefreshMono === null) scheduleRefresh(d, at)
      break
    }
    case 'resume': {
      recheck(d, at, true)
      break
    }
    case 'timer': {
      if (event.timer === 'expiry') { recheck(d, at, false); break }
      if (!d.state.visible) break
      d.state = { ...d.state, nextRefreshMono: null }
      requestRead(d, at)
      break
    }
  }
  return d
}
