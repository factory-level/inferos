import { useState, type ReactNode } from 'react'
import { Badge, Button, Checkbox, Loader } from '@cloudflare/kumo'
import {
  ArrowDownIcon, ArrowLeftIcon, ArrowRightIcon, ArrowUpIcon, ArrowsInLineHorizontalIcon, ArrowsInLineVerticalIcon,
  ArrowsOutLineHorizontalIcon, ArrowsOutLineVerticalIcon, TrashIcon,
} from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, OperateSession, Overseer } from '@gadgets/workshop-shared/api'
import type { CanvasProjectBoardWidget } from '@gadgets/workshop-shared/canvas'
import type {
  BuiltinWidgetPlacementRef, ConsoleWidgetPlacementRef, WidgetPlacement,
} from '@gadgets/workshop-shared/widget-placements'
import GadgetUI from '../../GadgetUI'
import { CanvasBoardWidget } from '../canvas/CanvasBoardWidget'
import { WidgetStateBar } from '../canvas/WidgetStateBar'
import { EMBEDDED_WIDGET_UNAVAILABLE, useEmbeddedConsoleWidget } from '../canvas/useEmbeddedConsoleWidget'
import { BoardConnectPrompt } from './BoardConnectPrompt'
import { SHOW_COMPLETED, type LayoutChange } from './personalCanvas'

/** One grid row, in pixels: a placement's height is its rows times this. */
export const CANVAS_ROW_PX = 80

const CHANGES: { change: LayoutChange; label: string; icon: ReactNode }[] = [
  { change: 'left', label: 'Move left', icon: <ArrowLeftIcon size={14} aria-hidden /> },
  { change: 'right', label: 'Move right', icon: <ArrowRightIcon size={14} aria-hidden /> },
  { change: 'up', label: 'Move up', icon: <ArrowUpIcon size={14} aria-hidden /> },
  { change: 'down', label: 'Move down', icon: <ArrowDownIcon size={14} aria-hidden /> },
  { change: 'narrower', label: 'Narrower', icon: <ArrowsInLineHorizontalIcon size={14} aria-hidden /> },
  { change: 'wider', label: 'Wider', icon: <ArrowsOutLineHorizontalIcon size={14} aria-hidden /> },
  { change: 'shorter', label: 'Shorter', icon: <ArrowsInLineVerticalIcon size={14} aria-hidden /> },
  { change: 'taller', label: 'Taller', icon: <ArrowsOutLineVerticalIcon size={14} aria-hidden /> },
]

type ConsoleBodyProps = {
  api: RpcStub<AuthenticatedApi> | undefined
  viewer: object | null
  session: RpcStub<OperateSession>
  placementId: string
  target: ConsoleWidgetPlacementRef
  height: number
}

/**
 * A placed console widget, opened every time through the Wiki embed's checked path with the
 * person's own access (FAC-13). One that can't be opened says why and stays on the canvas as a
 * reference, never as an empty frame: they may remove it, or check again later. Its state is its
 * own (keyed by the placement), so two placements of one widget filter independently.
 */
const ConsoleWidgetBody = ({ api, viewer, session, placementId, target, height }: ConsoleBodyProps) => {
  const [attempt, setAttempt] = useState(0)
  const [widgetState, setWidgetState] = useState<string | null>(null)
  const shown = useEmbeddedConsoleWidget(api, viewer, target, String(attempt))
  const again = <Button size="sm" onClick={() => setAttempt(n => n + 1)}>Check again</Button>
  const gone = (text: string) => <div className="flex flex-wrap items-center gap-2 p-3 text-sm text-kumo-subtle">
    <p role="status" className="m-0">No longer available. {text} It stays on your canvas until you remove it.</p>{again}
  </div>
  switch (shown.status) {
    case 'loading':
      return <p aria-busy="true" className="flex items-center gap-2 p-3 text-sm text-kumo-subtle"><Loader size="sm" /> Loading the widget…</p>
    case 'no-access':
      return gone('You can no longer open the workspace it is in.')
    case 'unavailable':
      return gone(EMBEDDED_WIDGET_UNAVAILABLE[shown.reason])
    case 'revoked':
      return gone('Its console changed, or your access to it ended.')
    case 'error':
      return <div className="flex flex-wrap items-center gap-2 p-3 text-sm">
        <p role="alert" className="m-0 text-kumo-danger">Couldn’t open this widget: {shown.message}</p>{again}
      </div>
    case 'ready': {
      const { widget } = shown
      return <>
        {widget.blueprintId !== target.blueprintId || widget.version !== target.version
          ? <p className="m-0 border-b border-kumo-line px-3 py-1.5"><Badge variant="warning">Updated since it was placed</Badge></p> : null}
        <WidgetStateBar session={session} onStateChange={setWidgetState}
          widgetRef={{ workspaceId: target.workspaceId, consoleId: widget.consoleId, revision: widget.revision, gadgetId: widget.gadgetId, placementId }} />
        <GadgetUI key={`${widget.revision}:${widget.gadgetId}`} gadget={shown.stub} height={`${height}px`} widgetState={widgetState} />
      </>
    }
  }
}

