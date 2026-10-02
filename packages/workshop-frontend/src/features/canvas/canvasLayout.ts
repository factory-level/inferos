import type { CanvasSection, CanvasWidget } from '@gadgets/workshop-shared/canvas'
import type { WorkpieceId } from '@gadgets/workshop-shared/api'

/**
 * Columns follow the width of the canvas pane rather than the viewport, since the chat pane
 * beside it takes a user-chosen share of the window. Each section is a size container.
 */
export const sectionGridClass = (columns: CanvasSection['columns']) =>
  `grid grid-cols-1 gap-3 ${columns === 3 ? '@3xl:grid-cols-2 @5xl:grid-cols-3' : columns === 2 ? '@3xl:grid-cols-2' : ''}`

export const widgetSpanClass = (size: CanvasWidget['size'], columns: CanvasSection['columns']) =>
  size === 'full' ? '@3xl:col-span-full' : size === 'wide' && columns > 1 ? '@3xl:col-span-2' : ''

export const gadgetRef = (id: WorkpieceId) => `gadget:${id}`

/** Only valid on a parsed `inferos.gadget` widget, whose reference the contract already checked. */
export const gadgetIdOf = (targetRef: string): WorkpieceId => Number(targetRef.slice('gadget:'.length))
