// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useResizableSplit } from './useResizableSplit'

let root: Root
let container: HTMLDivElement
let split: ReturnType<typeof useResizableSplit>
const Probe = ({ enabled, side }: { enabled: boolean; side?: 'left' | 'right' }) => {
  split = useResizableSplit(enabled, side)
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

it('measures from the split container, not the window, on either side', async () => {
  // The split sits right of a 260px sidebar: its container spans x = 260..1200.
  const parentElement = { getBoundingClientRect: () => ({ left: 260, right: 1200, width: 940 }) }
  const onHandle = () => {
    const event = handle()
    return { ...event, currentTarget: { ...event.currentTarget, parentElement } }
  }

  await act(async () => root.render(<Probe enabled />))
  let event = onHandle() as never
  await act(async () => { split.handleProps.onPointerDown(event) })
  await act(async () => { split.handleProps.onPointerUp({ ...(event as object), type: 'pointerup', clientX: 760 } as never) })
  expect(split.width).toBe(500)

  await act(async () => root.render(<Probe enabled side="right" />))
  event = onHandle() as never
  await act(async () => { split.handleProps.onPointerDown(event) })
  await act(async () => { split.handleProps.onPointerUp({ ...(event as object), type: 'pointerup', clientX: 800 } as never) })
  expect(split.width).toBe(400)
  // The workspace pane keeps its minimum within the container: 940 - 400.
  await act(async () => { split.handleProps.onPointerDown(event) })
  await act(async () => { split.handleProps.onPointerUp({ ...(event as object), type: 'pointerup', clientX: 300 } as never) })
  expect(split.width).toBe(540)
})
