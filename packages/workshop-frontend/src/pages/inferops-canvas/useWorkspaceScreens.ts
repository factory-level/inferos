import { useEffect, useState, useSyncExternalStore } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, GadgetMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import { parseCanvasDefinition, type CanvasDefinition } from '@gadgets/workshop-shared/canvas'
import type { OperateConsole } from '@gadgets/workshop-shared/operate-console'
import type { OperateFlow } from '@gadgets/workshop-shared/operate-flow'

/** At most this many recently active workspaces are opened to list their screens. */
export const MAX_SCREEN_WORKSPACES = 24

/** At most this many workspaces shared with the use role are opened to find their consoles. */
export const MAX_USE_CONSOLE_WORKSPACES = 24

/**
 * A listed workspace, with its saved screens (null when they could not be read) and the flows and
 * consoles authored over them. A workspace the user can build in lists all three; one shared with
 * them for use only is listed only when it holds consoles, read-only, with just the screens those
 * consoles show and no flows, which is all the use role can read (see `canBuild`).
 */
export type WorkspaceScreens = {
  workspace: GadgetMetadataWithTimestamps
  screens: CanvasDefinition[] | null
  flows: OperateFlow[]
  consoles: OperateConsole[]
}

/** The screen lists as loaded so far. */
export type WorkspaceScreensState =
  | { status: 'loading' } | { status: 'error' } | { status: 'ready'; workspaces: WorkspaceScreens[] }

// Loads in flight, per API stub and mode. The Operate sidebar and the InferOps Canvas home mount
// together and both list screens; sharing the load opens each workspace once, not twice.
const inFlight = new WeakMap<object, Map<string, Promise<WorkspaceScreens[]>>>()

// Bumped when screens, flows or consoles are created, changed or deleted, so mounted lists reload and a load already in flight
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
    const recent = all.toSorted((a, b) => new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime())
    const builds = recent.filter(workspace => workspace.role !== 'use').slice(0, MAX_SCREEN_WORKSPACES)
    // An operator without Build reaches their console through a workspace shared for use, which is
    // not among the recent build workspaces; it is listed only when it holds a console.
    const uses = durableViews ? recent.filter(workspace => workspace.role === 'use').slice(0, MAX_USE_CONSOLE_WORKSPACES) : []
    const operated = Promise.all(uses.map(async (workspace): Promise<WorkspaceScreens | null> => {
      const overseer = api.openGadget(workspace.id)
      try {
        const [consoles, screens] = await Promise.all([overseer.listConsoles(), overseer.listCanvases()])
        return consoles.length === 0 ? null : { workspace, screens: screens.map(parseCanvasDefinition), flows: [], consoles }
      } catch {
        return null
      } finally {
        overseer[Symbol.dispose]()
      }
    }))
    const built = Promise.all(builds.map(async (workspace): Promise<WorkspaceScreens> => {
      if (!durableViews) return { workspace, screens: [], flows: [], consoles: [] }
      // No observer callback: a workspace that first needs observer setup is skipped here and
      // set up when the user opens it.
      const overseer = api.openGadget(workspace.id)
      try {
        // All three reads ride one batch on the pipelined stub.
        const [screens, flows, consoles] =
          await Promise.all([overseer.listCanvases(), overseer.listFlows(), overseer.listConsoles()])
        return { workspace, screens: screens.map(parseCanvasDefinition), flows, consoles }
      } catch {
        return { workspace, screens: null, flows: [], consoles: [] }
      } finally {
        overseer[Symbol.dispose]()
      }
    }))
    const [listed, consoled] = await Promise.all([built, operated])
    return [...listed, ...consoled.filter(entry => entry !== null)]
  }).finally(() => byMode.delete(key))
  byMode.set(key, load)
  return load
}

/** Whether the user can author in a listed workspace: everything but a workspace shared for use. */
export const canBuild = (entry: WorkspaceScreens): boolean => entry.workspace.role !== 'use'

/**
 * The saved screens across the user's most recently active build workspaces, followed by the
 * workspaces shared with them for use that hold consoles. Screens live in each
 * workspace, so every listed workspace is opened (one pipelined call each) and its stub disposed
 * as soon as its screens are read. Callers mounted at the same time share one load.
 */
export const useWorkspaceScreens = (api: RpcStub<AuthenticatedApi>, durableViews: boolean): WorkspaceScreensState => {
  const [state, setState] = useState<WorkspaceScreensState>({ status: 'loading' })
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
