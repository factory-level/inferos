// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WorkspaceScreensState } from '../../pages/inferops-canvas/useWorkspaceScreens'
import { ConsoleMosaic } from './ConsoleMosaic'
import type { CanvasDefinition } from '@gadgets/workshop-shared/canvas'
import type { ConsoleSource, OperateConsoleContent } from '@gadgets/workshop-shared/operate-console'
import type { ConsoleEntry } from './consoles'

let root: Root
let container: HTMLDivElement
const onOpen = vi.fn<(entry: ConsoleEntry, source: ConsoleSource) => void>()
const onEdit = vi.fn<(entry: ConsoleEntry) => void>()
const onPublish = vi.fn<(entry: ConsoleEntry) => void>()
const screens = (count: number): WorkspaceScreensState => ({ status: 'ready', workspaces: [{
  workspace: { id: 'workspace', title: 'Operations' } as ConsoleEntry['workspace'], screens: [], flows: [], publishedScreens: {},
  consoles: Array.from({ length: count }, (_, index) => {
    const content: OperateConsoleContent = { title: `Console ${index + 1}`, fullChat: 'default', views: [{ id: 'main', title: 'Main', type: 'screen', screen: 'screen' }] }
    return { ...content, id: `c${index}`, revision: '0', published: { revision: '0', publishedAt: '2026-10-06T00:00:00.000Z', content } }
  }),
}] })
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  onOpen.mockClear(); onEdit.mockClear(); onPublish.mockClear()
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })
const render = (count: number, highlighted?: string) => act(() => root.render(
  <ConsoleMosaic screens={screens(count)} onOpen={onOpen} onEdit={onEdit} onPublish={onPublish} highlighted={highlighted} />))
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
  act(() => root.render(<ConsoleMosaic screens={{ status: 'ready', workspaces }} onOpen={onOpen} onEdit={onEdit} onPublish={onPublish} />))
  expect(button('Edit Console 1')).toBeUndefined()
  expect(button('Publish Console 1')).toBeUndefined()
  expect(container.textContent).not.toContain('Draft')
  act(() => button('Open Console 1').click())
  expect(onOpen).toHaveBeenCalledWith(expect.anything(), 'published')
})

it('shows a builder each console\'s publication status, with preview and publish where it has a draft to publish', () => {
  const board: CanvasDefinition = { schemaVersion: 1, id: 'screen', title: 'Board', revision: '3', sections: [] }
  const main: OperateConsoleContent = { title: 'Main', fullChat: 'default', views: [{ id: 'main', title: 'Main', type: 'screen', screen: 'screen' }] }
  const published = (revision: string) => ({ revision, publishedAt: '2026-10-06T00:00:00.000Z', content: main })
  const render3 = (screenRevision: string) => act(() => root.render(<ConsoleMosaic onOpen={onOpen} onEdit={onEdit} onPublish={onPublish} screens={{ status: 'ready', workspaces: [{
    workspace: { id: 'workspace', title: 'Operations', role: 'build' } as ConsoleEntry['workspace'], flows: [],
    screens: [{ ...board, revision: screenRevision }], publishedScreens: { c1: [board], c2: [board] },
    consoles: [
      { ...main, id: 'c0', title: 'New', revision: '0', published: null },
      { ...main, id: 'c1', title: 'Edited', revision: '4', published: published('3') },
      { ...main, id: 'c2', title: 'Live', revision: '3', published: published('3') },
    ],
  }] }} />))
  render3('3')
  const tile = (title: string) => [...container.querySelectorAll('li')].find(item => item.textContent?.includes(title))!.textContent
  expect(tile('New')).toContain('Draft')
  expect(tile('Edited')).toContain('Unpublished changes')
  expect(tile('Live')).toContain('Published')
  expect(button('Publish Live')).toBeUndefined()

  // A console never published opens only as a preview of its draft.
  act(() => button('Preview New').click())
  expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ console: expect.objectContaining({ id: 'c0' }) }), 'draft')
  act(() => button('Open Edited').click())
  expect(onOpen).toHaveBeenLastCalledWith(expect.anything(), 'published')
  act(() => button('Preview the draft of Edited').click())
  expect(onOpen).toHaveBeenLastCalledWith(expect.anything(), 'draft')
  act(() => button('Publish Edited').click())
  expect(onPublish).toHaveBeenCalledWith(expect.objectContaining({ console: expect.objectContaining({ id: 'c1' }) }))

  // A screen edited since it was published is an unpublished change too.
  render3('4')
  expect(tile('Live')).toContain('Unpublished changes')
  expect(button('Publish Live')).toBeDefined()
})
