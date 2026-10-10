// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ConsoleEntry } from './consoles'
import { ConsoleWidgetActions } from './ConsoleWidgetActions'

const ENTRY = { workspace: { id: 'ws1' }, screens: [], publishedScreens: [], console: { id: 'c1', revision: '1', title: 'Ops', fullChat: 'available',
  views: [{ id: 'v1', type: 'screen', title: 'Board', screen: 's1' }],
  hostBoards: [{ kind: 'host-board', id: 'hb1', label: 'Team board', requirement: { name: 'a', resource: 'inferops-board', target: 'inferops://acme.ops/project/board/A' } }],
  boundViews: [{ kind: 'bound-view', id: 'bv1', gadgetId: 3, blueprintId: 'bp', version: 1, label: 'Triage view', requirements: ['a'] },
    { kind: 'bound-view', gadgetId: 4, blueprintId: 'bp', version: 1, label: 'Unsaved view', requirements: ['a'] }] } } as unknown as ConsoleEntry

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('PointerEvent', MouseEvent)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); document.body.replaceChildren(); vi.unstubAllGlobals() })

const open = async (props: Partial<Parameters<typeof ConsoleWidgetActions>[0]>) => {
  await act(async () => root.render(<ConsoleWidgetActions entry={ENTRY} onOpen={() => {}} {...props} />))
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open a widget"]')!.click())
}
const section = (name: string) => document.querySelector(`section[aria-label="${name}"]`)

it('lists the console\'s saved bound views under Views and opens one', async () => {
  const onOpenBoundView = vi.fn<(entryId: string) => void>()
  await open({ onOpenBoundView, onOpenHostBoard: () => {} })
  expect(section('Boards')?.textContent).toContain('Team board')
  expect(section('Views')?.textContent).toBe('ViewsTriage view')
  await act(async () => [...section('Views')!.querySelectorAll('button')][0].click())
  expect(onOpenBoundView).toHaveBeenCalledWith('bv1')
})

it('shows no Views section while bound views are off', async () => {
  await open({ onOpenHostBoard: () => {} })
  expect(section('Views')).toBeNull()
  expect(document.body.textContent).not.toContain('Triage view')
})
