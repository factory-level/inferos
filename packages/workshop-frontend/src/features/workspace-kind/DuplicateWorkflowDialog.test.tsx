// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// FAC-123: a person duplicates a definition they can see, asked only for the copy's title. The
// dialog says what the copy is (theirs, independent, nothing carried over, unable to run until its
// connections are set up); the server decides the rest and a refusal is shown in its words.
import { act, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { WorkflowDefinition } from '@gadgets/workshop-shared/workflow-definition'
import { DuplicateWorkflowDialog } from './DuplicateWorkflowDialog'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const toast = vi.hoisted(() => vi.fn<(toast: { title: string }) => void>())
vi.mock('@cloudflare/kumo', () => ({
  Dialog: Object.assign(
    ({ children }: { children: ReactNode }) => <dialog open>{children}</dialog>,
    {
      Root: ({ children }: { children: ReactNode }) => <>{children}</>,
      Title: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
      Description: ({ children }: { children: ReactNode }) => <p>{children}</p>,
      Close: ({ render }: { render: (props: object) => ReactElement }) => render({}),
    },
  ),
  Input: ({ value, onChange, 'aria-label': label }: {
    value: string; onChange: (e: { target: { value: string } }) => void; 'aria-label': string
  }) => <input aria-label={label} value={value} onChange={onChange} />,
  useKumoToastManager: () => ({ add: toast }),
}))
vi.mock('../../components/WorkshopControls', () => ({
  WorkshopButton: ({ children, ...props }: ComponentProps<'button'>) => <button type="button" {...props}>{children}</button>,
  WorkshopIconButton: ({ children, ...props }: ComponentProps<'button'>) => <button type="button" {...props}>{children}</button>,
}))

const ADA = { type: 'user' as const, id: 'ada', name: 'Ada' }
const revision = { revision: 1, source: { kind: 'gadget' as const, gadgetId: 3, commitId: 'a'.repeat(40) }, savedAt: new Date(0) }
const SOURCE: WorkflowDefinition = { id: 'k', title: 'Refunds', owner: ADA, revisions: [revision], published: null }

let container: HTMLDivElement
let root: Root
beforeEach(() => { toast.mockReset(); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

const button = (label: string) => [...container.querySelectorAll('button')].find(b => b.textContent === label)!
const titleBox = () => container.querySelector<HTMLInputElement>('input[aria-label="Copy title"]')!
const type = async (value: string) => {
  const input = titleBox()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const render = async (overseer: Partial<Overseer>, onDuplicated = vi.fn<(copy: WorkflowDefinition) => void>()) => {
  await act(async () => root.render(<DuplicateWorkflowDialog overseer={overseer as unknown as RpcStub<Overseer>}
    source={SOURCE} onClose={() => {}} onDuplicated={onDuplicated} />))
  return onDuplicated
}

it("says the copy is the person's own, independent, and can't run until its connections are set up", async () => {
  await render({})
  const said = container.textContent!
  expect(said).toContain('Duplicate “Refunds”')
  expect(said).toContain('new workflow of your own')
  expect(said).toContain('Later changes to “Refunds” never reach it')
  expect(said).toContain('no sharing, publication, trigger or connection')
  expect(said).toContain("can't run until you set up its connections from your own accounts and models")
  expect(titleBox().value).toBe('Refunds (copy)')
})

it('duplicates with the title given, and hands the copy back', async () => {
  const copy: WorkflowDefinition = { ...SOURCE, id: 'c', title: 'My refunds' }
  const duplicateWorkflowDefinition = vi.fn<Overseer['duplicateWorkflowDefinition']>(async () => copy)
  const onDuplicated = await render({ duplicateWorkflowDefinition })
  await type('  My refunds ')
  await act(async () => button('Duplicate').click())
  expect(duplicateWorkflowDefinition).toHaveBeenCalledWith({ sourceId: 'k', title: 'My refunds' })
  expect(onDuplicated).toHaveBeenCalledWith(copy)
})

it('offers no duplicate without a title', async () => {
  await render({})
  await type('   ')
  expect(button('Duplicate').disabled).toBe(true)
})

it("shows a refusal in the server's own words, and hands nothing back", async () => {
  const duplicateWorkflowDefinition = vi.fn<Overseer['duplicateWorkflowDefinition']>(async () => {
    throw new Error("This workflow uses a connection that can't be set up in a copy yet, so it can't be duplicated.")
  })
  const onDuplicated = await render({ duplicateWorkflowDefinition })
  await act(async () => button('Duplicate').click())
  expect(toast.mock.calls[0]![0].title).toBe("This workflow uses a connection that can't be set up in a copy yet, so it can't be duplicated.")
  expect(onDuplicated).not.toHaveBeenCalled()
  expect(button('Duplicate').disabled).toBe(false)
})
