import { Button } from '@cloudflare/kumo'
import { Link } from '@tanstack/react-router'
import type { HostBoardSelectionIntent } from './useHostBoardSelection'
import type { HostBoardAccount } from './useHostBoardAccounts'

/**
 * Chooses which of the operator's own InferOps accounts reads a host board. It offers only the
 * accounts it is given (`useHostBoardAccounts`, filtered by the board's target); the choice and
 * its request key live with the dialog (`useHostBoardSelection`), so this view can come and go.
 */
export const HostBoardPicker = ({ accounts, intent, onSelect }: {
  accounts: readonly HostBoardAccount[] | null | 'unavailable'
  intent: HostBoardSelectionIntent
  onSelect: (accountId: number) => void
}) =>
  <div className="space-y-2">
    {accounts === null ? <p role="status">Looking for your InferOps accounts…</p>
      : accounts === 'unavailable' ? <p role="alert">Could not list your InferOps accounts. Close the board and open it again to retry.</p>
      : accounts.length === 0 ? <p role="status">You have no InferOps account that can read this board. <Link to="/gatekeepers" className="text-kumo-brand underline">Connect InferOps</Link>, then come back.</p>
      : <div className="flex flex-wrap gap-2">
          {accounts.map(account => <Button key={account.id} size="sm" disabled={intent.busy} onClick={() => onSelect(account.id)}>
            Use {account.name}
          </Button>)}
        </div>}
    {intent.refused && <p role="alert" className="text-kumo-danger">Could not use that connection. Try again, or choose another.</p>}
  </div>
