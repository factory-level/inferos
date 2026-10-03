// The board data adapter every board-shaped card shares. One instance serves one scope: the
// user's capability on one workspace (its Overseer stub), so nothing read in one scope is ever
// shown in another. Within a scope, entries are keyed by the canonical widget request. A target
// is resolved to a session only through the workspace's existing connection
// (Overseer.getGatekeeperByResourceUrl), so a reference identifies a board and authorizes nothing.
//
// InferOps stays authoritative: the adapter keeps snapshots, never a second copy it edits. A move
// is proposed through the gatekeeper's approval path and shown as pending until the authoritative
// board says it was decided. Reads are independent board reads; there is no batching.
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { CanvasProjectBoardWidget } from '@gadgets/workshop-shared/canvas'
import type { Board, InferOpsProjectSession, Revision } from '@inferos/gatekeeper-inferops/src/types'

/** What one board card asks for: registered kind and version, canonical target, normalized params. */
export type BoardRequest = Pick<CanvasProjectBoardWidget, 'kind' | 'version' | 'targetRef' | 'params'>

/** A move proposed through the gatekeeper that the authoritative board has not yet decided. */
export type PendingMove = {
  issueId: string
  fromStateId: string
  toStateId: string
  /** The revision the move was proposed against. Opaque: the move is decided once it differs. */
  expectedRevision: Revision
  /** `proposing` while the transition call is in flight, `awaiting` once it is queued for approval. */
  phase: 'proposing' | 'awaiting'
}

export type BoardState =
  | { status: 'loading' }
  /** The workspace holds no connection covering the reference. The cue to offer connecting, never to connect. */
  | { status: 'unbound' }
  /** Nothing usable was loaded (or the connection was revoked, which drops what was). */
  | { status: 'error'; message: string }
  /** `stale`: newer data was asked for (a refresh, a move, an approval) and has not arrived; `error` says why the refresh failed. */
  | { status: 'ready' | 'stale'; board: Board; pending: readonly PendingMove[]; error?: string }

export type MoveResult = { ok: true } | { ok: false; code: string; message: string }

/** The state of a request nobody has subscribed to yet; one object, so snapshots compare equal. */
export const LOADING_BOARD: BoardState = { status: 'loading' }
const UNBOUND: BoardState = { status: 'unbound' }

/** The reference as the gatekeeper describes it: the host is case-insensitive, the key is not. */
export const canonicalBoardRef = (targetRef: string): string =>
  targetRef.replace(/^(inferops:\/\/)([^/]+)/, (_, scheme: string, host: string) => scheme + host.toLowerCase())

export const boardRequestKey = (request: BoardRequest): string =>
  `${request.kind}|${request.version}|${canonicalBoardRef(request.targetRef)}|${request.params.workflow}|${request.params.showCompleted}`

/** The columns a card shows for its params. Presentation only: the whole board was read. */
export const visibleColumns = (board: Board, params: BoardRequest['params']): Board['columns'] =>
  board.columns.filter(({ state }) => state.workflow === params.workflow &&
    (params.showCompleted || (state.group !== 'completed' && state.group !== 'cancelled')))

// The gatekeeper leads its messages with the code (`STALE_REVISION: ...`), all that survives RPC.
const codeOf = (error: unknown): string =>
  /^(?:\w*Error: )?([A-Z_]+): /.exec(error instanceof Error ? error.message : String(error))?.[1] ?? 'ERROR'
const messageOf = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^(?:\w*Error: )?[A-Z_]+: /, '')
// The connection no longer covers the target: its credential was refused, the project is gone
// from it, or the connection itself was removed from the workspace.
const revoked = (error: unknown): boolean =>
  ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'].includes(codeOf(error)) || messageOf(error).includes('No such gatekeeper')

type Entry = { target: string; request: BoardRequest; listeners: Set<() => void>; state: BoardState }

// What the scope knows about one board, shared by every card of it. The two clocks order reads:
// a read started before `wanted` cannot satisfy the demand that set it, and a read older than
// `applied` never lands over the one on screen.
type TargetData = { wanted: number; applied: number; pending: PendingMove[]; session?: Promise<RpcStub<InferOpsProjectSession> | null> }

type Read = { target: string; clock: number; entries: Set<Entry>; running: boolean }

