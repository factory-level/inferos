// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GadgetSummary, WorkpieceId } from '@gadgets/workshop-shared/api'
import type { CanvasDefinition } from '@gadgets/workshop-shared/canvas'
import { ConsoleRollup } from './ConsoleRollup'

const BOARD: CanvasDefinition = {
  schemaVersion: 1, id: 'board', revision: '0', title: 'Board',
  sections: [{ id: 'main', title: 'Main', columns: 2, widgets: [
    { id: 'w1', kind: 'inferops.project-board', version: 1, targetRef: 'inferops://demo.local/project/board/DEMO',
      size: 'full', params: { workflow: 'software', showCompleted: false } },
    { id: 'w2', kind: 'inferos.gadget', version: 1, targetRef: 'gadget:7', size: 'normal', params: {} },
  ] }],
}
const EMPTY: CanvasDefinition = { schemaVersion: 1, id: 'empty', revision: '0', title: 'Notes', sections: [] }
const gadgets = new Map<WorkpieceId, GadgetSummary>([[7, { id: 7, type: 'gadget', title: 'Shift summary' } as GadgetSummary]])

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

it('lists what each screen shows and opens a screen from its tile', () => {
  const onShowScreen = vi.fn<(screenId: string) => void>()
  act(() => root.render(<ConsoleRollup screenIds={['board', 'empty', 'gone']} screens={[BOARD, EMPTY]}
    gadgets={gadgets} onShowScreen={onShowScreen} />))

  const items = [...container.querySelectorAll('[aria-label="On Board"] > span')].map(item => item.textContent)
  expect(items).toEqual(['Board DEMOWidget', 'Shift summaryGadget'])
  expect(container.textContent).toContain('Nothing on this screen yet.')
  // A screen that is gone keeps its place, and can't be opened.
  expect(container.querySelectorAll('li')).toHaveLength(3)
  expect(container.querySelectorAll('li')[2].textContent).toBe('This screen is unavailable.')
  expect(container.querySelectorAll('li')[2].querySelector('button')).toBeNull()

  act(() => container.querySelector<HTMLButtonElement>('li button')!.click())
  expect(onShowScreen).toHaveBeenCalledWith('board')
})
