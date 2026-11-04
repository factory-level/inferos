// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { BoundHookInfo, GadgetSummary, Overseer } from '@gadgets/workshop-shared/api'
import type { WorkflowDefinition } from '@gadgets/workshop-shared/workflow-definition'
import { WorkflowTriggersPanel } from './WorkflowTriggersPanel'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const toast = vi.hoisted(() => vi.fn<(toast: unknown) => void>())

vi.mock('@cloudflare/kumo', () => ({
  Switch: ({ checked, disabled, onCheckedChange, 'aria-label': label }: {
    checked: boolean
    disabled?: boolean
    onCheckedChange: (checked: boolean) => void
    'aria-label': string
  }) => (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
      onClick={() => onCheckedChange(!checked)} />
  ),
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  Checkbox: ({ checked, onCheckedChange, 'aria-label': label }: {
    checked: boolean
    onCheckedChange: (checked: boolean) => void
    'aria-label': string
  }) => (
    <input type="checkbox" aria-label={label} checked={checked} onChange={e => onCheckedChange(e.target.checked)} />
  ),
  Button: ({ children, onClick, disabled }: { children: ReactNode; onClick?: () => void; disabled?: boolean }) => (
    <button type="button" onClick={onClick} disabled={disabled}>{children}</button>
  ),
  Input: ({ value, onChange, 'aria-label': label }: {
    value: string
    onChange: (e: { target: { value: string } }) => void
    'aria-label': string
  }) => <input aria-label={label} value={value} onChange={onChange} />,
  Select: Object.assign(({ children }: { children: ReactNode }) => <div>{children}</div>, {
    Option: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  }),
  useKumoToastManager: () => ({ add: toast }),
}))

vi.mock('../../errorReporting', () => ({ reportIssue: vi.fn<(site: string, err: unknown) => void>() }))
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ currentUser: { id: 'ada', name: 'Ada' } }) }))

const ADA = { type: 'user' as const, id: 'ada', name: 'Ada' }
const BEN = { type: 'user' as const, id: 'ben', name: 'Ben' }
const definition = (overrides: Partial<WorkflowDefinition>): WorkflowDefinition => ({
  id: 'def-1',
  title: 'Standup',
  owner: ADA,
  revisions: [{ revision: 1, source: { kind: 'gadget', gadgetId: 0, commitId: 'a'.repeat(40) }, savedAt: new Date(0) }],
  published: null,
  ...overrides,
})

const hook = (overrides: Partial<BoundHookInfo>): BoundHookInfo => ({
  id: 1,
  gatekeeperId: 10,
  gadgetId: 0,
  description: { title: 'Weekdays at 09:00', description: 'Post the standup digest' },
  enabled: true,
  ...overrides,
})

let container: HTMLDivElement
let root: Root

const button = (label: string) =>
  [...container.querySelectorAll('button')].find(b => b.textContent?.includes(label))
const GADGET = { id: 0, title: 'Digest' } as GadgetSummary

