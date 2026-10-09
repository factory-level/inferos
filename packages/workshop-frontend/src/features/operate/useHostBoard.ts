import { useEffect, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import { getOperateSessionErrorCode, OPERATE_SESSION_ERROR_CODES, type ConsoleHostBoard, type OperateSession } from '@gadgets/workshop-shared/api'
import {
  hostBoardView,
  initialHostBoardState,
  reduceHostBoard,
  type HostBoardClock,
  type HostBoardEvent,
  type HostBoardTimer,
  type HostBoardViewState,
} from './hostBoardState'
import type { HostBoardTarget } from './hostBoardTypes'

type WithoutClock<E> = E extends unknown ? Omit<E, 'at'> : never
/** An event for the view, stamped with both clocks when it is applied. */
export type HostBoardInput = WithoutClock<HostBoardEvent>

const now = (): HostBoardClock => ({ mono: performance.now(), wall: Date.now() })

// The kernel's guard refusals: the console revision or session context the handle was acquired for
// no longer holds, so the handle is never read again and a new one waits for a new context.
const isGuardRefusal = (caught: unknown) =>
  getOperateSessionErrorCode(caught) === OPERATE_SESSION_ERROR_CODES.consoleChanged
  || (caught instanceof Error && /is not open in your operate session|has no requirement/.test(caught.message))

/**
 * One host board of the open console revision, read through the operator's own selection. It
 * acquires the kernel's handle for `target`, subscribes to its selection, and runs the host-board
 * state machine's reads and timers; the handle and subscription are disposed when `target` changes
 * or the view unmounts. The board is held only in memory.
 */
export const useHostBoard = (session: RpcStub<OperateSession> | null, target: HostBoardTarget, requirement: string)
  : { view: HostBoardViewState; dispatch: (event: HostBoardInput) => void } => {
  const machine = useRef(initialHostBoardState(document.visibilityState === 'visible'))
  const run = useRef<(event: HostBoardInput) => void>(() => {})
  const [, setTick] = useState(0)
  const { consoleId, source, revision } = target.console
  const { entryId } = target

  useEffect(() => {
    if (!session) return
    let disposed = false
    const timers = new Map<HostBoardTimer, ReturnType<typeof setTimeout>>()
    const contextToken = (machine.current.context?.token ?? 0) + 1
    let handle: RpcStub<ConsoleHostBoard> | null = null
    let subscription: RpcStub<{}> | null = null
    let subscriptions = 0

    const apply = (event: HostBoardInput) => {
      if (disposed) return
      const step = reduceHostBoard(machine.current, { ...event, at: now() } as HostBoardEvent)
      machine.current = step.state
      for (const command of step.commands) {
        if (command.type === 'read') {
          if (!handle) continue
          const { token } = command
          handle.readRequirement(requirement)
            .then(read => apply({ type: 'read-answer', token, read }))
            .catch((caught: unknown) => apply({ type: 'read-failed', token, failure: isGuardRefusal(caught) ? 'handle-invalid' : 'error' }))
        } else if (command.type === 'set-timer') {
          clearTimeout(timers.get(command.timer))
          const { timer } = command
          timers.set(timer, setTimeout(() => { timers.delete(timer); apply({ type: 'timer', timer }) }, command.delayMs))
        } else {
          clearTimeout(timers.get(command.timer))
          timers.delete(command.timer)
        }
      }
      setTick(tick => tick + 1)
    }
    run.current = apply

    handle = session.getConsoleHostBoard({ consoleId, source, revision }, entryId)
    apply({ type: 'context', context: { token: contextToken, target: { entryId, console: { consoleId, source, revision } } } })
    const subscribe = () => {
      const id = ++subscriptions
      apply({ type: 'selection-subscribed', subscription: id })
      const pending = handle!.subscribeSelection(update => {
        if (update.state === 'unknown') apply({ type: 'selection-failed', subscription: id })
        else apply({ type: 'selection', subscription: id, selection: update })
      })
      pending.then(stub => {
        if (disposed || id !== subscriptions) stub[Symbol.dispose]()
        else subscription = stub
      }).catch((caught: unknown) => {
        if (isGuardRefusal(caught)) apply({ type: 'handle-invalidated' })
        else apply({ type: 'selection-failed', subscription: id })
      })
    }
    subscribe()

    const onVisibility = () => apply({ type: 'visibility', visible: document.visibilityState === 'visible' })
    const onResume = () => apply({ type: 'resume' })
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onResume)
    window.addEventListener('pageshow', onResume)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onResume)
      window.removeEventListener('pageshow', onResume)
      // Drop the handle before disposing, so nothing settling later can touch the next context.
      apply({ type: 'context', context: null })
      disposed = true
      run.current = () => {}
      for (const timer of timers.values()) clearTimeout(timer)
      subscription?.[Symbol.dispose]()
      handle?.[Symbol.dispose]()
    }
  }, [session, consoleId, source, revision, entryId, requirement])

  return { view: hostBoardView(machine.current, now()), dispatch: event => run.current(event) }
}
