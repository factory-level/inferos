// The one funnel for failures in bound-view code. A bound view sends no telemetry: every promise,
// event handler, effect body, subscription callback, timer and evaluator call goes through
// `contain`, which turns a throw or a rejection into the constant report below, handed to a local
// site that sets a fixed UI state. The caught value is dropped unread, so no message, stack or
// value derived from the data can reach the console, window `error`, `unhandledrejection` or the
// Workshop's error reporter.

/** The only thing a contained failure reports: a constant, carrying nothing of the failure. */
export type BoundViewFailure = { readonly type: 'BoundViewFailure' }

/** The constant failure report. */
export const BOUND_VIEW_FAILURE: BoundViewFailure = Object.freeze({ type: 'BoundViewFailure' })

/** Where a contained failure goes: a local handler that shows a fixed state. */
export type BoundViewFailureSite = (failure: BoundViewFailure) => void

/** Tells `site` that something failed, dropping anything `site` itself throws. */
export const reportBoundViewFailure = (site: BoundViewFailureSite): void => {
  try { site(BOUND_VIEW_FAILURE) } catch { /* dropped: there is nowhere further to send it */ }
}

/**
 * Wraps `fn` so that it never throws and never rejects: a synchronous throw, or the rejection of a
 * promise it returns, is dropped and only {@link BOUND_VIEW_FAILURE} is sent to `site`. The wrapper
 * returns nothing, so no caller can observe the failure either.
 */
export const contain = <A extends unknown[]>(site: BoundViewFailureSite, fn: (...args: A) => unknown) =>
  (...args: A): void => {
    try {
      const result = fn(...args)
      if (typeof result === 'object' && result !== null && typeof (result as { then?: unknown }).then === 'function') {
        Promise.resolve(result as PromiseLike<unknown>).then(undefined, () => reportBoundViewFailure(site))
      }
    } catch {
      reportBoundViewFailure(site)
    }
  }
