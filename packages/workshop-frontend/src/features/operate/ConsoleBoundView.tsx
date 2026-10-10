import { useLayoutEffect, useRef } from 'react'
import { Button, Dialog, Loader } from '@cloudflare/kumo'
import { XIcon } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { OperateSession } from '@gadgets/workshop-shared/api'
import type { BoundViewEntry, ConsoleRef, HostBoardEntry } from '@gadgets/workshop-shared/operate-console'
import { HostBoardPicker } from './HostBoardPicker'
import { useHostBoard } from './useHostBoard'
import { useHostBoardAccounts } from './useHostBoardAccounts'
import { useHostBoardSelection } from './useHostBoardSelection'
import { contain } from './boundView/contain'
import { useBoundViewCohort, type BoundViewCohort, type BoundViewShown } from './boundView/useBoundViewCohort'

const SHOWN_STATUS: Partial<Record<BoundViewShown['status'], string>> = {
  waiting: 'Waiting for a fresh read of every board this view uses…',
  blocked: 'Close the other window or widget to see this view.',
  'too-large': 'This view is too large to show.',
  invalid: 'This view can\'t be shown with this board data.',
  failed: 'This view could not be shown. Close it and open it again.',
}

/**
 * A bound view of the console revision the session has open, opened from the console's widget
 * menu: the console's authored `view.json`, evaluated by trusted host code over the operator's
 * own reads of the console's host boards, and rendered in a dedicated React root. This component
 * and its children render statuses only, never board data; while the view is open the page
 * unmounts every authored frame (see `OperateSessionPage`), and nothing is accepted or rendered
 * while any frame-like element exists. In a draft preview the spec stays at the commit it was
 * first read at until "Refresh preview".
 */
export const ConsoleBoundView = ({ session, console: ref, entry, hostBoards, onClose, onRefused, onStaleOrUnavailable }: {
  session: RpcStub<OperateSession>
  /** The revision the session opened. */
  console: ConsoleRef
  /** The bound view, as that revision registers it. */
  entry: BoundViewEntry & { id: string }
  /** That revision's host boards, which serve the view's requirements. */
  hostBoards: readonly HostBoardEntry[]
  onClose: () => void
  /** The kernel refused the view because that console revision is no longer open. */
  onRefused: () => void
  /** A read answered `stale` or `unavailable`: the revision may have moved on unannounced. */
  onStaleOrUnavailable: () => void
}) => {
  const boards = new Map(hostBoards.flatMap(board => board.id === undefined ? [] : [[board.id, board] as const]))
  const { cohort, containerRef } = useBoundViewCohort(session, { console: ref, entryId: entry.id }, new Set(boards.keys()), onRefused)
  const description = cohort.description
  const shown = cohort.shown()
  const draft = ref.source === 'draft'
  const refresh = contain(cohort.site, () => cohort.refresh())

  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}>
    <Dialog size="lg" className="flex max-h-[90dvh] !w-[min(1200px,calc(100vw-32px))] flex-col overflow-hidden rounded-xl bg-kumo-base p-0">
      <header className="flex items-center justify-between gap-3 border-b border-kumo-line px-5 py-3">
        <Dialog.Title className="truncate text-sm font-medium text-kumo-default"><bdi>{entry.label}</bdi></Dialog.Title>
        <div className="flex items-center gap-2">
          {draft && <Button size="sm" variant="ghost" onClick={refresh}>Refresh preview</Button>}
          <Dialog.Close render={<Button size="sm" variant="ghost" aria-label="Close view"><XIcon size={16} aria-hidden /></Button>} />
        </div>
      </header>
      <Dialog.Description className="sr-only">A read-only view, read with your own InferOps access.</Dialog.Description>
      <div className="min-h-0 space-y-4 overflow-auto p-5 text-sm">
        {description.status === 'loading' && <p role="status" className="flex items-center gap-2 text-kumo-subtle"><Loader size="sm" /> Opening this view…</p>}
        {description.status === 'unavailable' && <p role="status" className="text-kumo-subtle">This view is unavailable right now. Close it and open it again to retry.</p>}
        {description.status === 'invalid' && <p role="status" className="text-kumo-subtle">This view can&apos;t be shown: its definition is not valid.</p>}
        {description.status === 'ready' && <>
          <header className="space-y-1">
            <h2 className="text-base font-medium text-kumo-default"><bdi>{description.spec.title}</bdi></h2>
            {draft && <p className="text-xs text-kumo-subtle">Draft preview of commit <code>{description.commitId.slice(0, 12)}</code></p>}
          </header>
          {SHOWN_STATUS[shown.status] && <p role="status" className="text-kumo-subtle">{SHOWN_STATUS[shown.status]}</p>}
          {description.requirements.map(requirement => {
            const board = boards.get(requirement.hostBoardEntryId)
            return board && <BoundViewRequirement key={`${cohort.contextToken}/${requirement.name}`} session={session} cohort={cohort}
              console={ref} hostBoard={{ ...board, id: requirement.hostBoardEntryId }} name={requirement.name}
              onRefused={onRefused} onStaleOrUnavailable={onStaleOrUnavailable} />
          })}
        </>}
        {/* The dedicated root's container: no class, no children of this root, display set inline only. */}
        <div ref={containerRef} data-bound-view="" />
      </div>
    </Dialog>
  </Dialog.Root>
}

