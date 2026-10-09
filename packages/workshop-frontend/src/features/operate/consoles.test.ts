import { describe, expect, it } from 'vitest'
import { MAX_CONSOLE_WIDGETS, type ConsoleWidgetEntry, type HostBoardEntry } from '@gadgets/workshop-shared/operate-console'
import { consoleContentForSave } from './consoles'

const BASE = { title: 'Operations', fullChat: 'default' as const, views: [{ id: 'v1', type: 'screen' as const, title: 'Board', screen: 's1' }] }
const board = (n: number): HostBoardEntry => ({ kind: 'host-board', id: `hb${n}`, label: `Board ${n}`,
  requirement: { name: `board-${n}`, resource: 'inferops-board', target: `inferops://acme.ops/project/board/K${n}` } })
const widgets = (count: number): ConsoleWidgetEntry[] => Array.from({ length: count }, (_, n) =>
  ({ gadgetId: n + 1, blueprintId: 'bp', version: 1, label: `Widget ${n + 1}`, state: 'resettable' }))

describe('consoleContentForSave', () => {
  it('omits unedited saved boards, so the kernel keeps them as they are', () => {
    const content = consoleContentForSave(BASE, [board(1)], undefined)
    expect(content).not.toHaveProperty('hostBoards')
    expect(content.title).toBe('Operations')
  })

  it('sends an edited list in full, an empty one included', () => {
    expect(consoleContentForSave(BASE, [board(1)], []).hostBoards).toEqual([])
    expect(consoleContentForSave(BASE, undefined, [board(2)]).hostBoards).toEqual([board(2)])
  })

  it('counts saved boards toward the combined limit even when they are left out', () => {
    expect(() => consoleContentForSave({ ...BASE, widgets: widgets(MAX_CONSOLE_WIDGETS) }, [board(1)], undefined))
      .toThrow(`at most ${MAX_CONSOLE_WIDGETS} widgets and host boards`)
    expect(consoleContentForSave({ ...BASE, widgets: widgets(MAX_CONSOLE_WIDGETS - 1) }, [board(1)], undefined).widgets)
      .toHaveLength(MAX_CONSOLE_WIDGETS - 1)
  })
})
