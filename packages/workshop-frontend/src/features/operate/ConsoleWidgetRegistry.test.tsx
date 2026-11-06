// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ConsoleWidgetEntry } from '@gadgets/workshop-shared/operate-console'
import { ConsoleWidgetRegistry, type WidgetCandidates } from './ConsoleWidgetRegistry'
import { setFieldValue } from '../canvas/kumoPopupDoubles'

let container: HTMLDivElement
let root: Root
const change = vi.fn<(widgets: ConsoleWidgetEntry[]) => void>()
const install = (id: number, title: string, version: number, more: { refusal?: string; tools?: string[] } = {}) => ({
  gadgetId: id, title, blueprintId: `bp${id}`, version, versionId: `bp${id}@${version}`, commitId: `c${id}0000000000`,
  surfaces: more.refusal ? null : { ui: true, tools: more.tools ?? [], states: null }, refusal: more.refusal ?? null })
const ready = (...list: ReturnType<typeof install>[]): WidgetCandidates => ({ state: 'ready', list })
const registered: ConsoleWidgetEntry = { gadgetId: 3, blueprintId: 'bp3', version: 2, label: 'Status', state: 'resettable' }

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('PointerEvent', MouseEvent)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  change.mockClear()
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

const render = (widgets: ConsoleWidgetEntry[], published?: ConsoleWidgetEntry[], disabled = false,
    candidates: WidgetCandidates = ready(install(3, 'Status', 2), install(5, 'Queue', 1))) => act(() => root.render(
  <ConsoleWidgetRegistry widgets={widgets} published={published} candidates={candidates}
    disabled={disabled} onChange={change} />))
const button = (text: string) => [...container.querySelectorAll('button')].find(item => item.textContent === text)

it('says which registered widgets operators already have, and removes one from the draft', () => {
  render([registered], [{ ...registered, gadgetId: 40, frozen: { sourceGadgetId: 3, commitId: 'c3' } }])
  expect(container.querySelector('[aria-label="Registered widgets"]')?.textContent).toContain('Version 2 · Published')
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Remove Status"]')!.click())
  expect(change).toHaveBeenCalledWith([])
})

it('marks a registered widget unpublished until the console is published with it', () => {
  render([registered], [])
  expect(container.textContent).toContain('Version 2 · Not yet published')
})

it('matches draft entries by their source install and published ones by their frozen install', () => {
  const frozen = { ...registered, gadgetId: 40, frozen: { sourceGadgetId: 3, commitId: 'c3' } }
  const status = () => [...container.querySelectorAll('[aria-label="Registered widgets"] li')].map(item => item.textContent)
  // The use role reads the published registry, whose entries name their frozen installs.
  render([frozen], [frozen], true)
  expect(status()).toEqual([expect.stringContaining('Version 2 · Published')])
  // A frozen install no longer current, as a stale view would hold, is not the published one.
  render([{ ...frozen, gadgetId: 39 }], [frozen], true)
  expect(status()).toEqual([expect.stringContaining('Not yet published')])
  // In a draft: a new version, a renamed entry and another blueprint's install are not yet published.
  render([{ ...registered, version: 3 }, { ...registered, gadgetId: 3, label: 'Renamed' }], [frozen])
  expect(status()).toEqual([expect.stringContaining('Version 3 · Not yet published'), expect.stringContaining('Not yet published')])
  render([{ ...registered, blueprintId: 'other' }], [frozen])
  expect(status()).toEqual([expect.stringContaining('Not yet published')])
  // A draft entry never matches a published entry by the frozen install's own id.
  render([{ ...registered, gadgetId: 40 }], [frozen])
  expect(status()).toEqual([expect.stringContaining('Not yet published')])
})

it('registers only after the builder declares the widget\'s state resettable', () => {
  render([registered])
  expect(button('Register widget')?.disabled).toBe(true)
  // The already-registered install is not offered again.
  expect(container.textContent).not.toContain('Status (version 2)')
  const checkbox = container.querySelector<HTMLButtonElement>('[role="checkbox"]')!
  act(() => checkbox.click())
  expect(button('Register widget')?.disabled).toBe(true)
})

it('offers nothing to edit when the viewer cannot write the console', () => {
  render([registered], undefined, true)
  expect(button('Register widget')).toBeUndefined()
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Remove Status"]')?.disabled).toBe(true)
})

