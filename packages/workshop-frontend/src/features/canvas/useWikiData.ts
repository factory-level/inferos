import { useEffect, useState, useSyncExternalStore } from 'react'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { useActionEntries } from '../../useActions'
import { canonicalBoardRef } from './boardData'
import { LOADING_WIKI, WikiData, type WikiSnapshot } from './wikiData'

const noSubscription = () => () => {}

/**
 * The Wiki at `targetRef`, read through the workspace whose capability `overseer` is. One instance
 * per widget, disposed with it (its session included). The Wiki is re-read when an action on it
 * leaves `pending` in the action log, by whoever decided it, so an edit's outcome shows from the
 * page itself; every record is also offered to the body edits, to tell their own approval apart.
 */
export const useWikiData = (overseer: RpcStub<Overseer>, targetRef: string): { snapshot: WikiSnapshot; data: WikiData | null } => {
  const [held, setHeld] = useState<{ overseer: RpcStub<Overseer>; data: WikiData } | null>(null)
  useEffect(() => {
    const data = new WikiData(overseer, targetRef)
    setHeld({ overseer, data })
    return () => { data.dispose(); setHeld(null) }
  }, [overseer, targetRef])
  // Until the effect for a new scope or reference has run, the held instance is the previous one's.
  const data = held && held.overseer === overseer && held.data.target === canonicalBoardRef(targetRef) ? held.data : null
  const snapshot = useSyncExternalStore(data?.subscribe ?? noSubscription, () => data?.snapshot ?? LOADING_WIKI)

  useActionEntries(overseer, record => {
    data?.noteAction(record)
    if (record.type === 'action' && record.state !== 'pending' && record.resourceUrl && data &&
      canonicalBoardRef(record.resourceUrl) === data.target) data.refresh()
  })

  return { snapshot, data }
}