beforeEach(() => {
  toast.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function render(overseer: Partial<Overseer>, gadgets: GadgetSummary[] = []) {
  const withDefaults: Partial<Overseer> = {
    listWorkflowDefinitions: async () => [],
    getTriggerDefinition: async () => null,
    listTriggerControls: async () => [],
    listCollaborators: async () => [],
    ...overseer,
  }
  await act(async () => {
    root.render(
      <WorkflowTriggersPanel
        overseer={withDefaults as unknown as RpcStub<Overseer>}
        gadgets={gadgets}
        refreshKey=""
        pendingActionCount={0}
        onOpenActivity={() => {}}
      />,
    )
  })
}

describe('WorkflowTriggersPanel', () => {
  it("lists the workspace's bound hooks as its triggers", async () => {
    await render({
      listHooks: async () => [
        hook({ id: 1 }),
        hook({ id: 2, description: { title: 'When a row is added', description: '' }, resourceTitle: 'Standup sheet' }),
      ],
    })
    expect(container.querySelector('h2')?.textContent).toBe('Triggers')
    const items = [...container.querySelectorAll('li')].map(li => li.textContent)
    expect(items).toHaveLength(2)
    expect(items[0]).toContain('Weekdays at 09:00')
    expect(items[1]).toContain('Standup sheet')
  })

  it('says so when there are no triggers', async () => {
    await render({ listHooks: async () => [] })
    expect(container.textContent).toContain('No triggers yet')
  })

  it('disables a trigger through the overseer, reverting if that fails', async () => {
    const disableHook = vi.fn<(id: number) => Promise<void>>(async () => { throw new Error('nope') })
    await render({ listHooks: async () => [hook({ id: 7 })], disableHook })
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!
    await act(async () => { toggle.click() })
    expect(disableHook).toHaveBeenCalledWith(7)
    expect(toast).toHaveBeenCalled()
    expect(container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true')
  })

  it('reports a load failure instead of an empty list', async () => {
    await render({ listHooks: async () => { throw new Error('down') } })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load triggers")
    expect(container.textContent).not.toContain('No triggers yet')
  })


  it('saves the workflow as a definition without publishing it', async () => {
    const saveWorkflowDefinition = vi.fn<Overseer['saveWorkflowDefinition']>(async () => definition({}))
    const publishWorkflowDefinition = vi.fn<Overseer['publishWorkflowDefinition']>(async () => definition({}))
    await render({ listHooks: async () => [], saveWorkflowDefinition, publishWorkflowDefinition }, [GADGET])
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Definition title"]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, ' Standup ')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { button('Save')!.click() })
    expect(saveWorkflowDefinition).toHaveBeenCalledWith({ title: 'Standup', gadgetId: 0 })
    expect(publishWorkflowDefinition).not.toHaveBeenCalled()
  })

  it("offers its owner a new revision and publication, and nobody else's", async () => {
    const publishWorkflowDefinition = vi.fn<Overseer['publishWorkflowDefinition']>(async () => definition({}))
    await render({
      listHooks: async () => [],
      listWorkflowDefinitions: async () => [
        definition({}),
        definition({ id: 'def-2', title: 'Theirs', owner: BEN, published: { revision: 1, at: new Date(0), by: BEN } }),
      ],
      publishWorkflowDefinition,
    }, [GADGET])
    expect(container.textContent).toContain('Not published')
    expect(container.textContent).toContain('Published: revision 1')
    expect([...container.querySelectorAll('button')].filter(b => b.textContent?.includes('Save new revision')))
      .toHaveLength(1)
    await act(async () => { button('Publish revision 1')!.click() })
    expect(publishWorkflowDefinition).toHaveBeenCalledWith('def-1', 1)
  })

  it('says which revision a pinned trigger runs, and pins or unpins it', async () => {
    const pinTriggerDefinition = vi.fn<Overseer['pinTriggerDefinition']>(async () => {})
    const published = definition({ title: 'Digest flow', published: { revision: 1, at: new Date(0), by: ADA } })
    await render({
      listHooks: async () => [hook({ id: 7 }), hook({ id: 8 })],
      listWorkflowDefinitions: async () => [published],
      getTriggerDefinition: async (id: number) => (id === 8 ? { definitionId: 'def-1', revision: 1 } : null),
      pinTriggerDefinition,
    })
    const items = [...container.querySelectorAll('li')]
    expect(items[1]?.textContent).toContain('Runs “Digest flow”, revision 1')
    await act(async () => { items[0]!.querySelector('button:not([role="switch"])')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(pinTriggerDefinition).toHaveBeenCalledWith(7, { definitionId: 'def-1', revision: 1 })
    const unpin = [...items[1]!.querySelectorAll('button')].find(b => b.textContent === 'Unpin')!
    await act(async () => { unpin.click() })
    expect(pinTriggerDefinition).toHaveBeenCalledWith(8, null)
  })

  it("shows the server's refusal in its own words", async () => {
    await render({
      listHooks: async () => [],
      listWorkflowDefinitions: async () => [definition({})],
      publishWorkflowDefinition: async () => {
        throw new Error("You don't have permission to share or publish configuration other people use.")
      },
    }, [GADGET])
    await act(async () => { button('Publish revision 1')!.click() })
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: "You don't have permission to share or publish configuration other people use.",
    }))
  })
})

// FAC-102 part 2: who may run a pinned trigger on request.
describe('a pinned trigger\'s run-on-request control', () => {
  const PIN = { definitionId: 'def-1', revision: 1 }
  const BEN_COLLABORATOR = { profile: BEN, addedBy: [], role: 'use' as const }
  const setInput = (input: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }

  it('lets a builder name a button and who may press it', async () => {
    const setTriggerControl = vi.fn<Overseer['setTriggerControl']>(async () => null)
    await render({
      listHooks: async () => [hook({ id: 7 })], getTriggerDefinition: async () => PIN,
      listCollaborators: async () => [BEN_COLLABORATOR], setTriggerControl,
    })
    expect(button('Add button')?.disabled).toBe(true)
    await act(async () => { setInput(container.querySelector('[aria-label="Button label"]')!, 'Issue refunds now') })
    await act(async () => { container.querySelector<HTMLInputElement>('[aria-label="Let Ben run it"]')!.click() })
    await act(async () => { button('Add button')!.click() })
    expect(setTriggerControl).toHaveBeenCalledWith(7, { label: 'Issue refunds now', invokers: ['ben'] })
  })

  it('shows an unpinned trigger no control', async () => {
    await render({ listHooks: async () => [hook({ id: 7 })], listCollaborators: async () => [BEN_COLLABORATOR] })
    expect(container.querySelector('[aria-label="Run on request"]')).toBeNull()
  })

  it('lists recent runs on request with who asked, and shows a refusal in the server\'s words', async () => {
    const control = { hookId: 7, label: 'Issue refunds now', invokers: ['ben'], definition: PIN, configuredBy: ADA, configuredAt: new Date(0) }
    await render({
      listHooks: async () => [hook({ id: 7 })], getTriggerDefinition: async () => PIN,
      listCollaborators: async () => [BEN_COLLABORATOR], listTriggerControls: async () => [control],
      listWorkflowDeliveries: async () => [
        { hookId: 7, definitionId: 'def-1', revision: 1, commitId: 'a'.repeat(40), at: new Date(0) },
        { hookId: 7, definitionId: 'def-1', revision: 1, commitId: 'a'.repeat(40), at: new Date(1), invocation: { id: 'i1', requestedBy: 'ben' } },
      ],
      setTriggerControl: async () => { throw new Error("You don't have permission to share or publish configuration other people use.") },
    })
    await act(async () => {})
    const runs = container.querySelector('[aria-label="Recent runs on request"]')!
    expect(runs.querySelectorAll('li')).toHaveLength(1)
    expect(runs.textContent).toContain('Requested by Ben')
    await act(async () => { button('Remove')!.click() })
    expect(container.querySelector('[role="alert"]')?.textContent)
      .toBe("You don't have permission to share or publish configuration other people use.")
  })
})
