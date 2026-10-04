// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { OperateConsoleContent } from '@gadgets/workshop-shared/operate-console'
import type { ConsoleEntry } from './consoles'

const state = vi.hoisted(() => ({
  denied: false,
  replace: vi.fn<(id: string, revision: string, content: OperateConsoleContent) => Promise<void>>(),
  invalidate: vi.fn<() => void>(),
}))
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: {} }) }))
vi.mock('../../useWorkspaceOpen', () => ({ useWorkspaceOpen: () => ({
  overseer: { stub: { replaceConsole: state.replace } }, metadata: { role: state.denied ? 'use' : 'build' },
}) }))
vi.mock('../../pages/inferops-canvas/useWorkspaceScreens', () => ({ invalidateWorkspaceScreens: state.invalidate }))
import { ConsoleSettings } from './ConsoleSettings'

const entry: ConsoleEntry = { workspace: { id: 'w1', title: 'Operations', created: new Date(), lastActive: new Date() }, screens: [], console: {
  id: 'c1', revision: '3', title: 'Operations', fullChat: 'default',
  views: [{ id: 'v1', type: 'screen', title: 'Board', screen: 's1' }],
} }
let container: HTMLDivElement
let root: Root
const close = vi.fn<() => void>()
const edit = vi.fn<() => void>()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('PointerEvent', MouseEvent)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  state.denied = false; state.replace.mockReset().mockResolvedValue(); state.invalidate.mockClear(); close.mockClear(); edit.mockClear()
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })
const render = () => act(() => root.render(<ConsoleSettings entry={entry} onClose={close} onEdit={edit} />))
const save = () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Save settings')!

it('defaults old consoles to opt-out and persists four independent flags without copying pages', async () => {
  render()
  const checkboxes = [...container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')]
  expect(checkboxes).toHaveLength(4)
  expect(checkboxes.every(checkbox => checkbox.getAttribute('aria-checked') === 'false')).toBe(true)
  act(() => checkboxes[0].click())
  act(() => checkboxes[2].click())
  await act(async () => save().click())
  expect(state.replace).toHaveBeenCalledWith('c1', '3', expect.objectContaining({
    views: entry.console.views, customization: { screens: true, widgets: false, tools: true, skills: false },
  }))
  expect(close).toHaveBeenCalledOnce()
  expect(state.invalidate).toHaveBeenCalledOnce()
})

it('keeps choices after a revision conflict', async () => {
  state.replace.mockRejectedValue(new Error('Conflict'))
  render()
  const checkbox = container.querySelector<HTMLButtonElement>('[role="checkbox"]')!
  act(() => checkbox.click())
  await act(async () => save().click())
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Your choices are still here')
  expect(checkbox.getAttribute('aria-checked')).toBe('true')
  expect(close).not.toHaveBeenCalled()
})

it('does not offer policy or configuration writes to use-role viewers', () => {
  state.denied = true
  render()
  expect(save()).toBeUndefined()
  expect(container.querySelector('a')).toBeNull()
  expect([...container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')].every(checkbox => checkbox.getAttribute('aria-disabled') === 'true' || checkbox.disabled)).toBe(true)
  expect(state.replace).not.toHaveBeenCalled()
})
