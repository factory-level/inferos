import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { ActionLogEntry, Overseer } from '@gadgets/workshop-shared/api'
import { useActionEntries, useActions } from '../../useActions'
import { NO_ACTIVITY, foldBoardActivity, nextActivityChange, type BoardActivity } from './boardActivity'

// Entries received for one scope. Held with the stub they came from, so a render for another
// scope (another workspace, a reopened session) never reads them.
type ScopeLog = { overseer: RpcStub<Overseer>; records: ReadonlyMap<number, ActionLogEntry> }

const EMPTY_RECORDS: ReadonlyMap<number, ActionLogEntry> = new Map()

/**
 * The activity on one board, from the action log of the workspace whose capability `overseer` is.
 * It combines the log's live entries (replayed on mount) with the actions already pending when
 * the session opened, which the log pages rather than streams. `connected` is whether the board's
 * connection is currently usable; while it is not, nothing shows as awaiting. A null `targetRef`
 * has no activity. `clock` is injectable for tests.
 */
export const useBoardActivity = (
  overseer: RpcStub<Overseer>, targetRef: string | null, connected: boolean, clock: () => number = Date.now,
): { activity: BoardActivity; now: number } => {
  const [log, setLog] = useState<ScopeLog>(() => ({ overseer, records: EMPTY_RECORDS }))
  const { pending } = useActions(overseer)
  // Re-renders when a recent item crosses a minute or fades; the value itself is unused.
  const [, setTick] = useState(0)

  useActionEntries(overseer, record => {
    if (!record.resourceUrl) return
    setLog(previous => ({
      overseer,
      records: new Map(previous.overseer === overseer ? previous.records : EMPTY_RECORDS).set(record.id, record),
    }))
  })

  const live = log.overseer === overseer ? log.records : EMPTY_RECORDS
  // A live entry is newer than the paged copy of the same record, so it comes last and wins.
  const records = [...pending.filter(record => !live.has(record.id)), ...live.values()]
  const now = clock()
  const activity = targetRef === null ? NO_ACTIVITY : foldBoardActivity(records, targetRef, now, connected)
  const wake = nextActivityChange(activity, now)

  useEffect(() => {
    if (wake === null) return
    const timer = setTimeout(() => setTick(tick => tick + 1), Math.max(0, wake - clock()))
    return () => clearTimeout(timer)
  }, [wake, clock])

  return { activity, now }
}
