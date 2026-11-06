// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { WorkspaceConfiguration, WorkspaceSettings } from '@gadgets/workshop-shared/workspace-settings'
import { WorkspaceSettingsEditor } from './WorkspaceSettingsEditor'

// FAC-95: the workspace's settings in the builder. The kernel is a
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

function workspaceKernel(initial: WorkspaceConfiguration, refuse?: string) {
  let current = initial
  const setWorkspaceConfiguration = vi.fn<(revision: string, settings: WorkspaceSettings) => Promise<WorkspaceConfiguration>>(async (revision, settings) => {
    if (refuse) throw new Error(refuse)
    if (revision !== current.revision) throw new Error('changed')
    current = { revision: String(Number(revision) + 1), settings }
    return current
  })
  const overseer = { getWorkspaceConfiguration: async () => current, setWorkspaceConfiguration } as unknown as RpcStub<Overseer>
  return { overseer, setWorkspaceConfiguration }
}

it('saves the workspace’s settings as one change at the revision it read', async () => {
  const k = workspaceKernel({ revision: '3', settings: { 'chatPane.widgets': 'none' } })
  await act(async () => root.render(<WorkspaceSettingsEditor overseer={k.overseer} />)); await settle()
  expect(container.textContent).toContain('No setting grants access to data or actions.')
  await choose('Widget alerts', 'On')
  await act(async () => button('Save workspace settings')!.click()); await settle()
  expect(k.setWorkspaceConfiguration).toHaveBeenCalledWith('3', { 'chatPane.widgets': 'none', 'baseUi.alerts': true })
  await choose('Chat pane widgets', 'Default (The console’s widgets)')
  await act(async () => button('Save workspace settings')!.click()); await settle()
  expect(k.setWorkspaceConfiguration).toHaveBeenLastCalledWith('4', { 'baseUi.alerts': true })
})

it('shows a refused save in the server’s words, keeping the choice, and offers to reload', async () => {
  const refusal = "You don't have permission to share or publish configuration other people use."
  const k = workspaceKernel({ revision: '0', settings: {} }, refusal)
  await act(async () => root.render(<WorkspaceSettingsEditor overseer={k.overseer} />)); await settle()
  await choose('Widget notifications', 'On')
  await act(async () => button('Save workspace settings')!.click()); await settle()
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(refusal)
  expect(button('Reload settings')).toBeDefined()
  expect(button('Save workspace settings')?.disabled).toBe(false)
})
