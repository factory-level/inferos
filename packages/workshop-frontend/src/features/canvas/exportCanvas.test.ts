import { beforeEach, expect, it, vi } from 'vitest'
import { parseCanvasDefinition, type CanvasDefinition } from '@gadgets/workshop-shared/canvas'
import { saveTextToFile } from '../../fileTransfers'
import { exportCanvas } from './exportCanvas'

vi.mock('../../fileTransfers', () => ({ saveTextToFile: vi.fn<(name: string, text: string) => void>() }))
beforeEach(() => vi.clearAllMocks())
const definition = (): CanvasDefinition => ({ schemaVersion: 1, id: 'view-1', revision: '7', title: 'Dispatch', sections: [{
  id: 'section-1', title: 'Work', columns: 2, widgets: [{ id: 'widget-1', kind: 'inferops.project-board', version: 1,
    targetRef: 'inferops://demo.local/project/board/DEMO', size: 'wide', params: { workflow: 'software', showCompleted: false } }],
}] })

it('exports a definition that can be imported unchanged, preserving layout and references', () => {
  const view = definition()
  exportCanvas(view)
  expect(saveTextToFile).toHaveBeenCalledOnce()
  const [filename, content] = vi.mocked(saveTextToFile).mock.calls[0]
  expect(filename).toBe('canvas-view-1.json')
  expect(parseCanvasDefinition(JSON.parse(content))).toEqual(view)
})

it('refuses unknown authority or data fields before writing a download', () => {
  for (const field of ['credentials', 'ownerId', 'sharing', 'rows']) {
    expect(() => exportCanvas(Object.assign(definition(), { [field]: 'must-not-export' }))).toThrow(/Invalid canvas/)
  }
  expect(saveTextToFile).not.toHaveBeenCalled()
})
