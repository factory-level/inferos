// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceKind } from '@gadgets/workshop-shared/api'
import { WorkspaceKindPicker } from './WorkspaceKindPicker'

// jsdom has no PointerEvent, which Kumo's radio dispatches on click.
if (!('PointerEvent' in window)) {
  Object.defineProperty(window, 'PointerEvent', { value: class extends MouseEvent {} })
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const radios = () => [...container.querySelectorAll<HTMLElement>('[role="radio"]')]
const checked = () => radios().map(radio => radio.getAttribute('aria-checked'))
const tabStops = () => radios().filter(radio => radio.tabIndex === 0)
const labelOf = (radio: HTMLElement) => radio.closest('label')?.textContent ?? ''

/** The picker as its page owns it: the chosen kind lives in the caller. */
const Owner = ({ initial, onKindChange }: { initial: WorkspaceKind; onKindChange: (kind: WorkspaceKind) => void }) => {
  const [kind, setKind] = useState(initial)
  return <WorkspaceKindPicker kind={kind} onKindChange={next => { setKind(next); onKindChange(next) }} />
}

/** Kumo's group moves focus in a microtask after the keydown, so let that settle too. */
const press = async (key: string) => {
  const target = document.activeElement
  if (!target) throw new Error('nothing focused')
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

describe('WorkspaceKindPicker', () => {
  it('offers the three kinds as one named radio group and marks only the current one as chosen', () => {
    act(() => root.render(<WorkspaceKindPicker kind="widget" onKindChange={() => {}} />))
    expect(container.querySelector('[role="radiogroup"]')).not.toBeNull()
    const labelledBy = container.querySelector('fieldset')?.getAttribute('aria-labelledby')
    expect(labelledBy && document.getElementById(labelledBy)?.textContent).toBe('What this workspace builds')
    expect(radios().map(labelOf))
      .toEqual([expect.stringMatching(/^App/), expect.stringMatching(/^Widget/), expect.stringMatching(/^Workflow/)])
    expect(checked()).toEqual(['false', 'true', 'false'])
  })

  it('reports the kind that was picked', () => {
    const onKindChange = vi.fn<(kind: WorkspaceKind) => void>()
    act(() => root.render(<WorkspaceKindPicker kind="app" onKindChange={onKindChange} />))
    act(() => radios()[2]!.click())
    expect(onKindChange).toHaveBeenCalledWith('workflow')
  })

  it('is one tab stop, on the chosen kind', () => {
    act(() => root.render(<WorkspaceKindPicker kind="widget" onKindChange={() => {}} />))
    expect(tabStops()).toEqual([radios()[1]])
  })

  it('moves and selects with the arrow keys, wrapping at the ends', async () => {
    const onKindChange = vi.fn<(kind: WorkspaceKind) => void>()
    act(() => root.render(<Owner initial="app" onKindChange={onKindChange} />))
    act(() => radios()[0]!.focus())

    await press('ArrowDown')
    expect(document.activeElement).toBe(radios()[1])
    expect(checked()).toEqual(['false', 'true', 'false'])
    expect(tabStops()).toEqual([radios()[1]])

    await press('ArrowRight')
    expect(document.activeElement).toBe(radios()[2])
    await press('ArrowDown')
    expect(document.activeElement).toBe(radios()[0])
    await press('ArrowUp')
    expect(document.activeElement).toBe(radios()[2])
    await press('ArrowLeft')
    expect(document.activeElement).toBe(radios()[1])

    expect(onKindChange.mock.calls.map(([kind]) => kind)).toEqual(['widget', 'workflow', 'app', 'workflow', 'widget'])
    expect(checked()).toEqual(['false', 'true', 'false'])
  })
})
