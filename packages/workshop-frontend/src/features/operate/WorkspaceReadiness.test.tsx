// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { Overseer, WorkspaceReadiness as Readiness } from '@gadgets/workshop-shared/api'
import { WorkspaceReadiness } from './WorkspaceReadiness'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

const ready: Readiness = {
  deploymentReady: true,
  items: [
    { name: 'inferops-connection', status: 'ready', detail: "A person's InferOps account is connected here.", action: null },
    { name: 'records-binding', status: 'ready', detail: 'A gadget here is bound to an InferOps custom table.', action: null },
    { name: 'workflow-policy-binding', status: 'ready', detail: 'A gadget here is bound to an InferOps workflow policy.', action: null },
    { name: 'published-console', status: 'ready', detail: '1 published console(s).', action: null },
  ],
}
const notReady: Readiness = {
  deploymentReady: false,
  items: [
    ready.items[0]!,
    { name: 'records-binding', status: 'attention', detail: 'No gadget here is bound to an InferOps custom table yet.',
      action: 'Install the gadget and configure its InferOps custom table connection.' },
    { name: 'workflow-policy-binding', status: 'blocked', detail: 'InferOps workflow policies are turned off for this deployment, so nothing can bind them.',
      action: 'Turn on InferOps workflow policies for this deployment.' },
    ready.items[3]!,
  ],
}

const overseerWith = (...answers: (Readiness | Error)[]) => {
  const get = vi.fn<() => Promise<Readiness>>()
  for (const answer of answers) get.mockImplementationOnce(async () => { if (answer instanceof Error) throw answer; return answer })
  return { stub: { getWorkspaceReadiness: get } as unknown as RpcStub<Overseer>, get }
}
const render = async (stub: RpcStub<Overseer>) => {
  await act(async () => root.render(<WorkspaceReadiness overseer={stub} />))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
const clickCheckAgain = async () => {
  const button = [...container.querySelectorAll('button')].find(b => b.textContent === 'Check again')!
  await act(async () => { button.click() })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

it("says the InferOS side is ready only when the server says so, never the whole environment", async () => {
  const { stub } = overseerWith(ready)
  await render(stub)
  expect(container.textContent).toContain('InferOS side: ready')
  expect(container.textContent).not.toMatch(/(^|[^:] )Ready to hand over|Environment ready/)
  expect(container.textContent).toContain("Your company's people and InferOps setup are checked in InferOps.")
})

it("shows each item in the server's words, with what to do next, and not ready while one isn't", async () => {
  const { stub } = overseerWith(notReady)
  await render(stub)
  expect(container.textContent).toContain('InferOS side: not ready yet')
  expect(container.textContent).toContain('Needs you')
  expect(container.textContent).toContain('Install the gadget and configure its InferOps custom table connection.')
  expect(container.textContent).toContain('Blocked')
  expect(container.textContent).toContain('InferOps workflow policies are turned off for this deployment')
  expect(container.textContent).not.toContain('InferOS side: ready')
})

it("says a failed check failed, never an empty or ready list, and checks again on request", async () => {
  const { stub, get } = overseerWith(new Error('refused'), ready)
  await render(stub)
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn't check this workspace's readiness")
  expect(container.textContent).not.toContain('InferOS side: ready')
  await clickCheckAgain()
  expect(get).toHaveBeenCalledTimes(2)
  expect(container.textContent).toContain('InferOS side: ready')
})
