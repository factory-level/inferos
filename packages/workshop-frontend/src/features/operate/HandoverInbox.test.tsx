// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import { createOperateSessionError, OPERATE_SESSION_ERROR_CODES, type Overseer } from '@gadgets/workshop-shared/api'
import type { OperateEvent, OperateHandover } from '@gadgets/workshop-shared/operate-session'

const api = vi.hoisted(() => ({
  authenticatedApi: {
    subscribeConnectedAccounts: (subscriber: { add: (...args: unknown[]) => void; ready: () => void }) => {
      subscriber.add(7, { displayName: 'me@acme.test' }, { displayName: 'InferOps' }, [], true, 'inferops')
      subscriber.ready()
      return Object.assign(Promise.resolve({}), { [Symbol.dispose]: () => {} })
    },
  },
}))
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => api }))
vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: unknown }) => <a href="/gatekeepers">{children as never}</a> }))

import { HandoverInbox } from './HandoverInbox'

const handover: OperateHandover = {
  id: 'h1', from: { id: 'alice', name: 'Alice' }, to: { id: 'me', name: 'Me' },
  boardRef: 'inferops://acme.operations/project/board/ENG', issueId: 'issue-1', note: 'Over to you',
}
const newGatekeeper = vi.fn<(accountId: number, url: string) => Promise<object | null>>()
const workspace = { id: 'my-session', stub: { newGatekeeper } as unknown as RpcStub<Overseer>, restricted: false }
const onEvent = vi.fn<(event: OperateEvent) => Promise<void>>()
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  onEvent.mockReset().mockResolvedValue(); newGatekeeper.mockReset()
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })
const render = () => act(async () => root.render(<HandoverInbox handovers={[handover]} workspace={workspace} onEvent={onEvent} />))
const button = (text: string) => [...container.querySelectorAll('button')].find(b => b.textContent === text)!

it('opens a handover in the person\'s own session workspace, with its issue, then clears it', async () => {
  await render()
  expect(container.textContent).toContain('Alice handed you board ENG and an issue on it: “Over to you”')
  await act(async () => button('Open').click())
  expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
    { type: 'openBoard', board: { workspaceId: 'my-session', boardRef: handover.boardRef } },
    { type: 'openIssue', issueId: 'issue-1' },
    { type: 'dismissHandover', id: 'h1' },
  ])
})

it('grants nothing: a board out of reach stays closed and offers to connect it with their own account', async () => {
  onEvent.mockRejectedValueOnce(createOperateSessionError(OPERATE_SESSION_ERROR_CODES.boardUnavailable))
  await render()
  await act(async () => button('Open').click())
  expect(onEvent).toHaveBeenCalledTimes(1)
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('connect it with your own InferOps account')

  // Connecting is the person's own newGatekeeper in their own workspace, and then it opens.
  newGatekeeper.mockResolvedValue({ [Symbol.dispose]: () => {} })
  await act(async () => button('Connect with me@acme.test').click())
  expect(newGatekeeper).toHaveBeenCalledWith(7, handover.boardRef)
  expect(onEvent.mock.calls.at(-1)?.[0]).toEqual({ type: 'dismissHandover', id: 'h1' })
})

it('dismisses without opening', async () => {
  await render()
  await act(async () => button('Dismiss').click())
  expect(onEvent.mock.calls.map(([event]) => event)).toEqual([{ type: 'dismissHandover', id: 'h1' }])
})
