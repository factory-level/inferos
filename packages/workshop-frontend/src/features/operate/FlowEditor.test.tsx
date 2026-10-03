// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasDefinition } from '@gadgets/workshop-shared/canvas'
import type { OperateFlowContent } from '@gadgets/workshop-shared/operate-flow'
import { FlowEditor } from './FlowEditor'

const screen = (id: string, title: string): CanvasDefinition =>
  ({ schemaVersion: 1, id, revision: '0', title, sections: [] })
const SCREENS = [screen('intake', 'Intake'), screen('triage', 'Triage'), screen('orders', 'Orders')]

let container: HTMLDivElement
let root: Root
const onSave = vi.fn<(content: OperateFlowContent) => void>()

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
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
const steps = () => [...container.querySelectorAll('ol[aria-label="Steps"] li')]
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
