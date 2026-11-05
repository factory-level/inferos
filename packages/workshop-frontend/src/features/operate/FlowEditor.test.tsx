// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasDefinition } from '@gadgets/workshop-shared/canvas'
import type { OperateFlowContent } from '@gadgets/workshop-shared/operate-flow'
import { setFieldValue } from '../canvas/kumoPopupDoubles'

// Kumo's Select, as a native select, so a test can choose a route's destination.
vi.mock('@cloudflare/kumo', async importOriginal => {
  const actual = await importOriginal<typeof import('@cloudflare/kumo')>()
  const Select = ({ label, value, disabled, onValueChange, children }: { label: string; value: string; disabled?: boolean; onValueChange: (value: string) => void; children: ReactNode }) =>
    <label>{label}<select aria-label={label} value={value} disabled={disabled} onChange={event => onValueChange(event.target.value)}><option value="">Choose a page</option>{children}</select></label>
  Select.Option = ({ value, children }: { value: string; children: ReactNode }) => <option value={value}>{children}</option>
  return { ...actual, Select }
})
import { FlowEditor } from './FlowEditor'

const screen = (id: string, title: string): CanvasDefinition =>
  ({ schemaVersion: 1, id, revision: '0', title, sections: [] })
const SCREENS = [screen('intake', 'Intake'), screen('triage', 'Triage'), screen('orders', 'Orders')]

let container: HTMLDivElement
let root: Root
const onSave = vi.fn<(content: OperateFlowContent) => void>()

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('PointerEvent', MouseEvent)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  onSave.mockClear()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const render = (initial: OperateFlowContent) => act(() => root.render(
  <FlowEditor screens={SCREENS} initial={initial} saving={false} error={null} onSave={onSave} onCancel={() => {}} />,
))
const button = (name: string) => {
  const found = [...container.querySelectorAll('button')]
    .find(candidate => (candidate.getAttribute('aria-label') ?? candidate.textContent?.trim()) === name)
  if (!found) throw new Error(`No button named ${name}`)
  return found
}
const steps = () => [...container.querySelectorAll('ol[aria-label="Steps"] > li')]
  .map(item => item.querySelectorAll('span')[1]?.textContent)
const save = () => act(() => container.querySelector('form')!.requestSubmit())

describe('FlowEditor', () => {
  it('saves the screens in the order the author arranged them', () => {
    render({ title: 'Admission', steps: ['intake', 'triage'] })
    act(() => button('+ Orders').click())
    act(() => button('Move step 3 up').click())
    act(() => button('Move step 1 down').click())
    expect(steps()).toEqual(['Orders', 'Intake', 'Triage'])
    save()
    expect(onSave).toHaveBeenCalledWith({ title: 'Admission', steps: ['orders', 'intake', 'triage'] })
  })

  it('lets a screen repeat and a step be removed', () => {
    render({ title: 'Rounds', steps: ['intake'] })
    act(() => button('+ Intake').click())
    act(() => button('+ Triage').click())
    act(() => button('Remove step 1').click())
    save()
    expect(onSave).toHaveBeenCalledWith({ title: 'Rounds', steps: ['intake', 'triage'] })
  })

  it('cannot be saved with no steps, and bounds the first and last step', () => {
    render({ title: 'Empty', steps: [] })
    expect(button('Save flow').disabled).toBe(true)
    act(() => button('+ Intake').click())
    expect(button('Save flow').disabled).toBe(false)
    expect(button('Move step 1 up').disabled).toBe(true)
    expect(button('Move step 1 down').disabled).toBe(true)
  })

  it('names a step whose screen has since been removed', () => {
    render({ title: 'Stale', steps: ['gone', 'intake'] })
    expect(steps()).toEqual(['Removed screen', 'Intake'])
  })
})

const step = (n: number) => container.querySelector<HTMLElement>(`ol[aria-label="Steps"] > li[aria-label="Step ${n}"]`)!
const field = <T extends HTMLInputElement | HTMLSelectElement>(scope: ParentNode, label: string, at = 0): T => {
  const found = [...scope.querySelectorAll('label')].filter(item => item.textContent?.startsWith(label))[at]
  const control = found?.control ?? found?.querySelector('select')
  if (!control) throw new Error(`No field labelled ${label}`)
  return control as T
}
const type = (control: HTMLInputElement | HTMLSelectElement, value: string) => act(() => setFieldValue(control, value))
const branch = () => act(() => container.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click())
const routes = (n: number) => [...step(n).querySelectorAll(`ul[aria-label="Routes from page ${n}"] > li`)]

