import { useState } from 'react'
import { Button, Dialog } from '@cloudflare/kumo'
import { useAuthenticatedApi } from '../../AuthContext'
import { useWorkspaceOpen } from '../../useWorkspaceOpen'
import { invalidateWorkspaceScreens } from '../../pages/inferops-canvas/useWorkspaceScreens'
import type { ConsoleEntry } from './consoles'

const ignore = () => {}

/**
 * Confirms publishing a builder's console draft, through their own build capability: operators
 * move to this revision, with its screens as they are now. A draft saved elsewhere since it was
 * listed is a conflict, never published blind.
 */
export const ConsolePublishDialog = ({ entry, onClose }: {
  entry: ConsoleEntry
  onClose: () => void
}) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const { overseer, metadata, error: accessError } = useWorkspaceOpen({ id: entry.workspace.id, authenticatedApi,
    onMetadata: ignore, onShareKeyConsumed: ignore, onInvalidShareKey: ignore })
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = !!overseer && !!metadata && metadata.role !== 'use' && !accessError
  const publish = async () => {
    if (!overseer || !ready || publishing) return
    setPublishing(true); setError(null)
    try {
      await overseer.stub.publishConsole(entry.console.id, entry.console.revision)
      invalidateWorkspaceScreens()
      onClose()
    } catch (caught) {
      console.error('Console publish failed:', caught)
      setError('Could not publish this console. If it changed since it was loaded, close this, review the latest draft and publish again. Otherwise check your access.')
    } finally { setPublishing(false) }
  }
  return <Dialog.Root open onOpenChange={open => { if (!open && !publishing) onClose() }}>
    <Dialog size="sm" className="space-y-4 rounded-xl bg-kumo-base p-5">
      <Dialog.Title className="text-base font-medium text-kumo-default">Publish {entry.console.title}?</Dialog.Title>
      <Dialog.Description className="text-sm text-kumo-subtle">
        Operators will use this version and its screens as they are now. Anyone with it open moves to it when they next navigate. Later edits stay in the draft until you publish again.
      </Dialog.Description>
      {accessError && <p role="alert" className="text-sm text-kumo-danger">This console's workspace can't be opened. You may no longer have access to it.</p>}
      {error && <p role="alert" className="text-sm text-kumo-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button disabled={publishing} onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!ready || publishing} onClick={() => void publish()}>{publishing ? 'Publishing…' : 'Publish'}</Button>
      </div>
    </Dialog>
  </Dialog.Root>
}
