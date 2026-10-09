import { useEffect, useRef, useState } from 'react'
import { AccountsSubscriberAdapter } from '../../accountsSubscriber'
import { useAuthenticatedApi } from '../../AuthContext'

/** One of the operator's own accounts that can reach a host board's target. */
export type HostBoardAccount = { id: number; name: string }

/**
 * The operator's own accounts with valid credentials for `targetRef` (null until listed, and
 * `unavailable` when they could not be listed), kept
 * subscribed for as long as the board is open, so a change is seen while the board shows too.
 * `onChanged` is called for every add, removal or credential change after the first listing; it
 * only invalidates the view, and never selects an account.
 */
export const useHostBoardAccounts = (targetRef: string, onChanged: () => void): readonly HostBoardAccount[] | null | 'unavailable' => {
  const { authenticatedApi } = useAuthenticatedApi()
  const [accounts, setAccounts] = useState<readonly HostBoardAccount[] | null | 'unavailable'>(null)
  const changed = useRef(onChanged)
  changed.current = onChanged

  useEffect(() => {
    let cancelled = false
    let ready = false
    const found = new Map<number, HostBoardAccount>()
    const publish = () => { if (!cancelled) setAccounts([...found.values()]) }
    const notify = () => { if (ready && !cancelled) changed.current() }
    const subscriber = new AccountsSubscriberAdapter({
      add({ id, description, vendor, credentialsValid }) {
        if (credentialsValid) found.set(id, { id, name: description.uniqueName ?? description.displayName ?? vendor.displayName })
        else found.delete(id)
        publish()
        notify()
      },
      remove(id) { found.delete(id); publish(); notify() },
      ready() { ready = true; publish() },
    })
    const subscription = authenticatedApi.subscribeConnectedAccounts(subscriber, { resourceUrl: targetRef })
    // A failed listing is not "no accounts": it is shown as its own state, with no cause.
    subscription.catch(() => { if (!cancelled) setAccounts('unavailable') })
    return () => {
      cancelled = true
      subscription[Symbol.dispose]()
    }
  }, [authenticatedApi, targetRef])

  return accounts
}
