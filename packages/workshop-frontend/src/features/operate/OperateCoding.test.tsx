// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
// Code is not edited from Operate: a board on a session screen or a flow step never offers coding
// dispatch, and never even looks up the project's coding-dispatch connection, though the workspace
// holds one and the same board on the workspace's own canvas would offer it.
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { CanvasDefinition } from '@gadgets/workshop-shared/canvas'
import type { Board } from '@inferos/gatekeeper-inferops/src/types'
import { FlowScreen } from './FlowScreen'
import { SessionScreen } from './SessionScreen'

const BOARD = 'inferops://demo.local/project/board/DEMO'
const DISPATCH = 'inferops://demo.local/project/dispatch/DEMO'
const screen: CanvasDefinition = { schemaVersion: 1, id: 'ops', revision: '0', title: 'Ops', sections: [{ id: 'main', title: 'Main', columns: 1,
  widgets: [{ id: 'b', kind: 'inferops.project-board', version: 1, targetRef: BOARD, size: 'wide', params: { workflow: 'software', showCompleted: false } }] }] }
const board: Board = {
  project: { id: 'p', identifier: 'DEMO', name: 'Demo' },
  columns: [{ state: { id: 'todo', name: 'Todo', group: 'unstarted', position: 0, workflow: 'software' }, issues: [{
    id: '1', identifier: 'DEMO-1', title: 'Issue 1', priority: 'none', stateId: 'todo', targetDate: null, workflow: 'software',
    revision: '7', assigneeId: null, blockedReason: null,
  }] }],
}
const dispatchSession = { listRepos: async () => [], listRuns: async () => [], [Symbol.dispose]: () => {} }
const boardSession = { readBoard: async () => board, [Symbol.dispose]: () => {} }
const lookup = vi.fn<(url: string) => Promise<object | null>>(async url => ({
  openSession: async () => url === DISPATCH ? dispatchSession : boardSession, [Symbol.dispose]: () => {},
}))
const overseer = {
  getGatekeeperByResourceUrl: lookup,
  getCanvas: async () => screen,
  listCanvases: async () => [screen],
  subscribeToActions: async () => ({ [Symbol.dispose]: () => {} }),
  listActions: async () => ({ entries: [] }),
} as unknown as RpcStub<Overseer>

vi.mock('@cloudflare/kumo', async importOriginal => ({
  ...(await import('../canvas/kumoPopupDoubles')).withKumoPopupDoubles(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: () => {} }),
}))
vi.mock('../../GadgetUI', () => ({ default: () => null }))
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: {} }) }))
const serverConfig = { canvasFeatures: { composableViews: true, durableViews: true } }
vi.mock('../../ServerConfigContext', () => ({ useServerConfig: () => serverConfig }))
// Stable across renders, as the real hooks' results are.
const opened = { overseer: { stub: overseer }, metadata: { role: 'build' }, error: null }
const workpieces = { workpieces: new Map(), ready: true }
vi.mock('../../useWorkspaceOpen', () => ({ useWorkspaceOpen: () => opened }))
vi.mock('../../hooks/useWorkspaceWorkpieces', () => ({ useWorkspaceWorkpieces: () => workpieces }))

let root: Root
let container: HTMLDivElement
const render = async (element: ReactElement) => {
  await act(async () => root.render(element))
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  lookup.mockClear()
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

it.each([
  ['a session screen', () => <SessionScreen workspaceId="w" screenId="ops" onShowScreen={() => {}} onClose={() => {}} />],
  ['a flow step', () => <FlowScreen workspaceId="w" screenId="ops" onTitle={() => {}} />],
])('shows the board on %s with no coding control, without looking up the coding-dispatch connection', async (_name, element) => {
  await render(element())
  expect(container.querySelector('[data-issue-id="1"]')).not.toBeNull()
  expect(container.querySelector('button[aria-label="Coding task for DEMO-1"]')).toBeNull()
  expect(lookup.mock.calls.map(([url]) => url)).toContain(BOARD)
  expect(lookup.mock.calls.map(([url]) => url)).not.toContain(DISPATCH)
})
