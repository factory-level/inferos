import { useEffect, useState } from 'react'
import { Button } from '@cloudflare/kumo'
import { Link } from '@tanstack/react-router'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { AccountsSubscriberAdapter } from '../../accountsSubscriber'
import { useAuthenticatedApi } from '../../AuthContext'

type Account = { id: number; name: string }

/**
 * What a board on a use-role operator's console offers while it is not connected in their own
 * session workspace: connect it with one of their own accounts that can reach it, or, with none,
 * connect InferOps first. The board is then read with the operator's own InferOps access; the
 * console owner's connection is never used, and a refusal (no grant for the project) is shown as is.
 */
export const BoardConnectPrompt = ({ scope, targetRef, onConnected }: {
  /** The operator's own session workspace. */
  scope: RpcStub<Overseer>
  targetRef: string
  onConnected: () => void
}) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const [accounts, setAccounts] = useState<readonly Account[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const found = new Map<number, Account>()
    const publish = () => { if (!cancelled) setAccounts([...found.values()]) }
    const subscriber = new AccountsSubscriberAdapter({
      add({ id, description, vendor, credentialsValid }) {
        if (credentialsValid) found.set(id, { id, name: description.uniqueName ?? description.displayName ?? vendor.displayName })
        else found.delete(id)
        publish()
      },
      remove(id) { found.delete(id); publish() },
      ready: publish,
    })
    const subscription = authenticatedApi.subscribeConnectedAccounts(subscriber, { resourceUrl: targetRef })
    subscription.catch(() => { if (!cancelled) setAccounts([]) })
    return () => {
      cancelled = true
      subscription[Symbol.dispose]()
    }
  }, [authenticatedApi, targetRef])

  const connect = async (account: Account) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const connection = await scope.newGatekeeper(account.id, targetRef)
      connection?.[Symbol.dispose]()
      onConnected()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return <div className="space-y-2 text-sm text-kumo-subtle">
    <p>Not connected for you. Boards on this console are read with your own InferOps access, so connect this board with your account to see it.</p>
    {accounts === null ? <p role="status">Looking for your InferOps account…</p>
      : accounts.length === 0 ? <p role="status">You have no InferOps account connected. <Link to="/gatekeepers" className="text-kumo-brand underline">Connect InferOps</Link>, then come back to this board.</p>
      : <div className="flex flex-wrap gap-2">
          {accounts.map(account => <Button key={account.id} size="sm" disabled={busy} onClick={() => void connect(account)}>
            Connect with {account.name}
          </Button>)}
        </div>}
    {error && <p role="alert" className="text-kumo-danger">Could not connect this board: {error}</p>}
  </div>
}
