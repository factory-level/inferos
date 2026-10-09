import { useEffect, useRef, useState } from 'react'
import { Button } from '@cloudflare/kumo'
import { Link } from '@tanstack/react-router'
import type { RpcStub } from 'capnweb'
import type { OperateSession } from '@gadgets/workshop-shared/api'
import { initialHostBoardPickerState, reduceHostBoardPicker, type HostBoardPickerCommand, type HostBoardPickerEvent } from './hostBoardPicker'
import type { HostBoardTarget } from './hostBoardTypes'
import type { HostBoardAccount } from './useHostBoardAccounts'

/**
 * Chooses which of the operator's own InferOps accounts reads a host board. It offers only the
 * accounts it is given (`useHostBoardAccounts`, filtered by the board's target), and selects
 * through the operator's session, which creates the connection in their own session workspace; no
 * one else's connection is ever offered. A retry after a lost answer reuses its request key, so it
 * never creates a second connection; after a settled refusal the next choice is a new request.
 */
export const HostBoardPicker = ({ session, target, accounts, onConnected }: {
  session: RpcStub<OperateSession>
  target: HostBoardTarget
  accounts: readonly HostBoardAccount[] | null
  onConnected: () => void
}) => {
  const [, setTick] = useState(0)
  const contextToken = useRef(0)
  const picker = useRef(initialHostBoardPickerState(0))
  const connected = useRef(onConnected)
  connected.current = onConnected
  const { consoleId, source, revision } = target.console

  // The picker's state lives in a ref and is reduced synchronously, so its in-flight latch holds
  // before any re-render.
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

  const { inFlight, failed } = picker.current
  return <div className="space-y-2">
    {accounts === null ? <p role="status">Looking for your InferOps accounts…</p>
      : accounts.length === 0 ? <p role="status">You have no InferOps account that can read this board. <Link to="/gatekeepers" className="text-kumo-brand underline">Connect InferOps</Link>, then come back.</p>
      : <div className="flex flex-wrap gap-2">
          {accounts.map(account => <Button key={account.id} size="sm" disabled={!!inFlight}
            onClick={() => apply({ type: 'submit', target, accountId: account.id, freshKey: crypto.randomUUID() })}>
            Use {account.name}
          </Button>)}
        </div>}
    {failed && <p role="alert" className="text-kumo-danger">Could not use that connection. Try again, or choose another.</p>}
  </div>
}
