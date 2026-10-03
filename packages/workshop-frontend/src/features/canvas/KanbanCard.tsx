import { useState, type KeyboardEvent } from 'react'
import { Badge, Button, DropdownMenu } from '@cloudflare/kumo'
import { ArrowRight, DotsThree } from '@phosphor-icons/react'
import type { Issue, State } from '@inferos/gatekeeper-inferops/src/types'
import type { PendingMove } from './boardData'
import { PRIORITY_LABELS, formatTargetDate, isOverdue, type MoveDecision } from './kanbanBoard'

const PRIORITY_VARIANT = { urgent: 'error', high: 'warning', medium: 'info', low: 'neutral', none: 'neutral' } as const

export type KanbanCardProps = {
  issue: Issue
  /** The column the board shows the issue in. */
  state: State
  /** Where the issue may move, in board order. Empty when it is pending or has nowhere to go. */
  targets: readonly State[]
  /** The issue's undecided move, resolved to its target state. */
  pending?: { move: PendingMove; toState: State | undefined }
  /** How the issue's last move was decided, until it moves again or changes. */
  decision?: { outcome: MoveDecision['outcome']; toState: State | undefined }
  /** `YYYY-MM-DD`, for the overdue mark. */
  today: string
  /** The element id of the board's keyboard instructions. */
  instructionsId: string
  onMove: (toState: State) => void
  onDragStart: () => void
  onDragEnd: () => void
}

/**
 * One issue on the board. It is a focusable card: the arrow keys pick a target column and Enter
 * proposes the move, the "Move to" menu offers the same targets, and it can be dragged to a
 * column. A pending move keeps its controls disabled, since the gatekeeper refuses a second.
 */
export const KanbanCard = ({ issue, state, targets, pending, decision, today, instructionsId, onMove, onDragStart, onDragEnd }: KanbanCardProps) => {
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
  return <li data-issue-id={issue.id} tabIndex={0} draggable={movable} aria-label={`${issue.identifier}: ${issue.title}`}
    aria-describedby={instructionsId} aria-busy={pending?.move.phase === 'proposing' || undefined}
    onKeyDown={onKeyDown} onBlur={() => setChoice(null)}
    onDragStart={event => { event.dataTransfer.setData('text/plain', issue.id); event.dataTransfer.effectAllowed = 'move'; onDragStart() }}
    onDragEnd={onDragEnd}
    className={`space-y-1.5 rounded-md border border-kumo-line bg-kumo-base p-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring ${movable ? 'cursor-grab' : ''} ${pending ? 'opacity-80' : ''}`}>
    <div className="flex items-center gap-2">
      <span className="font-mono text-xs text-kumo-subtle">{issue.identifier}</span>
      {issue.priority !== 'none' && <Badge variant={PRIORITY_VARIANT[issue.priority]}>{PRIORITY_LABELS[issue.priority]}</Badge>}
      {movable && <DropdownMenu>
        <DropdownMenu.Trigger render={<Button size="xs" shape="square" variant="ghost" className="ml-auto" aria-label={`Move ${issue.identifier} to…`} icon={DotsThree} />} />
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
    {pending && <Badge variant="warning" icon={ArrowRight}>
      {pending.move.phase === 'proposing' ? 'Proposing move to' : 'Awaiting approval:'} {pending.toState?.name ?? 'another state'}
    </Badge>}
    {decision && !pending && <Badge variant={decision.outcome === 'rejected' ? 'error' : 'success'}>
      Move to {decision.toState?.name ?? 'another state'} {decision.outcome}
    </Badge>}
    {chosen && <p className="text-xs text-kumo-brand">Move to {chosen.name}? Enter to propose, Escape to cancel.</p>}
  </li>
}
