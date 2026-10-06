// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, GadgetMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import type { CanvasDefinition } from '@gadgets/workshop-shared/canvas'
import type { OperateConsole } from '@gadgets/workshop-shared/operate-console'
import { canBuild, useWorkspaceScreens, type WorkspaceScreensState } from './useWorkspaceScreens'

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
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

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
