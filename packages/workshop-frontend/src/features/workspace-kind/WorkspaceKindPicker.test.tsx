// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceKindPicker } from './WorkspaceKindPicker'

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

const radios = () => [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]

describe('WorkspaceKindPicker', () => {
  it('offers the three kinds and marks only the current one as chosen', () => {
    act(() => root.render(<WorkspaceKindPicker kind="widget" onKindChange={() => {}} />))
    expect(radios().map(radio => [radio.querySelector('span')?.textContent, radio.getAttribute('aria-checked')]))
      .toEqual([['App', 'false'], ['Widget', 'true'], ['Workflow', 'false']])
  })

  it('reports the kind that was picked', () => {
    const onKindChange = vi.fn<(kind: string) => void>()
    act(() => root.render(<WorkspaceKindPicker kind="app" onKindChange={onKindChange} />))
    act(() => radios()[2]!.click())
    expect(onKindChange).toHaveBeenCalledWith('workflow')
  })
})