it('offers only the installs a console can offer, and says why the others are not', () => {
  render([], undefined, false, ready(install(5, 'Queue', 1),
    install(7, 'Durable', 1, { refusal: 'Gadget 7 declares a data contract, so its state is not resettable.' })))
  const select = container.querySelector('[role="combobox"]')!
  act(() => (select as HTMLElement).click())
  const options = [...document.querySelectorAll('[role="option"]')].map(option => option.textContent)
  expect(options).toEqual([expect.stringContaining('Queue')])
  const unusable = container.querySelector('[aria-label="Widget installs a console cannot offer"]')!
  expect(unusable.textContent).toContain('Durable')
  expect(unusable.textContent).toContain('declares a data contract')
})

it('shows each registered widget\'s stable version, the commit it runs and what it offers', () => {
  render([registered], [{ ...registered, gadgetId: 40, frozen: { sourceGadgetId: 3, commitId: 'f00dfeed99', ui: true } }], false,
    ready(install(3, 'Status', 2, { tools: ['count'] })))
  const shown = container.querySelector('[aria-label="Registered widgets"]')!.textContent
  expect(shown).toContain('bp3@2')
  expect(shown).toContain('at c300000')
  expect(shown).toContain('UI')
  expect(shown).toContain('Tools: count')
  expect(shown).toContain('Operators run f00dfee')
})

it('warns when a registered install can no longer be offered', () => {
  render([registered], undefined, false,
    ready(install(3, 'Status', 2, { refusal: 'Gadget 3 has bindings; a console offers only widgets with none.' })))
  const row = container.querySelector('[aria-label="Registered widgets"] li')!
  expect(row.textContent).toContain('Can\'t be offered')
  expect(row.textContent).toContain('has bindings')
})

it('offers nothing to register while installs are being checked, or when the check failed', () => {
  render([], undefined, false, { state: 'loading' })
  expect(container.textContent).toContain('Checking widget installs')
  expect(button('Register widget')?.disabled).toBe(true)
  render([], undefined, false, { state: 'error' })
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not check')
  expect(button('Register widget')?.disabled).toBe(true)
})

it('says a registered widget whose install is gone, or is no longer a widget, can\'t be offered', () => {
  // The kernel lists only current widget installs, so the registered install 3 is absent.
  render([registered], undefined, false, ready(install(5, 'Queue', 1)))
  const row = container.querySelector('[aria-label="Registered widgets"] li')!
  expect(row.textContent).toContain('Can\'t be offered')
  expect(row.textContent).toContain('no longer installed')
  // Still installed, but now at another version than the one registered: a save refuses that too.
  render([registered], undefined, false, ready(install(3, 'Status', 3)))
  expect(container.querySelector('[aria-label="Registered widgets"] li')!.textContent).toContain('now runs bp3@3, not bp3@2')
  // While the kernel's answer is still loading, nothing is claimed either way.
  render([registered], undefined, false, { state: 'loading' })
  expect(container.querySelector('[aria-label="Registered widgets"] li')!.textContent).not.toContain('Can\'t be offered')
})

// FAC-8: one authored widget version, installed twice, is placed as two independent instances.
it('registers two installs of one widget version as separate entries, each offering only what the kernel declares', () => {
  const north = { ...install(7, 'Status board', 1, { tools: ['count'] }), blueprintId: 'bp-authored', versionId: 'bp-authored@1' }
  const south = { ...install(8, 'Status board', 1), blueprintId: 'bp-authored', versionId: 'bp-authored@1' }
  const first: ConsoleWidgetEntry = { gadgetId: 7, blueprintId: 'bp-authored', version: 1, label: 'North desk', state: 'resettable' }
  render([first], undefined, false, ready(north, south))

  act(() => (container.querySelector('[role="combobox"]') as HTMLElement).click())
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
  expect(option.map(item => item.textContent)).toEqual([expect.stringContaining('Status board (version 1)')])
  act(() => option[0]!.click())
  const name = [...container.querySelectorAll('label')].find(item => item.textContent === 'Name operators see')!
  act(() => setFieldValue(document.getElementById(name.htmlFor) as HTMLInputElement, 'South desk'))
  act(() => container.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click())
  act(() => button('Register widget')!.click())
  expect(change).toHaveBeenCalledWith([first,
    { gadgetId: 8, blueprintId: 'bp-authored', version: 1, label: 'South desk', state: 'resettable' }])

  render(change.mock.calls[0]![0], undefined, false, ready(north, south))
  const rows = [...container.querySelectorAll('[aria-label="Registered widgets"] li')].map(item => item.textContent ?? '')
  expect(rows[0]).toContain('North desk')
  expect(rows[0]).toContain('Tools: count')
  expect(rows[1]).toContain('South desk')
  expect(rows[1]).toContain('UI')
  // Nothing the second install's commit doesn't declare is offered for it.
  expect(rows[1]).not.toContain('Tools')
})
