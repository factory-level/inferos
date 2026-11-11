// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// FAC-123: the owner sets up a duplicate's connections, each from their own connected account and a
// resource, or one of their own models. Any left stay to set up; the server checks them all, and a
// refusal is shown in its words. The account and resource picker is the blueprint one
// (GatekeeperBindingField), stood in for here by what it hands back.
import { act, type ChangeEvent, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { WorkflowDefinition, WorkflowRequiredBinding } from '@gadgets/workshop-shared/workflow-definition'
import { SetUpConnectionsDialog } from './SetUpConnectionsDialog'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const RESOURCE = 'inferops://acme.operations/project/board/ENG'
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
  Select: Object.assign(
    ({ children, onValueChange, value, 'aria-label': label }: {
      children: ReactNode; onValueChange: (value: string) => void; value?: string; 'aria-label': string
    }) => (
      <select aria-label={label} value={value ?? ''} onChange={(e: ChangeEvent<HTMLSelectElement>) => onValueChange(e.target.value)}>
        <option value="">none</option>
        {children}
      </select>
    ),
    { Option: ({ children, value }: { children: ReactNode; value: string }) => <option value={value}>{children}</option> },
  ),
  useKumoToastManager: () => ({ add: toast }),
}))
vi.mock('../../components/WorkshopControls', () => ({
  WorkshopButton: ({ children, ...props }: ComponentProps<'button'>) => <button type="button" {...props}>{children}</button>,
  WorkshopIconButton: ({ children, ...props }: ComponentProps<'button'>) => <button type="button" {...props}>{children}</button>,
}))
// Picking an account and a resource, as the picker reports it: the account, ready, and how to read the resource.
vi.mock('../../components/GatekeeperBindingField', () => ({
  GatekeeperBindingField: ({ title, binding, onChange, onReadyChange, onCollectorChange }: {
    title: string; binding: { gatekeeperName: string; typeUrlPattern: string; resourceUrl?: string }
    onChange: (update: { accountId?: number }) => void; onReadyChange: (ready: boolean) => void
    onCollectorChange: (collect: (() => Promise<string>) | null) => void
  }) => (
    <button type="button" data-binding={JSON.stringify(binding)} onClick={() => {
      onChange({ accountId: 7 }); onCollectorChange(async () => RESOURCE); onReadyChange(true)
    }}>Pick for {title}</button>
  ),
}))
const api = vi.hoisted(() => ({
  listGatekeeperVendors: async () => [],
  listModels: async () => [{ type: 'model', id: 'm1', name: 'My model' }],
}))
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: api, currentUser: { id: 'ada', name: 'Ada' } }) }))
vi.mock('./useConnectedAccounts', () => ({ useConnectedAccounts: () => [] }))
vi.mock('../../connectHandoff', () => ({ openConnectWindow: vi.fn<(flow: unknown) => Window>() }))

const ADA = { type: 'user' as const, id: 'ada', name: 'Ada' }
const revision = { revision: 1, source: { kind: 'gadget' as const, gadgetId: 3, commitId: 'a'.repeat(40) }, savedAt: new Date(0) }
const BOARD: WorkflowRequiredBinding = { name: 'BOARD', title: 'Board', type: 'gatekeeper', vendorId: 'inferops', typeUrlPattern: 'inferops://*', unmet: 'not-owners' }
const MODEL: WorkflowRequiredBinding = { name: 'MODEL', type: 'aiModel', unmet: 'missing' }
const COPY: WorkflowDefinition = { id: 'c', title: 'Refunds (copy)', owner: ADA, revisions: [revision], published: null, bindingsNeeded: [BOARD, MODEL] }

let container: HTMLDivElement
let root: Root
beforeEach(() => { toast.mockReset(); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

const button = (label: string) => [...container.querySelectorAll('button')].find(b => b.textContent === label)
const render = async (overseer: Partial<Overseer>, definition = COPY, onSetUp = vi.fn<() => void>()) => {
  await act(async () => root.render(<SetUpConnectionsDialog overseer={overseer as unknown as RpcStub<Overseer>}
    definition={definition} onClose={() => {}} onSetUp={onSetUp} />))
  return onSetUp
}
const pickModel = async () => {
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="Model for MODEL"]')!
  await act(async () => { select.value = 'm1'; select.dispatchEvent(new Event('change', { bubbles: true })) })
}

it('lists each connection it needs and what is wrong with it, offering nothing of the source', async () => {
  await render({})
  expect(container.textContent).toContain('Set up connections for “Refunds (copy)”')
  expect(container.querySelector('section[aria-label="Board"]')?.textContent).toContain("another person's account or model")
  expect(container.querySelector('section[aria-label="MODEL"]')?.textContent).toContain('Not set up yet.')
  // The picker is asked for the vendor and resource type only, never a resource to suggest.
  expect(JSON.parse(button('Pick for Board')!.getAttribute('data-binding')!))
    .toEqual({ gatekeeperName: 'inferops', typeUrlPattern: 'inferops://*' })
  expect(button('Set up connections')!.disabled).toBe(true)
})

it('sets up every connection chosen, the account with the resource it picked and a model, then reloads', async () => {
  const rebindWorkflowDefinition = vi.fn<Overseer['rebindWorkflowDefinition']>(async () => ({ ...COPY, bindingsNeeded: [] }))
  const onSetUp = await render({ rebindWorkflowDefinition })
  await act(async () => button('Pick for Board')!.click())
  await pickModel()
  await act(async () => button('Set up connections')!.click())
  expect(rebindWorkflowDefinition).toHaveBeenCalledWith('c', {
    BOARD: { type: 'gatekeeper', accountId: 7, resourceUrl: RESOURCE },
    MODEL: { type: 'aiModel', modelId: 'm1' },
  })
  expect(onSetUp).toHaveBeenCalledOnce()
})

it('sets up only some, saying the rest stay to set up and it still cannot run', async () => {
  const rebindWorkflowDefinition = vi.fn<Overseer['rebindWorkflowDefinition']>(async () => ({ ...COPY, bindingsNeeded: [MODEL] }))
  await render({ rebindWorkflowDefinition })
  await pickModel()
  expect(container.textContent).toContain("The rest stay to set up, and it can't run until they are.")
  await act(async () => button('Set up 1 of 2')!.click())
  expect(rebindWorkflowDefinition).toHaveBeenCalledWith('c', { MODEL: { type: 'aiModel', modelId: 'm1' } })
})

it("shows a refusal in the server's own words and keeps the dialog open", async () => {
  const rebindWorkflowDefinition = vi.fn<Overseer['rebindWorkflowDefinition']>(async () => {
    throw new Error('The connection "MODEL" needs one of your models')
  })
  const onSetUp = await render({ rebindWorkflowDefinition })
  await pickModel()
  await act(async () => button('Set up 1 of 2')!.click())
  expect(toast.mock.calls[0]![0].title).toBe('The connection "MODEL" needs one of your models')
  expect(onSetUp).not.toHaveBeenCalled()
  expect(button('Set up 1 of 2')!.disabled).toBe(false)
})

it('says when there is nothing left to set up', async () => {
  await render({}, { ...COPY, bindingsNeeded: [] })
  expect(container.textContent).toContain('Its connections are all set up.')
  expect(button('Set up connections')).toBeUndefined()
})
