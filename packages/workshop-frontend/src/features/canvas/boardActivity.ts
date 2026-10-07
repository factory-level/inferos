// Activity on one board, derived from the workspace action log: what the agent, a person, a
// gadget or a hook read or asked to change through the board's connection. Pure rules only; the
// log itself is the authority, and nothing here keeps a copy of InferOps data. An entry shows only
// the title the gatekeeper rendered for humans, never its description, fields or payload.
import { actionChangeTime, type ActionLogEntry, type ActionRequester } from '@gadgets/workshop-shared/api'
import { canonicalBoardRef } from './boardData'

/** How long a read or a decided action stays on the board after it happened. */
export const RECENT_ACTIVITY_MS = 2 * 60_000

/** The most recent (non-pending) items a board keeps. Pending ones are bounded by the approval queue. */
export const RECENT_ACTIVITY_LIMIT = 5

/** `awaiting` is active until decided; the others are recent and fade after `RECENT_ACTIVITY_MS`. */
export type BoardActivityKind = 'read' | 'awaiting' | 'applied' | 'rejected' | 'failed'

export type BoardActivityItem = {
  /** The action log entry's id. */
  id: number
  kind: BoardActivityKind
  /** Who asked, as a display label; null for entries written before callers were tracked. */
  actor: string | null
  /** The one-line title the gatekeeper rendered for humans, e.g. "Move ENG-12 to Done". */
  title: string
  /** When it was asked (`awaiting`) or last changed (read, applied, rejected). */
  at: Date
  /** The identifier of the issue an action moves or edits, when the gatekeeper named it. */
  issue?: string
  /** The title of the issue an action creates, when the gatekeeper named it (and it names no existing issue). */
  creates?: string
  /** The action's kind tag (`ActionKind.tag`), when the gatekeeper gave one, e.g. "inferops.code-dispatch". */
  tag?: string
}

export type BoardActivity = {
  /** Actions awaiting approval, newest first. Empty while the board's connection is not usable. */
  active: readonly BoardActivityItem[]
  /** Reads and decided actions within the window, newest first, at most `RECENT_ACTIVITY_LIMIT`. */
  recent: readonly BoardActivityItem[]
  /**
   * Every decided (applied or rejected) action the log holds for the board, however old, oldest
   * first: what a board reads its proposals' outcomes from (see `advanceDecisions`).
   */
  decided: readonly BoardActivityItem[]
}

export const NO_ACTIVITY: BoardActivity = { active: [], recent: [], decided: [] }

/**
 * Display labels for `ActionLogEntry.requestedBy`. A person is not necessarily the viewer: the
 * log says a person asked through the Workshop, not which one.
 */
export const ACTOR_LABELS: Record<ActionRequester, string> = {
  agent: 'Agent', person: 'Person', gadget: 'Gadget', hook: 'Automation',
}

// The gatekeeper names the moved or edited issue in an inline "Issue" field of the description it
// renders for the approver, and an issue it creates by an inline "Title" with no "Issue". Only a
// whole value is trusted; a truncated one is not an identifier.
const inlineField = (record: ActionLogEntry, label: string): string | undefined => {
  if (record.type !== 'action') return undefined
  const field = record.description.fields?.find(f => f.label === label)
  return field?.kind === 'inline' && !field.truncated ? field.value : undefined
}
const issueOf = (record: ActionLogEntry): string | undefined => inlineField(record, 'Issue')
const createsOf = (record: ActionLogEntry): string | undefined =>
  issueOf(record) === undefined ? inlineField(record, 'Title') : undefined

const kindOf = (record: ActionLogEntry): BoardActivityKind | null => {
  if (record.type === 'observation') return 'read'
  if (record.type !== 'action') return null
  return record.state === 'pending' ? 'awaiting' : record.state === 'approved' ? 'applied'
    : record.state === 'failed' ? 'failed' : 'rejected'
}

const newestFirst = (a: BoardActivityItem, b: BoardActivityItem) => b.at.getTime() - a.at.getTime() || b.id - a.id

/**
 * The activity of the board at `targetRef`. Only entries whose `resourceUrl` is that board (after
 * the adapter's canonicalization) count; entries for other resources or with none are ignored.
 * A later record with the same id replaces an earlier one, so a decision supersedes its pending
 * copy. When `connected` is false (the connection was revoked, or the board cannot be read) no
 * action is shown as awaiting: the board can no longer show what became of it.
 */
