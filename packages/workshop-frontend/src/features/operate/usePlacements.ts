import { useEffect, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { OperateSession } from '@gadgets/workshop-shared/api'
import type { OperateEventRecord } from '@gadgets/workshop-shared/operate-session'
import {
  WIDGET_PLACEMENT_ERROR_CODES, type WidgetPlacementInput, type WidgetPlacements,
} from '@gadgets/workshop-shared/widget-placements'
import { companyChangedSince, placementErrorCode, placementRefusalText } from './personalCanvas'

/** The person's placements as loaded. */
export type PlacementsState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; placements: WidgetPlacements }

/** Why the canvas was read again by itself, said once over it. */
export type PlacementsNotice = { kind: 'company-changed' | 'changed-elsewhere'; text: string } | null

export const COMPANY_CHANGED_TEXT =
  'Your canvas was cleared when you switched company: each company has its own, and the one you ' +
  'left is not kept.'
export const CHANGED_ELSEWHERE_TEXT =
  'Your canvas changed in another tab or on another device, so it now shows the latest. Make your change again.'

/**
 * The person's own Operate canvas (FAC-13) through their operate session: read on every new
 * session stub (a reconnect replaces it), and changed only at the revision last read. A change the
 * kernel refuses as a conflict reads the canvas again and says why: the person moved to another
 * company (the operate log records it, and the kernel cleared the former company's canvas), or
 * another tab changed it first. When a company change arrives while the canvas is shown, it is
 * read again at once. Any other refusal is returned in the kernel's words and changes nothing.
 */
export const usePlacements = (session: RpcStub<OperateSession> | null, recentEvents: readonly OperateEventRecord[]) => {
  const [state, setState] = useState<PlacementsState>({ status: 'loading' })
  const [notice, setNotice] = useState<PlacementsNotice>(null)
  const [reload, setReload] = useState(0)
  // When the canvas was last read, so only a company change after it reads as the reason.
  const readAt = useRef(0)

  useEffect(() => {
    if (!session) return
    let current = true
    setState(previous => previous.status === 'ready' ? previous : { status: 'loading' })
    session.listWidgetPlacements().then(
      placements => { if (current) { readAt.current = Date.now(); setState({ status: 'ready', placements }) } },
      () => { if (current) setState({ status: 'error' }) })
    return () => { current = false }
  }, [session, reload])

  // A company change while the canvas is shown: the kernel cleared it, so read it again and say so.
  const changed = companyChangedSince(recentEvents, readAt.current)
  useEffect(() => {
    if (!changed || readAt.current === 0) return
    setNotice({ kind: 'company-changed', text: COMPANY_CHANGED_TEXT })
    setReload(n => n + 1)
  }, [changed])

  const apply = async (change: (stub: RpcStub<OperateSession>, revision: number) => Promise<WidgetPlacements>)
      : Promise<string | null> => {
    if (!session || state.status !== 'ready') return 'Your canvas is still loading.'
    setNotice(null)
    try {
      const placements = await change(session, state.placements.revision)
      readAt.current = Date.now()
      setState({ status: 'ready', placements })
      return null
    } catch (caught) {
      const code = placementErrorCode(caught)
      if (code === WIDGET_PLACEMENT_ERROR_CODES.conflict || code === WIDGET_PLACEMENT_ERROR_CODES.notFound) {
        setNotice(companyChangedSince(recentEvents, readAt.current)
          ? { kind: 'company-changed', text: COMPANY_CHANGED_TEXT }
          : { kind: 'changed-elsewhere', text: CHANGED_ELSEWHERE_TEXT })
        setReload(n => n + 1)
        return null
      }
      return placementRefusalText(caught)
    }
  }

  return {
    state,
    notice,
    dismissNotice: () => setNotice(null),
    retry: () => setReload(n => n + 1),
    /** Saves a new placement or a change to one; resolves to the refusal's words, or null. */
    save: (input: WidgetPlacementInput) => apply((stub, revision) => stub.saveWidgetPlacement(input, revision)),
    /** Removes a placement; resolves to the refusal's words, or null. */
    remove: (placementId: string) => apply((stub, revision) => stub.removeWidgetPlacement(placementId, revision)),
  }
}
