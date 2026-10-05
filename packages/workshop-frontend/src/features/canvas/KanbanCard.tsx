import { useState, type KeyboardEvent } from 'react'
import { Badge, Button, DropdownMenu } from '@cloudflare/kumo'
import { ArrowRight, Code, DotsThree, PencilSimple } from '@phosphor-icons/react'
import type { Issue, IssueChanges, Run, State } from '@inferos/gatekeeper-inferops/src/types'
import type { BoardActivityItem } from './boardActivity'
import type { PendingChange, PendingMove, ProposalResult } from './boardData'
import { CodingRunBadge } from './CodingRunStatus'
import type { CodingControl } from './KanbanCodingForm'
import { KanbanIssueDialog, type IssueDialogControl } from './KanbanIssueDialog'
import { PRIORITY_LABELS, formatTargetDate, isOverdue, type ChangeDecision } from './kanbanBoard'

const PRIORITY_VARIANT = { urgent: 'error', high: 'warning', medium: 'info', low: 'neutral', none: 'neutral' } as const

export type KanbanCardProps = {
  issue: Issue
  position: { index: number; count: number }
  onDialogOpenChange: (open: boolean) => void
  /** The column the board shows the issue in. */
  state: State
  /** Where the issue may move, in board order. Empty when it is pending or has nowhere to go. */
  targets: readonly State[]
  /** The issue's undecided move, resolved to its target state. */
  pending?: { move: PendingMove; toState: State | undefined }
  /** A move of the issue awaiting approval that this board did not propose, from the action log. */
  proposed?: BoardActivityItem
  /** How the issue's last move was decided, until it moves again or changes. */
  decision?: { outcome: ChangeDecision['outcome']; toState: State | undefined }
  /** An edit of the issue this board proposed that the board does not show as pending yet. */
  edit?: Extract<PendingChange, { kind: 'update' }>
  /** How the issue's last edit was decided, until it changes again. */
  editDecision?: ChangeDecision['outcome']
  /** Proposes an edit at the issue's revision; absent while the issue cannot be edited (anything pending). */
  onUpdate?: (changes: IssueChanges) => Promise<ProposalResult>
  /** Holds the edit dialog's open state outside the card (see `IssueDialogControl`). */
  editControl?: IssueDialogControl
  /**
   * Coding dispatch for the issue's project, with the issue's latest run. Absent when the board's
   * workspace holds no coding-dispatch connection for the project, or the surface offers none.
   */
  coding?: { control: CodingControl; run: Run | undefined }
  /** `YYYY-MM-DD`, for the overdue mark. */
  today: string
  /** The element id of the board's keyboard instructions. */
  instructionsId: string
  onMove: (toState: State) => void
  onDragStart: () => void
  onDragEnd: () => void
}

// The one badge that says what is waiting on the issue, most specific first: this board's own move
// or edit, then a request from the action log (which names who asked), then the gatekeeper's own
// pending marker, which also covers changes requested elsewhere that the log does not tie to it.
const pendingBadge = ({ issue, pending, edit, proposed }: Pick<KanbanCardProps, 'issue' | 'pending' | 'edit' | 'proposed'>): string | null => {
  if (pending) return `${pending.move.phase === 'proposing' ? 'Proposing move to' : 'Awaiting approval:'} ${pending.toState?.name ?? 'another state'}`
  if (edit?.phase === 'proposing') return 'Proposing edit…'
  if (issue.pending === 'create') return 'New issue, waiting for approval'
  if (proposed) return `Awaiting approval${proposed.actor ? ` (${proposed.actor})` : ''}: ${proposed.title}`
  if (edit || issue.pending === 'update') return 'Edit waiting for approval'
  if (issue.pending === 'transition') return 'Move waiting for approval'
  return null
}

/**
 * One issue on the board. It is a focusable card: the arrow keys pick a target column and Enter
 * proposes the move, the "Move to" menu offers the same targets, and it can be dragged to a
 * column; its Edit button opens the edit form. Anything pending on the issue (a move, an edit, or
 * its own creation) withholds every control, since the gatekeeper allows one pending change.
 * With coding dispatch offered, it shows the issue's latest coding run, and a software issue's
 * Coding button opens its coding task, which a pending move or edit does not withhold.
 */
