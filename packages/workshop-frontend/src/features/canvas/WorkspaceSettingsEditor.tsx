import { useEffect, useState } from 'react'
import { Button, Loader, Select } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { WORKSPACE_SETTINGS, WORKSPACE_SETTING_KEYS, type WorkspaceConfiguration, type WorkspaceSettingKey, type WorkspaceSettings } from '@gadgets/workshop-shared/workspace-settings'
import { SETTING_LABELS, settingValueLabel } from './workspaceSettingLabels'

const UNSET = 'default'

/**
 * The workspace's own settings (FAC-95), which every page shows unless it overrides one: each
 * registry setting set here or left at its default. Saved as one change at the revision read, so
 * a change made elsewhere meanwhile is refused in the server's words rather than overwritten.
 * Nothing reaches operators until a console is published again, and no setting grants anything.
 */
export const WorkspaceSettingsEditor = ({ overseer }: { overseer: RpcStub<Overseer> }) => {
  const [read, setRead] = useState<{ configuration: WorkspaceConfiguration } | { error: string } | null>(null)
  const [draft, setDraft] = useState<WorkspaceSettings>({})
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let current = true
    overseer.getWorkspaceConfiguration().then(
      configuration => { if (current) { setRead({ configuration }); setDraft(configuration.settings) } },
      (error: unknown) => { if (current) setRead({ error: error instanceof Error ? error.message : String(error) }) })
    return () => { current = false }
  }, [overseer, attempt])

  if (!read) return <p aria-busy="true" className="flex items-center gap-2 text-sm text-kumo-subtle"><Loader size="sm" /> Reading the workspace’s settings…</p>
  if ('error' in read) return <div className="flex flex-wrap items-center gap-2 text-sm">
    <p role="alert" className="text-kumo-danger">Couldn’t read the workspace’s settings: {read.error}</p>
    <Button size="sm" onClick={() => { setRead(null); setAttempt(n => n + 1) }}>Try again</Button>
  </div>

  const { configuration } = read
  const changed = JSON.stringify(draft) !== JSON.stringify(configuration.settings)
  const choose = (key: WorkspaceSettingKey, value: string) => setDraft(previous => {
    const next: Record<string, unknown> = { ...previous }
    if (value === UNSET) delete next[key]
    else next[key] = WORKSPACE_SETTINGS[key].values.find(item => String(item) === value)
    return next as WorkspaceSettings
  })
  const save = async () => {
    setBusy(true); setSaveError(null)
    try {
      const saved = await overseer.setWorkspaceConfiguration(configuration.revision, draft)
      setRead({ configuration: saved }); setDraft(saved.settings)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return <section aria-label="Workspace settings" className="space-y-3">
    <p className="text-xs font-medium uppercase text-kumo-subtle">Workspace settings</p>
    <p className="text-sm text-kumo-subtle">Every page uses these unless it overrides one. Operators get them when a console is published. No setting grants access to data or actions.</p>
    {WORKSPACE_SETTING_KEYS.map(key => {
      const setting = WORKSPACE_SETTINGS[key]
      const value = draft[key]
      return <div key={key} className="space-y-1">
        <Select label={SETTING_LABELS[key]} value={value === undefined ? UNSET : String(value)} disabled={busy}
          onValueChange={next => choose(key, String(next ?? UNSET))}
          renderValue={next => next === UNSET || next === undefined ? `Default (${settingValueLabel(setting.default)})` : settingValueLabel(setting.values.find(item => String(item) === next) ?? String(next))}>
          <Select.Option value={UNSET}>Default ({settingValueLabel(setting.default)})</Select.Option>
          {setting.values.map(item => <Select.Option key={String(item)} value={String(item)}>{settingValueLabel(item)}</Select.Option>)}
        </Select>
        <p className="text-xs text-kumo-subtle">{setting.permits}</p>
      </div>
    })}
    {saveError && <p role="alert" className="text-sm text-kumo-danger">{saveError}</p>}
    <div className="flex flex-wrap items-center gap-2">
      <Button disabled={busy || !changed} onClick={() => void save()}>{busy ? 'Saving…' : 'Save workspace settings'}</Button>
      {saveError && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setRead(null); setSaveError(null); setAttempt(n => n + 1) }}>Reload settings</Button>}
    </div>
  </section>
}