export const foldBoardActivity = (
  records: Iterable<ActionLogEntry>, targetRef: string, now: number, connected: boolean,
): BoardActivity => {
  const target = canonicalBoardRef(targetRef)
  const latest = new Map<number, ActionLogEntry>()
  for (const record of records) {
    if (record.resourceUrl && canonicalBoardRef(record.resourceUrl) === target) latest.set(record.id, record)
  }
  const active: BoardActivityItem[] = []
  const recent: BoardActivityItem[] = []
  const decided: BoardActivityItem[] = []
  for (const record of latest.values()) {
    const kind = kindOf(record)
    if (!kind) continue
    const item: BoardActivityItem = {
      id: record.id,
      kind,
      actor: record.requestedBy ? ACTOR_LABELS[record.requestedBy] : null,
      title: record.description.title,
      at: kind === 'awaiting' ? record.createdAt : actionChangeTime(record),
      issue: issueOf(record),
      ...createsOf(record) !== undefined ? { creates: createsOf(record) } : {},
      ...record.type === 'action' && record.description.actionKind ? { tag: record.description.actionKind.tag } : {},
    }
    if (kind === 'applied' || kind === 'rejected' || kind === 'failed') decided.push(item)
    if (kind === 'awaiting') {
      if (connected) active.push(item)
    } else if (now - item.at.getTime() < RECENT_ACTIVITY_MS) {
      recent.push(item)
    }
  }
  return {
    active: active.toSorted(newestFirst),
    recent: recent.toSorted(newestFirst).slice(0, RECENT_ACTIVITY_LIMIT),
    decided: decided.toSorted((a, b) => a.id - b.id),
  }
}

/**
 * When the display of `activity` next changes on its own, as an absolute time: a recent item
 * crossing a whole minute of age, or fading out. Null when nothing will change without new entries.
 */
export const nextActivityChange = (activity: BoardActivity, now: number): number | null => {
  let next: number | null = null
  for (const { at } of activity.recent) {
    const age = Math.max(0, now - at.getTime())
    const change = at.getTime() + Math.min((Math.floor(age / 60_000) + 1) * 60_000, RECENT_ACTIVITY_MS)
    if (next === null || change < next) next = change
  }
  return next
}

/** "just now" or "3m ago". */
export const formatActivityAge = (at: Date, now: number): string => {
  const minutes = Math.floor((now - at.getTime()) / 60_000)
  return minutes < 1 ? 'just now' : `${minutes}m ago`
}

/** One item as a sentence, for the activity line's accessible text and announcements. */
export const describeActivity = (item: BoardActivityItem, now: number): string => {
  const actor = item.actor ?? 'Someone'
  switch (item.kind) {
    case 'awaiting': return `${actor} is waiting for approval: ${item.title}`
    case 'read': return `${actor}: ${item.title}, ${formatActivityAge(item.at, now)}`
    case 'applied': return `${actor}: ${item.title}, applied ${formatActivityAge(item.at, now)}`
    case 'rejected': return `${actor}: ${item.title}, rejected ${formatActivityAge(item.at, now)}`
    case 'failed': return `${actor}: ${item.title}, approved but not applied ${formatActivityAge(item.at, now)}`
  }
}

/**
 * Two resources' activity shown as one, such as a board's and its project's coding dispatch.
 * Action log ids are unique within the workspace, so the items never collide.
 */
export const combineActivity = (a: BoardActivity, b: BoardActivity): BoardActivity => ({
  active: [...a.active, ...b.active].toSorted(newestFirst),
  recent: [...a.recent, ...b.recent].toSorted(newestFirst).slice(0, RECENT_ACTIVITY_LIMIT),
  decided: [...a.decided, ...b.decided].toSorted((x, y) => x.id - y.id),
})

/** Only the actions: reads left out, for a resource that is re-read automatically and would fill the line with them. */
export const actionsOnly = (activity: BoardActivity): BoardActivity => activity.recent.some(item => item.kind === 'read')
  ? { ...activity, recent: activity.recent.filter(item => item.kind !== 'read') }
  : activity

/** Awaiting actions by the identifier of the issue they move, for the issue's card. */
export const awaitingByIssue = (activity: BoardActivity): ReadonlyMap<string, BoardActivityItem> =>
  new Map(activity.active.flatMap(item => item.issue ? [[item.issue, item] as const] : []))
