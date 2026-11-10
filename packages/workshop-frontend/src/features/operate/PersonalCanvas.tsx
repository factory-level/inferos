import { useEffect, useState, type CSSProperties } from 'react'
import { Button } from '@cloudflare/kumo'
import { PlusIcon, XIcon } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, OperateSession, Overseer } from '@gadgets/workshop-shared/api'
import type { OperateEventRecord } from '@gadgets/workshop-shared/operate-session'
import { WIDGET_PLACEMENT_LIMITS, type WidgetPlacement, type WidgetPlacementRef } from '@gadgets/workshop-shared/widget-placements'
import type { WorkspaceScreensState } from '../../pages/inferops-canvas/useWorkspaceScreens'
import { changedLayout, defaultSize, firstFreeSlot, othersOf, type LayoutChange } from './personalCanvas'
import { CANVAS_ROW_PX, PlacedWidget } from './PlacedWidget'
import { usePlacements } from './usePlacements'
import { WidgetFinder } from './WidgetFinder'

/**
 * The person's own Operate canvas (FAC-13): the widgets they placed, each where and as large as
 * they put it on a 12-column grid, saved with them for the company they work in now, and "Add a
 * widget" to find more by what they want them for. Placing a widget stores a reference only: each
 * is opened through its own checked path every time it is shown. On a narrow screen placements
 * stack in canvas order.
 */
export const PersonalCanvas = ({ api, viewer, session, sessionWorkspace, recentEvents, screens, currentBoard, focusedPlacement }: {
  api: RpcStub<AuthenticatedApi>
  viewer: object | null
  session: RpcStub<OperateSession>
  sessionWorkspace: RpcStub<Overseer> | null
  recentEvents: readonly OperateEventRecord[]
  screens: WorkspaceScreensState
  currentBoard: string | null
  /** The placement a deep link names, brought into view. */
  focusedPlacement?: string
}) => {
  const { state, notice, dismissNotice, retry, save, remove } = usePlacements(session, recentEvents)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const placements = state.status === 'ready' ? state.placements.placements : []
  const shown = state.status === 'ready' && focusedPlacement !== undefined &&
    placements.some(placement => placement.placementId === focusedPlacement)

  // A deep link's placement, once it is on the page: scrolled to and focused, once.
  useEffect(() => {
    if (!shown) return
    const element = document.getElementById(`placement-${focusedPlacement}`)
    element?.scrollIntoView?.({ block: 'nearest' })
    element?.focus()
  }, [shown, focusedPlacement])

  const act = async (work: () => Promise<string | null>) => {
    setBusy(true)
    setRefusal(null)
    try {
      setRefusal(await work())
    } finally {
      setBusy(false)
    }
  }

  const place = async (ref: WidgetPlacementRef): Promise<string | null> => {
    const layout = firstFreeSlot(defaultSize(ref), placements.map(placement => placement.layout))
    if (!layout) return 'Your canvas has no room left for this widget. Remove or shrink one first.'
    const refused = await save({ ref, layout })
    if (!refused) setAdding(false)
    return refused
  }
  const change = (placement: WidgetPlacement, layoutChange: LayoutChange) => {
    const layout = changedLayout(placement.layout, layoutChange, othersOf(placements, placement.placementId))
    if (layout) void act(() => save({ placementId: placement.placementId, ref: placement.ref, layout, filters: placement.filters }))
  }

  const full = placements.length >= WIDGET_PLACEMENT_LIMITS.placements
  return (
    <section aria-labelledby="personal-canvas-heading" className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="personal-canvas-heading" className="m-0 min-w-0 flex-1 text-[17px] leading-6 font-medium tracking-[-0.35px] text-kumo-default">My canvas</h2>
        {state.status === 'ready' && (adding
          ? <Button size="sm" variant="ghost" icon={XIcon} onClick={() => setAdding(false)}>Done adding</Button>
          : <Button size="sm" variant="primary" icon={PlusIcon} disabled={full} onClick={() => setAdding(true)}>Add a widget</Button>)}
      </div>
      <p className="m-0 text-[13px] leading-[18px] text-kumo-subtle">
        Your own arrangement of the widgets you may use, for the company you work in now. It is kept with your
        account, so it follows you to another device; switching company starts a new one.
      </p>
      {full && <p role="status" className="m-0 text-[12px] text-kumo-subtle">Your canvas holds the most widgets it can ({WIDGET_PLACEMENT_LIMITS.placements}). Remove one to add another.</p>}
      {notice && (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-kumo-line bg-kumo-elevated px-3 py-2 text-sm text-kumo-default">
          <span className="min-w-0 flex-1">{notice.text}</span>
          <Button size="sm" variant="ghost" onClick={dismissNotice}>Dismiss</Button>
        </div>
      )}
      {refusal && <p role="alert" className="m-0 text-sm text-kumo-danger">{refusal}</p>}

      {adding && <WidgetFinder api={api} screens={screens} currentBoard={currentBoard} onPlace={place} />}

      {state.status === 'loading' && <p role="status" className="m-0 text-sm text-kumo-subtle">Loading your canvas…</p>}
      {state.status === 'error' && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-kumo-danger">
          Couldn't load your canvas.
          <Button size="sm" onClick={retry}>Try again</Button>
        </div>
      )}
      {state.status === 'ready' && placements.length === 0 && !adding && (
        <p className="m-0 rounded-xl border border-dashed border-kumo-line p-6 text-center text-sm text-kumo-subtle">
          Nothing on your canvas yet. Add a widget to start.
        </p>
      )}
      {placements.length > 0 && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-12" style={{ gridAutoRows: `minmax(${CANVAS_ROW_PX}px, auto)` }}>
          {placements.map(placement => (
            <div key={placement.placementId} className="flex min-w-0 md:[grid-column:var(--col)] md:[grid-row:var(--row)]"
              style={{
                '--col': `${placement.layout.x + 1} / span ${placement.layout.w}`,
                '--row': `${placement.layout.y + 1} / span ${placement.layout.h}`,
              } as CSSProperties}>
              <PlacedWidget placement={placement} api={api} viewer={viewer} session={session} sessionWorkspace={sessionWorkspace}
                busy={busy} focused={placement.placementId === focusedPlacement}
                canChange={layoutChange => changedLayout(placement.layout, layoutChange, othersOf(placements, placement.placementId)) !== null}
                onChange={layoutChange => change(placement, layoutChange)}
                onFilters={filters => void act(() => save({ placementId: placement.placementId, ref: placement.ref, layout: placement.layout, filters }))}
                onRemove={() => void act(() => remove(placement.placementId))} />
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