/**
 * A placed board, read through the person's own session workspace with their own InferOps access,
 * as the session's board is (FAC-13). Its one filter, whether it shows completed issues, is the
 * placement's own, saved with it.
 */
const BoardBody = ({ placement, target, sessionWorkspace, onFilters }: {
  placement: WidgetPlacement
  target: BuiltinWidgetPlacementRef
  sessionWorkspace: RpcStub<Overseer> | null
  /** Absent on a canvas the person can't arrange: the filter is then shown as it was placed. */
  onFilters?: (filters: Record<string, string>) => void
}) => {
  if (!sessionWorkspace) return <p role="status" className="p-3 text-sm text-kumo-subtle">Opening your session…</p>
  const showCompleted = placement.filters[SHOW_COMPLETED] === 'true'
  const widget: CanvasProjectBoardWidget = {
    id: `placement-${placement.placementId}`, kind: 'inferops.project-board', version: 1, targetRef: target.target, size: 'full',
    params: { workflow: 'software', showCompleted },
  }
  return <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
    {onFilters && <Checkbox label="Show completed" checked={showCompleted}
      onCheckedChange={(checked) => onFilters({ ...placement.filters, [SHOW_COMPLETED]: checked === true ? 'true' : 'false' })} />}
    <div className="min-h-0 flex-1 overflow-auto">
      <CanvasBoardWidget widget={widget} overseer={sessionWorkspace} presentation="full"
        unboundAction={retry => <BoardConnectPrompt scope={sessionWorkspace} targetRef={target.target} onConnected={retry} />} />
    </div>
  </div>
}

/** What a placement is called before anything of it is read: from its own reference. */
const placementTitle = (placement: WidgetPlacement) => placement.ref.type === 'builtin'
  ? `Board ${placement.ref.target.split('/').pop()}`
  : placement.ref.blueprintId

/** The controls of a placement the person can arrange: move, resize, filter and remove it. */
export type PlacementEdit = {
  busy: boolean
  canChange: (change: LayoutChange) => boolean
  onChange: (change: LayoutChange) => void
  onFilters: (filters: Record<string, string>) => void
  onRemove: () => void
}

/**
 * One placement on a canvas: its widget and, when `edit` is given (the person's own canvas), the
 * controls that move and resize it in whole grid cells (by keyboard, touch or mouse; a control the
 * grid or another placement would refuse is disabled) and remove it. Without `edit` (a temporary
 * canvas, FAC-137) it is shown as placed, with nothing to arrange.
 */
export const PlacedWidget = ({ placement, api, viewer, session, sessionWorkspace, focused, edit }: {
  placement: WidgetPlacement
  api: RpcStub<AuthenticatedApi> | undefined
  viewer: object | null
  session: RpcStub<OperateSession>
  sessionWorkspace: RpcStub<Overseer> | null
  /** The placement a deep link names. */
  focused: boolean
  edit?: PlacementEdit
}) => {
  const title = placementTitle(placement)
  const height = placement.layout.h * CANVAS_ROW_PX - 96
  return (
    <article id={`placement-${placement.placementId}`} aria-label={`Placed widget ${title}`} tabIndex={-1}
      className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-kumo-base ${focused ? 'border-kumo-brand' : 'border-kumo-line'}`}
      style={{ minHeight: placement.layout.h * CANVAS_ROW_PX }}>
      <header className="flex flex-wrap items-center gap-1 border-b border-kumo-line px-3 py-1.5">
        <h3 className="m-0 min-w-0 flex-1 truncate text-sm font-medium text-kumo-default">{title}</h3>
        {edit && <div role="toolbar" aria-label={`Arrange ${title}`} className="flex flex-wrap items-center gap-0.5">
          {CHANGES.map(({ change, label, icon }) => (
            <Button key={change} size="sm" variant="ghost" shape="square" aria-label={label} title={label}
              disabled={edit.busy || !edit.canChange(change)} onClick={() => edit.onChange(change)}>{icon}</Button>
          ))}
          <Button size="sm" variant="ghost" shape="square" aria-label="Remove from canvas" title="Remove from canvas"
            disabled={edit.busy} onClick={edit.onRemove}><TrashIcon size={14} aria-hidden /></Button>
        </div>}
      </header>
      {placement.ref.type === 'console-widget'
        ? <ConsoleWidgetBody api={api} viewer={viewer} session={session} placementId={placement.placementId}
            target={placement.ref} height={Math.max(height, 120)} />
        : <BoardBody placement={placement} target={placement.ref} sessionWorkspace={sessionWorkspace} onFilters={edit?.onFilters} />}
    </article>
  )
}
