// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, GadgetMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import type { CanvasDefinition } from '@gadgets/workshop-shared/canvas'
import type { OperateConsole } from '@gadgets/workshop-shared/operate-console'
import { canBuild, recheckWorkspaceScreens, RECHECK_FLOOR_MS, retryWorkspaceScreens, useWorkspaceScreens, type WorkspaceScreensState } from './useWorkspaceScreens'
import { LOAD_TIMEOUT_MS, WORKSPACE_READ_TIMEOUT_MS } from '../../loadTimeout'

const CONSOLE: OperateConsole = { id: 'c1', revision: '0', published: null, title: 'Operations lead', fullChat: 'off',
  views: [{ id: 'board', title: 'Board', type: 'screen', screen: 's1' }] }
const workspace = (id: string, role: 'build' | 'use' | undefined, lastActive: string) =>
  ({ id, title: id, role, lastActive: new Date(lastActive) }) as unknown as GadgetMetadataWithTimestamps
const denied = () => Promise.reject(new Error('Unauthorized'))

// Each workspace as its role sees it: the use role lists consoles and the screens they show, not flows.
const fakeApi = (consolesOf: Record<string, OperateConsole[]>, list: GadgetMetadataWithTimestamps[],
    consoleScreensOf: Record<string, CanvasDefinition[]> = {}, publishedOf: Record<string, CanvasDefinition> = {}) => {
  const opened: string[] = []
  const api = {
    listGadgets: async () => list,
    openGadget: (id: string) => {
      opened.push(id)
      const use = list.find(item => item.id === id)?.role === 'use'
      return {
        listCanvases: async () => use ? consoleScreensOf[id] ?? [] : [],
        listFlows: use ? denied : async () => [],
        listConsoles: async () => consolesOf[id] ?? [],
        getConsoleScreen: async (consoleId: string, screenId: string, source: string) =>
          source === 'published' ? publishedOf[`${consoleId}/${screenId}`] ?? null : null,
        [Symbol.dispose]: () => {},
      }
    },
  }
  return { api: api as unknown as RpcStub<AuthenticatedApi>, opened }
}

let root: Root
let container: HTMLDivElement
let state: WorkspaceScreensState = { status: 'loading' }
const Probe = ({ api }: { api: RpcStub<AuthenticatedApi> }) => { state = useWorkspaceScreens(api, true); return null }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals() })

it('lists use-role workspaces that hold consoles, read-only, after the build workspaces', async () => {
  const screen: CanvasDefinition = { schemaVersion: 1, id: 's1', revision: '0', title: 'Board', sections: [] }
  const { api } = fakeApi({ shared: [CONSOLE] }, [
    workspace('shared', 'use', '2026-01-01'),
    workspace('empty', 'use', '2026-06-01'),
    workspace('mine', undefined, '2026-03-01'),
  ], { shared: [screen] })
  await act(async () => root.render(<Probe api={api} />))
  if (state.status !== 'ready') throw new Error(`not ready: ${state.status}`)
  expect(state.workspaces.map(entry => entry.workspace.id)).toEqual(['mine', 'shared'])
  const shared = state.workspaces[1]!
  expect(shared).toMatchObject({ screens: [screen], flows: [], consoles: [CONSOLE] })
  expect(canBuild(shared)).toBe(false)
  expect(canBuild(state.workspaces[0]!)).toBe(true)
})

it('keeps each published console\'s screens as published, apart from the workspace\'s current screens', async () => {
  const current: CanvasDefinition = { schemaVersion: 1, id: 's1', revision: '2', title: 'Board v2', sections: [] }
  const published: CanvasDefinition = { ...current, revision: '1', title: 'Board' }
  const live = { ...CONSOLE, id: 'live', revision: '3', published: { revision: '3', publishedAt: '2026-10-06T00:00:00.000Z', content: CONSOLE } }
  const { api } = fakeApi({ mine: [CONSOLE, live] }, [workspace('mine', 'build', '2026-03-01')], {}, { 'live/s1': published })
  await act(async () => root.render(<Probe api={api} />))
  if (state.status !== 'ready') throw new Error(`not ready: ${state.status}`)
  expect(state.workspaces[0]!.publishedScreens).toEqual({ live: [published] })
})

