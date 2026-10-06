import { useState } from 'react'
import { Button, Checkbox } from '@cloudflare/kumo'
import { DEFAULT_CONSOLE_CUSTOMIZATION } from '@gadgets/workshop-shared/operate-console'
import { useAuthenticatedApi } from '../../AuthContext'
import { useWorkspaceOpen } from '../../useWorkspaceOpen'
import { invalidateWorkspaceScreens } from '../../pages/inferops-canvas/useWorkspaceScreens'
import { buildReturnHref } from './operateMode'
import type { ConsoleEntry } from './consoles'

const ignore = () => {}
const options = [
  { key: 'screens', title: 'Personal, shareable screens', description: 'Allow users to create their own screens for this console.' },
  { key: 'widgets', title: 'Custom widgets', description: 'Allow users to add their own widgets.' },
  { key: 'tools', title: 'Application tools', description: 'Allow users to add application tools.' },
  { key: 'skills', title: 'Custom skills', description: 'Allow users to add skills for the assistant.' },
] as const

/** Console policy is saved through the existing build capability, with revision conflict checks. */
export const ConsoleSettings = ({ entry, onClose, onEdit }: {
  entry: ConsoleEntry
  onClose: () => void
  onEdit: () => void
}) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const { overseer, metadata, error: accessError } = useWorkspaceOpen({ id: entry.workspace.id, authenticatedApi,
    onMetadata: ignore, onShareKeyConsumed: ignore, onInvalidShareKey: ignore })
  const [customization, setCustomization] = useState(entry.console.customization ?? { ...DEFAULT_CONSOLE_CUSTOMIZATION })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const editable = !!overseer && !!metadata && metadata.role !== 'use' && !accessError
  const save = async () => {
    if (!overseer || !editable || saving) return
    setSaving(true); setError(null)
    try {
      await overseer.stub.replaceConsole(entry.console.id, entry.console.revision, { title: entry.console.title, views: entry.console.views, fullChat: entry.console.fullChat, customization })
      invalidateWorkspaceScreens()
      onClose()
    } catch {
      setError('Could not save settings. Your choices are still here. Check your access, or reopen settings if someone else changed this console.')
    } finally { setSaving(false) }
  }
  return <section className="mx-auto w-full max-w-2xl space-y-8 px-6 py-10" aria-label="Console settings">
    <header className="flex items-start justify-between gap-4"><div>
      <h1 className="text-xl font-semibold text-kumo-default">Settings</h1>
      <p className="mt-1 text-sm text-kumo-subtle">{entry.console.title}</p>
    </div><Button variant="ghost" disabled={saving} onClick={onClose}>Done</Button></header>
    <div className="space-y-5">
      <div><h2 className="text-sm font-medium text-kumo-default">User customization</h2>
        <p className="mt-1 text-sm text-kumo-subtle">Personal additions leave the shared pages unchanged. Pages can be reused across consoles. Settings save to the draft; operators get them when you publish.</p></div>
      {options.map(option => <div key={option.key} className="space-y-1">
        <Checkbox label={option.title} checked={customization[option.key]} disabled={!editable || saving}
          onCheckedChange={checked => setCustomization({ ...customization, [option.key]: checked })} />
        <p className="pl-6 text-sm text-kumo-subtle">{option.description}</p>
      </div>)}
      {!editable && <p role="status" className="text-sm text-kumo-subtle">Console owners and editors manage these settings.</p>}
    </div>
    {error && <p role="alert" className="text-sm text-kumo-danger">{error}</p>}
    {editable && <>
      <Button variant="primary" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save settings'}</Button>
      <div className="flex flex-wrap items-center gap-3 border-t border-kumo-line pt-5">
        <Button disabled={saving} onClick={onEdit}>Edit pages and starting screen</Button>
        <a href={buildReturnHref()} className="rounded-md text-sm text-kumo-subtle underline focus-visible:ring-2 focus-visible:ring-kumo-ring">Open configuration workspace</a>
      </div>
    </>}
  </section>
}
