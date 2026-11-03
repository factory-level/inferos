import { useEffect, useState } from 'react'
import { Badge, Button, Dialog } from '@cloudflare/kumo'
import type { Issue, IssueActivityEntry, State } from '@inferos/gatekeeper-inferops/src/types'
import type { ActivityResult } from './boardData'
import { PRIORITY_LABELS, formatTargetDate, proposalErrorText } from './kanbanBoard'

const FIELD_LABELS: Record<string, string> = {
  stateId: 'State', title: 'Title', priority: 'Priority', description: 'Description',
  assigneeId: 'Assignee', targetDate: 'Target date', blockedReason: 'Blocked reason',
}

const ACTOR_LABELS = { person: 'A person', agent: 'An agent', system: 'InferOps' } as const

/** A long value is cut for the list; the issue itself holds the whole of it. */
const VALUE_MAX = 200

const valueText = (entry: IssueActivityEntry, states: readonly State[]): string => {
  if (entry.value === null) return 'nothing'
  if (entry.field === 'stateId') return states.find(state => state.id === entry.value)?.name ?? 'another state'
  if (entry.field === 'priority') return PRIORITY_LABELS[entry.value as Issue['priority']] ?? entry.value
  return entry.value.length > VALUE_MAX ? `${entry.value.slice(0, VALUE_MAX)}…` : entry.value
}

const whenText = (at: string): string => new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

type Loaded = { status: 'loading' } | ActivityResult

/**
 * One issue, read-only: its fields as the board shows them and what people and agents did on it,
 * read through the gatekeeper with the person's own access when the dialog opens. Nothing here
 * proposes a change. A refusal is shown in the gatekeeper's words, never as an empty history.
 */
export const KanbanIssueDetails = ({ issue, state, states, onActivity }: {
  issue: Issue
  state: State
  states: readonly State[]
  onActivity: () => Promise<ActivityResult>
}) => {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let current = true
    setLoaded({ status: 'loading' })
    void onActivity().then(result => { if (current) setLoaded(result) })
    return () => { current = false }
  // One read per opening and per Try again; the board re-rendering the card is not a new read.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt])

  return <div className="space-y-4">
    <Dialog.Title>{issue.identifier}: {issue.title}</Dialog.Title>
    <Dialog.Description className="text-sm text-kumo-subtle">Read-only. Changes go through Edit and Move, and wait for approval.</Dialog.Description>
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      <dt className="text-kumo-subtle">State</dt><dd>{state.name}</dd>
      <dt className="text-kumo-subtle">Priority</dt><dd>{PRIORITY_LABELS[issue.priority]}</dd>
      {issue.targetDate && <><dt className="text-kumo-subtle">Target date</dt><dd>{formatTargetDate(issue.targetDate)}</dd></>}
      {issue.assigneeId && <><dt className="text-kumo-subtle">Assignee</dt><dd title={issue.assigneeId}>{issue.assigneeId.slice(0, 8)}</dd></>}
      {issue.blockedReason && <><dt className="text-kumo-subtle">Blocked</dt><dd className="text-kumo-danger">{issue.blockedReason}</dd></>}
    </dl>
    <section aria-labelledby={`activity-${issue.id}`} className="space-y-2">
      <h3 id={`activity-${issue.id}`} className="text-sm font-semibold text-kumo-default">Activity</h3>
      {'status' in loaded && <p role="status" className="text-sm text-kumo-subtle">Loading activity…</p>}
      {'ok' in loaded && !loaded.ok && <div role="alert" className="space-y-2">
        <p className="text-sm text-kumo-danger">Could not read this issue's activity: {proposalErrorText(loaded)}</p>
        <Button size="sm" variant="secondary" onClick={() => setAttempt(n => n + 1)}>Try again</Button>
      </div>}
      {'ok' in loaded && loaded.ok && (loaded.activity.entries.length === 0
        ? <p className="text-sm text-kumo-subtle">Nothing recorded on this issue yet.</p>
        : <ol className="max-h-80 space-y-2 overflow-y-auto">
          {loaded.activity.entries.map((entry, index) => <li key={`${entry.at}-${index}`} className="rounded-md border border-kumo-line p-2 text-sm">
            <div className="flex flex-wrap items-center gap-2 text-xs text-kumo-subtle">
              {entry.actor === 'agent' ? <Badge variant="info">Agent</Badge> : <span>{entry.actor ? ACTOR_LABELS[entry.actor] : 'Someone'}</span>}
              <time dateTime={entry.at}>{whenText(entry.at)}</time>
            </div>
            {entry.kind === 'comment'
              ? <p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{entry.body}</p>
              : <p className="mt-1 [overflow-wrap:anywhere]">Set {FIELD_LABELS[entry.field ?? ''] ?? entry.field ?? 'a field'} to {valueText(entry, states)}</p>}
          </li>)}
          {loaded.activity.omitted > 0 && <li className="text-xs text-kumo-subtle">{loaded.activity.omitted} earlier {loaded.activity.omitted === 1 ? 'entry' : 'entries'} not shown.</li>}
        </ol>)}
    </section>
    <div className="flex justify-end">
      <Dialog.Close render={<Button type="button" variant="secondary">Close</Button>} />
    </div>
  </div>
}
