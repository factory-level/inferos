// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
// A use-role viewer sees a flow's step only through the published console open on the page, as
// ConsolePage shows its screens, and fails closed otherwise, reading nothing else; an owner or
// Build viewer reads the step from the workspace as before.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import type { CanvasDefinition } from '@gadgets/workshop-shared/canvas'
import type { OperateConsole } from '@gadgets/workshop-shared/operate-console'
import type { OperateConsoleRun, OperateFlowRun } from '@gadgets/workshop-shared/operate-session'
import type { ConsoleEntry } from './consoles'
import type { SessionWorkspace } from './useSessionWorkspace'

type Read = (...args: unknown[]) => Promise<unknown>
const doubles = vi.hoisted(() => ({
  opened: null as unknown as { overseer: { stub: Record<string, Mock<Read>> } | null; metadata: { role?: string } | null; error: unknown },
  canvas: null as null | { definition: { id: string; title: string }; overseer: unknown; resourceScope?: { overseer: unknown }; offeredBy?: unknown },
}))
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: {} }) }))
vi.mock('../../useWorkspaceOpen', () => ({ useWorkspaceOpen: () => doubles.opened }))
vi.mock('../../hooks/useWorkspaceWorkpieces', () => ({ useWorkspaceWorkpieces: () => ({ workpieces: new Map() }) }))
vi.mock('./BoardConnectPrompt', () => ({ BoardConnectPrompt: () => <div data-testid="connect" /> }))
vi.mock('../canvas/CanvasView', () => ({
  CanvasView: (props: NonNullable<typeof doubles.canvas>) => {
    doubles.canvas = props
    return <div data-testid="canvas">{props.definition.title}</div>
  },
}))

import { FlowScreen, type FlowConsole } from './FlowScreen'

const screen = (id: string, title: string): CanvasDefinition => ({ schemaVersion: 1, id, revision: '4', title, sections: [] })
const STEPS = ['s1', 's2', 's3']
const RUN: OperateFlowRun = { workspaceId: 'w1', flowId: 'intake', title: 'Intake', steps: STEPS, index: 1 }
const SNAPSHOT = { id: 'intake', revision: '0', title: 'Intake', steps: STEPS }
const CONSOLE = (revision: string, flows = [SNAPSHOT], views = STEPS): OperateConsole => {
  const content = { title: 'Intake console', fullChat: 'off' as const, flows: flows.map(flow => flow.id),
    views: views.map(id => ({ id, title: id, type: 'screen' as const, screen: id })) }
  return { ...content, id: 'c1', revision, published: { revision, publishedAt: '2026-10-14T00:00:00.000Z', content, flows } }
}
// As findConsole resolves it: the published revision, over the screens as published.
const PUBLISHED_COPY = screen('s2', 'Triage (published)')
const entry = (console = CONSOLE('3'), screens = [screen('s1', 'Intake'), PUBLISHED_COPY, screen('s3', 'Confirm')]): ConsoleEntry =>
  ({ workspace: { id: 'w1', role: 'use' } as never, console, screens, publishedScreens: screens })
const OPEN: OperateConsoleRun = { workspaceId: 'w1', consoleId: 'c1', title: 'Intake console', source: 'published',
  revision: '3', fullChat: 'off', viewId: 's1', screenId: null }
const SESSION: SessionWorkspace = { stub: { name: 'session' } as never, id: 'session-ws', restricted: false }
const shown = (extra: Partial<FlowConsole> = {}): FlowConsole =>
  ({ open: OPEN, entry: entry(), loading: false, sessionWorkspace: SESSION, ...extra })

let container: HTMLDivElement
let root: Root
let reads: Record<string, Mock<Read>>
const onTitle = vi.fn<(title: string | null) => void>()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  reads = {
    getCanvas: vi.fn<Read>(async () => screen('s2', 'Triage (live)')),
    listFlows: vi.fn<Read>(async () => []),
    listCanvases: vi.fn<Read>(async () => []),
  }
  doubles.opened = { overseer: { stub: reads }, metadata: { role: 'use' }, error: null }
  doubles.canvas = null
  onTitle.mockClear()
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

