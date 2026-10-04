import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { useActionEntries } from '../../useActions'
import { BoardMetrics, type BoardMetricsSnapshot } from './boardMetrics'
import { BoardData, LOADING_BOARD, boardRequestKey, type BoardRequest, type BoardState, type ProposalResult } from './boardData'
import type { IssueChanges, NewIssue, Revision } from '@inferos/gatekeeper-inferops/src/types'

// One adapter per scope, the Overseer stub being the user's capability on the workspace. A new
// stub (another workspace, a reopened session) gets an empty adapter; the old one is disposed with
// its last card, so no scope's data outlives it.
const adapters = new Map<RpcStub<Overseer>, { data: BoardData; refs: number; metrics?: BoardMetrics }>()

declare global {
  interface Window {
    /** Development builds only: read metrics of every open board scope (#28). Counts and timings, no board content. */
    __inferosBoardMetrics?: () => BoardMetricsSnapshot[]
  }
}

if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.__inferosBoardMetrics = () => [...adapters.values()].flatMap(held => held.metrics ? [held.metrics.snapshot()] : [])
}

const acquire = (overseer: RpcStub<Overseer>): BoardData => {
  let held = adapters.get(overseer)
  if (!held) {
    const metrics = import.meta.env.DEV ? new BoardMetrics() : undefined
    held = { data: new BoardData(overseer, { metrics }), refs: 0, metrics }
    adapters.set(overseer, held)
  }
  held.refs++
  return held.data
}

const release = (overseer: RpcStub<Overseer>): void => {
  const held = adapters.get(overseer)
  if (!held || --held.refs > 0) return
  adapters.delete(overseer)
  held.data.dispose()
}

/** Mark every card of a board in this scope stale and re-read it, e.g. once a proposed move was decided. */
export const invalidateBoard = (overseer: RpcStub<Overseer>, targetRef: string): void => {
  adapters.get(overseer)?.data.invalidate(targetRef)
}

/**
 * Re-read a board whenever an action on its connection leaves `pending`: a move approved or
 * rejected, by anyone, changes the authoritative board. Every presentation that shows boards
 * of the scope calls this; the action store is shared and reference-counted.
 */
export const useDecidedActionInvalidation = (overseer: RpcStub<Overseer>): void => {
  useActionEntries(overseer, record => {
    if (record.type === 'action' && record.state !== 'pending' && record.resourceUrl) invalidateBoard(overseer, record.resourceUrl)
  })
}

/**
 * Re-read the board at `targetRef` in every open scope, each through its own capability: after an
 * approval whose apply failed, say, which leaves its action pending (so no log entry re-reads the
 * board) while the board may have changed underneath it.
 */
export const invalidateBoardInEveryScope = (targetRef: string): void => {
  for (const { data } of adapters.values()) data.invalidate(targetRef)
}

/**
 * Re-read, in every open scope, any board an action of this workspace touched once it leaves
 * `pending`. For a workspace that shows no boards itself but proposes moves on them, such as an
 * operate session's: a decided move there changes the board a screen shows through its own
 * workspace. Each scope re-reads through its own capability, so nothing crosses between them.
 */
export const useDecidedActionInvalidationInEveryScope = (overseer: RpcStub<Overseer> | null): void => {
  useActionEntries(overseer, record => {
    if (record.type !== 'action' || record.state === 'pending' || !record.resourceUrl) return
    invalidateBoardInEveryScope(record.resourceUrl)
  })
}

const NOT_LOADED: ProposalResult = { ok: false, code: 'NOT_LOADED', message: 'The board is not loaded.' }

/**
 * The live state of one board card's request in the given scope, with its actions. While `active`
 * is false (a card not yet near the screen) the request is not subscribed, so nothing is read, and
 * the state stays `loading`; it is subscribed, and read or served from a card already showing the
 * board, once `active` turns true.
 */
export const useBoardData = (overseer: RpcStub<Overseer>, request: BoardRequest, active = true): {
  state: BoardState
  refresh: () => void
  move: (issueId: string, toStateId: string, expectedRevision: Revision) => Promise<ProposalResult>
  create: (issue: NewIssue) => Promise<ProposalResult>
  update: (issueId: string, changes: IssueChanges, expectedRevision: Revision) => Promise<ProposalResult>
} => {
  const key = boardRequestKey(request)
  // Held for the component's life as well as per subscription, so a request change does not
  // dispose and recreate the scope's adapter between the two.
  useEffect(() => { acquire(overseer); return () => release(overseer) }, [overseer])
  const subscribe = useCallback((onChange: () => void) => {
    if (!active) return () => {}
    const data = acquire(overseer)
    const unsubscribe = data.subscribe(request, onChange)
    return () => { unsubscribe(); release(overseer) }
  // The request is identified by its key; a new object with the same key is the same request.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overseer, key, active])
  const getSnapshot = useCallback(() => active ? adapters.get(overseer)?.data.get(request) ?? LOADING_BOARD : LOADING_BOARD,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [overseer, key, active])
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const data = () => adapters.get(overseer)?.data
  return {
    state,
    refresh: () => data()?.refresh(request),
    move: (issueId, toStateId, expectedRevision) => data()?.move(request, issueId, toStateId, expectedRevision) ?? Promise.resolve(NOT_LOADED),
    create: issue => data()?.create(request, issue) ?? Promise.resolve(NOT_LOADED),
    update: (issueId, changes, expectedRevision) => data()?.update(request, issueId, changes, expectedRevision) ?? Promise.resolve(NOT_LOADED),
  }
}
