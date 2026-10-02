import { useEffect, useState, useSyncExternalStore } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, GadgetMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import { parseCanvasDefinition, type CanvasDefinition } from '@gadgets/workshop-shared/canvas'
import type { OperateFlow } from '@gadgets/workshop-shared/operate-flow'

/** At most this many recently active workspaces are opened to list their screens. */
export const MAX_SCREEN_WORKSPACES = 24

/**
 * A workspace the user can build in, with its saved screens (null when they could not be read) and
 * the flows authored over them.
 */
export type WorkspaceScreens = {
  workspace: GadgetMetadataWithTimestamps
  screens: CanvasDefinition[] | null
  flows: OperateFlow[]
}

type State = { status: 'loading' } | { status: 'error' } | { status: 'ready'; workspaces: WorkspaceScreens[] }

// Loads in flight, per API stub and mode. The Operate sidebar and the InferOps Canvas home mount
// together and both list screens; sharing the load opens each workspace once, not twice.
const inFlight = new WeakMap<object, Map<string, Promise<WorkspaceScreens[]>>>()

// Bumped when screens or flows are created, changed or deleted, so mounted lists reload and a load already in flight
// for the old revision isn't reused.
let screensRevision = 0
const revisionListeners = new Set<() => void>()
const subscribeRevision = (listener: () => void) => {
  revisionListeners.add(listener)
  return () => { revisionListeners.delete(listener) }
}
const getRevision = () => screensRevision

/** Marks every screen list stale (after a screen or flow changes) so mounted lists reload. */
export const invalidateWorkspaceScreens = () => {
  screensRevision++
  for (const listener of revisionListeners) listener()
}

const loadWorkspaceScreens = (api: RpcStub<AuthenticatedApi>, durableViews: boolean) => {
  let byMode = inFlight.get(api)
  if (!byMode) inFlight.set(api, byMode = new Map())
  const key = `${durableViews}:${screensRevision}`
  const pending = byMode.get(key)
  if (pending) return pending
  const load = api.listGadgets().then(async all => {
    const workspaces = all.filter(workspace => workspace.role !== 'use')
      .toSorted((a, b) => new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime())
      .slice(0, MAX_SCREEN_WORKSPACES)
    return Promise.all(workspaces.map(async (workspace): Promise<WorkspaceScreens> => {
      if (!durableViews) return { workspace, screens: [], flows: [] }
      // No observer callback: a workspace that first needs observer setup is skipped here and
      // set up when the user opens it.
      const overseer = api.openGadget(workspace.id)
      try {
        // Both reads ride one batch on the pipelined stub.
        const [screens, flows] = await Promise.all([overseer.listCanvases(), overseer.listFlows()])
        return { workspace, screens: screens.map(parseCanvasDefinition), flows }
      } catch {
        return { workspace, screens: null, flows: [] }
      } finally {
        overseer[Symbol.dispose]()
      }
    }))
  }).finally(() => byMode.delete(key))
  byMode.set(key, load)
  return load
}

/**
 * The saved screens across the user's most recently active build workspaces. Screens live in each
 * workspace, so every listed workspace is opened (one pipelined call each) and its stub disposed
 * as soon as its screens are read. Callers mounted at the same time share one load.
 */
export const useWorkspaceScreens = (api: RpcStub<AuthenticatedApi>, durableViews: boolean): State => {
  const [state, setState] = useState<State>({ status: 'loading' })
  const revision = useSyncExternalStore(subscribeRevision, getRevision)
  useEffect(() => {
    let stale = false
    // A reload keeps showing the previous list until the new one arrives.
    setState(previous => previous.status === 'ready' ? previous : { status: 'loading' })
    loadWorkspaceScreens(api, durableViews).then(
      workspaces => { if (!stale) setState({ status: 'ready', workspaces }) },
      () => { if (!stale) setState({ status: 'error' }) },
    )
    return () => { stale = true }
  }, [api, durableViews, revision])
  return state
}