/**
 * One requirement of a bound view: the host-board hooks for its board, under the cohort. It
 * renders that board's status (never its data) and offers its view to the cohort after every
 * commit. Its signals (an account change, a connection choice, a refusal) invalidate the cohort at
 * the epoch this child last rendered with, so many children reporting one change raise it once.
 */
const BoundViewRequirement = ({ session, cohort, console: ref, hostBoard, name, onRefused, onStaleOrUnavailable }: {
  session: RpcStub<OperateSession>
  cohort: BoundViewCohort
  console: ConsoleRef
  hostBoard: HostBoardEntry & { id: string }
  name: string
  onRefused: () => void
  onStaleOrUnavailable: () => void
}) => {
  const target = { entryId: hostBoard.id, console: ref }
  const seen = useRef(cohort.epoch)
  seen.current = cohort.epoch
  const signal = contain(cohort.site, () => cohort.invalidate(seen.current, 'callback'))
  const { view, changeSeq, dispatch } = useHostBoard(session, target, name, {
    onRequest: (readToken, sent) => cohort.tag(name, readToken, sent),
    onRefused: contain(cohort.site, () => { signal(); onRefused() }),
    onStaleOrUnavailable,
  })
  const accounts = useHostBoardAccounts(hostBoard.requirement.target, signal)
  const selection = useHostBoardSelection(session, target, signal)
  const dispatchRef = useRef(dispatch)
  dispatchRef.current = dispatch
  useLayoutEffect(() => cohort.register(name, event => dispatchRef.current(event)), [cohort, name])
  useLayoutEffect(() => contain(cohort.site, () => cohort.offer(name, ref, view, changeSeq))())

  if (view.status === 'ok') return null
  return <section className="space-y-2 rounded-lg border border-kumo-line p-3 text-kumo-subtle">
    <h3 className="text-xs font-medium text-kumo-default">{hostBoard.label}</h3>
    {view.status === 'loading' && <p role="status" className="flex items-center gap-2"><Loader size="sm" /> Reading the board…</p>}
    {view.status === 'unknown' && <p role="status">Checking your connection for this board…</p>}
    {view.status === 'cleared' && <p role="status">Nothing is shown for this board right now. If the console changed, reopen it to continue.</p>}
    {view.status === 'not-connected' && <>
      <p role="status">Not connected for you. This board is read with your own InferOps access, so choose one of your connections to see it.</p>
      <HostBoardPicker accounts={accounts} intent={selection.intent} onSelect={contain(cohort.site, selection.select)} />
    </>}
    {view.status === 'unavailable' && <>
      <p role="status">This board is unavailable right now.</p>
      <Button size="sm" onClick={contain(cohort.site, () => dispatch({ type: 'retry' }))}>Retry</Button>
    </>}
    {selection.intent.lost && <div role="alert" className="space-y-2">
      <p>Could not confirm your connection choice. It may still take effect; trying again is safe.</p>
      <Button size="sm" onClick={contain(cohort.site, selection.retry)}>Try that connection again</Button>
    </div>}
  </section>
}