export class BoardData {
  readonly #overseer: RpcStub<Overseer>
  readonly #maxConcurrent: number
  readonly #entries = new Map<string, Entry>()
  readonly #targets = new Map<string, TargetData>()
  readonly #reads: Read[] = []
  #clock = 0
  #disposed = false

  constructor(overseer: RpcStub<Overseer>, options: { maxConcurrent?: number } = {}) {
    this.#overseer = overseer
    this.#maxConcurrent = options.maxConcurrent ?? 4
  }

  /** Start serving a request; the first subscriber triggers the load. Unsubscribing the last one cancels any unused load. */
  subscribe(request: BoardRequest, listener: () => void): () => void {
    const key = boardRequestKey(request)
    let entry = this.#entries.get(key)
    if (!entry) {
      entry = { target: canonicalBoardRef(request.targetRef), request, listeners: new Set(), state: LOADING_BOARD }
      this.#entries.set(key, entry)
      this.#demand(entry)
    }
    entry.listeners.add(listener)
    return () => {
      entry.listeners.delete(listener)
      if (entry.listeners.size > 0 || this.#entries.get(key) !== entry) return
      this.#entries.delete(key)
      for (const read of this.#reads) read.entries.delete(entry)
      this.#pump()
    }
  }

  get(request: BoardRequest): BoardState {
    return this.#entries.get(boardRequestKey(request))?.state ?? LOADING_BOARD
  }

  /** Ask for data newer than now. The current snapshot stays visible, marked stale, until it arrives. */
  invalidate(targetRef: string): void {
    const target = canonicalBoardRef(targetRef)
    this.#target(target).wanted = ++this.#clock
    for (const entry of this.#entriesOf(target)) {
      if ('board' in entry.state) this.#set(entry, { ...entry.state, status: 'stale' })
      this.#demand(entry)
    }
  }

  refresh(request: BoardRequest): void {
    this.invalidate(request.targetRef)
  }

  /**
   * Propose moving an issue through the gatekeeper. The move is pending (shown on every card of
   * the board) until the authoritative board reports it decided; the board is re-read either way,
   * so a refused move restores it and an accepted one shows the gatekeeper's simulated result.
   */
  async move(request: BoardRequest, issueId: string, toStateId: string, expectedRevision: Revision): Promise<MoveResult> {
    const entry = this.#entries.get(boardRequestKey(request))
    if (!entry || !('board' in entry.state)) return { ok: false, code: 'NOT_LOADED', message: 'The board is not loaded.' }
    const column = entry.state.board.columns.find(c => c.issues.some(i => i.id === issueId))
    if (!column) return { ok: false, code: 'NOT_FOUND', message: 'No such issue on this board.' }
    const target = this.#target(entry.target)
    if (target.pending.some(p => p.issueId === issueId)) {
      return { ok: false, code: 'CONFLICT', message: 'This issue already has a move that has not taken effect yet.' }
    }
    const move: PendingMove = { issueId, fromStateId: column.state.id, toStateId, expectedRevision, phase: 'proposing' }
    this.#setPending(entry.target, [...target.pending, move])
    try {
      const session = await this.#session(entry.target)
      if (!session) {
        this.#setPending(entry.target, target.pending.filter(p => p !== move))
        return { ok: false, code: 'NOT_CONNECTED', message: 'No connection covers this board any more.' }
      }
      const issue = session.openIssue(issueId)
      try {
        await issue.transition(toStateId, expectedRevision)
      } finally {
        issue[Symbol.dispose]()
      }
      this.#setPending(entry.target, target.pending.filter(p => p !== move).concat({ ...move, phase: 'awaiting' }))
      return { ok: true }
    } catch (error) {
      this.#setPending(entry.target, target.pending.filter(p => p !== move))
      return { ok: false, code: codeOf(error), message: messageOf(error) }
    } finally {
      this.invalidate(entry.target)
    }
  }

  /** Drop every entry and session; late results are discarded. The scope is over. */
  dispose(): void {
    this.#disposed = true
    this.#entries.clear()
    this.#reads.length = 0
    for (const target of this.#targets.keys()) this.#forgetSession(target)
    this.#targets.clear()
  }

  #target(target: string): TargetData {
    let data = this.#targets.get(target)
    if (!data) {
      data = { wanted: 0, applied: 0, pending: [] }
      this.#targets.set(target, data)
    }
    return data
  }

  #entriesOf(target: string): Entry[] {
    return [...this.#entries.values()].filter(entry => entry.target === target)
  }

  #set(entry: Entry, state: BoardState): void {
    entry.state = state
    for (const listener of entry.listeners) listener()
  }

  #setPending(target: string, pending: PendingMove[]): void {
    this.#target(target).pending = pending
    for (const entry of this.#entriesOf(target)) {
      if ('board' in entry.state) this.#set(entry, { ...entry.state, pending })
    }
  }

