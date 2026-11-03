/**
 * How long a page waits for a list it can't show anything without (workspaces, screens,
 * gatekeepers) before it says the load failed and offers a retry. A hung request must never leave a
 * page on its loading line, or worse, read as an empty account (FAC-155).
 */
export const LOAD_TIMEOUT_MS = 15_000

/** One workspace's own reads, inside a list of them; one slow workspace mustn't hold up the rest. */
export const WORKSPACE_READ_TIMEOUT_MS = 10_000

/** A load that didn't settle in time. */
export class LoadTimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} did not answer within ${Math.round(ms / 1000)} s`)
    this.name = 'LoadTimeoutError'
  }
}

/**
 * The load, or a rejection with a `LoadTimeoutError` once `ms` pass without it settling. The
 * underlying request isn't cancelled (an RPC call has no abort), only no longer waited for.
 */
export function withLoadTimeout<T>(load: PromiseLike<T>, what: string, ms = LOAD_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LoadTimeoutError(what, ms)), ms)
  })
  return Promise.race([Promise.resolve(load), timeout]).finally(() => clearTimeout(timer))
}
