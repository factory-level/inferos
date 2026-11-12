// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// FAC-146: a board card's Workflow button steps through InferOps' three workflows, so a service
// board (Enquiry, Quoted, Booked, …) can be shown on a canvas.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { CanvasBoardWorkflow, CanvasProjectBoardWidget, CanvasSection } from '@gadgets/workshop-shared/canvas'
import { CanvasWidgetCard } from './CanvasWidgetCard'

const board = (workflow: CanvasBoardWorkflow): CanvasProjectBoardWidget => ({
  id: 'board', kind: 'inferops.project-board', version: 1, targetRef: 'inferops://grokbot.operations/project/board/JOB',
  size: 'full', params: { workflow, showCompleted: false },
})

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

/** Render a card for `workflow`, press its Workflow button, and answer the workflow it saved. */
async function pressWorkflow(workflow: CanvasBoardWorkflow): Promise<unknown> {
  const widget = board(workflow)
  const section: CanvasSection = { id: 'work', title: 'Work', columns: 2, widgets: [widget] }
  const onEdit = vi.fn<(operations: unknown[]) => Promise<boolean>>(async () => true)
  await act(async () => root.render(<CanvasWidgetCard widget={widget} section={section} index={0} busy={false} gadgets={new Map()}
    overseer={{} as RpcStub<Overseer>} onEdit={onEdit} />))
  const button = [...container.querySelectorAll('button')].find(b => b.textContent === `Workflow: ${workflow}`)
  expect(button, `a "Workflow: ${workflow}" button`).toBeDefined()
  await act(async () => button!.click())
  expect(onEdit).toHaveBeenCalledTimes(1)
  const [operation] = onEdit.mock.calls[0]![0] as [{ type: string; widget: CanvasProjectBoardWidget }]
  expect(operation.type).toBe('configureWidget')
  return operation.widget.params.workflow
}

it('offers service after content, and software after service', async () => {
  expect(await pressWorkflow('software')).toBe('content')
  expect(await pressWorkflow('content')).toBe('service')
  expect(await pressWorkflow('service')).toBe('software')
})
