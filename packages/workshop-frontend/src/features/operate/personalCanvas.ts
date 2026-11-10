import {
  WIDGET_PLACEMENT_ERROR_CODES, WIDGET_PLACEMENT_LIMITS,
  type WidgetPlacement, type WidgetPlacementLayout, type WidgetPlacementRef,
} from '@gadgets/workshop-shared/widget-placements'
import type { OperateEventRecord } from '@gadgets/workshop-shared/operate-session'

// A person's own Operate canvas (FAC-13): the pure rules the canvas page applies to its placements,
// kept apart from React so they are tested on their own. The kernel checks every placement again;
// these only keep the page from offering a change it would refuse or that would overlap another.

const CODES = new Set<string>(Object.values(WIDGET_PLACEMENT_ERROR_CODES))

// The code leads the kernel's message; across RPC an error's name may come before it
// ("WidgetPlacementError: WIDGET_PLACEMENTS_CONFLICT: …").
const CODED = /^(?:[A-Za-z]*Error: )?(WIDGET_[A-Z_]+): ?/

/** A placement refusal's code, or null for anything else. */
export const placementErrorCode = (caught: unknown): string | null => {
  const message = caught instanceof Error ? caught.message : typeof caught === 'string' ? caught : ''
  const code = CODED.exec(message)?.[1]
  return code && CODES.has(code) ? code : null
}

/** A refusal's own words after its code, for showing a person. */
export const placementRefusalText = (caught: unknown): string => {
  const message = caught instanceof Error ? caught.message : String(caught)
  return (placementErrorCode(caught) ? message.replace(CODED, '') : '') || 'That change could not be saved.'
}

/** The default size of a new placement, in grid cells: a board takes the whole width. */
export const defaultSize = (ref: WidgetPlacementRef): { w: number; h: number } =>
  ref.type === 'builtin' ? { w: WIDGET_PLACEMENT_LIMITS.columns, h: 6 } : { w: 6, h: 5 }

const overlaps = (a: WidgetPlacementLayout, b: WidgetPlacementLayout) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** Whether `layout` fits the grid and overlaps none of `others`. */
export const fits = (layout: WidgetPlacementLayout, others: readonly WidgetPlacementLayout[]): boolean =>
  layout.x >= 0 && layout.y >= 0 && layout.w >= 1 && layout.h >= 1 &&
  layout.x + layout.w <= WIDGET_PLACEMENT_LIMITS.columns && layout.y < WIDGET_PLACEMENT_LIMITS.rows &&
  layout.h <= WIDGET_PLACEMENT_LIMITS.height && others.every(other => !overlaps(layout, other))

/** The first free place for a widget of this size, reading row by row, or null if none is left. */
export const firstFreeSlot = (size: { w: number; h: number }, others: readonly WidgetPlacementLayout[])
    : WidgetPlacementLayout | null => {
  const w = Math.min(size.w, WIDGET_PLACEMENT_LIMITS.columns)
  for (let y = 0; y < WIDGET_PLACEMENT_LIMITS.rows; y++) {
    for (let x = 0; x + w <= WIDGET_PLACEMENT_LIMITS.columns; x++) {
      const layout = { x, y, w, h: size.h }
      if (fits(layout, others)) return layout
    }
  }
  return null
}

/** A change a person can ask of one placement's layout. */
export type LayoutChange = 'left' | 'right' | 'up' | 'down' | 'wider' | 'narrower' | 'taller' | 'shorter'

const STEP: Record<LayoutChange, Partial<Record<keyof WidgetPlacementLayout, number>>> = {
  left: { x: -1 }, right: { x: 1 }, up: { y: -1 }, down: { y: 1 },
  wider: { w: 1 }, narrower: { w: -1 }, taller: { h: 1 }, shorter: { h: -1 },
}

/** `layout` after `change`, or null when it would leave the grid or overlap another placement. */
export const changedLayout = (layout: WidgetPlacementLayout, change: LayoutChange,
    others: readonly WidgetPlacementLayout[]): WidgetPlacementLayout | null => {
  const step = STEP[change]
  const next = { x: layout.x + (step.x ?? 0), y: layout.y + (step.y ?? 0), w: layout.w + (step.w ?? 0), h: layout.h + (step.h ?? 0) }
  return fits(next, others) ? next : null
}

/** The other placements' layouts, for checking one placement's change against. */
export const othersOf = (placements: readonly WidgetPlacement[], placementId: string) =>
  placements.filter(placement => placement.placementId !== placementId).map(placement => placement.layout)

/**
 * Whether the person moved to another company after `since` (ms since the epoch), as the operate
 * session's log records it: the kernel then cleared the former company's canvas.
 */
export const companyChangedSince = (records: readonly OperateEventRecord[], since: number): boolean =>
  records.some(record => record.event.type === 'companyChanged' && new Date(record.at).getTime() > since)

/** Whether a built-in widget kind can be placed here: only an InferOps board, for now. */
export const placeableBuiltin = (kind: string) => kind === 'project/board'

/** The filter a placed board keeps: whether it shows completed issues. */
export const SHOW_COMPLETED = 'showCompleted'
