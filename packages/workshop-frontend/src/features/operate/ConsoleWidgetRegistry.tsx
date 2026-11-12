import { useState } from 'react'
import { Button, Checkbox, Input, Select } from '@cloudflare/kumo'
import { MAX_CONSOLE_WIDGETS, type ConsoleWidgetCandidate, type ConsoleWidgetEntry } from '@gadgets/workshop-shared/operate-console'
import type { WidgetCommandDeclaration } from '@gadgets/workshop-shared/widget-tools'
import { ConsoleCommandBindings, type BoardConnection } from './ConsoleCommandBindings'

/** A widget install as the registry editor offers it: the kernel's description, with its title. */
export type TitledWidgetCandidate = ConsoleWidgetCandidate & { title: string }

/** The kernel's answer about which installs a console could register (`listConsoleWidgetCandidates`). */
export type WidgetCandidates =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'ready'; list: TitledWidgetCandidate[] }

const shortCommit = (commitId: string) => commitId.slice(0, 7)

/** What a candidate's commit offers, in words. */
const surfacesText = (surfaces: ConsoleWidgetCandidate['surfaces']) => !surfaces ? null
  : [surfaces.ui ? 'UI' : 'No UI', surfaces.tools.length > 0 ? `Tools: ${surfaces.tools.join(', ')}` : null]
    .filter(Boolean).join(' · ')

/**
 * The widgets a console offers, edited in its draft. Only installs the kernel says a console can
 * offer now are offered to register; the others are listed with the reason a save would refuse
 * them, so a widget that can't run is never offered as usable. Each registered widget shows its
 * stable version, the commit its install is at and what it offers, and, once published, the commit
 * operators run. Publishing the console freezes it for operators; the kernel checks every entry again.
 */
