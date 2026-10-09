import { useEffect, useRef, useState } from 'react'
import { Button } from '@cloudflare/kumo'
import { Link } from '@tanstack/react-router'
import type { RpcStub } from 'capnweb'
import type { OperateSession } from '@gadgets/workshop-shared/api'
import { AccountsSubscriberAdapter } from '../../accountsSubscriber'
import { useAuthenticatedApi } from '../../AuthContext'
import { initialHostBoardPickerState, reduceHostBoardPicker, type HostBoardPickerCommand, type HostBoardPickerEvent } from './hostBoardPicker'
import type { HostBoardTarget } from './hostBoardTypes'

type Account = { id: number; name: string }

/**
 * Chooses which of the operator's own InferOps accounts reads a host board. It lists only accounts
 * that can reach the board's target, and selects through the operator's session, which creates the
 * connection in their own session workspace; no one else's connection is ever offered. A retry of
 * the same choice reuses its request key, so a lost answer never creates a second connection.
 */
export const HostBoardPicker = ({ session, target, targetRef, onAccountsChanged, onConnected }: {
  session: RpcStub<OperateSession>
  target: HostBoardTarget
  /** The entry's frozen target: it filters the accounts offered and grants nothing. */
  targetRef: string
  /** An account that can reach the board was added, removed or lost its credentials. */
  onAccountsChanged: () => void
  onConnected: () => void
}) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const [accounts, setAccounts] = useState<readonly Account[] | null>(null)
  const [, setTick] = useState(0)
  const contextToken = useRef(0)
  const picker = useRef(initialHostBoardPickerState(0))
  const changed = useRef(onAccountsChanged)
  changed.current = onAccountsChanged
  const connected = useRef(onConnected)
  connected.current = onConnected
  const { consoleId, source, revision } = target.console

  useEffect(() => {
    let cancelled = false
    let ready = false
    const found = new Map<number, Account>()
    const publish = () => { if (!cancelled) setAccounts([...found.values()]) }
    const subscriber = new AccountsSubscriberAdapter({
      add({ id, description, vendor, credentialsValid }) {
        if (credentialsValid) found.set(id, { id, name: description.uniqueName ?? description.displayName ?? vendor.displayName })
        else found.delete(id)
        publish()
        if (ready && !cancelled) changed.current()
      },
      remove(id) { found.delete(id); publish(); if (ready && !cancelled) changed.current() },
      ready() { ready = true; publish() },
    })
    const subscription = authenticatedApi.subscribeConnectedAccounts(subscriber, { resourceUrl: targetRef })
    subscription.catch(() => { if (!cancelled) setAccounts([]) })
    return () => {
      cancelled = true
      subscription[Symbol.dispose]()
    }
  }, [authenticatedApi, targetRef])

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
      .then(outcome => outcome.status === 'selected', () => false)
      .then(ok => apply({ type: 'completed', contextToken: token, requestKey, ok }))
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