  // The newest read that can satisfy the target's demand, else a queued one re-stamped to now,
  // else a new one. A running read older than the demand is simply followed by another; the
  // clock rule in #run keeps whichever result is newer on screen.
  #demand(entry: Entry): void {
    const { wanted } = this.#target(entry.target)
    const candidates = this.#reads.filter(r => r.target === entry.target && (r.clock >= wanted || !r.running))
    let read = candidates.toSorted((a, b) => b.clock - a.clock)[0]
    if (!read) {
      read = { target: entry.target, clock: 0, entries: new Set(), running: false }
      this.#reads.push(read)
    }
    if (read.clock < wanted) read.clock = ++this.#clock
    read.entries.add(entry)
    this.#pump()
  }

  #pump(): void {
    for (let i = 0; i < this.#reads.length;) {
      const read = this.#reads[i]!
      if (!read.running && read.entries.size === 0) { this.#reads.splice(i, 1); continue }
      i++
    }
    for (const read of this.#reads) {
      if (this.#reads.filter(r => r.running).length >= this.#maxConcurrent) return
      if (!read.running) void this.#run(read)
    }
  }

  async #run(read: Read): Promise<void> {
    read.running = true
    if (read.clock === 0) read.clock = ++this.#clock
    try {
      const session = await this.#session(read.target)
      const board = session ? await session.readBoard() : null
      const target = this.#targets.get(read.target)
      if (!target || read.clock < target.wanted || read.clock <= target.applied) return
      target.applied = read.clock
      if (board) this.#reconcile(read.target, board)
      for (const entry of this.#entriesOf(read.target)) {
        this.#set(entry, board ? { status: 'ready', board, pending: target.pending } : UNBOUND)
      }
    } catch (error) {
      // Re-resolve the connection on the next read rather than reuse a session that just failed.
      this.#forgetSession(read.target)
      const target = this.#targets.get(read.target)
      if (!target || read.clock < target.wanted || read.clock <= target.applied) return
      for (const entry of this.#entriesOf(read.target)) {
        this.#set(entry, revoked(error) || !('board' in entry.state)
          ? { status: 'error', message: messageOf(error) }
          : { ...entry.state, status: 'stale', error: messageOf(error) })
      }
    } finally {
      const index = this.#reads.indexOf(read)
      if (index >= 0) this.#reads.splice(index, 1)
      if (!this.#disposed) this.#pump()
    }
  }

  // Keep an awaiting move only while the authoritative board still shows it undecided: the
  // gatekeeper simulates it in the target state at the unchanged revision until it is applied
  // (new revision) or rejected (back where it was, same revision).
  #reconcile(target: string, board: Board): void {
    const { pending } = this.#target(target)
    if (pending.length === 0) return
    const issues = new Map(board.columns.flatMap(c => c.issues.map(i => [i.id, i] as const)))
    this.#target(target).pending = pending.filter(move => {
      if (move.phase === 'proposing') return true
      const issue = issues.get(move.issueId)
      return issue !== undefined && issue.revision === move.expectedRevision && issue.stateId === move.toStateId
    })
  }

  #session(target: string): Promise<RpcStub<InferOpsProjectSession> | null> {
    // A move or read that outlives the scope must not open a session nobody will dispose.
    if (this.#disposed) return Promise.resolve(null)
    const data = this.#target(target)
    if (!data.session) {
      const session = (async () => {
        const client = await this.#overseer.getGatekeeperByResourceUrl(target)
        if (!client) return null
        try {
          return await client.openSession() as RpcStub<InferOpsProjectSession>
        } finally {
          client[Symbol.dispose]()
        }
      })()
      data.session = session
      // An unbound target is not cached: the next read looks the connection up again.
      void session.then(stub => { if (stub === null && data.session === session) data.session = undefined }, () => {})
    }
    return data.session
  }

  #forgetSession(target: string): void {
    const data = this.#targets.get(target)
    if (!data?.session) return
    void data.session.then(stub => stub?.[Symbol.dispose](), () => {})
    data.session = undefined
  }
}
