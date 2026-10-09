import { useState } from 'react'
import { Button, Checkbox, Input, Select } from '@cloudflare/kumo'
import type { GadgetSummary } from '@gadgets/workshop-shared/api'
import { MAX_CONSOLE_WIDGETS, type ConsoleWidgetEntry } from '@gadgets/workshop-shared/operate-console'

/**
 * The widgets a console offers, edited in its draft. A candidate is a widget installed into the
 * console's workspace from a published blueprint version; only that pinned version is registered,
 * and publishing the console freezes it for operators. The kernel checks every entry again.
 */
export const ConsoleWidgetRegistry = ({ widgets, published, candidates, hostBoardCount = 0, disabled, onChange }: {
  widgets: ConsoleWidgetEntry[]
  /** The registry operators use now, or undefined if the console was never published. */
  published: ConsoleWidgetEntry[] | undefined
  /** Widget installs of the workspace that could be registered. */
  candidates: GadgetSummary[]
  /** Host boards the console holds, which count toward the same limit. */
  hostBoardCount?: number
  disabled: boolean
  onChange: (widgets: ConsoleWidgetEntry[]) => void
}) => {
  const [selected, setSelected] = useState('')
  const [label, setLabel] = useState('')
  const [resettable, setResettable] = useState(false)
  const offered = candidates.filter(candidate => !widgets.some(entry => entry.gadgetId === candidate.id))
  const choice = offered.find(candidate => String(candidate.id) === selected)
  const install = choice?.installedFrom
  const full = widgets.length + hostBoardCount >= MAX_CONSOLE_WIDGETS
  const add = () => {
    if (!choice || !install || !resettable || full) return
    onChange([...widgets, { gadgetId: choice.id, blueprintId: install.blueprintId, version: install.version,
      label: label.trim() || choice.title, state: 'resettable' }])
    setSelected(''); setLabel(''); setResettable(false)
  }
  // A draft entry names the registered (source) install, which the published registry records as
  // `frozen.sourceGadgetId`; a published entry, as the use role reads it, already names its frozen
  // install, so it matches only an entry of the current publication with that same frozen install.
  const isPublished = (entry: ConsoleWidgetEntry) => !!published?.some(item =>
    (entry.frozen ? item.gadgetId === entry.gadgetId : item.frozen?.sourceGadgetId === entry.gadgetId) &&
    item.blueprintId === entry.blueprintId && item.version === entry.version && item.label === entry.label)

  return <section aria-labelledby="console-widgets-heading" className="space-y-4">
    <div><h2 id="console-widgets-heading" className="text-sm font-medium text-kumo-default">Widgets</h2>
      <p className="mt-1 text-sm text-kumo-subtle">The widgets this console offers its operators. Each runs the version it was installed at; publishing the console freezes it, so later edits reach operators only when you publish again.</p></div>
    {widgets.length === 0 ? <p className="text-sm text-kumo-subtle">No widgets are registered.</p>
      : <ul aria-label="Registered widgets" className="divide-y divide-kumo-line rounded-xl border border-kumo-line">
        {widgets.map(entry => <li key={entry.gadgetId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-kumo-default">{entry.label}</p>
            <p className="text-xs text-kumo-subtle">Version {entry.version} · {isPublished(entry) ? 'Published' : 'Not yet published'}</p>
          </div>
          <Button size="sm" variant="ghost" disabled={disabled} aria-label={`Remove ${entry.label}`}
            onClick={() => onChange(widgets.filter(item => item.gadgetId !== entry.gadgetId))}>Remove</Button>
        </li>)}
      </ul>}
    {!disabled && <div className="space-y-3 rounded-xl border border-kumo-line p-4">
      <Select label="Widget install" value={choice ? selected : ''} disabled={offered.length === 0 || full}
        placeholder={offered.length === 0 ? 'No widget installs to register' : 'Choose a widget install'}
        renderValue={value => offered.find(candidate => String(candidate.id) === value)?.title ?? 'Choose a widget install'}
        onValueChange={value => setSelected(String(value ?? ''))}>
        {offered.map(candidate => <Select.Option key={candidate.id} value={String(candidate.id)}>
          {candidate.title} (version {candidate.installedFrom?.version})
        </Select.Option>)}
      </Select>
      <Input label="Name operators see" value={label} maxLength={120} placeholder={choice?.title}
        onChange={event => setLabel(event.target.value)} />
      <Checkbox label="This widget may start with empty state each time the console is published" checked={resettable}
        onCheckedChange={checked => setResettable(checked === true)} />
      <Button disabled={!choice || !resettable || full} onClick={add}>Register widget</Button>
      {full && <p className="text-sm text-kumo-subtle">A console offers at most {MAX_CONSOLE_WIDGETS} widgets{hostBoardCount > 0 ? ' and boards' : ''}.</p>}
    </div>}
  </section>
}
