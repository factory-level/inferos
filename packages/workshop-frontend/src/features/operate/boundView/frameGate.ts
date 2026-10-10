// The zero-frame gate. While a bound view is shown, no frame-like element may exist in the page,
// so no authored frame shares the main thread with the view's rendering (a covert timing
// channel). The search covers the document and, recursively, every open shadow root found through
// `element.shadowRoot`. Closed shadow roots cannot be searched; no Workshop or Kumo code creates a
// shadow root at all, and a static test keeps it so.

/** The elements that can host another browsing context or plugin content. */
export const FRAME_ELEMENTS = ['iframe', 'frame', 'object', 'embed', 'fencedframe'] as const

const FRAME_SELECTOR = FRAME_ELEMENTS.join(', ')

/** Counts frame-like elements in `doc` and every open shadow root under it, and lists those roots. */
export const findFrames = (doc: Document): { count: number; roots: ShadowRoot[] } => {
  let count = 0
  const roots: ShadowRoot[] = []
  const search = (scope: Document | ShadowRoot) => {
    count += scope.querySelectorAll(FRAME_SELECTOR).length
    for (const element of scope.querySelectorAll('*')) {
      const shadow = element.shadowRoot
      if (shadow) {
        roots.push(shadow)
        search(shadow)
      }
    }
  }
  search(doc)
  return { count, roots }
}

/** A running frame watch. */
export type FrameWatch = {
  /** Searches again in full now, reports the result to the watch's callback, and returns whether no frame exists. */
  check: () => boolean
  /** Stops watching. */
  dispose: () => void
}

/**
 * Watches `doc` for frame-like elements. A `MutationObserver` on the document element, and one on
 * every open shadow root a search finds (a document observer cannot see inside them), triggers a
 * full search on every callback: the mutation records are ignored, so nothing depends on what
 * they report. Each search attaches observers to newly found shadow roots and detaches them from
 * roots that are gone. Every search, including {@link FrameWatch.check}, calls `onResult` with
 * whether the document holds no frame-like element.
 */
export const watchFrames = (doc: Document, onResult: (clear: boolean) => void): FrameWatch => {
  const watched = new Map<ShadowRoot, MutationObserver>()
  let disposed = false
  const options: MutationObserverInit = { subtree: true, childList: true }
  // An observer callback never throws out (the caller's `onResult` is expected to be contained too).
  const recheck = () => { try { check() } catch { /* dropped: the next callback or tick searches again */ } }
  const check = (): boolean => {
    if (disposed) return false
    const { count, roots } = findFrames(doc)
    const found = new Set(roots)
    for (const [shadow, observer] of watched) {
      if (!found.has(shadow)) { observer.disconnect(); watched.delete(shadow) }
    }
    for (const shadow of found) {
      if (watched.has(shadow)) continue
      const observer = new MutationObserver(recheck)
      observer.observe(shadow, options)
      watched.set(shadow, observer)
    }
    const clear = count === 0
    onResult(clear)
    return clear
  }
  const documentObserver = new MutationObserver(recheck)
  documentObserver.observe(doc.documentElement, options)
  return {
    check,
    dispose: () => {
      disposed = true
      documentObserver.disconnect()
      for (const observer of watched.values()) observer.disconnect()
      watched.clear()
    },
  }
}
