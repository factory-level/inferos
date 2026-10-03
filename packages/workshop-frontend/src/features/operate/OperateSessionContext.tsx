import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { RpcStub } from 'capnweb'
import {
  getOperateSessionErrorCode,
  OPERATE_SESSION_ERROR_CODES,
  type OperateSession,
} from '@gadgets/workshop-shared/api'
import type { OperateEvent, OperateSessionSnapshot } from '@gadgets/workshop-shared/operate-session'
import { useAuthenticatedApi } from '../../AuthContext'

/** How long a conflicting dispatch waits for the newer snapshot before giving up. */
const CONFLICT_WAIT_MS = 2000

type OperateSessionValue = {
  /** The session's page as of its latest event; null until the first snapshot arrives. */
  snapshot: OperateSessionSnapshot | null
  /** Set when the session could not be reached. */
  error: string | null
  /**
   * Appends an event at the latest known sequence number. On a conflict (another tab or the agent
   * moved first) it waits for the newer snapshot and retries once against it.
   */
  dispatch: (event: OperateEvent) => Promise<void>
  /** The session capability, for the session workspace (its operate chat). */
  session: { stub: RpcStub<OperateSession> } | null
}

const OperateSessionContext = createContext<OperateSessionValue | null>(null)

/**
 * Holds this tab's view of the person's single operate session: one subscription, kept live, that
 * every tab and device of theirs shares through the kernel.
 */
export const OperateSessionProvider = ({ children }: { children: ReactNode }) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const [snapshot, setSnapshot] = useState<OperateSessionSnapshot | null>(null)
  const [session, setSession] = useState<{ stub: RpcStub<OperateSession> } | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The latest seq seen and the waiters for a newer one, outside render so dispatch reads them fresh.
  const latest = useRef<{ seq: number; waiters: Array<() => void> }>({ seq: 0, waiters: [] })

  useEffect(() => {
    let cancelled = false
    let subscription: RpcStub<{}> | undefined
    const stub = authenticatedApi.getOperateSession()
    setSession({ stub })
    stub.subscribe(update => {
      if (cancelled) return
      if (update.seq < latest.current.seq) return
      latest.current.seq = update.seq
      setSnapshot({ seq: update.seq, state: update.state })
      const waiters = latest.current.waiters
      latest.current.waiters = []
      for (const wake of waiters) wake()
    }).then(resolved => {
      if (cancelled) resolved[Symbol.dispose]()
      else subscription = resolved
    }).catch(caught => {
      if (cancelled) return
      console.error('Failed to subscribe to the operate session:', caught)
      setError('Could not reach your operate session. Reload to try again.')
    })
    return () => {
      cancelled = true
      subscription?.[Symbol.dispose]()
      stub[Symbol.dispose]()
      setSession(null)
    }
  }, [authenticatedApi])

  const waitForNewerThan = (seq: number) => new Promise<void>(resolve => {
    if (latest.current.seq > seq) return resolve()
    const timer = setTimeout(resolve, CONFLICT_WAIT_MS)
    latest.current.waiters.push(() => { clearTimeout(timer); resolve() })
  })

  const dispatch = async (event: OperateEvent) => {
    if (!session) return
    for (let attempt = 0; ; attempt++) {
      const seq = latest.current.seq
      try {
        const next = await session.stub.dispatch(event, seq)
        if (next.seq > latest.current.seq) {
          latest.current.seq = next.seq
          setSnapshot(next)
        }
        return
      } catch (caught) {
        if (attempt > 0 || getOperateSessionErrorCode(caught) !== OPERATE_SESSION_ERROR_CODES.conflict) {
          throw caught
        }
        await waitForNewerThan(seq)
      }
    }
  }

  return (
    <OperateSessionContext.Provider value={{ snapshot, error, dispatch, session }}>
      {children}
    </OperateSessionContext.Provider>
  )
}

/** This tab's operate session, or null outside an `OperateSessionProvider` (Operate unavailable). */
export const useOperateSession = () => useContext(OperateSessionContext)
