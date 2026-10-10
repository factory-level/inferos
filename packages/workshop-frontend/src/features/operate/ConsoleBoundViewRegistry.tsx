import { useState } from 'react'
import { Button, Checkbox, Input, Select } from '@cloudflare/kumo'
import type { GadgetSummary } from '@gadgets/workshop-shared/api'
import { MAX_CONSOLE_WIDGETS, type BoundViewEntry, type HostBoardEntry } from '@gadgets/workshop-shared/operate-console'

/**
 * The bound views a console offers, edited in its draft. A bound view is a view-only widget
 * install (its `view.json`, with no code) that trusted host code renders over each operator's own
 * reads of the console's host boards, so it names which of those boards it reads; they must be
 * exactly the requirements its `view.json` lists. Publishing freezes the spec at its current
 * commit, so later edits reach operators only when the console is published again. The kernel
 * checks every entry again. Views open from the console's side assistant, so a console that shows
 * only Assistant offers none.
 */
export const ConsoleBoundViewRegistry = ({ boundViews, published, candidates, hostBoards, otherCount, assistantOnly, disabled, onChange }: {
  boundViews: BoundViewEntry[]
  /** The bound views operators use now, or undefined if the console was never published. */
  published: BoundViewEntry[] | undefined
  /** Widget installs of the workspace that could be registered. */
  candidates: GadgetSummary[]
  /** The host boards the console will hold: a view reads some of them. */
  hostBoards: readonly HostBoardEntry[]
  /** Widgets and host boards, which count toward the same limit. */
  otherCount: number
  /** The console shows only Assistant, where operators have no way to open a view. */
  assistantOnly: boolean
  disabled: boolean
  onChange: (boundViews: BoundViewEntry[]) => void
}) => {
  const [selected, setSelected] = useState('')
  const [label, setLabel] = useState('')
  const [requirements, setRequirements] = useState<string[]>([])
  const offered = candidates.filter(candidate => !boundViews.some(entry => entry.gadgetId === candidate.id))
  const choice = offered.find(candidate => String(candidate.id) === selected)
  const install = choice?.installedFrom
  const names = hostBoards.map(board => board.requirement.name)
  const chosen = requirements.filter(name => names.includes(name))
  const full = boundViews.length + otherCount >= MAX_CONSOLE_WIDGETS
  const add = () => {
    if (!choice || !install || chosen.length === 0 || full || assistantOnly) return
    onChange([...boundViews, { kind: 'bound-view', gadgetId: choice.id, blueprintId: install.blueprintId, version: install.version,
      label: label.trim() || choice.title, requirements: chosen }])
    setSelected(''); setLabel(''); setRequirements([])
  }
  const boardLabel = (name: string) => hostBoards.find(board => board.requirement.name === name)?.label ?? name
  const isPublished = (entry: BoundViewEntry) => entry.id !== undefined && !!published?.some(item => item.id === entry.id && item.label === entry.label)

  return <section aria-labelledby="console-bound-views-heading" className="space-y-4">
    <div><h2 id="console-bound-views-heading" className="text-sm font-medium text-kumo-default">Views</h2>
      <p className="mt-1 text-sm text-kumo-subtle">Read-only views of this console&apos;s boards, laid out by a view-only widget&apos;s view.json. Each operator sees them over their own boards; the view runs no code.</p></div>
    {assistantOnly && <p role="status" className="text-sm text-kumo-subtle">This console shows only Assistant, so operators can&apos;t open views on it.</p>}
    {boundViews.length === 0 ? <p className="text-sm text-kumo-subtle">No views are registered.</p>
      : <ul aria-label="Registered views" className="divide-y divide-kumo-line rounded-xl border border-kumo-line">
        {boundViews.map((entry, index) => <li key={entry.id ?? `new-${index}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-kumo-default">{entry.label}</p>
            <p className="truncate text-xs text-kumo-subtle">Reads {entry.requirements.map(boardLabel).join(', ')} · {assistantOnly ? 'Unavailable on an Assistant-only console' : isPublished(entry) ? 'Published' : 'Not yet published'}</p>
          </div>
          <Button size="sm" variant="ghost" disabled={disabled} aria-label={`Remove ${entry.label}`}
            onClick={() => onChange(boundViews.filter(item => item !== entry))}>Remove</Button>
        </li>)}
      </ul>}
    {!disabled && !assistantOnly && <div className="space-y-3 rounded-xl border border-kumo-line p-4">
      {hostBoards.length === 0 ? <p className="text-sm text-kumo-subtle">Register a board first: a view reads the console&apos;s boards.</p> : <>
        <Select label="View-only widget install" value={choice ? selected : ''} disabled={offered.length === 0 || full}
          placeholder={offered.length === 0 ? 'No widget installs to register' : 'Choose a widget install'}
          renderValue={value => offered.find(candidate => String(candidate.id) === value)?.title ?? 'Choose a widget install'}
          onValueChange={value => setSelected(String(value ?? ''))}>
          {offered.map(candidate => <Select.Option key={candidate.id} value={String(candidate.id)}>
            {candidate.title} (version {candidate.installedFrom?.version})
          </Select.Option>)}
        </Select>
        <Input label="Name operators see" value={label} maxLength={120} placeholder={choice?.title} disabled={full}
          onChange={event => setLabel(event.target.value)} />
        <fieldset className="space-y-2">
          <legend className="text-sm text-kumo-default">Boards it reads (the requirements its view.json lists)</legend>
          {hostBoards.map(board => <Checkbox key={board.requirement.name} label={`${board.label} (${board.requirement.name})`}
            checked={chosen.includes(board.requirement.name)} disabled={full}
            onCheckedChange={checked => setRequirements(checked === true ? [...chosen, board.requirement.name] : chosen.filter(name => name !== board.requirement.name))} />)}
        </fieldset>
        <Button disabled={!choice || chosen.length === 0 || full} onClick={add}>Register view</Button>
      </>}
      {full && <p className="text-sm text-kumo-subtle">A console offers at most {MAX_CONSOLE_WIDGETS} widgets, boards and views.</p>}
    </div>}
  </section>
}
