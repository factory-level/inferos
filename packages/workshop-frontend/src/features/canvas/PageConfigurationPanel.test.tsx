// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { WorkspaceSettings } from '@gadgets/workshop-shared/workspace-settings'
import { PageConfigurationPanel } from './PageConfigurationPanel'
import { parseCanvasPage, type CanvasPageOperation } from '@gadgets/workshop-shared/canvas-model'
import { traceConfiguration } from '@gadgets/workshop-shared/configuration-trace'

// FAC-95: one page's configuration in the builder: each setting's owner, overrides, and hooks traced. The kernel is a
// stand-in; what it answers is what the real one answers for these inputs.
let root: Root
let container: HTMLDivElement
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
const button = (name: string) => [...container.querySelectorAll('button')].find(item => item.textContent === name)
const choose = async (label: string, option: string) => {
  const field = [...container.querySelectorAll<HTMLElement>('[role="combobox"]')].find(item => item.closest('label, div')?.textContent?.includes(label))
  if (!field) throw new Error(`No select ${label}`)
  await act(async () => field.click()); await settle()
  const item = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(entry => entry.textContent === option)
  if (!item) throw new Error(`No option ${option}`)
  if (!('PointerEvent' in window)) Object.defineProperty(window, 'PointerEvent', { value: class extends MouseEvent {} })
  await act(async () => {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      item.dispatchEvent(new (type.startsWith('pointer') ? window.PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true }))
    }
  })
  await settle()
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

function pageKernel(workspace: WorkspaceSettings, pageSettings?: WorkspaceSettings) {
  const page = parseCanvasPage({ schemaVersion: 2, id: 'p', revision: '2', title: 'P', children: ['a'],
    ...(pageSettings ? { settings: pageSettings } : {}),
    attachments: [],
    nodes: [
      { nodeType: 'object', id: 'a', title: 'A', columns: 1, children: ['b'], attachments: [] },
      { nodeType: 'widget', id: 'b', kind: 'inferops.project-board', version: 1, targetRef: 'inferops://acme.operations/project/board/ENG',
        size: 'normal', params: { workflow: 'software', showCompleted: false },
        attachments: [{ id: 'go', version: 1, on: 'action-completed', effect: { kind: 'navigate', page: 'q' } }] },
    ] })
  const hooks = [{ hookId: 3, title: 'Issue moved', enabled: true, gatekeeperId: 7, gadgetId: 1, pinned: { definitionId: 'wf', revision: 2 } }]
  const overseer = { traceConfiguration: async () => traceConfiguration(workspace, page, hooks) } as unknown as RpcStub<Overseer>
  const onEdit = vi.fn<(operations: CanvasPageOperation[]) => Promise<boolean>>(async () => true)
  return { page, overseer, onEdit }
}

it('tells a workspace setting, a page override and a default apart, and traces each hook to its owner', async () => {
  const k = pageKernel({ 'chatPane.widgets': 'none' }, { 'baseUi.alerts': true })
  await act(async () => root.render(<PageConfigurationPanel overseer={k.overseer} page={k.page} busy={false} onEdit={k.onEdit} />)); await settle()
  const rows = [...container.querySelectorAll('[aria-label="Settings"] > li')].map(row => row.textContent ?? '')
  expect(rows[0]).toContain('Widget alertsOnOverridden on this page')
  expect(rows[1]).toContain('Widget notificationsOffDefault')
  expect(rows[2]).toContain('Chat pane widgetsNoneWorkspace setting')
  const hooks = container.querySelector('[aria-label="Page hooks"]')!.textContent ?? ''
  expect(hooks).toContain('held by page:p/node:b')
  expect(hooks).toContain("Moves the person's own page to q. It grants nothing.")
  const workspaceHooks = container.querySelector('[aria-label="Workspace hooks"]')!.textContent ?? ''
  expect(workspaceHooks).toContain('Issue moved: gatekeeper 7, gadget 1, workflow wf revision 2')
  expect(workspaceHooks).toContain('Read-only here.')
})

it('overrides a setting on this page, and resets it to the workspace’s, each as one page edit', async () => {
  const k = pageKernel({}, { 'baseUi.alerts': true })
  await act(async () => root.render(<PageConfigurationPanel overseer={k.overseer} page={k.page} busy={false} onEdit={k.onEdit} />)); await settle()
  await choose('Override Chat pane widgets on this page', 'None')
  expect(k.onEdit).toHaveBeenLastCalledWith([{ type: 'setSettings', settings: { 'baseUi.alerts': true, 'chatPane.widgets': 'none' } }])
  await act(async () => button('Reset to workspace')!.click())
  expect(k.onEdit).toHaveBeenLastCalledWith([{ type: 'setSettings', settings: {} }])
})

it('says so when the trace can’t be read, never showing an empty configuration', async () => {
  const overseer = { traceConfiguration: async () => { throw new Error('Canvas not found') } } as unknown as RpcStub<Overseer>
  const { page, onEdit } = pageKernel({})
  await act(async () => root.render(<PageConfigurationPanel overseer={overseer} page={page} busy={false} onEdit={onEdit} />)); await settle()
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Canvas not found')
  expect(container.querySelector('[aria-label="Settings"]')).toBeNull()
})
