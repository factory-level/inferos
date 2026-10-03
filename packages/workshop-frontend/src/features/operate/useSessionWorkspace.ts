import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { OperateSession, Overseer } from '@gadgets/workshop-shared/api'

/** The session's owner-only, operate-only workspace: where its chat runs and its agent's actions wait. */
export type SessionWorkspace = { stub: RpcStub<Overseer>; id: string; restricted: boolean }

/**
 * Opens the session workspace once for the page, so the operate chat and the session's approvals
 * share one capability (and one action-log subscription). Null until its metadata has loaded.
 */
export const useSessionWorkspace = (session: { stub: RpcStub<OperateSession> } | null): SessionWorkspace | null => {
  const [workspace, setWorkspace] = useState<SessionWorkspace | null>(null)
  useEffect(() => {
    if (!session) return
    let cancelled = false
    const stub = session.stub.getWorkspace()
    stub.getMetadata().then(metadata => {
      if (!cancelled) setWorkspace({ stub, id: metadata.id, restricted: metadata.containsRestrictedData === true })
    }).catch(caught => console.error('Failed to open the operate session workspace:', caught))
    return () => {
      cancelled = true
      stub[Symbol.dispose]()
      setWorkspace(null)
    }
  }, [session])
  return workspace
}