const render = async (console: FlowConsole, run = RUN) => {
  await act(async () => root.render(<FlowScreen run={run} console={console} onTitle={onTitle} />))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
const alert = () => container.querySelector('[role="alert"]')?.textContent
const NOT_OPEN = "This flow's console is not open. Exit the flow and start it again from its console."
const CHANGED = 'This console has changed since the flow started. Exit the flow and start it again from its console.'
const readNothing = () => {
  for (const read of Object.values(reads)) expect(read).not.toHaveBeenCalled()
}

it('U-1: draws the published copy from the open console, its frozen widgets and the session board scope', async () => {
  await render(shown())
  expect(doubles.canvas?.definition).toBe(PUBLISHED_COPY)
  expect(doubles.canvas?.offeredBy).toEqual({ consoleId: 'c1', revision: '3' })
  expect(doubles.canvas?.resourceScope?.overseer).toBe(SESSION.stub)
  expect(onTitle).toHaveBeenLastCalledWith('Triage (published)')
  expect(alert()).toBeUndefined()
  readNothing()
})

it.each([
  ['U-2: no console is open', shown({ open: null })],
  ['U-3: another console is open', shown({ open: { ...OPEN, consoleId: 'c2' }, entry: entry({ ...CONSOLE('3', []), id: 'c2' }) })],
  ['U-3: a console of another workspace is open', shown({ open: { ...OPEN, workspaceId: 'w2' } })],
  ['U-3: a draft preview is open', shown({ open: { ...OPEN, source: 'draft' } })],
  ['the open console is gone', shown({ entry: undefined })],
])('%s: unavailable, saying to start again from its console, reading nothing', async (_name, console) => {
  await render(console)
  expect(alert()).toBe(NOT_OPEN)
  expect(doubles.canvas).toBeNull()
  readNothing()
})

it.each([
  ['U-4: a newer revision was published', shown({ entry: entry(CONSOLE('4')) })],
  ['U-5: the snapshot has other steps', shown({ entry: entry(CONSOLE('3', [{ ...SNAPSHOT, steps: ['s3', 's2', 's1'] }])) })],
  ['U-5: the snapshot has another title', shown({ entry: entry(CONSOLE('3', [{ ...SNAPSHOT, title: 'Intake v2' }])) })],
])('%s: unavailable as changed, reading nothing', async (_name, console) => {
  await render(console)
  expect(alert()).toBe(CHANGED)
  expect(doubles.canvas).toBeNull()
  readNothing()
})

it('U-6: unavailable when the console does not show the step, reading nothing', async () => {
  for (const console of [
    shown({ entry: entry(CONSOLE('3', [SNAPSHOT], ['s1', 's3'])) }),
    shown({ entry: entry(CONSOLE('3'), [screen('s1', 'Intake'), screen('s3', 'Confirm')]) }),
  ]) {
    await render(console)
    expect(alert()).toMatch(/^This step is unavailable/)
    expect(doubles.canvas).toBeNull()
  }
  readNothing()
})

it.each([['an owner', {}], ['a Build collaborator', { role: 'build' }]])(
  'U-7: %s reads the step from the workspace, as before', async (_name, metadata) => {
    doubles.opened = { ...doubles.opened, metadata }
    await render(shown({ open: null, entry: undefined }))
    expect(reads.getCanvas).toHaveBeenCalledWith('s2')
    expect(doubles.canvas?.definition.title).toBe('Triage (live)')
    expect(doubles.canvas?.offeredBy).toBeUndefined()
    expect(doubles.canvas?.resourceScope).toBeUndefined()
  })

it('U-8: loading while the role, the consoles or the session workspace are unknown; unavailable on an open error', async () => {
  doubles.opened = { ...doubles.opened, metadata: null }
  await render(shown())
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Loading step…')
  readNothing()
  doubles.opened = { ...doubles.opened, metadata: { role: 'use' } }
  for (const console of [shown({ loading: true, entry: undefined }), shown({ sessionWorkspace: null })]) {
    await render(console)
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Loading step…')
    expect(doubles.canvas).toBeNull()
  }
  doubles.opened = { ...doubles.opened, error: new Error('denied') }
  await render(shown())
  expect(alert()).toMatch(/^This step is unavailable/)
  readNothing()
})
