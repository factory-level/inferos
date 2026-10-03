import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, GadgetMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import { parseCanvasDefinition, type CanvasDefinition } from '@gadgets/workshop-shared/canvas'

/** At most this many recently active workspaces are opened to list their screens. */
export const MAX_SCREEN_WORKSPACES = 24

/** A workspace the user can build in, with its saved screens (null when they could not be read). */
export type WorkspaceScreens = { workspace: GadgetMetadataWithTimestamps; screens: CanvasDefinition[] | null }

type State = { status: 'loading' } | { status: 'error' } | { status: 'ready'; workspaces: WorkspaceScreens[] }

// Loads in flight, per API stub and mode. The Operate sidebar and the InferOps Canvas home mount
// together and both list screens; sharing the load opens each workspace once, not twice.
const inFlight = new WeakMap<object, Map<boolean, Promise<WorkspaceScreens[]>>>()

const loadWorkspaceScreens = (api: RpcStub<AuthenticatedApi>, durableViews: boolean) => {
  let byMode = inFlight.get(api)
  if (!byMode) inFlight.set(api, byMode = new Map())
  const pending = byMode.get(durableViews)
  if (pending) return pending
  const load = api.listGadgets().then(async all => {
    const workspaces = all.filter(workspace => workspace.role !== 'use')
      .toSorted((a, b) => new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime())
      .slice(0, MAX_SCREEN_WORKSPACES)
    return Promise.all(workspaces.map(async (workspace): Promise<WorkspaceScreens> => {
      if (!durableViews) return { workspace, screens: [] }
      // No observer callback: a workspace that first needs observer setup is skipped here and
      // set up when the user opens it.
      const overseer = api.openGadget(workspace.id)
      try {
        return { workspace, screens: (await overseer.listCanvases()).map(parseCanvasDefinition) }
      } catch {
        return { workspace, screens: null }
      } finally {
        overseer[Symbol.dispose]()
      }
    }))
  }).finally(() => byMode.delete(durableViews))
  byMode.set(durableViews, load)
  return load
}

/**
 * The saved screens across the user's most recently active build workspaces. Screens live in each
 * workspace, so every listed workspace is opened (one pipelined call each) and its stub disposed
 * as soon as its screens are read. Callers mounted at the same time share one load.
 */
export const useWorkspaceScreens = (api: RpcStub<AuthenticatedApi>, durableViews: boolean): State => {
  const [state, setState] = useState<State>({ status: 'loading' })
  useEffect(() => {
    let stale = false
    setState({ status: 'loading' })
    loadWorkspaceScreens(api, durableViews).then(
      workspaces => { if (!stale) setState({ status: 'ready', workspaces }) },
      () => { if (!stale) setState({ status: 'error' }) },
    )
    return () => { stale = true }
  }, [api, durableViews])
  return state
}
