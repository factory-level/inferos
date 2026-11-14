// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ConsoleSummary } from '@gadgets/workshop-shared/api'
import { OwnConsoleTiles } from './OwnConsoleTiles'
import type { MyConsolesState } from './useMyConsoles'

let root: Root
let container: HTMLDivElement
const onOpen = vi.fn<(console: ConsoleSummary) => void>()
const onEdit = vi.fn<(console: ConsoleSummary) => void>()
const summary = (extra: Partial<ConsoleSummary>): ConsoleSummary =>
  ({ id: 'c1', title: 'Dispatch', role: 'build', published: true, created: new Date(0), ...extra })
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  onOpen.mockClear(); onEdit.mockClear()
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })
const render = (consoles: MyConsolesState) => act(() => root.render(<OwnConsoleTiles consoles={consoles} onOpen={onOpen} onEdit={onEdit} />))
const button = (label: string) => [...container.querySelectorAll('button')].find(item => item.getAttribute('aria-label') === label)!

it('shows nothing while loading or with no consoles, and says when listing failed', () => {
  render({ status: 'loading' })
  expect(container.textContent).toBe('')
  render({ status: 'ready', consoles: [] })
  expect(container.textContent).toBe('')
  render({ status: 'error' })
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('could not be loaded')
})

it('opens a published console, and offers editing only to someone who can build it', () => {
  const mine = summary({})
  const shared = summary({ id: 'c2', title: 'Crew lead', role: 'use' })
  render({ status: 'ready', consoles: [mine, shared] })
  act(() => button('Open Dispatch').click())
  expect(onOpen).toHaveBeenCalledWith(mine)
  act(() => button('Edit Dispatch').click())
  expect(onEdit).toHaveBeenCalledWith(mine)
  expect(button('Open Crew lead')).toBeDefined()
  expect(button('Edit Crew lead')).toBeUndefined()
})

it('does not open a console that has no publication yet', () => {
  render({ status: 'ready', consoles: [summary({ published: false })] })
  const tile = button('Dispatch is not published yet')
  expect(tile.disabled).toBe(true)
  act(() => tile.click())
  expect(onOpen).not.toHaveBeenCalled()
  expect(container.textContent).toContain('Not published')
})
