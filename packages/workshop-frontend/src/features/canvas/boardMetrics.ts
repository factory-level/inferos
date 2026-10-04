// Development-only read metrics for the board data adapter (#28). Counts and timings only: no
// target, board content or identity is kept, and nothing is sent anywhere. The hook enables it
// in dev builds; production adapters are built without one, so they pay nothing for it.

/** How a board read ended: landed, found no connection, lost to a newer read or a departed card, or failed. */
export type BoardReadOutcome = 'applied' | 'unbound' | 'superseded' | 'failed'

/** One finished read. `bytes` is the UTF-8 length of the result as JSON, null when nothing was returned. */
export type BoardReadSample = { durationMs: number; bytes: number | null; outcome: BoardReadOutcome }

export type BoardMetricsSnapshot = {
  /** `readBoard()` calls started (each preceded by a session lookup when none is cached). */
  readsStarted: number
  /** Demands served by a read already queued or in flight, or by an existing entry, instead of a new read. */
  sharedDemands: number
  outcomes: Record<BoardReadOutcome, number>
  /** Over the retained samples, including the session lookup of a first read. */
  latencyMs: { p50: number | null; p95: number | null }
  payloadBytes: { last: number | null; max: number | null }
  /** The most recent samples, oldest first. */
  recent: readonly BoardReadSample[]
}

/** The nearest-rank percentile of `values`, or null when there are none. */
export const percentile = (values: readonly number[], p: number): number | null => {
  if (values.length === 0) return null
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!
}

const encoder = new TextEncoder()

export class BoardMetrics {
  readonly #now: () => number
  readonly #limit: number
  readonly #samples: BoardReadSample[] = []
  readonly #outcomes: Record<BoardReadOutcome, number> = { applied: 0, unbound: 0, superseded: 0, failed: 0 }
  #readsStarted = 0
  #sharedDemands = 0
  #lastBytes: number | null = null
  #maxBytes: number | null = null

  constructor(options: { now?: () => number; limit?: number } = {}) {
    this.#now = options.now ?? (() => performance.now())
    this.#limit = options.limit ?? 200
  }

  /** A demand joined existing work rather than starting a read. */
  shared(): void {
    this.#sharedDemands++
  }

  /** A read started; call the returned function once with how it ended and what it returned. */
  readStarted(): (outcome: BoardReadOutcome, result?: unknown) => void {
    this.#readsStarted++
    const start = this.#now()
    let finished = false
    return (outcome, result) => {
      if (finished) return
      finished = true
      const bytes = result == null ? null : encoder.encode(JSON.stringify(result)).byteLength
      if (bytes !== null) {
        this.#lastBytes = bytes
        this.#maxBytes = Math.max(this.#maxBytes ?? 0, bytes)
      }
      this.#outcomes[outcome]++
      this.#samples.push({ durationMs: this.#now() - start, bytes, outcome })
      if (this.#samples.length > this.#limit) this.#samples.shift()
    }
  }

  snapshot(): BoardMetricsSnapshot {
    const durations = this.#samples.map(sample => sample.durationMs)
    return {
      readsStarted: this.#readsStarted,
      sharedDemands: this.#sharedDemands,
      outcomes: { ...this.#outcomes },
      latencyMs: { p50: percentile(durations, 50), p95: percentile(durations, 95) },
      payloadBytes: { last: this.#lastBytes, max: this.#maxBytes },
      recent: [...this.#samples],
    }
  }
}
