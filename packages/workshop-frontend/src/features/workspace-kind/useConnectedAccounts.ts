import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { AccountsSubscriberAdapter } from '../../accountsSubscriber'
import type { AccountOption } from '../../gatekeeper-modal/AccountChooser'
import { logRpcFailure } from '../../rpcErrors'

/**
 * This person's own connected accounts, kept current while the caller is mounted: the server pushes
 * each added, changed (a reconnect) and removed account. The subscription ends on unmount or when
 * the API changes.
 */
export const useConnectedAccounts = (api: RpcStub<AuthenticatedApi>): AccountOption[] => {
  const [accounts, setAccounts] = useState<AccountOption[]>([])

  useEffect(() => {
    let cancelled = false
    const byId = new Map<number, AccountOption>()
    setAccounts([])
    const subscriber = new AccountsSubscriberAdapter({
      add({ id, description, vendor, supportedResources, credentialsValid, vendorId }) {
        if (cancelled) return
        byId.set(id, { id, description, vendorId, vendorDescription: vendor, supportedResources, credentialsValid })
        setAccounts(Array.from(byId.values()))
      },
      remove(id) {
        if (cancelled) return
        byId.delete(id)
        setAccounts(Array.from(byId.values()))
      },
    })
    const subscription = api.subscribeConnectedAccounts(subscriber)
    subscription.catch(err => {
      if (!cancelled) logRpcFailure('Failed to subscribe to connected accounts:', err)
    })
    return () => {
      cancelled = true
      subscription[Symbol.dispose]()
    }
  }, [api])

  return accounts
}