describe('FlowEditor, for a flow that names its pages', () => {
  it('keeps an existing flow in order exactly as it was, with no pages, until branching is chosen', () => {
    render({ title: 'Admission', steps: ['intake', 'triage'] })
    expect(container.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('false')
    expect(container.textContent).not.toContain('Page name')
    save()
    expect(onSave.mock.calls[0]![0]).toStrictEqual({ title: 'Admission', steps: ['intake', 'triage'] })
  })

  it('starts branching from the order the flow had, each page leading to the next under names that are not screen ids', () => {
    render({ title: 'Admission', steps: ['intake', 'triage', 'orders'] })
    branch()
    expect(field<HTMLInputElement>(step(1), 'Page name').value).toBe('intake-2')
    expect(routes(3).map(item => item.textContent)).toEqual(['No routes: the flow can finish here.'])
    save()
    expect(onSave.mock.calls[0]![0]).toStrictEqual({ title: 'Admission', steps: ['intake', 'triage', 'orders'], pages: [
      { name: 'intake-2', routes: [{ label: 'Next', to: 'triage-2' }] },
      { name: 'triage-2', routes: [{ label: 'Next', to: 'orders-2' }] },
      { name: 'orders-2' },
    ] })
  })

  it('authors a branch, a retry and a return, with page states, and a rename keeps the routes that lead there', () => {
    render({ title: 'Admission', steps: ['intake', 'triage', 'orders'] })
    branch()
    // Triage may be checked again (to itself) or sent back to intake, and has two states.
    act(() => button('Add a route from page 2').click())
    type(field(routes(2)[1]!, 'Route label'), 'Check again')
    type(field(routes(2)[1]!, 'Leads to'), field<HTMLSelectElement>(routes(2)[1]!, 'Leads to').options[2]!.value)
    act(() => button('Add a route from page 2').click())
    type(field(routes(2)[2]!, 'Route label'), 'Back to intake')
    type(field(routes(2)[2]!, 'Leads to'), field<HTMLSelectElement>(routes(2)[2]!, 'Leads to').options[1]!.value)
    type(field(step(2), 'Page states'), 'open, checked')
    type(field(step(1), 'Page name'), 'start')
    save()
    expect(onSave.mock.calls[0]![0].pages).toStrictEqual([
      { name: 'start', routes: [{ label: 'Next', to: 'triage-2' }] },
      { name: 'triage-2', states: ['open', 'checked'], routes: [
        { label: 'Next', to: 'orders-2' }, { label: 'Check again', to: 'triage-2' }, { label: 'Back to intake', to: 'start' },
      ] },
      { name: 'orders-2' },
    ])
  })

  it('edits a saved flow with pages and saves it back unchanged', () => {
    const saved: OperateFlowContent = { title: 'Rounds', steps: ['intake', 'triage'], pages: [
      { name: 'ward', states: ['due', 'seen'], routes: [{ label: 'See next', to: 'ward' }, { label: 'Escalate', to: 'escalate' }] },
      { name: 'escalate', routes: [{ label: 'Return', to: 'ward' }] },
    ] }
    render(saved)
    expect(container.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('true')
    save()
    expect(onSave.mock.calls[0]![0]).toStrictEqual(saved)
  })

  it("refuses to save a route whose page was removed, or a name a page can't have, in the kernel's words", () => {
    render({ title: 'Admission', steps: ['intake', 'triage', 'orders'] })
    branch()
    act(() => button('Remove step 3').click())
    expect(field<HTMLSelectElement>(routes(2)[0]!, 'Leads to').value).toBe('')
    save()
    expect(onSave).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('A route must lead to a page of the same flow.')
    act(() => button('Remove route 1 from page 2').click())
    type(field(step(1), 'Page name'), 'triage')
    save()
    expect(onSave).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/^A flow page needs a unique lowercase name/)
    type(field(step(1), 'Page name'), 'Intake page')
    save()
    expect(onSave).not.toHaveBeenCalled()
    type(field(step(1), 'Page name'), 'intake-page')
    save()
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
})
