// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ConsoleEntry } from './consoles'

const testState = vi.hoisted(() => ({
  publishConsole: vi.fn<(id: string, revision: string) => Promise<unknown>>(),
  invalidate: vi.fn<() => void>(),
}))
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: {} }) }))
vi.mock('../../useWorkspaceOpen', () => ({ useWorkspaceOpen: () => ({
  overseer: { stub: { publishConsole: testState.publishConsole } }, metadata: { id: 'w1', role: 'build' }, error: null,
}) }))
vi.mock('../../pages/inferops-canvas/useWorkspaceScreens', () => ({ invalidateWorkspaceScreens: testState.invalidate }))

import { ConsolePublishDialog } from './ConsolePublishDialog'

const entry: ConsoleEntry = { workspace: { id: 'w1', title: 'Intake desk' } as never, screens: [], publishedScreens: [], console: {
  id: 'c1', revision: '3', published: null, title: 'Intake console', fullChat: 'off',
  views: [{ id: 'intake', title: 'Intake', type: 'screen', screen: 's1' }], flows: ['f1'],
} }
let root: Root
let container: HTMLDivElement
const onClose = vi.fn<() => void>()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  testState.publishConsole.mockReset(); testState.invalidate.mockClear(); onClose.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const render = () => act(() => root.render(<ConsolePublishDialog entry={entry} onClose={onClose} />))
const publish = () => act(async () => {
  [...document.querySelectorAll('button')].find(button => button.textContent === 'Publish')!.click()
})
const alertText = () => document.querySelector('[role="alert"]')?.textContent

it('D-1: says that publishing freezes the console with its screens and flows', () => {
  render()
  expect(document.body.textContent).toContain('Operators will use this version, its screens and its flows as they are now.')
})

it("D-2: shows the kernel's own refusal about a console flow, and stays open", async () => {
  const refusal = 'Console flow "Intake" has step notes-id, which the console does not show'
  testState.publishConsole.mockRejectedValueOnce(new Error(refusal))
  render()
  await publish()
  expect(testState.publishConsole).toHaveBeenCalledWith('c1', '3')
  expect(alertText()).toBe(refusal)
  expect(onClose).not.toHaveBeenCalled()
})

it('D-3: shows the generic message for any other refusal', async () => {
  testState.publishConsole.mockRejectedValueOnce(new Error('Internal detail 1234'))
  render()
  await publish()
  expect(alertText()).toContain('Could not publish this console.')
  expect(document.body.textContent).not.toContain('Internal detail 1234')
  expect(onClose).not.toHaveBeenCalled()
})
