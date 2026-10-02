import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

const CHAT_WIDTH_STORAGE_KEY = 'gadgets:workshop:chatWidth'
const MIN_CHAT_WIDTH = 280
const MIN_WORKSPACE_WIDTH = 400
const DEFAULT_CHAT_WIDTH = 420

const isBrowser = typeof window !== 'undefined'

const clampChatWidth = (width: number) => {
  if (!isBrowser) return Math.max(MIN_CHAT_WIDTH, Math.min(DEFAULT_CHAT_WIDTH, width))
  const max = Math.max(MIN_CHAT_WIDTH, window.innerWidth - MIN_WORKSPACE_WIDTH)
  return Math.max(MIN_CHAT_WIDTH, Math.min(max, width))
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
 * Width of a left chat column beside a workspace pane, dragged from a handle between them. The
 * width is remembered across workspaces and pages and re-clamped when the window resizes.
 * Pointer capture keeps resizing reliable when dragging across a gadget iframe.
 */
export const useResizableSplit = (enabled: boolean) => {
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
    const next = e.type === 'pointercancel' ? widthRef.current : clampChatWidth(e.clientX)
    setWidth(next)
    persistChatWidth(next)
    setIsResizing(false)
  }

  return {
    width,
    isResizing,
    handleProps: {
      onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
        if (!enabled) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        setIsResizing(true)
      },
      onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
        setWidth(clampChatWidth(e.clientX))
      },
      onPointerUp,
      onPointerCancel: onPointerUp,
    },
  }
}
