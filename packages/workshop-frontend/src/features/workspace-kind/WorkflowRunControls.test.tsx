// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// FAC-102 part 2: the workflow runs a use collaborator may ask for. Only the controls listing them,
// each a label and a button; a press reads "requested", never done; a refusal is the server's words.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { RUN_REQUESTED_TEXT, WorkflowRunControls } from './WorkflowRunControls'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

vi.mock('@cloudflare/kumo', () => ({
  Button: ({ children, onClick, disabled }: { children: ReactNode; onClick?: () => void; disabled?: boolean }) => (
    <button type="button" onClick={onClick} disabled={disabled}>{children}</button>
  ),
}))

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function render(overseer: Partial<Overseer>) {
  await act(async () => {
    root.render(<WorkflowRunControls overseer={overseer as unknown as RpcStub<Overseer>} />)
  })
}
const button = (label: string) => [...container.querySelectorAll('button')].find(b => b.textContent === label)

it('renders nothing for someone no control lists', async () => {
  await render({ listTriggerControls: async () => [] })
  expect(container.innerHTML).toBe('')
})

it('shows only the label, runs the trigger on press and says it was requested, not done', async () => {
  const invokeTrigger = vi.fn<Overseer['invokeTrigger']>(async () =>
    ({ id: 'inv', hookId: 7, definitionId: 'def', revision: 1, requestedAt: new Date(0) }))
  // Even if more came back, nothing but the label is shown.
  await render({
    listTriggerControls: async () => [{ hookId: 7, label: 'Issue refunds now', invokers: ['someone-else'] } as never],
    invokeTrigger,
  })
  expect(container.textContent).toBe('Issue refunds now')
  // (Only the label before the press; afterwards, the requested line with its time.)
  await act(async () => { button('Issue refunds now')!.click() })
  expect(invokeTrigger).toHaveBeenCalledWith(7)
  expect(container.querySelector('[role="status"]')?.textContent).toMatch(new RegExp(`^${RUN_REQUESTED_TEXT} \\(requested at .+\\)$`))
  expect(container.textContent).not.toMatch(/done\b(?!.*yet)|applied|succeeded/i)
})

it("shows a refusal in the server's words, the retry time included", async () => {
  const refusal = "You've run this trigger 3 times in the last 10 minutes. Try again in 7 minutes."
  await render({
    listTriggerControls: async () => [{ hookId: 7, label: 'Issue refunds now' }],
    invokeTrigger: async () => { throw new Error(refusal) },
  })
  await act(async () => { button('Issue refunds now')!.click() })
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(refusal)
  expect(container.querySelector('[role="status"]')).toBeNull()
})
