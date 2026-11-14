import { useEffect, useState } from 'react'
import type { AuthenticatedApi, ConsoleSummary } from '@gadgets/workshop-shared/api'
import type { RpcStub } from 'capnweb'

/** The person's consoles that belong to no workspace, while loading, once listed, or when listing failed. */
export type MyConsolesState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; consoles: readonly ConsoleSummary[] }

const listeners = new Set<() => void>()

/** Re-reads the list wherever it is shown: after a console is created, saved, published or shared. */
export const invalidateMyConsoles = () => { for (const listener of listeners) listener() }

/** Lists the person's consoles that belong to no workspace. One call; it opens no console. */
export const useMyConsoles = (authenticatedApi: RpcStub<AuthenticatedApi>, enabled: boolean): MyConsolesState => {
  const [state, setState] = useState<MyConsolesState>({ status: 'loading' })
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const listener = () => setVersion(current => current + 1)
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, [])
  useEffect(() => {
    if (!enabled) {
      setState({ status: 'ready', consoles: [] })
      return
    }
    let cancelled = false
    authenticatedApi.listMyConsoles().then(
      consoles => { if (!cancelled) setState({ status: 'ready', consoles }) },
      caught => {
        console.error('Failed to list consoles:', caught)
        if (!cancelled) setState({ status: 'error' })
      })
    return () => { cancelled = true }
  }, [authenticatedApi, enabled, version])
  return state
}
