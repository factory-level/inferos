// FAC-13: the rules a person's Operate canvas applies before asking the kernel: a refusal's code
// read whatever wraps it, new placements in the first free place, moves and resizes that never
// leave the 12-column grid or overlap another placement, and a company change told apart.
import { describe, expect, it } from 'vitest'
import type { OperateEventRecord } from '@gadgets/workshop-shared/operate-session'
import {
  changedLayout, companyChangedSince, defaultSize, firstFreeSlot, fits, placementErrorCode, placementRefusalText,
} from './personalCanvas'

describe('a placement refusal', () => {
  it('reads its code as the kernel wrote it, or with the error name RPC adds, and nothing else', () => {
    expect(placementErrorCode(new Error('WIDGET_PLACEMENTS_CONFLICT: Your placements changed; read them again.'))).toBe('WIDGET_PLACEMENTS_CONFLICT')
    expect(placementErrorCode(new Error('WidgetPlacementError: WIDGET_PLACEMENTS_FULL: You keep 64 placements.'))).toBe('WIDGET_PLACEMENTS_FULL')
    expect(placementErrorCode(new Error('WIDGET_STATE_CONFLICT: not ours'))).toBeNull()
    expect(placementErrorCode(new Error('network down'))).toBeNull()
  })

  it("shows the kernel's own words, never its code", () => {
    expect(placementRefusalText(new Error('WidgetPlacementError: WIDGET_PLACEMENTS_FULL: You keep 64 placements.'))).toBe('You keep 64 placements.')
    expect(placementRefusalText(new Error('boom'))).toBe('That change could not be saved.')
  })
})

describe('the grid', () => {
  it('puts a new widget in the first free place, row by row, and a board across the whole width', () => {
    expect(defaultSize({ type: 'builtin', kind: 'project/board', target: 'inferops://a.b/project/board/K' })).toEqual({ w: 12, h: 6 })
    expect(firstFreeSlot({ w: 6, h: 5 }, [])).toEqual({ x: 0, y: 0, w: 6, h: 5 })
    expect(firstFreeSlot({ w: 6, h: 5 }, [{ x: 0, y: 0, w: 6, h: 5 }])).toEqual({ x: 6, y: 0, w: 6, h: 5 })
    expect(firstFreeSlot({ w: 12, h: 2 }, [{ x: 3, y: 0, w: 2, h: 4 }])).toEqual({ x: 0, y: 4, w: 12, h: 2 })
  })

  it('moves and resizes in whole cells, never off the grid or onto another placement', () => {
    const others = [{ x: 6, y: 0, w: 6, h: 5 }]
    const here = { x: 0, y: 0, w: 6, h: 5 }
    expect(changedLayout(here, 'left', others)).toBeNull()
    expect(changedLayout(here, 'up', others)).toBeNull()
    expect(changedLayout(here, 'right', others)).toBeNull()
    expect(changedLayout(here, 'wider', others)).toBeNull()
    expect(changedLayout(here, 'down', others)).toEqual({ x: 0, y: 1, w: 6, h: 5 })
    expect(changedLayout(here, 'narrower', others)).toEqual({ x: 0, y: 0, w: 5, h: 5 })
    expect(changedLayout({ x: 0, y: 0, w: 1, h: 1 }, 'narrower', [])).toBeNull()
    expect(changedLayout({ x: 0, y: 0, w: 4, h: 24 }, 'taller', [])).toBeNull()
    expect(fits({ x: 8, y: 0, w: 4, h: 3 }, [])).toBe(true)
    expect(fits({ x: 9, y: 0, w: 4, h: 3 }, [])).toBe(false)
  })
})

const record = (type: string, at: number) => ({ seq: 1, event: { type }, actor: 'person', at: new Date(at) }) as unknown as OperateEventRecord

describe('a company change', () => {
  it('counts only after the canvas was last read', () => {
    expect(companyChangedSince([record('companyChanged', 2000)], 1000)).toBe(true)
    expect(companyChangedSince([record('companyChanged', 500)], 1000)).toBe(false)
    expect(companyChangedSince([record('showHome', 2000)], 1000)).toBe(false)
  })
})
