import { useEffect, useState } from 'react'
import { Badge, Button, Loader, Select } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { CanvasPage, CanvasPageOperation } from '@gadgets/workshop-shared/canvas-model'
import type { ConfigurationTraceEntry } from '@gadgets/workshop-shared/configuration-trace'
import { WORKSPACE_SETTINGS, type WorkspaceSettingKey, type WorkspaceSettings } from '@gadgets/workshop-shared/workspace-settings'
import { SETTING_LABELS, SETTING_OWNER_LABELS, settingValueLabel } from './workspaceSettingLabels'

type Setting = Extract<ConfigurationTraceEntry, { kind: 'setting' }>
type PageHook = Extract<ConfigurationTraceEntry, { kind: 'page-hook' }>
type WorkspaceHook = Extract<ConfigurationTraceEntry, { kind: 'workspace-hook' }>

/**
 * One page's configuration, traced (FAC-95). It shows each setting with the value the page gets
 * and whether that's the page's own override, the workspace's setting or the default, and lets a
 * builder override it here or reset it to the workspace's. It lists the page's hooks with the page
 * or object that holds them and what each may do, and the workspace's hooks read-only. The trace is
 * read again for each page revision, so it always describes the page shown. An override is one
 * `setSettings` edit of this page; nothing here grants anything.
 */
export const PageConfigurationPanel = ({ overseer, page, busy, onEdit }: {
  overseer: RpcStub<Overseer>
  page: CanvasPage
  busy: boolean
  onEdit: (operations: CanvasPageOperation[]) => Promise<boolean>
}) => {
  const [trace, setTrace] = useState<{ key: string; entries: ConfigurationTraceEntry[] } | { key: string; error: string } | null>(null)
  const key = `${page.id}:${page.revision}`
  useEffect(() => {
    let current = true
    overseer.traceConfiguration(page.id).then(
      entries => { if (current) setTrace({ key, entries }) },
      (error: unknown) => { if (current) setTrace({ key, error: error instanceof Error ? error.message : String(error) }) })
    return () => { current = false }
  }, [overseer, page.id, key])

  const shown = trace?.key === key ? trace : null
  const overrides: WorkspaceSettings = page.settings ?? {}
  const override = (settingKey: WorkspaceSettingKey, value: string | null) => {
    const next: Record<string, unknown> = { ...overrides }
    if (value === null) delete next[settingKey]
    else next[settingKey] = WORKSPACE_SETTINGS[settingKey].values.find(item => String(item) === value)
    return onEdit([{ type: 'setSettings', settings: next as WorkspaceSettings }])
  }

  return <section aria-label="Page configuration" className="space-y-3">
    <p className="text-xs font-medium uppercase text-kumo-subtle">Configuration</p>
    {!shown && <p aria-busy="true" className="flex items-center gap-2 text-sm text-kumo-subtle"><Loader size="sm" /> Tracing this page’s configuration…</p>}
    {shown && 'error' in shown && <p role="alert" className="text-sm text-kumo-danger">Couldn’t trace this page’s configuration: {shown.error}</p>}
    {shown && 'entries' in shown && <>
      <ul aria-label="Settings" className="space-y-2">
        {shown.entries.filter((entry): entry is Setting => entry.kind === 'setting').map(setting => {
          const values = WORKSPACE_SETTINGS[setting.key].values
          return <li key={setting.key} className="space-y-1 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-kumo-default">{SETTING_LABELS[setting.key]}</span>
              <span className="text-kumo-default">{settingValueLabel(setting.value)}</span>
              <Badge variant={setting.owner === 'page' ? 'primary' : 'neutral'}>{SETTING_OWNER_LABELS[setting.owner]}</Badge>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <Select label={`Override ${SETTING_LABELS[setting.key]} on this page`} value={setting.owner === 'page' ? String(setting.value) : ''}
                disabled={busy} onValueChange={next => { if (next !== null && next !== undefined && next !== '') void override(setting.key, String(next)) }}
                renderValue={next => next ? settingValueLabel(values.find(item => String(item) === next) ?? String(next)) : 'Not overridden'}>
                {values.map(item => <Select.Option key={String(item)} value={String(item)}>{settingValueLabel(item)}</Select.Option>)}
              </Select>
              {setting.owner === 'page' && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void override(setting.key, null)}>Reset to workspace</Button>}
            </div>
            <p className="text-xs text-kumo-subtle">{setting.permits}</p>
          </li>
        })}
      </ul>
      <div className="space-y-1">
        <p className="text-sm font-medium text-kumo-default">Page hooks</p>
        {shown.entries.some(entry => entry.kind === 'page-hook') ? <ul aria-label="Page hooks" className="space-y-1">
          {shown.entries.filter((entry): entry is PageHook => entry.kind === 'page-hook').map(hook => <li key={hook.target} className="text-sm text-kumo-default">
            On <code>{hook.on}</code>, {hook.effect}, held by <code>{hook.owner}</code>. <span className="text-kumo-subtle">{hook.permits}</span>
          </li>)}
        </ul> : <p className="text-sm text-kumo-subtle">None. Add one from an attachment.</p>}
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-kumo-default">Workspace hooks (read-only)</p>
        {shown.entries.some(entry => entry.kind === 'workspace-hook') ? <ul aria-label="Workspace hooks" className="space-y-1">
          {shown.entries.filter((entry): entry is WorkspaceHook => entry.kind === 'workspace-hook').map(hook => <li key={hook.hookId} className="text-sm text-kumo-default">
            {hook.title}{hook.enabled ? '' : ' (off)'}: gatekeeper {hook.owner.gatekeeperId}, gadget {hook.owner.gadgetId}
            {hook.pinned ? `, workflow ${hook.pinned.definitionId} revision ${hook.pinned.revision}` : ''}. <span className="text-kumo-subtle">{hook.permits}</span>
          </li>)}
        </ul> : <p className="text-sm text-kumo-subtle">None.</p>}
      </div>
    </>}
  </section>
}
