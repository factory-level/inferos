// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GadgetSummary } from '@gadgets/workshop-shared/api'
import type { ConsoleWidgetEntry } from '@gadgets/workshop-shared/operate-console'
import { ConsoleWidgetRegistry } from './ConsoleWidgetRegistry'

let container: HTMLDivElement
let root: Root
const change = vi.fn<(widgets: ConsoleWidgetEntry[]) => void>()
const install = (id: number, title: string, version: number): GadgetSummary =>
  ({ id, type: 'gadget', title, commitId: `c${id}`, installedFrom: { blueprintId: `bp${id}`, version, kind: 'widget' } })
const registered: ConsoleWidgetEntry = { gadgetId: 3, blueprintId: 'bp3', version: 2, label: 'Status', state: 'resettable' }

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('PointerEvent', MouseEvent)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  change.mockClear()
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

const render = (widgets: ConsoleWidgetEntry[], published?: ConsoleWidgetEntry[], disabled = false) => act(() => root.render(
  <ConsoleWidgetRegistry widgets={widgets} published={published} candidates={[install(3, 'Status', 2), install(5, 'Queue', 1)]}
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
