// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useResizableSplit } from './useResizableSplit'

let root: Root
let container: HTMLDivElement
let split: ReturnType<typeof useResizableSplit>
const Probe = ({ enabled }: { enabled: boolean }) => {
  split = useResizableSplit(enabled)
  return null
}
// jsdom has no pointer capture, so model one pointer on the handle.
const handle = () => {
  let captured = false
  return {
    pointerId: 1, type: 'pointermove', preventDefault() {},
    currentTarget: {
      setPointerCapture: () => { captured = true },
      releasePointerCapture: () => { captured = false },
      hasPointerCapture: () => captured,
    },
  }
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 })
  localStorage.clear()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

it('restores a stored width, clamped so the workspace pane keeps its minimum', async () => {
  localStorage.setItem('gadgets:workshop:chatWidth', '5000')
  await act(async () => root.render(<Probe enabled />))
  expect(split.width).toBe(800)
})

it('drags within bounds and persists the released width, but ignores drags while disabled', async () => {
  await act(async () => root.render(<Probe enabled={false} />))
  const event = handle() as never
  await act(async () => { split.handleProps.onPointerDown(event); split.handleProps.onPointerMove({ ...(event as object), clientX: 600 } as never) })
  expect(split.width).toBe(420)
  await act(async () => root.render(<Probe enabled />))
  await act(async () => { split.handleProps.onPointerDown(event) })
  expect(split.isResizing).toBe(true)
  await act(async () => { split.handleProps.onPointerMove({ ...(event as object), clientX: 100 } as never) })
  expect(split.width).toBe(280)
  await act(async () => { split.handleProps.onPointerUp({ ...(event as object), type: 'pointerup', clientX: 600 } as never) })
  expect(split.width).toBe(600)
  expect(split.isResizing).toBe(false)
  expect(localStorage.getItem('gadgets:workshop:chatWidth')).toBe('600')
})
