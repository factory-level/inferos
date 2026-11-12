// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { DelegateSummary } from '@gadgets/workshop-shared/delegate'
import { Delegates } from './Delegates'

const running: DelegateSummary = {
  delegateId: 'dl-1', title: 'Triage the open bugs', state: 'running', connections: ['inferops'], tools: ['grep', 'executeCode'],
  chatId: 7, launchedAt: new Date(1_700_000_000_000).toISOString(),
}
const revoked: DelegateSummary = { ...running, delegateId: 'dl-2', title: 'Summarise the week', state: 'failed', reason: 'requester-revoked' }
const listDelegates = vi.fn<() => Promise<DelegateSummary[]>>()
const stopDelegate = vi.fn<(id: string) => Promise<void>>()
const workspace = { id: 'my-session', stub: { listDelegates, stopDelegate } as unknown as RpcStub<Overseer>, restricted: false }
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  listDelegates.mockReset(); stopDelegate.mockReset().mockResolvedValue()
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })
const render = () => act(async () => root.render(<Delegates workspace={workspace} />))
const buttons = () => [...container.querySelectorAll('button')]

it("lists the person's own delegates, what each may use and how it ended, and stops only a running one", async () => {
  listDelegates.mockResolvedValue([running, revoked])
  await render()
  expect(container.textContent).toContain('Triage the open bugs · Running')
  expect(container.textContent).toContain('Connections: inferops · Tools: grep, executeCode')
  expect(container.textContent).toContain('Summarise the week · Failed: your access here changed while it ran')
  expect(buttons().map(b => b.textContent)).toEqual(['Refresh', 'Stop'])
  listDelegates.mockResolvedValue([{ ...running, state: 'failed', reason: 'cancelled' }, revoked])
  await act(async () => buttons().find(b => b.textContent === 'Stop')!.click())
  expect(stopDelegate).toHaveBeenCalledWith('dl-1')
  expect(container.textContent).toContain('Triage the open bugs · Failed: you stopped it')
  expect(buttons().map(b => b.textContent)).toEqual(['Refresh'])
})

it('says when a stop failed, and keeps the delegate as it was', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  listDelegates.mockResolvedValue([running])
  stopDelegate.mockRejectedValue(new Error('down'))
  await render()
  await act(async () => buttons().find(b => b.textContent === 'Stop')!.click())
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn't stop it")
  expect(container.textContent).toContain('Running')
})

it('shows nothing when there are none, and says so plainly when the list fails, with a retry', async () => {
  listDelegates.mockResolvedValue([])
  await render()
  expect(container.textContent).toBe('')
  vi.spyOn(console, 'error').mockImplementation(() => {})
  listDelegates.mockReset().mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce([running])
  act(() => root.unmount()); root = createRoot(container)
  await render()
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load your delegates.")
  await act(async () => buttons().find(b => b.textContent === 'Try again')!.click())
  expect(container.textContent).toContain('Triage the open bugs')
})
