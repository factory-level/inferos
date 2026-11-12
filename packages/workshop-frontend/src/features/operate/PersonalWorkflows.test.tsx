// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { PersonalWorkflow } from '@gadgets/workshop-shared/personal-workflow'
import { PersonalWorkflows } from './PersonalWorkflows'

const ISSUE = '40000000-0000-4000-8000-000000000001'
const DONE = '40000000-0000-4000-8000-000000000002'
const COMMAND = 'inferops://acme.operations/inferos/console-command/ws-c/console-1/12/moveIssue?revision="3"'
const workflow: PersonalWorkflow = {
  id: 'pw-1', title: 'Close out', fromAction: 4, createdAt: new Date(1_700_000_000_000), expiresAt: new Date(1_700_086_400_000),
  steps: [{ reference: COMMAND, workspaceId: 'ws-c', consoleId: 'console-1', revision: '3', gadgetId: 12, command: 'moveIssue',
    input: { issueId: ISSUE, toStateId: DONE } }],
}
const listPersonalWorkflows = vi.fn<() => Promise<PersonalWorkflow[]>>()
const workspace = { id: 'my-session', stub: { listPersonalWorkflows } as unknown as RpcStub<Overseer>, restricted: false }
const writeText = vi.fn<(text: string) => Promise<void>>()
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  listPersonalWorkflows.mockReset(); writeText.mockReset().mockResolvedValue()
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })
const render = () => act(async () => root.render(<PersonalWorkflows workspace={workspace} />))
const button = (text: string) => [...container.querySelectorAll('button')].find(b => b.textContent === text)

it('lists the person\'s own workflows with their steps, and copies the reference their Dot runs one by', async () => {
  listPersonalWorkflows.mockResolvedValue([workflow])
  await render()
  expect(container.textContent).toContain('Close out')
  expect(container.textContent).toContain('1 step')
  expect(container.textContent).toContain(`moveIssue on console console-1: issue ${ISSUE} to state ${DONE}`)
  const reference = 'inferops://acme.operations/inferos/personal-workflow/my-session/pw-1'
  expect(container.querySelector('code')?.textContent).toBe(reference)
  await act(async () => button('Copy reference')!.click())
  expect(writeText).toHaveBeenCalledWith(reference)
  expect(container.querySelector('[role="status"]')?.textContent).toContain('you approve each run here')
})

it('shows nothing when there are none, and says so plainly when the list fails, with a retry', async () => {
  listPersonalWorkflows.mockResolvedValue([])
  await render()
  expect(container.textContent).toBe('')
  vi.spyOn(console, 'error').mockImplementation(() => {})
  listPersonalWorkflows.mockReset().mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce([workflow])
  act(() => root.unmount()); root = createRoot(container)
  await render()
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load your personal workflows.")
  await act(async () => button('Try again')!.click())
  expect(container.textContent).toContain('Close out')
})

it('says when the reference could not be copied, and offers no run or create of its own', async () => {
  listPersonalWorkflows.mockResolvedValue([workflow])
  writeText.mockRejectedValue(new Error('denied'))
  await render()
  await act(async () => button('Copy reference')!.click())
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn't copy it")
  expect([...container.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Refresh', 'Copy reference'])
})
