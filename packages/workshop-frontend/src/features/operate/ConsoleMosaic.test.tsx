// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WorkspaceScreensState } from '../../pages/inferops-canvas/useWorkspaceScreens'
import { ConsoleMosaic } from './ConsoleMosaic'
import type { ConsoleEntry } from './consoles'

let root: Root
let container: HTMLDivElement
const onOpen = vi.fn<(entry: ConsoleEntry) => void>()
const onEdit = vi.fn<(entry: ConsoleEntry) => void>()
const screens = (count: number): WorkspaceScreensState => ({ status: 'ready', workspaces: [{
  workspace: { id: 'workspace', title: 'Operations' } as ConsoleEntry['workspace'], screens: [], flows: [],
  consoles: Array.from({ length: count }, (_, index) => ({ id: `c${index}`, title: `Console ${index + 1}`, revision: '0', fullChat: 'default',
    views: [{ id: 'main', title: 'Main', type: 'screen', screen: 'screen' }] })),
}] })
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  onOpen.mockClear(); onEdit.mockClear()
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })
const render = (count: number, highlighted?: string) => act(() => root.render(
  <ConsoleMosaic screens={screens(count)} onOpen={onOpen} onEdit={onEdit} highlighted={highlighted} />))
const button = (label: string) => [...container.querySelectorAll('button')].find(item => (item.getAttribute('aria-label') ?? item.textContent) === label)!

it('shows only real cards, with eight consoles per page and no placeholders', () => {
  render(0)
  expect(container.querySelectorAll('li')).toHaveLength(0)
  expect(container.textContent).toContain('Your consoles live here')
  render(1)
  expect(container.querySelectorAll('li')).toHaveLength(1)
  render(8)
  expect(container.querySelectorAll('li')).toHaveLength(8)
  expect(container.querySelector('nav')).toBeNull()
  render(9)
  expect(container.querySelectorAll('li')).toHaveLength(8)
  act(() => button('Next').click())
  expect(container.querySelectorAll('li')).toHaveLength(1)
  expect(button('Open Console 9')).toBeDefined()
  expect(button('Next').disabled).toBe(true)
  act(() => button('Previous').click())
  expect(button('Open Console 1')).toBeDefined()
})

it('opens and edits independently, and lands on the saved console’s page', () => {
  render(9, 'c8')
  act(() => button('Edit Console 9').click())
  expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ console: expect.objectContaining({ id: 'c8' }) }))
  expect(onOpen).not.toHaveBeenCalled()
  act(() => button('Open Console 9').click())
  expect(onOpen).toHaveBeenCalledOnce()
})

it('opens a console shared for use but offers no edit', () => {
  const shared = screens(1)
  if (shared.status !== 'ready') throw new Error('unreachable')
  const workspaces = [{ ...shared.workspaces[0]!, screens: null, workspace: { id: 'workspace', title: 'Operations', role: 'use' } as ConsoleEntry['workspace'] }]
  act(() => root.render(<ConsoleMosaic screens={{ status: 'ready', workspaces }} onOpen={onOpen} onEdit={onEdit} />))
  expect(button('Edit Console 1')).toBeUndefined()
  act(() => button('Open Console 1').click())
  expect(onOpen).toHaveBeenCalledOnce()
})
