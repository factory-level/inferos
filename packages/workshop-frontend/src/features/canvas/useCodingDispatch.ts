import { useEffect, useState, useSyncExternalStore } from 'react'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { DispatchTarget, Revision } from '@inferos/gatekeeper-inferops/src/types'
import { useActionEntries } from '../../useActions'
import { canonicalBoardRef, type ProposalResult } from './boardData'
import { CODING_UNAVAILABLE, CodingDispatchData, type CodingDispatchState } from './codingDispatch'

const NOT_LOADED: ProposalResult = { ok: false, code: 'NOT_LOADED', message: 'Coding runs are not loaded.' }
const noSubscription = () => () => {}

/**
 * The coding runs of the project at `targetRef` (a coding-dispatch reference), read through the
 * workspace whose capability `overseer` is, with its proposals. Null `targetRef` reads nothing and
 * stays `unavailable`: the surface does not offer coding. Runs are re-read when a dispatch or
 * cancel on the reference leaves `pending` in the action log, by whoever decided it.
 */
export const useCodingDispatch = (overseer: RpcStub<Overseer>, targetRef: string | null): {
  state: CodingDispatchState
  refresh: () => void
  dispatch: (issueKey: string, target: DispatchTarget, expectedRevision: Revision) => Promise<ProposalResult>
  cancel: (runId: string) => Promise<ProposalResult>
} => {
  const [held, setHeld] = useState<{ overseer: RpcStub<Overseer>; data: CodingDispatchData } | null>(null)
  useEffect(() => {
    if (targetRef === null) return
    const data = new CodingDispatchData(overseer, targetRef)
    setHeld({ overseer, data })
    return () => { data.dispose(); setHeld(null) }
  }, [overseer, targetRef])
  // Until the effect for a new scope or reference has run, the held instance is the previous one's.
  const data = held && targetRef !== null && held.overseer === overseer && held.data.target === canonicalBoardRef(targetRef) ? held.data : null
  const state = useSyncExternalStore(data?.subscribe ?? noSubscription, () => data?.state ?? CODING_UNAVAILABLE)

  useActionEntries(targetRef === null ? null : overseer, record => {
    if (record.type === 'action' && record.state !== 'pending' && record.resourceUrl && data &&
      canonicalBoardRef(record.resourceUrl) === data.target) data.refresh()
  })

  return {
    state,
    refresh: () => data?.refresh(),
    dispatch: (issueKey, target, expectedRevision) => data?.dispatch(issueKey, target, expectedRevision) ?? Promise.resolve(NOT_LOADED),
    cancel: runId => data?.cancel(runId) ?? Promise.resolve(NOT_LOADED),
  }
}
