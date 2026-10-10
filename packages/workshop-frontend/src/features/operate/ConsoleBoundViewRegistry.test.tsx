// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GadgetSummary } from '@gadgets/workshop-shared/api'
import { MAX_CONSOLE_WIDGETS, type BoundViewEntry, type HostBoardEntry } from '@gadgets/workshop-shared/operate-console'

// Kumo's Select, as a native select, so a test can choose an install.
vi.mock('@cloudflare/kumo', async importOriginal => {
  const actual = await importOriginal<typeof import('@cloudflare/kumo')>()
  const Select = ({ label, value, disabled, onValueChange, children }: { label: string; value: string; disabled?: boolean; onValueChange: (value: string) => void; children: ReactNode }) =>
    <label>{label}<select aria-label={label} value={value} disabled={disabled} onChange={event => onValueChange(event.target.value)}><option value="">None</option>{children}</select></label>
  Select.Option = ({ value, children }: { value: string; children: ReactNode }) => <option value={value}>{children}</option>
  return { ...actual, Select }
})
import { ConsoleBoundViewRegistry } from './ConsoleBoundViewRegistry'

let container: HTMLDivElement
let root: Root
const change = vi.fn<(views: BoundViewEntry[]) => void>()
const install = (id: number, title: string): GadgetSummary => ({ id, type: 'gadget', title, commitId: `c${id}`, installedFrom: { blueprintId: `bp${id}`, version: 2, kind: 'widget' } })
const board = (name: string): HostBoardEntry => ({ kind: 'host-board', id: `hb-${name}`, label: `Board ${name}`,
  requirement: { name, resource: 'inferops-board', target: `inferops://acme.ops/project/board/${name.toUpperCase()}` } })
const VIEW: BoundViewEntry = { kind: 'bound-view', id: 'bv1', gadgetId: 3, blueprintId: 'bp3', version: 2, label: 'Triage', requirements: ['a'] }

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('PointerEvent', MouseEvent)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  change.mockClear()
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

const render = (props: Partial<Parameters<typeof ConsoleBoundViewRegistry>[0]> = {}) => act(() => root.render(
  <ConsoleBoundViewRegistry boundViews={[VIEW]} published={undefined} candidates={[install(3, 'Triage spec'), install(5, 'Queue spec')]}
    hostBoards={[board('a'), board('b')]} otherCount={2} assistantOnly={false} disabled={false} onChange={change} {...props} />))
const button = (text: string) => [...container.querySelectorAll('button')].find(item => item.textContent === text)

it('lists each view with the boards it reads and whether operators have it, and removes one from the draft', () => {
  render({ published: [VIEW] })
  expect(container.querySelector('[aria-label="Registered views"]')?.textContent).toContain('Reads Board a · Published')
  render({ published: [] })
  expect(container.textContent).toContain('Not yet published')
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Remove Triage"]')!.click())
  expect(change).toHaveBeenCalledWith([])
})

it('registers a widget install with the boards it reads, pinned to its installed version', () => {
  render()
  expect(button('Register view')?.disabled).toBe(true)
  // The registered install is not offered again.
  expect(container.textContent).not.toContain('Triage spec (version 2)')
  const select = container.querySelector('select')!
  act(() => { select.value = '5'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(button('Register view')?.disabled).toBe(true)
  const boards = [...container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')]
  act(() => boards[1].click())
  act(() => button('Register view')!.click())
  expect(change).toHaveBeenCalledWith([VIEW, { kind: 'bound-view', gadgetId: 5, blueprintId: 'bp5', version: 2, label: 'Queue spec', requirements: ['b'] }])
})

it('asks for a board first, offers none on an Assistant-only console, and stops at the shared limit', () => {
  render({ hostBoards: [] })
  expect(container.textContent).toContain('Register a board first')
  render({ assistantOnly: true })
  expect(container.textContent).toContain('This console shows only Assistant, so operators can\'t open views on it.')
  expect(container.textContent).toContain('Unavailable on an Assistant-only console')
  expect(button('Register view')).toBeUndefined()
  render({ otherCount: MAX_CONSOLE_WIDGETS - 1 })
  expect(button('Register view')?.disabled).toBe(true)
  expect(container.textContent).toContain(`at most ${MAX_CONSOLE_WIDGETS} widgets, boards and views`)
})

it('offers nothing to edit when the viewer cannot write the console', () => {
  render({ disabled: true })
  expect(button('Register view')).toBeUndefined()
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Remove Triage"]')?.disabled).toBe(true)
})