export const ConsoleWidgetRegistry = ({ widgets, published, candidates, hostBoardCount = 0, disabled, commands, onChange }: {
  widgets: ConsoleWidgetEntry[]
  /** The registry operators use now, or undefined if the console was never published. */
  published: ConsoleWidgetEntry[] | undefined
  /** The workspace's widget installs as the kernel describes them. */
  candidates: WidgetCandidates
  /** Host boards the console holds, which count toward the same limit. */
  hostBoardCount?: number
  disabled: boolean
  /**
   * What the builder needs to bind a widget's declared commands (FAC-14): the console's board
   * references, whether this person may edit, and the two reads. Absent, commands aren't shown.
   */
  commands?: {
    boardTargets: string[]
    editable: boolean
    loadCommands: (commitId: string) => Promise<WidgetCommandDeclaration[]>
    resolveBoard: (target: string) => Promise<BoardConnection | null>
  }
  onChange: (widgets: ConsoleWidgetEntry[]) => void
}) => {
  const [selected, setSelected] = useState('')
  const [label, setLabel] = useState('')
  const [resettable, setResettable] = useState(false)
  const described = candidates.state === 'ready' ? candidates.list : []
  const unregistered = described.filter(candidate => !widgets.some(entry => entry.gadgetId === candidate.gadgetId))
  const offered = unregistered.filter(candidate => candidate.refusal === null)
  const refused = unregistered.filter(candidate => candidate.refusal !== null)
  const choice = offered.find(candidate => String(candidate.gadgetId) === selected)
  const full = widgets.length + hostBoardCount >= MAX_CONSOLE_WIDGETS
  const add = () => {
    if (!choice || !resettable || full) return
    onChange([...widgets, { gadgetId: choice.gadgetId, blueprintId: choice.blueprintId, version: choice.version,
      label: label.trim() || choice.title, state: 'resettable' }])
    setSelected(''); setLabel(''); setResettable(false)
  }
  // A draft entry names the registered (source) install, which the published registry records as
  // `frozen.sourceGadgetId`; a published entry, as the use role reads it, already names its frozen
  // install, so it matches only an entry of the current publication with that same frozen install.
  const publishedAs = (entry: ConsoleWidgetEntry) => published?.find(item =>
    (entry.frozen ? item.gadgetId === entry.gadgetId : item.frozen?.sourceGadgetId === entry.gadgetId) &&
    item.blueprintId === entry.blueprintId && item.version === entry.version && item.label === entry.label)
  const placeholder = candidates.state === 'loading' ? 'Checking widget installs…'
    : offered.length === 0 ? 'No widget installs to register' : 'Choose a widget install'

  return <section aria-labelledby="console-widgets-heading" className="space-y-4">
    <div><h2 id="console-widgets-heading" className="text-sm font-medium text-kumo-default">Widgets</h2>
      <p className="mt-1 text-sm text-kumo-subtle">The widgets this console offers its operators. Each runs the version it was installed at; publishing the console freezes it, so later edits reach operators only when you publish again.</p></div>
    {widgets.length === 0 ? <p className="text-sm text-kumo-subtle">No widgets are registered.</p>
      : <ul aria-label="Registered widgets" className="divide-y divide-kumo-line rounded-xl border border-kumo-line">
        {widgets.map(entry => {
          const live = publishedAs(entry)
          const candidate = entry.frozen ? undefined : described.find(item => item.gadgetId === entry.gadgetId)
          const offers = surfacesText(candidate?.surfaces ?? null)
          // The kernel lists current widget installs only, each at the version it runs now, so a
          // registered install it leaves out, or lists at another blueprint or version, is one a
          // save would refuse too. Nothing is claimed until its answer has arrived.
          const refusal = entry.frozen || candidates.state !== 'ready' ? null
            : !candidate ? 'it is no longer installed in this workspace, or no longer a widget install.'
            : candidate.blueprintId !== entry.blueprintId || candidate.version !== entry.version
              ? `the install now runs ${candidate.blueprintId}@${candidate.version}, not ${entry.blueprintId}@${entry.version}.`
            : candidate.refusal
          return <li key={entry.gadgetId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0 space-y-0.5">
              <p className="truncate text-sm font-medium text-kumo-default">{entry.label}</p>
              <p className="text-xs text-kumo-subtle">Version {entry.version} · {live ? 'Published' : 'Not yet published'}</p>
              <p className="truncate text-xs text-kumo-subtle">
                {`${entry.blueprintId}@${entry.version}`}
                {candidate?.commitId ? ` · at ${shortCommit(candidate.commitId)}` : ''}
                {offers ? ` · ${offers}` : ''}
                {live?.frozen ? ` · Operators run ${shortCommit(live.frozen.commitId)}` : ''}
              </p>
              {refusal && <p className="text-xs text-kumo-danger">Can't be offered: {refusal}</p>}
              {commands && !entry.frozen && candidate && <ConsoleCommandBindings commitId={candidate.commitId ?? null}
                bindings={entry.commands ?? []} boardTargets={commands.boardTargets} editable={commands.editable}
                disabled={disabled} loadCommands={commands.loadCommands} resolveBoard={commands.resolveBoard}
                onChange={bound => onChange(widgets.map(item => item.gadgetId !== entry.gadgetId ? item
                  : bound.length > 0 ? { ...item, commands: bound } : (({ commands: _, ...rest }) => rest)(item)))} />}
            </div>
            <Button size="sm" variant="ghost" disabled={disabled} aria-label={`Remove ${entry.label}`}
              onClick={() => onChange(widgets.filter(item => item.gadgetId !== entry.gadgetId))}>Remove</Button>
          </li>
        })}
      </ul>}
    {!disabled && <div className="space-y-3 rounded-xl border border-kumo-line p-4">
      <Select label="Widget install" value={choice ? selected : ''} disabled={offered.length === 0 || full}
        placeholder={placeholder}
        renderValue={value => offered.find(candidate => String(candidate.gadgetId) === value)?.title ?? 'Choose a widget install'}
        onValueChange={value => setSelected(String(value ?? ''))}>
        {offered.map(candidate => <Select.Option key={candidate.gadgetId} value={String(candidate.gadgetId)}>
          {candidate.title} (version {candidate.version})
        </Select.Option>)}
      </Select>
      {candidates.state === 'error' && <p role="alert" className="text-sm text-kumo-danger">Could not check which widget installs a console can offer. Reopen settings to try again.</p>}
      <Input label="Name operators see" value={label} maxLength={120} placeholder={choice?.title}
        onChange={event => setLabel(event.target.value)} />
      <Checkbox label="This widget may start with empty state each time the console is published" checked={resettable}
        onCheckedChange={checked => setResettable(checked === true)} />
      <Button disabled={!choice || !resettable || full} onClick={add}>Register widget</Button>
      {full && <p className="text-sm text-kumo-subtle">A console offers at most {MAX_CONSOLE_WIDGETS} widgets{hostBoardCount > 0 ? ' and boards' : ''}.</p>}
      {refused.length > 0 && <div className="space-y-1">
        <p className="text-sm text-kumo-subtle">Not offered:</p>
        <ul aria-label="Widget installs a console cannot offer" className="space-y-1">
          {refused.map(candidate => <li key={candidate.gadgetId} className="text-xs text-kumo-subtle">
            <span className="font-medium text-kumo-default">{candidate.title}</span> (version {candidate.version}): {candidate.refusal}
          </li>)}
        </ul>
      </div>}
    </div>}
  </section>
}
