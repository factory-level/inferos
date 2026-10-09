import { useRef, type ReactNode } from 'react'
import { Badge, Button, Loader } from '@cloudflare/kumo'
import type { HostBoardViewColumn as HostBoardColumn, HostBoardViewGroup as HostBoardGroup, HostBoardViewIssue as HostBoardIssue,
  HostBoardViewPriority as HostBoardPriority } from '@gadgets/workshop-shared/operate-console'
import type { HostBoardViewState } from './hostBoardState'

const GROUP_LABEL: Record<HostBoardGroup, string> = {
  backlog: 'Backlog',
  unstarted: 'Not started',
  started: 'In progress',
  completed: 'Done',
  cancelled: 'Cancelled',
}

const PRIORITY: Record<HostBoardPriority, { label: string; variant: 'error' | 'warning' | 'secondary' | 'outline' }> = {
  urgent: { label: 'Urgent', variant: 'error' },
  high: { label: 'High', variant: 'warning' },
  medium: { label: 'Medium', variant: 'secondary' },
  low: { label: 'Low', variant: 'secondary' },
  none: { label: 'No priority', variant: 'outline' },
}

/**
 * A host-rendered, read-only InferOps board on an Operate console. Trusted host code: it renders
 * the kernel's projected snapshot as text only (no markup from data, no links, no authored code)
 * and never logs or stores it. Freshness and authority are decided by the host-board state
 * machine; this component only draws the state it is given.
 */
export const HostBoardView = ({ label, view, picker, onRetry }: {
  /** The registry entry's label, the board's accessible name. */
  label: string
  view: HostBoardViewState
  /** The host's connection picker, shown while the operator has no connection for this board. */
  picker: ReactNode
  onRetry: () => void
}) => {
  const rootRef = useRef<HTMLElement>(null)
  const retry = () => {
    // The Retry button goes away once the read starts; keep focus inside the board.
    rootRef.current?.focus()
    onRetry()
  }

  return <section ref={rootRef} tabIndex={-1} aria-label={label} className="flex min-h-0 flex-col gap-3 text-sm outline-none">
    {view.status === 'loading' && <p role="status" className="flex items-center gap-2 text-kumo-subtle"><Loader size="sm" /> Reading the board…</p>}
    {view.status === 'not-connected' && <div className="space-y-2 text-kumo-subtle">
      <p role="status">Not connected for you. This board is read with your own InferOps access, so choose one of your connections to see it.</p>
      {picker}
    </div>}
    {view.status === 'unavailable' && <div className="space-y-2 text-kumo-subtle">
      <p role="status">This board is unavailable right now.</p>
      <Button size="sm" onClick={retry}>Retry</Button>
    </div>}
    {view.status === 'ok' && <>
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-medium text-kumo-default">{view.board.project.identifier} · {view.board.project.name}</h2>
        <p className="text-xs text-kumo-subtle">Read at <time dateTime={view.readAt}>{new Date(view.readAt).toLocaleTimeString()}</time></p>
      </header>
      {/* Focusable so the columns can be scrolled from the keyboard. */}
      <div tabIndex={0} role="group" aria-label={`${label} columns`} className="flex min-h-0 gap-3 overflow-x-auto pb-2">
        {view.board.columns.map((column, index) => <BoardColumn key={index} column={column} />)}
      </div>
    </>}
  </section>
}

const BoardColumn = ({ column }: { column: HostBoardColumn }) =>
  <section aria-label={column.label} className="flex w-64 shrink-0 flex-col gap-2 rounded-lg bg-kumo-recessed p-2">
    <h3 className="flex items-baseline justify-between gap-2 font-medium text-kumo-default">
      <span>{column.label}</span>
      <span className="text-xs font-normal text-kumo-subtle">{GROUP_LABEL[column.group]} · {column.issues.length}</span>
    </h3>
    {column.issues.length > 0 && <ol className="flex flex-col gap-2">
      {column.issues.map((issue, index) => <BoardCard key={index} issue={issue} />)}
    </ol>}
  </section>

const BoardCard = ({ issue }: { issue: HostBoardIssue }) =>
  <li className="space-y-1 rounded-md border border-kumo-line bg-kumo-base p-2">
    <p className="text-xs text-kumo-subtle">{issue.identifier}</p>
    <p className="text-kumo-default">{issue.title}</p>
    <div className="flex flex-wrap items-center gap-1">
      <Badge variant={PRIORITY[issue.priority].variant}>{PRIORITY[issue.priority].label}</Badge>
      {issue.blocked && <Badge variant="destructive">Blocked</Badge>}
      {issue.targetDate && <span className="text-xs text-kumo-subtle">Due <time dateTime={issue.targetDate}>{issue.targetDate}</time></span>}
    </div>
  </li>
