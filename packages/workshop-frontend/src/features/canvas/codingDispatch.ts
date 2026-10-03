// The coding runs of one project, read through the workspace's coding-dispatch binding for it
// (`inferops://<tenant>.<workspace>/project/dispatch/<KEY>`). Like a board, the reference is
// resolved only through a connection the workspace already holds
// (Overseer.getGatekeeperByResourceUrl), so it identifies a project and authorizes nothing; a
// board binding never stands in for it. InferOps stays authoritative: this keeps the latest read,
// and a dispatch or cancel is only proposed through the gatekeeper's approval path.
//
// Runs change without anyone acting here (the runner claims and finishes them), so while a run is
// active or a change of one awaits approval the list is re-read on a backoff, and no longer once
// nothing is in flight or after `FOLLOW_LIMIT` re-reads. A refresh or a decided action restarts it.
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { DispatchTarget, InferOpsDispatchSession, Repo, Revision, Run } from '@inferos/gatekeeper-inferops/src/types'
import { canonicalBoardRef, codeOf, messageOf, type ProposalResult } from './boardData'
import { needsFollowing } from './codingRuns'

export type CodingDispatchState =
  /** Not resolved yet, or the workspace holds no coding-dispatch connection for the project: offer nothing. */
  | { status: 'unavailable' }
  /** The deployment has coding dispatch turned off (`DISABLED`). The connection is kept. */
  | { status: 'disabled'; message: string }
  /** Nothing could be read. */
  | { status: 'error'; message: string }
  /**
   * `refreshing` while a newer read is under way; `error` when the last one failed and these are
   * the previous runs; `followStopped` when runs are still in flight but automatic re-reads ended.
   */
  | { status: 'ready'; repos: readonly Repo[]; runs: readonly Run[]; refreshing: boolean; error?: string; followStopped?: true }

export const CODING_UNAVAILABLE: CodingDispatchState = { status: 'unavailable' }

/** The waits between automatic re-reads while something is in flight; the last repeats. */
export const FOLLOW_DELAYS_MS: readonly number[] = [10_000, 20_000, 40_000, 60_000]

/** Automatic re-reads per refresh: about an hour at the longest wait. Each read is an observation in the action log. */
export const FOLLOW_LIMIT = 60

const NOT_CONNECTED = { ok: false, code: 'NOT_CONNECTED', message: 'No coding-dispatch connection covers this project any more.' } as const

export class CodingDispatchData {
  /** The canonical coding-dispatch reference this instance reads. */
  readonly target: string
  readonly #overseer: RpcStub<Overseer>
  readonly #listeners = new Set<() => void>()
  #state: CodingDispatchState = CODING_UNAVAILABLE
  #session?: Promise<RpcStub<InferOpsDispatchSession> | null>
  #reading = false
  // A read asked for while one was running; `repos` when it must re-read the repositories too.
  #again: { repos: boolean } | null = null
  #followed = 0
  #timer?: ReturnType<typeof setTimeout>
  #disposed = false

  constructor(overseer: RpcStub<Overseer>, targetRef: string) {
    this.#overseer = overseer
    this.target = canonicalBoardRef(targetRef)
    void this.#read(true)
  }

  get state(): CodingDispatchState {
    return this.#state
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  /** Re-read the repositories and runs now, and follow runs in flight afresh. Calls made during a read coalesce into one more. */
  refresh = (): void => {
    this.#followed = 0
    this.#request(true)
  }

  /** Propose handing the issue, at the revision it was read at, to the coding runner. Re-reads either way. */
  dispatch(issueKey: string, target: DispatchTarget, expectedRevision: Revision): Promise<ProposalResult> {
    return this.#propose(session => session.dispatch(issueKey, target, expectedRevision))
  }

  /** Propose stopping a queued or running run. Re-reads either way. */
  cancel(runId: string): Promise<ProposalResult> {
    return this.#propose(session => session.cancel(runId))
  }

  /** Stop following, drop the session; late results are discarded. */
  dispose(): void {
    this.#disposed = true
    clearTimeout(this.#timer)
    this.#listeners.clear()
    this.#forgetSession()
  }

  async #propose(call: (session: RpcStub<InferOpsDispatchSession>) => Promise<void>): Promise<ProposalResult> {
    try {
      const session = await this.#sessionOf()
      if (!session) return NOT_CONNECTED
      await call(session)
      return { ok: true }
    } catch (error) {
      return { ok: false, code: codeOf(error), message: messageOf(error) }
    } finally {
      this.refresh()
    }
  }

  #request(repos: boolean): void {
    if (this.#disposed) return
    if (this.#reading) {
      this.#again = { repos: repos || (this.#again?.repos ?? false) }
      return
    }
    void this.#read(repos)
  }

  #set(state: CodingDispatchState): void {
    if (this.#disposed) return
    this.#state = state
    for (const listener of this.#listeners) listener()
  }

  async #read(repos: boolean): Promise<void> {
    clearTimeout(this.#timer)
    this.#timer = undefined
    this.#reading = true
    const before = this.#state
    if (before.status === 'ready') this.#set({ ...before, refreshing: true })
    try {
      const session = await this.#sessionOf()
      if (this.#disposed) return
      if (!session) {
        this.#set(CODING_UNAVAILABLE)
        return
      }
      // Repositories change rarely; a follow-up re-read asks only for runs, each read being an observation.
      const known = before.status === 'ready' && !repos ? before.repos : null
      const [repoList, runs] = await Promise.all([known ?? session.listRepos(), session.listRuns()])
      this.#set({ status: 'ready', repos: repoList, runs, refreshing: false })
    } catch (error) {
      // Re-resolve the connection on the next read rather than reuse a session that just failed.
      this.#forgetSession()
      const message = messageOf(error)
      const current = this.#state
      this.#set(codeOf(error) === 'DISABLED' ? { status: 'disabled', message }
        // The connection was removed from the workspace: as with no binding, offer nothing.
        : message.includes('No such gatekeeper') ? CODING_UNAVAILABLE
          : current.status === 'ready' ? { ...current, refreshing: false, error: message }
            : { status: 'error', message })
    } finally {
      this.#reading = false
      const again = this.#again
      this.#again = null
      if (!this.#disposed) {
        if (again) void this.#read(again.repos)
        else this.#follow()
      }
    }
  }

  #follow(): void {
    const state = this.#state
    if (state.status !== 'ready' || state.error !== undefined || !state.runs.some(needsFollowing)) {
      this.#followed = 0
      return
    }
    if (this.#followed >= FOLLOW_LIMIT) {
      this.#set({ ...state, followStopped: true })
      return
    }
    const delay = FOLLOW_DELAYS_MS[Math.min(this.#followed, FOLLOW_DELAYS_MS.length - 1)]
    this.#followed++
    this.#timer = setTimeout(() => this.#request(false), delay)
  }

  #sessionOf(): Promise<RpcStub<InferOpsDispatchSession> | null> {
    if (this.#disposed) return Promise.resolve(null)
    if (!this.#session) {
      const session = (async () => {
        const client = await this.#overseer.getGatekeeperByResourceUrl(this.target)
        if (!client) return null
        try {
          return await client.openSession() as RpcStub<InferOpsDispatchSession>
        } finally {
          client[Symbol.dispose]()
        }
      })()
      this.#session = session
      // No binding is not cached: the next read looks the connection up again.
      void session.then(stub => { if (stub === null && this.#session === session) this.#session = undefined }, () => {})
    }
    return this.#session
  }

  #forgetSession(): void {
    const session = this.#session
    if (!session) return
    this.#session = undefined
    void session.then(stub => stub?.[Symbol.dispose](), () => {})
  }
}
