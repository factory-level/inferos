import { Button, Dialog } from '@cloudflare/kumo'
import { XIcon } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { OperateSession } from '@gadgets/workshop-shared/api'
import type { ConsoleRef, HostBoardEntry } from '@gadgets/workshop-shared/operate-console'
import { HostBoardPicker } from './HostBoardPicker'
import { HostBoardView } from './HostBoardView'
import { useHostBoard } from './useHostBoard'
import { useHostBoardAccounts } from './useHostBoardAccounts'
import { useHostBoardSelection } from './useHostBoardSelection'

/**
 * A host board of the console revision the session has open, opened from the console's widget
 * menu. Trusted host code renders it from the snapshot the kernel reads with the operator's own
 * selected connection; the entry's target only filters which of their accounts are offered.
 */
export const ConsoleHostBoard = ({ session, console: ref, entry, onClose }: {
  session: RpcStub<OperateSession>
  /** The revision the session opened. */
  console: ConsoleRef
  /** The host board, as that revision registers it; it has an id once saved. */
  entry: HostBoardEntry & { id: string }
  onClose: () => void
}) => {
  const target = { entryId: entry.id, console: ref }
  const { view, dispatch } = useHostBoard(session, target, entry.requirement.name)
  // Subscribed while the board is open, not only while the picker shows: any change clears the
  // board and re-reads through the operator's current selection; it never picks an account.
  const accounts = useHostBoardAccounts(entry.requirement.target, () => dispatch({ type: 'invalidate' }))
  // The connection choice outlives the picker, which `pending` hides (see `useHostBoardSelection`).
  const selection = useHostBoardSelection(session, target, () => dispatch({ type: 'invalidate' }))
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}>
    <Dialog size="lg" className="flex max-h-[90dvh] !w-[min(1200px,calc(100vw-32px))] flex-col overflow-hidden rounded-xl bg-kumo-base p-0">
      <header className="flex items-center justify-between border-b border-kumo-line px-5 py-3">
        <Dialog.Title className="text-sm font-medium text-kumo-default">{entry.label}</Dialog.Title>
        <Dialog.Close render={<Button size="sm" variant="ghost" aria-label="Close board"><XIcon size={16} aria-hidden /></Button>} />
      </header>
      <Dialog.Description className="sr-only">A read-only board, read with your own InferOps access.</Dialog.Description>
      <div className="min-h-0 overflow-auto p-5">
        <HostBoardView label={entry.label} view={view} onRetry={() => dispatch({ type: 'retry' })}
          picker={<HostBoardPicker accounts={accounts} intent={selection.intent} onSelect={selection.select} />} />
        {selection.intent.lost && view.status !== 'ok' && <div role="alert" className="mt-3 space-y-2 text-sm text-kumo-subtle">
          <p>Could not confirm your connection choice. It may still take effect; trying again is safe.</p>
          <Button size="sm" onClick={selection.retry}>Try that connection again</Button>
        </div>}
        {(view.status === 'unknown' || view.status === 'cleared') && <p role="status" className="text-sm text-kumo-subtle">
          {view.status === 'unknown' ? 'Checking your connection for this board…' : 'Nothing is shown for this board right now. If the console changed, reopen it to continue.'}
        </p>}
      </div>
    </Dialog>
  </Dialog.Root>
}
