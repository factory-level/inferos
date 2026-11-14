import { useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { Badge, Button, Input, useKumoToastManager } from '@cloudflare/kumo'
import { PlusIcon } from '@phosphor-icons/react'
import { useAuthenticatedApi } from '../../AuthContext'
import { invalidateMyConsoles, useMyConsoles } from '../../features/operate/useMyConsoles'
import { useServerConfig } from '../../ServerConfigContext'

/**
 * A person's consoles, and where one is created: by name alone. A console belongs to no workspace
 * (ADR 0021), so nothing is chosen, created or opened first.
 */
export const ConsolesPage = ({ creating, onCreatingChange }: {
  /** Whether the name form is open, kept in the URL so "New console" elsewhere can link to it. */
  creating: boolean
  onCreatingChange: (creating: boolean) => void
}) => {
  const navigate = useNavigate()
  const toasts = useKumoToastManager()
  const { authenticatedApi } = useAuthenticatedApi()
  const durableViews = useServerConfig()?.canvasFeatures?.durableViews === true
  const consoles = useMyConsoles(authenticatedApi, durableViews)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)

  const create = async () => {
    setBusy(true)
    try {
      const created = await authenticatedApi.newConsole(title)
      invalidateMyConsoles()
      await navigate({ to: '/consoles/$id', params: { id: created.id } })
    } catch (caught) {
      console.error('Failed to create the console:', caught)
      toasts.add({ title: caught instanceof Error ? caught.message : 'The console could not be created.', variant: 'error' })
      setBusy(false)
    }
  }

  return <div className="mx-auto w-full max-w-5xl space-y-6 p-6">
    <header className="flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1">
        <h1 className="text-lg font-medium text-kumo-default">Consoles</h1>
        <p className="mt-1 text-sm text-kumo-subtle">A console brings a role's pages together for Operate. Give it a name to start.</p>
      </div>
      {!creating && <Button variant="primary" disabled={!durableViews} onClick={() => onCreatingChange(true)}>
        <PlusIcon size={14} aria-hidden />New console
      </Button>}
    </header>
    {!durableViews && <p role="status" className="text-sm text-kumo-subtle">Saved views are not enabled for this deployment, so consoles can't be created.</p>}
    {creating && durableViews && <form aria-label="New console" className="flex flex-wrap items-end gap-2 rounded-xl border border-kumo-line p-4"
      onSubmit={event => { event.preventDefault(); void create() }}>
      <div className="min-w-0 flex-1"><Input label="Console name" value={title} required maxLength={120} autoFocus disabled={busy}
        onChange={event => setTitle(event.target.value)} /></div>
      <Button type="submit" variant="primary" disabled={busy || title.trim().length === 0}>Create</Button>
      <Button type="button" disabled={busy} onClick={() => { setTitle(''); onCreatingChange(false) }}>Cancel</Button>
    </form>}
    {consoles.status === 'loading' && <p role="status" className="text-sm text-kumo-subtle">Loading consoles…</p>}
    {consoles.status === 'error' && <p role="alert" className="text-sm text-kumo-danger">Consoles could not be loaded. Reload to try again.</p>}
    {consoles.status === 'ready' && consoles.consoles.length === 0 && durableViews && !creating
      && <p className="rounded-xl border border-dashed border-kumo-line px-6 py-12 text-center text-sm text-kumo-subtle">You have no consoles yet.</p>}
    {consoles.status === 'ready' && consoles.consoles.length > 0 && <ul aria-label="Your consoles" className="divide-y divide-kumo-line rounded-xl border border-kumo-line">
      {consoles.consoles.map(console => <li key={console.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
        {console.role === 'use'
          ? <span className="min-w-0 flex-1 truncate text-sm text-kumo-default">{console.title}</span>
          : <Link to="/consoles/$id" params={{ id: console.id }} className="min-w-0 flex-1 truncate text-sm font-medium text-kumo-default hover:underline">{console.title}</Link>}
        <Badge variant={console.published ? 'success' : 'secondary'}>{console.published ? 'Published' : 'Draft'}</Badge>
        {console.role === 'use' && <span className="text-xs text-kumo-subtle">Shared with you; open it in Operate</span>}
      </li>)}
    </ul>}
  </div>
}
