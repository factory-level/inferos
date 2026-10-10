import { useEffect, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import { getOperateSessionErrorCode, OPERATE_SESSION_ERROR_CODES, type ConsoleHostBoard, type OperateSession } from '@gadgets/workshop-shared/api'
import {
  faultHostBoard,
  hostBoardView,
  initialHostBoardState,
  isCurrentRead,
  reduceHostBoard,
  type HostBoardClock,
  type HostBoardEvent,
  type HostBoardStep,
  type HostBoardTimer,
  type HostBoardViewState,
} from './hostBoardState'
import type { HostBoardTarget } from './hostBoardTypes'

type WithoutClock<E> = E extends unknown ? Omit<E, 'at'> : never
/** An event for the view, stamped with both clocks when it is applied. */
export type HostBoardInput = WithoutClock<HostBoardEvent>

const now = (): HostBoardClock => ({ mono: performance.now(), wall: Date.now() })

/** The first wait before resubscribing after a subscription ended, doubled per attempt up to the cap. */
export const HOST_BOARD_RESUBSCRIBE_MS = 2_000
/**
 * While a board is shown, expiry is rechecked this often on both clocks, so a board can't
 * outlive its wall-clock expiry because a timer fired late after the device slept.
 */
export const HOST_BOARD_TICK_MS = 5_000
const RESUBSCRIBE_CAP_MS = 30_000

// Context tokens are minted at module scope, so they rise across remounts as well as within one
// mount: a remounted view never repeats an earlier one's `(contextToken, token, generation)`.
let lastContextToken = 0

// The kernel's guard refusals: the console revision or session context the handle was acquired for
// no longer holds, so the handle is never read again and a new one waits for a new context. The
// kernel throws these as plain English errors with no code (OperateSessionImpl in
// packages/workshop-backend/src/server.ts: "is not open in your operate session" at :712
// selectHostBoardConnection, :725 getConsoleHostBoard and :769 #subscribeHostBoardSelection, and
// "has no requirement" at :733 readRequirement), so they are matched by text
// until a coded OperateSessionError exists. Anything unmatched is an ordinary failure (fail closed).
// A bound view's description (`getConsoleBoundView`) is refused with the same "is not open" text.
/** Whether `caught` is the kernel refusing a console context that is no longer open (see above). */
export const isGuardRefusal = (caught: unknown): boolean =>
  getOperateSessionErrorCode(caught) === OPERATE_SESSION_ERROR_CODES.consoleChanged
  || (caught instanceof Error && /is not open in your operate session|has no requirement/.test(caught.message))

/** What a read was sent under (see {@link HostBoardOptions.onRequest}). */
export type HostBoardReadSent = { contextToken: number; generation: number; changeSeq: number | null }

/** Options for {@link useHostBoard}. */
export type HostBoardOptions = {
  /**
   * Called with the read's token where each read is issued, before its answer can arrive, so a
   * caller can tag the read (for example with its own epoch) and match the `ok` view's
   * `read.token` against it later. `sent` is what the read was sent under: its context token,
   * its generation and the selection's `changeSeq` (null while none is known), so a caller can
   * also require them unchanged when the answer is shown. It sees no board data. A throw from it
   * is dropped, and the read is still issued.
   */
  onRequest?: (readToken: number, sent: HostBoardReadSent) => void
  /**
   * Called once when the kernel refuses the handle because that console revision is no longer
   * open (a guard refusal of a read or of the selection subscription); it is never read again.
   */
  onRefused?: () => void
  /**
   * Called after each current read answered `stale` or `unavailable`, which may mean the console
   * revision moved on without this view being told, so a caller can re-check it.
   */
  onStaleOrUnavailable?: () => void
}

/**
 * One host board of the open console revision, read through the operator's own selection. It
 * acquires the kernel's handle for `target`, subscribes to its selection, and runs the host-board
 * state machine's reads and timers; the handle and subscription are disposed when `target` changes
 * or the view unmounts. The board is held only in memory. `onRefused` and `onStaleOrUnavailable`
 * (see {@link HostBoardOptions}) let the dialog close, or check its console, rather than linger.
 *
 * Nothing here reaches the global error reporter. An event the reducer throws on resets the
 * machine to {@link faultHostBoard}'s fixed *unavailable* state. Timer and DOM listener callbacks
 * drop any throw, and every promise chain ends in a terminal catch that never rethrows, so no raw
 * reason reaches window `error` or `unhandledrejection`.
 */
export const useHostBoard = (session: RpcStub<OperateSession> | null, target: HostBoardTarget, requirement: string, options?: HostBoardOptions)
  : { view: HostBoardViewState; changeSeq: number | null; dispatch: (event: HostBoardInput) => void } => {
  const machine = useRef(initialHostBoardState(document.visibilityState === 'visible'))
  const onRequest = useRef(options?.onRequest)
  onRequest.current = options?.onRequest
  const refused = useRef(options?.onRefused)
  refused.current = options?.onRefused
  const notShown = useRef(options?.onStaleOrUnavailable)
  notShown.current = options?.onStaleOrUnavailable
  const run = useRef<(event: HostBoardInput) => void>(() => {})
  const [, setTick] = useState(0)
  const { consoleId, source, revision } = target.console
  const { entryId } = target

  useEffect(() => {
    if (!session) return
    let disposed = false
    const timers = new Map<HostBoardTimer, ReturnType<typeof setTimeout>>()
    const contextToken = ++lastContextToken
    let handle: RpcStub<ConsoleHostBoard> | null = null
    let subscription: RpcStub<{}> | null = null
    let subscriptions = 0
    let handleInvalid = false
    // A refused handle is never read again, and the view is told once.
    const refuse = () => {
      if (disposed || handleInvalid) return
      handleInvalid = true
      try { refused.current?.() } catch { /* dropped, like onRequest's */ }
    }
    let resubscribeTimer: ReturnType<typeof setTimeout> | undefined
    let backoff = HOST_BOARD_RESUBSCRIBE_MS

    const apply = (event: HostBoardInput) => {
      if (disposed) return
      const at = now()
      let step: HostBoardStep
      try {
        step = reduceHostBoard(machine.current, { ...event, at } as HostBoardEvent)
      } catch {
        step = faultHostBoard(machine.current, at)
      }
      machine.current = step.state
      for (const command of step.commands) {
        if (command.type === 'read') {
          if (!handle) continue
          const { token } = command
          const inFlight = machine.current.inFlight
          const sent: HostBoardReadSent = { contextToken: command.contextToken,
            generation: inFlight?.token === token ? inFlight.generation : machine.current.generation,
            changeSeq: machine.current.selection?.changeSeq ?? null }
          try { onRequest.current?.(token, sent) } catch { /* dropped: the read is issued regardless */ }
          handle.readRequirement(requirement)
            .then(read => {
              // Only a current read's answer says anything about the console now.
              const current = !disposed && isCurrentRead(machine.current, token)
              apply({ type: 'read-answer', token, read })
              // Without a guard refusal, a moved-on revision reads as `stale` (then `unavailable`):
              // the caller re-checks the console rather than trust a notice it may have missed.
              if (current && (read.status === 'stale' || read.status === 'unavailable')) {
                try { notShown.current?.() } catch { /* dropped, like onRequest's */ }
              }
            })
            // Anything but a recognized guard refusal is an ordinary failure: the board is cleared
            // and shown as unavailable, and only the cadence, Retry or the tab being shown again
            // reads again.
            .catch((caught: unknown) => {
              const guard = isGuardRefusal(caught)
              if (guard) refuse()
              apply({ type: 'read-failed', token, failure: guard ? 'handle-invalid' : 'error' })
            })
            .catch(() => {})
        } else if (command.type === 'set-timer') {
          clearTimeout(timers.get(command.timer))
          const { timer } = command
          timers.set(timer, setTimeout(contained(() => { timers.delete(timer); apply({ type: 'timer', timer }) }), command.delayMs))
        } else {
          clearTimeout(timers.get(command.timer))
          timers.delete(command.timer)
        }
      }
      setTick(tick => tick + 1)
    }
    run.current = apply
    // For timer and DOM listener callbacks, where a throw would reach window `error`.
    const contained = (fn: () => void) => () => { try { fn() } catch { /* dropped */ } }

    handle = session.getConsoleHostBoard({ consoleId, source, revision }, entryId)
    apply({ type: 'context', context: { token: contextToken, target: { entryId, console: { consoleId, source, revision } } } })
    // A subscription that ended (`unknown`, a failed delivery or a broken transport) leaves authority
    // unknown and the board cleared; a fresh subscription, after a backoff or at once on a resume,
    // restores it only through its own snapshot and a fenced read. A refused handle is never retried.
    const subscribe = () => {
      clearTimeout(resubscribeTimer)
      resubscribeTimer = undefined
      if (disposed || handleInvalid) return
      subscription?.[Symbol.dispose]()
      subscription = null
      const id = ++subscriptions
      apply({ type: 'selection-subscribed', subscription: id })
      const ended = () => {
        if (disposed || handleInvalid || id !== subscriptions) return
        apply({ type: 'selection-failed', subscription: id })
        resubscribeTimer = setTimeout(contained(subscribe), backoff)
        backoff = Math.min(backoff * 2, RESUBSCRIBE_CAP_MS)
      }
      const pending = handle!.subscribeSelection(update => {
        if (id !== subscriptions) return
        if (update.state === 'unknown') { ended(); return }
        backoff = HOST_BOARD_RESUBSCRIBE_MS
        apply({ type: 'selection', subscription: id, selection: update })
      })
      pending.then(stub => {
        if (disposed || id !== subscriptions) stub[Symbol.dispose]()
        else subscription = stub
      }).catch((caught: unknown) => {
        if (id !== subscriptions) return
        if (isGuardRefusal(caught)) { refuse(); apply({ type: 'handle-invalidated' }) }
        else ended()
      }).catch(() => {})
    }
    subscribe()

    const resumeSubscription = () => { if (resubscribeTimer !== undefined) subscribe() }
    const onVisibility = contained(() => {
      const visible = document.visibilityState === 'visible'
      apply({ type: 'visibility', visible })
      if (visible) resumeSubscription()
    })
    const onResume = contained(() => { apply({ type: 'resume' }); resumeSubscription() })
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onResume)
    window.addEventListener('pageshow', onResume)
    window.addEventListener('online', onResume)
    // Expiry is rechecked on its own, not only when something renders (see HOST_BOARD_TICK_MS);
    // the recheck clears an expired board and rearms the expiry timer, and never reads early.
    const tick = setInterval(contained(() => { if (machine.current.accepted) apply({ type: 'timer', timer: 'expiry' }) }), HOST_BOARD_TICK_MS)
    return () => {
      clearInterval(tick)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onResume)
      window.removeEventListener('pageshow', onResume)
      window.removeEventListener('online', onResume)
      // Drop the handle before disposing, so nothing settling later can touch the next context.
      apply({ type: 'context', context: null })
      disposed = true
      run.current = () => {}
      for (const timer of timers.values()) clearTimeout(timer)
      clearTimeout(resubscribeTimer)
      subscription?.[Symbol.dispose]()
      handle?.[Symbol.dispose]()
    }
  }, [session, consoleId, source, revision, entryId, requirement])

  // `changeSeq` is the latest selection delivery's, so a caller can tell whether the selection
  // changed since a read was sent (see `HostBoardReadSent`) even when that did not invalidate.
  return { view: hostBoardView(machine.current, now()), changeSeq: machine.current.selection?.changeSeq ?? null,
    dispatch: event => run.current(event) }
}
