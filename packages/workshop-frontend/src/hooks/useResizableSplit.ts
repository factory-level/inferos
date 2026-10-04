import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'

const CHAT_WIDTH_STORAGE_KEY = 'gadgets:workshop:chatWidth'
const MIN_CHAT_WIDTH = 280
const MIN_WORKSPACE_WIDTH = 400
const DEFAULT_CHAT_WIDTH = 420

const isBrowser = typeof window !== 'undefined'

// `available` is the width the chat and the workspace share: the split's container when known,
// else the window.
const clampChatWidth = (width: number, available = isBrowser ? window.innerWidth : undefined) => {
  if (available === undefined) return Math.max(MIN_CHAT_WIDTH, Math.min(DEFAULT_CHAT_WIDTH, width))
  const max = Math.max(MIN_CHAT_WIDTH, available - MIN_WORKSPACE_WIDTH)
  return Math.max(MIN_CHAT_WIDTH, Math.min(max, width))
}

/** Which side of the workspace pane the chat column sits on. */
export type SplitSide = 'left' | 'right'

// The chat width a pointer at `clientX` asks for, measured from the edge of the split's container
// (the handle's parent) that the chat sits against, so a sidebar beside the split doesn't count.
const widthAt = (handle: HTMLElement, clientX: number, side: SplitSide) => {
  const container = handle.parentElement?.getBoundingClientRect()
  if (!container) return clampChatWidth(side === 'left' ? clientX : window.innerWidth - clientX)
  const width = side === 'left' ? clientX - container.left : container.right - clientX
  return clampChatWidth(width, container.width)
}

const getInitialChatWidth = () => {
  if (!isBrowser) return DEFAULT_CHAT_WIDTH
  const fallback = Math.min(DEFAULT_CHAT_WIDTH, Math.floor(window.innerWidth * 0.38))
  let parsed = NaN
  try {
    const stored = window.localStorage.getItem(CHAT_WIDTH_STORAGE_KEY)
    if (stored) parsed = Number(stored)
  } catch {
    // private mode / sandboxed iframes
  }
  return clampChatWidth(Number.isFinite(parsed) ? parsed : fallback)
}

const persistChatWidth = (width: number) => {
  try {
    window.localStorage.setItem(CHAT_WIDTH_STORAGE_KEY, String(Math.round(width)))
  } catch {
    // private mode / sandboxed iframes
  }
}

/**
 * Width of a chat column beside a workspace pane, on its `side`, dragged from a handle between
 * them. The width is remembered across workspaces and pages and re-clamped when the window
 * resizes. Pointer capture keeps resizing reliable when dragging across a gadget iframe.
 */
export const useResizableSplit = (enabled: boolean, side: SplitSide = 'left') => {
  const [width, setWidth] = useState(getInitialChatWidth)
  const widthRef = useRef(width)
  widthRef.current = width
  const [isResizing, setIsResizing] = useState(false)

  useEffect(() => {
    const handleResize = () => setWidth(current => clampChatWidth(current))
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    if (!isResizing) return
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    return () => {
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
  }, [isResizing])

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    const next = e.type === 'pointercancel' ? widthRef.current : widthAt(e.currentTarget, e.clientX, side)
    setWidth(next)
    persistChatWidth(next)
    setIsResizing(false)
  }

  return {
    width,
    isResizing,
    handleProps: {
      tabIndex: 0,
      onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (!enabled || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
        event.preventDefault()
        const delta = (event.key === 'ArrowRight' ? 20 : -20) * (side === 'right' ? -1 : 1)
        const next = clampChatWidth(widthRef.current + delta, event.currentTarget.parentElement?.clientWidth)
        setWidth(next)
        persistChatWidth(next)
      },
      onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
        if (!enabled) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        setIsResizing(true)
      },
      onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
        setWidth(widthAt(e.currentTarget, e.clientX, side))
      },
      onPointerUp,
      onPointerCancel: onPointerUp,
    },
  }
}
