import { useLayoutEffect, useRef, useState, type DragEventHandler, type KeyboardEvent, type ReactNode } from 'react'
import { Button } from '@cloudflare/kumo'
import { Plus } from '@phosphor-icons/react'
import type { Issue, NewIssue, State } from '@inferos/gatekeeper-inferops/src/types'
import type { ProposalResult } from './boardData'
import type { KanbanLayout } from './KanbanBoard'
import { KanbanIssueDialog } from './KanbanIssueDialog'
import { sortIssues } from './kanbanBoard'

const WINDOW_THRESHOLD = 50
const ESTIMATED_HEIGHT = 140
const GAP = 8
const OVERSCAN = 3

const cardElements = (list: HTMLElement) => [...list.querySelectorAll<HTMLElement>('[data-issue-id]')]
const tabStops = (card: HTMLElement) => [card, ...card.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]')]
  .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[hidden], [inert], [aria-hidden="true"]')
    && getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden')

/** A column owns its scrolling window; proposals and interactions keep their cards mounted. */
export const KanbanColumn = ({ state, issues, headingId, layout, dropOk, dropNo, retained, focusedIssueId, onCreate,
  onDragOver, onDragLeave, onDrop, renderCard }: {
  state: State
  issues: readonly Issue[]
  headingId: string
  layout: KanbanLayout
  dropOk: boolean
  dropNo: boolean
  retained: ReadonlySet<string>
  focusedIssueId: string | null
  onCreate: (issue: NewIssue) => Promise<ProposalResult>
  onDragOver: DragEventHandler<HTMLElement>
  onDragLeave: DragEventHandler<HTMLElement>
  onDrop: DragEventHandler<HTMLElement>
  renderCard: (issue: Issue, position: { index: number; count: number }, onDialogOpenChange: (open: boolean) => void) => ReactNode
}) => {
  const list = useRef<HTMLUListElement>(null)
  const heights = useRef(new Map<string, number>())
  const [measurement, setMeasurement] = useState(0)
  const [viewport, setViewport] = useState({ top: 0, height: 480 })
  const [focused, setFocused] = useState<string | null>(null)
  const [dialogs, setDialogs] = useState<ReadonlySet<string>>(new Set())
  const focusRequest = useRef<{ id: string; last: boolean } | null>(null)
  const sorted = sortIssues(issues)
  const windowed = sorted.length > WINDOW_THRESHOLD
  const offsets = [0]
  for (const issue of sorted) offsets.push(offsets.at(-1)! + (heights.current.get(issue.id) ?? ESTIMATED_HEIGHT) + GAP)
  const firstMatch = sorted.findIndex((_, index) => offsets[index + 1]! > viewport.top)
  const firstVisible = firstMatch < 0 ? Math.max(0, sorted.length - 1) : firstMatch
  const afterVisible = sorted.findIndex((_, index) => offsets[index]! >= viewport.top + viewport.height)
  const start = Math.max(0, firstVisible - OVERSCAN)
  const end = Math.min(sorted.length, (afterVisible < 0 ? sorted.length : afterVisible) + OVERSCAN)
  const rendered = sorted.flatMap((issue, index) => !windowed || index >= start && index < end
    // Endpoints preserve native Tab entry/exit from a column's header or outside the board.
    || index === 0 || index === sorted.length - 1 || retained.has(issue.id) || dialogs.has(issue.id)
    || issue.id === focused || issue.id === focusedIssueId ? [index] : [])

  useLayoutEffect(() => {
    const element = list.current
    if (!element || !windowed) return
    const update = () => setViewport(previous => {
      const next = { top: element.scrollTop, height: element.clientHeight || 480 }
      return next.top === previous.top && next.height === previous.height ? previous : next
    })
    update()
    element.addEventListener('scroll', update, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    observer?.observe(element)
    return () => { element.removeEventListener('scroll', update); observer?.disconnect() }
  }, [windowed])

  // Badges, wrapped titles and dialogs' triggers give cards different heights. Keep estimates for
  // unseen cards, then replace them with measured heights without truncating any card content.
  useLayoutEffect(() => {
    if (!windowed || !list.current) return
    const measure = () => {
      let changed = false
      for (const element of cardElements(list.current!)) {
        const height = element.getBoundingClientRect().height
        const id = element.dataset.issueId!
        if (height > 0 && heights.current.get(id) !== height) { heights.current.set(id, height); changed = true }
      }
      if (changed) setMeasurement(value => value + 1)
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    for (const element of cardElements(list.current)) observer?.observe(element)
    return () => observer?.disconnect()
  })

  useLayoutEffect(() => {
    const request = focusRequest.current
    const element = list.current && cardElements(list.current).find(card => card.dataset.issueId === request?.id)
    if (!request || !element) return
    focusRequest.current = null
    const target = request.last ? tabStops(element).at(-1)! : element
    target.focus({ preventScroll: true })
    element.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [focused, viewport, measurement])

  const focusCard = (index: number, last = false) => {
    const issue = sorted[index]
    const element = list.current
    if (!issue || !element) return
    focusRequest.current = { id: issue.id, last }
    setFocused(issue.id)
    const top = offsets[index]!
    const bottom = offsets[index + 1]!
    if (top < element.scrollTop) element.scrollTop = top
    else if (bottom > element.scrollTop + viewport.height) element.scrollTop = Math.max(0, bottom - viewport.height)
    setViewport({ top: element.scrollTop, height: element.clientHeight || 480 })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const target = event.target
    // Dialog/menu portals bubble through React too; their keyboard handling belongs to them.
    if (event.defaultPrevented || !(target instanceof HTMLElement) || !list.current?.contains(target)) return
    const card = target.closest<HTMLElement>('[data-issue-id]')
    if (!card) return
    const index = sorted.findIndex(issue => issue.id === card.dataset.issueId)
    if (event.key === 'Tab') {
      const stops = tabStops(card)
      const atBoundary = event.shiftKey ? target === card : target === stops.at(-1)
      const next = index + (event.shiftKey ? -1 : 1)
      if (atBoundary && sorted[next] && !cardElements(list.current).some(element => element.dataset.issueId === sorted[next]!.id)) {
        event.preventDefault()
        focusCard(next, event.shiftKey)
      }
    } else if (target === card && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      focusCard(event.key === 'Home' ? 0 : event.key === 'End' ? sorted.length - 1
        : Math.max(0, Math.min(sorted.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))))
    }
  }

  const content: ReactNode[] = []
  let next = 0
  for (const index of rendered) {
    if (index > next) content.push(<li key={`gap-${next}`} aria-hidden="true" role="presentation" className="shrink-0" style={{ height: offsets[index]! - offsets[next]! }} />)
    const issue = sorted[index]!
    content.push(renderCard(issue, { index, count: sorted.length }, open => {
      // Closing restores focus through the dialog primitive after this render. Retain its trigger.
      if (!open) setFocused(issue.id)
      setDialogs(previous => {
        const changed = new Set(previous)
        if (open) changed.add(issue.id)
        else changed.delete(issue.id)
        return changed
      })
    }))
    next = index + 1
  }
  if (next < sorted.length) content.push(<li key={`gap-${next}`} aria-hidden="true" role="presentation" className="shrink-0" style={{ height: offsets.at(-1)! - offsets[next]! }} />)

  // An embedded board has only max-height, so a percentage cap would leave its list unbounded.
  // Its column cap is the board's 32rem less the board's 0.25rem bottom padding.
  return <section data-state-id={state.id} aria-labelledby={headingId}
    className={`flex min-h-0 flex-col rounded-lg border bg-kumo-tint ${layout === 'full' ? 'max-h-full min-w-64 flex-1' : 'max-h-[31.75rem] w-64 shrink-0'} ${dropOk ? 'border-kumo-brand' : 'border-kumo-line'} ${dropNo ? 'opacity-60' : ''}`}
    onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
    <div className="flex shrink-0 items-center gap-2 px-3 py-2">
      <h3 id={headingId} className="flex min-w-0 flex-1 items-baseline gap-2 text-sm font-medium text-kumo-default">
        <span className="truncate">{state.name}</span>
        <span className="text-xs text-kumo-subtle" aria-label={`${issues.length} ${issues.length === 1 ? 'issue' : 'issues'}`}>{issues.length}</span>
      </h3>
      <KanbanIssueDialog kind="create" state={state} onCreate={onCreate}
        trigger={<Button size="xs" shape="square" variant="ghost" aria-label={`New issue in ${state.name}`} icon={Plus} />} />
    </div>
    <ul ref={list} aria-labelledby={headingId} className="flex min-h-12 flex-col overflow-y-auto px-2" onKeyDown={onKeyDown}
      onFocus={event => { if (list.current?.contains(event.target)) setFocused(event.target.closest<HTMLElement>('[data-issue-id]')?.dataset.issueId ?? null) }}
      onBlur={event => { if (event.relatedTarget instanceof Node && !list.current?.contains(event.relatedTarget)) setFocused(null) }}>
      {issues.length === 0 ? <li className="px-1 pb-2 text-xs text-kumo-subtle">No issues</li> : content}
    </ul>
  </section>
}
