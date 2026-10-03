// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { ActionLogEntry, ActionsSubscriber, Overseer } from '@gadgets/workshop-shared/api'
import { RECENT_ACTIVITY_MS } from './boardActivity'
import { useBoardActivity } from './useBoardActivity'

const BOARD = 'inferops://demo.local/project/board/DEMO'
const T0 = Date.UTC(2026, 9, 2, 12)
let now = T0
const clock = () => now

const entry = (id: number, type: 'action' | 'observation', state: ActionLogEntry['state'], title: string): ActionLogEntry => ({
  id, type, state, resourceUrl: BOARD, resourceTitle: 'InferOps board DEMO', createdAt: new Date(T0), requestedBy: 'agent',
  description: { title, description: '' },
} as ActionLogEntry)

// A workspace's capability: its live action stream and its pending page.
const scope = (pending: ActionLogEntry[] = []) => {
  const live: { subscriber?: ActionsSubscriber } = {}
  const overseer = {
    subscribeToActions: async (subscriber: ActionsSubscriber) => { live.subscriber = subscriber; return { [Symbol.dispose]: () => {} } },
    listActions: async () => ({ entries: pending }),
  } as unknown as RpcStub<Overseer>
  return { overseer, push: (record: ActionLogEntry) => act(async () => { live.subscriber?.entry(record) }) }
}

const Probe = ({ overseer, name, connected = true }: { overseer: RpcStub<Overseer>; name: string; connected?: boolean }) => {
  const { activity } = useBoardActivity(overseer, BOARD, connected, clock)
  return <ul data-probe={name}>{[...activity.active, ...activity.recent].map(item => <li key={item.id}>{item.kind}:{item.title}</li>)}</ul>
}

let root: Root
let container: HTMLDivElement
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
const shown = (name: string) => [...container.querySelectorAll(`[data-probe="${name}"] li`)].map(li => li.textContent)

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  now = T0
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals() })

it("never shows another workspace's entries, and drops a scope's entries when the card moves to another scope", async () => {
  const a = scope()
  const b = scope()
  await act(async () => root.render(<><Probe overseer={a.overseer} name="a" /><Probe overseer={b.overseer} name="b" /></>))
  await settle()
  await a.push(entry(1, 'observation', 'approved', 'Read InferOps board DEMO'))
  await b.push(entry(1, 'action', 'pending', 'Move DEMO-9 to Done'))
  expect(shown('a')).toEqual(['read:Read InferOps board DEMO'])
  expect(shown('b')).toEqual(['awaiting:Move DEMO-9 to Done'])

  await act(async () => root.render(<><Probe overseer={b.overseer} name="a" /><Probe overseer={b.overseer} name="b" /></>))
  await settle()
  expect(shown('a')).toEqual(['awaiting:Move DEMO-9 to Done'])
})

it('shows actions already pending when the session opened, and moves them to recent once decided live', async () => {
  const pending = entry(4, 'action', 'pending', 'Move DEMO-1 to Done')
  const a = scope([pending])
  await act(async () => root.render(<Probe overseer={a.overseer} name="a" />))
  await settle()
  expect(shown('a')).toEqual(['awaiting:Move DEMO-1 to Done'])
  await a.push({ ...pending, state: 'approved', appliedAt: new Date(T0 + 1000) } as ActionLogEntry)
  await settle()
  expect(shown('a')).toEqual(['applied:Move DEMO-1 to Done'])
})

it('clears awaiting activity while the connection is not usable', async () => {
  const a = scope([entry(4, 'action', 'pending', 'Move DEMO-1 to Done')])
  await act(async () => root.render(<Probe overseer={a.overseer} name="a" />))
  await settle()
  expect(shown('a')).toHaveLength(1)
  await act(async () => root.render(<Probe overseer={a.overseer} name="a" connected={false} />))
  expect(shown('a')).toEqual([])
})

it('fades a recent item on its own once the window has passed', async () => {
  const a = scope()
  await act(async () => root.render(<Probe overseer={a.overseer} name="a" />))
  await settle()
  vi.useFakeTimers()
  await a.push(entry(1, 'observation', 'approved', 'Read InferOps board DEMO'))
  expect(shown('a')).toHaveLength(1)
  now = T0 + RECENT_ACTIVITY_MS
  await act(async () => { vi.advanceTimersByTime(RECENT_ACTIVITY_MS) })
  expect(shown('a')).toEqual([])
})
