import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { RpcStub } from 'capnweb'
import {
  getOperateSessionErrorCode,
  OPERATE_SESSION_ERROR_CODES,
  type OperateSession,
} from '@gadgets/workshop-shared/api'
import type { OperateEvent, OperateEventRecord, OperateSessionSnapshot } from '@gadgets/workshop-shared/operate-session'
import { useAuthenticatedApi } from '../../AuthContext'
import { invalidateWorkspaceScreens } from '../../pages/inferops-canvas/useWorkspaceScreens'

/** How long a conflicting dispatch waits for the newer snapshot before giving up. */
const CONFLICT_WAIT_MS = 2000

/** How many of the latest log entries a tab keeps, to say who last changed the page and how. */
const RECENT_EVENTS = 20

const mergeRecords = (held: OperateEventRecord[], more: OperateEventRecord[]) => {
  const bySeq = new Map(held.map(record => [record.seq, record]))
  for (const record of more) bySeq.set(record.seq, record)
  return [...bySeq.values()].toSorted((a, b) => a.seq - b.seq).slice(-RECENT_EVENTS)
}

type OperateSessionValue = {
  /** The session's page as of its latest event; null until the first snapshot arrives. */
  snapshot: OperateSessionSnapshot | null
  /**
   * The latest log entries, oldest first: the tail as of opening, then each later one as it lands.
   * Each names its actor, so the page can say what the operate agent did.
   */
  recentEvents: OperateEventRecord[]
  /** Set when the session could not be reached. */
  error: string | null
  /**
   * Appends an event at the latest known sequence number. On a conflict (another tab or the agent
   * moved first) it waits for the newer snapshot and retries once against it. A `consoleChanged`
   * refusal means this tab's copy of a console is out of date, so the saved consoles are re-read
   * before it rejects.
   */
  dispatch: (event: OperateEvent) => Promise<void>
  /** The session capability, for the session workspace (its operate chat). */
  session: { stub: RpcStub<OperateSession> } | null
  /**
   * The console revision the kernel last said has moved on (republished or deleted elsewhere)
   * while this session had it open, or null. A run still naming exactly this revision shows
   * nothing more of it: the kernel refuses its reads and navigation.
   */
  staleConsole: StaleConsole | null
}

/** A console revision a session had open when the kernel said it moved on. */
export type StaleConsole = { workspaceId: string; consoleId: string; revision: string }

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
  const [recentEvents, setRecentEvents] = useState<OperateEventRecord[]>([])
  const [staleConsole, setStaleConsole] = useState<StaleConsole | null>(null)
  // The latest seq seen and the waiters for a newer one, outside render so dispatch reads them fresh.
  const latest = useRef<{ seq: number; waiters: Array<() => void> }>({ seq: 0, waiters: [] })

  useEffect(() => {
    let cancelled = false
    let subscription: RpcStub<{}> | undefined
    const stub = authenticatedApi.getOperateSession()
    setSession({ stub })
    stub.subscribe(update => {
      if (cancelled) return
      // A notice repeats the page unchanged, whose run it found stale. The saved consoles are
      // re-read so the console reopens at its new revision.
      const notice = update.consoleRevision
      if (notice) {
        const run = update.state.console
        if (run?.workspaceId === notice.workspaceId && run.consoleId === notice.consoleId && run.revision !== notice.revision) {
          setStaleConsole({ workspaceId: run.workspaceId, consoleId: run.consoleId, revision: run.revision })
          invalidateWorkspaceScreens()
        }
        return
      }
      if (update.record) {
        const record = update.record
        setRecentEvents(held => mergeRecords(held, [record]))
      } else {
        // The first, current-state call: fetch the tail it summarizes. Live entries may land
        // first; merging by seq keeps each once.
        stub.listEvents(Math.max(0, update.seq - RECENT_EVENTS), RECENT_EVENTS).then(tail => {
          if (!cancelled) setRecentEvents(held => mergeRecords(held, tail))
        }).catch(caught => console.error('Failed to read the operate session log:', caught))
      }
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
      setRecentEvents([])
      setStaleConsole(null)
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
        const code = getOperateSessionErrorCode(caught)
        if (code === OPERATE_SESSION_ERROR_CODES.consoleChanged) invalidateWorkspaceScreens()
        if (attempt > 0 || code !== OPERATE_SESSION_ERROR_CODES.conflict) {
          throw caught
        }
        await waitForNewerThan(seq)
      }
    }
  }

  return (
    <OperateSessionContext.Provider value={{ snapshot, recentEvents, error, dispatch, session, staleConsole }}>
      {children}
    </OperateSessionContext.Provider>
  )
}

/** This tab's operate session, or null outside an `OperateSessionProvider` (Operate unavailable). */
export const useOperateSession = () => useContext(OperateSessionContext)