export const KanbanCard = ({ issue, position, onDialogOpenChange, state, targets, pending, proposed, decision, edit, editDecision, coding, today, instructionsId, onMove, onUpdate, editControl, onDragStart, onDragEnd }: KanbanCardProps) => {
  const [choice, setChoice] = useState<State | null>(null)
  const movable = targets.length > 0 && !pending
  const chosen = choice && targets.find(target => target.id === choice.id) ? choice : null

  const onKeyDown = (event: KeyboardEvent<HTMLLIElement>) => {
    // Keys inside the card's own controls (the menu) are theirs.
    if (event.target !== event.currentTarget || !movable) return
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      const step = event.key === 'ArrowRight' ? 1 : -1
      // With nothing chosen, right starts at the first target and left at the last.
      const index = chosen ? targets.findIndex(target => target.id === chosen.id) : step > 0 ? -1 : targets.length
      setChoice(targets[(index + step + targets.length) % targets.length] ?? null)
      event.preventDefault()
    } else if (event.key === 'Enter' && chosen) {
      setChoice(null)
      onMove(chosen)
      event.preventDefault()
    } else if (event.key === 'Escape' && chosen) {
      setChoice(null)
      event.preventDefault()
    }
  }

  const overdue = isOverdue(issue, state, today)
  const waiting = pendingBadge({ issue, pending, edit, proposed })
  const codable = coding !== undefined && issue.workflow === 'software' && issue.pending !== 'create'
  return <li aria-posinset={position.index + 1} aria-setsize={position.count} data-issue-id={issue.id} data-pending={issue.pending} tabIndex={0} draggable={movable}
    aria-label={`${issue.identifier}: ${issue.title}${issue.pending === 'create' ? ' (not created yet)' : ''}`}
    aria-describedby={instructionsId} aria-busy={pending?.move.phase === 'proposing' || edit?.phase === 'proposing' || undefined}
    onKeyDown={onKeyDown} onBlur={() => setChoice(null)}
    // A drag can still start from inside a card that is not draggable (selected text, say).
    onDragStart={event => {
      if (!movable) { event.preventDefault(); return }
      event.dataTransfer.setData('text/plain', issue.id); event.dataTransfer.effectAllowed = 'move'; onDragStart()
    }}
    onDragEnd={onDragEnd}
    className={`mb-2 shrink-0 space-y-1.5 rounded-md border border-kumo-line bg-kumo-base p-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring ${movable ? 'cursor-grab' : ''} ${waiting ? 'opacity-80' : ''} ${issue.pending === 'create' ? 'border-dashed' : ''}`}>
    <div className="flex items-center gap-2">
      <span className="font-mono text-xs text-kumo-subtle">{issue.identifier}</span>
      {issue.priority !== 'none' && <Badge variant={PRIORITY_VARIANT[issue.priority]}>{PRIORITY_LABELS[issue.priority]}</Badge>}
      {codable && <KanbanIssueDialog onOpenChange={onDialogOpenChange} kind="code" issue={issue} run={coding.run} coding={coding.control}
        trigger={<Button size="xs" shape="square" variant="ghost" className="ml-auto" aria-label={`Coding task for ${issue.identifier}`} icon={Code} />} />}
      {onUpdate && <KanbanIssueDialog onOpenChange={open => {
        // Controlled edits are retained by the board's openIssue value, including remote closes.
        if (!editControl || !open) onDialogOpenChange(open)
      }} kind="edit" issue={issue} onUpdate={onUpdate} control={editControl}
        trigger={<Button size="xs" shape="square" variant="ghost" className={codable ? '' : 'ml-auto'} aria-label={`Edit ${issue.identifier}`} icon={PencilSimple} />} />}
      {movable && <DropdownMenu>
        <DropdownMenu.Trigger render={<Button size="xs" shape="square" variant="ghost" className={onUpdate || codable ? '' : 'ml-auto'} aria-label={`Move ${issue.identifier} to…`} icon={DotsThree} />} />
        <DropdownMenu.Content align="end">
          {targets.map(target => <DropdownMenu.Item key={target.id} onClick={() => onMove(target)}>Move to {target.name}</DropdownMenu.Item>)}
        </DropdownMenu.Content>
      </DropdownMenu>}
    </div>
    <p className="font-medium text-kumo-default [overflow-wrap:anywhere]">{issue.title}</p>
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-kumo-subtle">
      {issue.assigneeId && <span title={issue.assigneeId}>Assignee {issue.assigneeId.slice(0, 8)}</span>}
      {issue.targetDate && <span className={overdue ? 'text-kumo-danger' : ''}>{overdue ? 'Overdue' : 'Due'} {formatTargetDate(issue.targetDate)}</span>}
    </div>
    {issue.blockedReason && <p className="rounded bg-kumo-danger-tint px-2 py-1 text-xs text-kumo-danger">Blocked: {issue.blockedReason}</p>}
    {waiting && <Badge variant="warning" icon={pending ? ArrowRight : undefined}>{waiting}</Badge>}
    {decision && !waiting && <Badge variant={decision.outcome === 'rejected' ? 'error' : 'success'}>
      Move to {decision.toState?.name ?? 'another state'} {decision.outcome}
    </Badge>}
    {editDecision && !waiting && <Badge variant={editDecision === 'rejected' ? 'error' : 'success'}>Edit {editDecision}</Badge>}
    {coding?.run && <CodingRunBadge run={coding.run} />}
    {chosen && <p className="text-xs text-kumo-brand">Move to {chosen.name}? Enter to propose, Escape to cancel.</p>}
  </li>
}
