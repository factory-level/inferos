import { useEffect, useState } from 'react'
import { RpcStub, RpcTarget } from 'capnweb'
import type {
  Overseer,
  WorkpieceId,
  WorkpieceSummary,
  WorkpiecesSubscriber,
} from '@gadgets/workshop-shared/api'

type Workpieces = Map<WorkpieceId, WorkpieceSummary>

// Receives the workspace's workpiece list (see Overseer.subscribeToWorkpieces()). Entries
// received before ready() are buffered so a (re)subscription replaces the list atomically instead
// of flashing a partially-populated one.
class WorkpiecesSubscriberImpl extends RpcTarget implements WorkpiecesSubscriber {
  private buffer: Workpieces | null = new Map()
  private cancelled = false

  constructor(
    private onUpdate: (update: (prev: Workpieces) => Workpieces) => void,
    private onReady: (initial: Workpieces) => void,
  ) {
    super()
  }

  entry(summary: WorkpieceSummary) {
    if (this.cancelled) return
    if (this.buffer) {
      this.buffer.set(summary.id, summary)
      return
    }
    this.onUpdate(prev => new Map(prev).set(summary.id, summary))
  }

  removed(id: WorkpieceId) {
    if (this.cancelled) return
    if (this.buffer) {
      this.buffer.delete(id)
      return
    }
    this.onUpdate(prev => {
      const next = new Map(prev)
      next.delete(id)
      return next
    })
  }

  ready() {
    if (this.cancelled) return
    const initial = this.buffer ?? new Map<WorkpieceId, WorkpieceSummary>()
    this.buffer = null
    this.onReady(initial)
  }

  // local call
  cancel() {
    this.cancelled = true
  }
}

/**
 * The live workpiece list of the open workspace. `ready` flips once the initial listing has
 * arrived. The list is cleared when `workspaceId` changes, but deliberately not when only the
 * overseer stub is replaced (a reconnect), so a resubscription swaps the list in without flashing.
 */
export const useWorkspaceWorkpieces = (
  overseer: { stub: RpcStub<Overseer> } | null,
  workspaceId: string | undefined,
) => {
  const [state, setState] = useState({ workspaceId, workpieces: new Map() as Workpieces, ready: false })
  if (state.workspaceId !== workspaceId) setState({ workspaceId, workpieces: new Map(), ready: false })

  useEffect(() => {
    if (!overseer) return
    let sub: RpcStub<{}> | null = null
    let cancelled = false
    const subscriber = new WorkpiecesSubscriberImpl(
      update => setState(prev => ({ ...prev, workpieces: update(prev.workpieces) })),
      initial => setState(prev => ({ ...prev, workpieces: initial, ready: true })),
    )
    overseer.stub
      .subscribeToWorkpieces(subscriber)
      .then(s => {
        if (cancelled) { s[Symbol.dispose](); return }
        sub = s
      })
      .catch(err => console.error('Failed to subscribe to workpieces:', err))
    return () => {
      cancelled = true
      subscriber.cancel()
      sub?.[Symbol.dispose]()
    }
  }, [overseer])

  return { workpieces: state.workpieces, ready: state.ready }
}
