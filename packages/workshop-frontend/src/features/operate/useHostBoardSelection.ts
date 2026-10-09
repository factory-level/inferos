import { useEffect, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { OperateSession } from '@gadgets/workshop-shared/api'
import { initialHostBoardPickerState, reduceHostBoardPicker, type HostBoardPickerCommand, type HostBoardPickerEvent } from './hostBoardPicker'
import type { HostBoardTarget } from './hostBoardTypes'

/** Where the operator's connection choice for one host board stands. */
export type HostBoardSelectionIntent = {
  /** A selection call is under way; nothing else can be submitted. */
  busy: boolean
  /** The last call's answer was lost: `retry()` sends it again with the same request key. */
  lost: boolean
  /** The kernel answered superseded or failed; the next choice is a new request. */
  refused: boolean
}

/**
 * The operator's connection choice for a host board, kept for the dialog's lifetime rather than
 * the picker's: the kernel publishes `pending` as soon as it reserves the intent, which hides the
 * picker, and a reply lost after that must still be retryable with the same request key. Selects
 * through the operator's session only; `onConnected` runs once the kernel answers `selected`.
 */
export const useHostBoardSelection = (session: RpcStub<OperateSession>, target: HostBoardTarget, onConnected: () => void)
  : { intent: HostBoardSelectionIntent; select: (accountId: number) => void; retry: () => void } => {
  const [, setTick] = useState(0)
  const contextToken = useRef(0)
  const picker = useRef(initialHostBoardPickerState(0))
  const connected = useRef(onConnected)
  connected.current = onConnected
  const { consoleId, source, revision } = target.console

  // Reduced synchronously from a ref, so the in-flight latch holds before any re-render.
  const apply = (event: HostBoardPickerEvent) => {
    const step = reduceHostBoardPicker(picker.current, event)
    picker.current = step.state
    for (const command of step.commands) run(command)
    setTick(tick => tick + 1)
  }
  const run = (command: HostBoardPickerCommand) => {
    if (command.type === 'connected') { connected.current(); return }
    const { intent, requestKey, contextToken: token } = command
    session.selectHostBoardConnection({ consoleId: intent.consoleId, source: intent.source, revision: intent.revision },
      intent.entryId, intent.accountId, requestKey)
      .then(answer => answer.status === 'selected' ? 'selected' as const : 'settled' as const, () => 'lost' as const)
      .then(outcome => apply({ type: 'completed', contextToken: token, requestKey, outcome }))
  }

  useEffect(() => {
    const token = ++contextToken.current
    apply({ type: 'context', contextToken: token })
    return () => apply({ type: 'context', contextToken: null })
    // A new console revision or entry is a new intent context; `apply` reads only refs.
  }, [consoleId, source, revision, target.entryId])

  const { inFlight, failed, last } = picker.current
  return {
    intent: { busy: !!inFlight, lost: failed && !!last, refused: failed && !last },
    select: accountId => apply({ type: 'submit', target, accountId, freshKey: crypto.randomUUID() }),
    retry: () => apply({ type: 'retry' }),
  }
}