it('coalesces rechecks: one reload in flight at a time, at least the floor apart, with one trailing reload', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const loads: Array<() => void> = []
  const api = {
    listGadgets: () => new Promise<GadgetMetadataWithTimestamps[]>(resolve => loads.push(() => resolve([]))),
    openGadget: () => { throw new Error('unused') },
  } as unknown as RpcStub<AuthenticatedApi>
  const finish = (index: number) => act(async () => loads[index]!())
  const advance = (ms: number) => act(async () => { vi.advanceTimersByTime(ms) })
  await act(async () => root.render(<Probe api={api} />))
  await finish(0)
  await advance(RECHECK_FLOOR_MS)

  // A burst asks once: a reload starts at once, and later asks wait while it is in flight.
  for (let i = 0; i < 5; i++) await act(async () => recheckWorkspaceScreens())
  expect(loads).toHaveLength(2)
  await advance(RECHECK_FLOOR_MS * 2)
  expect(loads).toHaveLength(2)
  // Asked again while in flight: one trailing reload once it settles and the floor has passed.
  await act(async () => recheckWorkspaceScreens())
  await act(async () => recheckWorkspaceScreens())
  await finish(1)
  expect(loads).toHaveLength(3)
  await finish(2)
  // Within the floor of the last start, a recheck waits for it.
  await act(async () => recheckWorkspaceScreens())
  await advance(RECHECK_FLOOR_MS - 1)
  expect(loads).toHaveLength(3)
  await advance(1)
  expect(loads).toHaveLength(4)
  await finish(3)
})

// FAC-155: a failed or hung load ends in `error`, never a list that looks empty, and one workspace
// that never answers doesn't hold up the others.
const never = () => new Promise<never>(() => {})

it('a failed workspace list is an error, not an empty list', async () => {
  const api = { listGadgets: () => Promise.reject(new Error('down')) } as unknown as RpcStub<AuthenticatedApi>
  await act(async () => root.render(<Probe api={api} />))
  expect(state).toEqual({ status: 'error' })
})

it('a workspace list that never answers becomes an error after the load timeout', async () => {
  vi.useFakeTimers()
  const api = { listGadgets: never } as unknown as RpcStub<AuthenticatedApi>
  await act(async () => root.render(<Probe api={api} />))
  expect(state).toEqual({ status: 'loading' })
  await act(async () => { await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS) })
  expect(state).toEqual({ status: 'error' })
})

it('a workspace whose reads never answer is listed as unreadable, and the rest still load', async () => {
  vi.useFakeTimers()
  const { api } = fakeApi({}, [workspace('slow', undefined, '2026-02-01'), workspace('quick', undefined, '2026-01-01')])
  const stub = api as unknown as { openGadget: (id: string) => Record<string, unknown> }
  const open = stub.openGadget
  stub.openGadget = (id: string) => id === 'slow'
    ? { listCanvases: never, listFlows: never, listConsoles: never, [Symbol.dispose]: () => {} }
    : open(id)
  await act(async () => root.render(<Probe api={api} />))
  await act(async () => { await vi.advanceTimersByTimeAsync(WORKSPACE_READ_TIMEOUT_MS) })
  if (state.status !== 'ready') throw new Error(`not ready: ${state.status}`)
  expect(state.workspaces.map(entry => [entry.workspace.id, entry.screens])).toEqual([['slow', null], ['quick', []]])
})

it('a use-role workspace whose reads never answer stays listed as unreadable, not dropped', async () => {
  vi.useFakeTimers()
  const { api } = fakeApi({}, [workspace('mine', undefined, '2026-02-01'), workspace('shared', 'use', '2026-01-01')])
  const stub = api as unknown as { openGadget: (id: string) => Record<string, unknown> }
  const open = stub.openGadget
  stub.openGadget = (id: string) => id === 'shared'
    ? { listCanvases: never, listFlows: never, listConsoles: never, [Symbol.dispose]: () => {} }
    : open(id)
  await act(async () => root.render(<Probe api={api} />))
  await act(async () => { await vi.advanceTimersByTimeAsync(WORKSPACE_READ_TIMEOUT_MS) })
  if (state.status !== 'ready') throw new Error(`not ready: ${state.status}`)
  expect(state.workspaces.map(entry => [entry.workspace.id, entry.screens])).toEqual([['mine', []], ['shared', null]])
})

it('a use-role workspace whose reads fail stays listed as unreadable too', async () => {
  const { api } = fakeApi({}, [workspace('shared', 'use', '2026-01-01')])
  const stub = api as unknown as { openGadget: (id: string) => Record<string, unknown> }
  stub.openGadget = () => ({ listCanvases: denied, listFlows: denied, listConsoles: denied, [Symbol.dispose]: () => {} })
  await act(async () => root.render(<Probe api={api} />))
  if (state.status !== 'ready') throw new Error(`not ready: ${state.status}`)
  expect(state.workspaces.map(entry => [entry.workspace.id, entry.screens])).toEqual([['shared', null]])
})

it('Try again loads the list again after a failure', async () => {
  let calls = 0
  const api = { listGadgets: async () => { calls++; if (calls === 1) throw new Error('down'); return [] }, openGadget: () => ({}) } as unknown as RpcStub<AuthenticatedApi>
  await act(async () => root.render(<Probe api={api} />))
  expect(state).toEqual({ status: 'error' })
  await act(async () => retryWorkspaceScreens())
  expect(state).toEqual({ status: 'ready', workspaces: [] })
})
