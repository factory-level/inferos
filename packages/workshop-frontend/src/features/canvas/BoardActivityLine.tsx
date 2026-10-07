import { Badge } from '@cloudflare/kumo'
import { describeActivity, formatActivityAge, type BoardActivity, type BoardActivityItem, type BoardActivityKind } from './boardActivity'

const KIND: Record<BoardActivityKind, { label: string; variant: 'warning' | 'neutral' | 'success' | 'error' }> = {
  awaiting: { label: 'Awaiting approval', variant: 'warning' },
  read: { label: 'Read', variant: 'neutral' },
  applied: { label: 'Applied', variant: 'success' },
  rejected: { label: 'Rejected', variant: 'error' },
  failed: { label: 'Not applied', variant: 'error' },
}

const ActivityRow = ({ item, now }: { item: BoardActivityItem; now: number }) =>
  <li className="flex min-w-0 items-center gap-2" data-activity-kind={item.kind}>
    <span className="sr-only">{describeActivity(item, now)}</span>
    <span aria-hidden="true" className="flex min-w-0 items-center gap-2">
      <Badge variant={KIND[item.kind].variant}>{KIND[item.kind].label}</Badge>
      {item.actor && <span className="shrink-0 font-medium text-kumo-default">{item.actor}</span>}
      <span className="truncate" title={item.title}>{item.title}</span>
      {item.kind !== 'awaiting' && <span className="shrink-0">{formatActivityAge(item.at, now)}</span>}
    </span>
  </li>

/**
 * What was recently done on a board through its connection, and what is waiting for approval.
 * A card shows one line (the newest awaiting action, else the newest recent item) and counts the
 * rest; the full view lists them all. Only a new awaiting action is announced, politely: reads
 * and decisions are not, so an agent reading in a loop does not talk over the user.
 */
export const BoardActivityLine = ({ activity, now, compact }: { activity: BoardActivity; now: number; compact: boolean }) => {
  const { active, recent } = activity
  const shown = compact ? [...active, ...recent].slice(0, 1) : [...active, ...recent]
  const more = active.length + recent.length - shown.length
  return <>
    {/* Always mounted, so a screen reader is already watching it when the first action arrives. */}
    <p role="status" aria-live="polite" className="sr-only">{active[0] ? describeActivity(active[0], now) : ''}</p>
    {shown.length > 0 && <section aria-label="Board activity"
      className="flex min-w-0 items-center gap-2 border-b border-kumo-line px-3 py-1.5 text-xs text-kumo-subtle">
      <ul className={`flex min-w-0 flex-1 ${compact ? '' : 'flex-col gap-1'}`}>
        {shown.map(item => <ActivityRow key={item.id} item={item} now={now} />)}
      </ul>
      {more > 0 && <span className="shrink-0">+{more} more</span>}
    </section>}
  </>
}
