import { useEffect, useState, type RefObject } from 'react'

/**
 * Latches once the element has come within 200px of its scroll pane, so a card far down a long canvas
 * does no work (a gadget's bundle, a board's read) until someone scrolls near it. It never resets:
 * scrolling away again keeps what was loaded. `eager`, or a browser without IntersectionObserver,
 * counts as on screen from the start.
 */
export const useHasBeenOnScreen = (ref: RefObject<HTMLElement | null>, eager = false, scrollRoot?: RefObject<HTMLElement | null>): boolean => {
  const [seen, setSeen] = useState(() => eager || typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    if (seen || !ref.current) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setSeen(true)
    }, { root: scrollRoot?.current ?? null, rootMargin: '200px' })
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [ref, seen, scrollRoot])
  return seen || eager
}
