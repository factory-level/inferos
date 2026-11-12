// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useLayoutEffect, type ReactNode } from 'react'
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
    listReadableWorkflowHistories: async () => [],
    getTriggerDefinition: async () => null,
    listWorkflowDeliveries: async () => [],
    listTriggerControls: async () => [],
    listCollaborators: async () => [],
    getTriggerAssignment: async () => ({ enabled: true, assignment: null }),
    getGadget: (() => ({ listBindings: async () => [], [Symbol.dispose]: () => {} })) as unknown as Overseer['getGadget'],
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
  it('discovers history IDs before reading history, including swept definitions', async () => {
    const listReadableWorkflowHistories = vi.fn<Overseer['listReadableWorkflowHistories']>(async () => [
      { definitionId: 'swept-definition' },
    ])
    const listWorkflowDeliveries = vi.fn<Overseer['listWorkflowDeliveries']>(async id => [
      { hookId: 3, definitionId: id, revision: 2, commitId: 'a'.repeat(40), at: new Date(0), result: { outcome: 'succeeded', settledAt: new Date(1) } },
    ])
    await render({ listHooks: async () => [], listReadableWorkflowHistories, listWorkflowDeliveries })
    await act(async () => {})
    expect(listReadableWorkflowHistories).toHaveBeenCalledOnce()
    expect(listWorkflowDeliveries).toHaveBeenCalledWith('swept-definition')
    expect(container.textContent).toContain('Workflow swept-definition')
    expect(container.textContent).toContain('Finished')
  })

  it('keeps discovery loading distinct from an empty readable-history list', async () => {
    let resolveHistories!: (rows: Awaited<ReturnType<Overseer['listReadableWorkflowHistories']>>) => void
    await render({
      listHooks: async () => [],
      listReadableWorkflowHistories: () => new Promise(resolve => { resolveHistories = resolve }),
    })
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Loading available run histories…')
    expect(container.textContent).not.toContain('No run history available.')
    await act(async () => { resolveHistories([]) })
    expect(container.textContent).toContain('No run history available.')
    expect(container.querySelector('[role="status"]')).toBeNull()
  })

  it("never commits the previous overseer's history on the first render after an identity switch", async () => {
    const previousOverseer: Partial<Overseer> = {
      listHooks: async () => [],
      listWorkflowDefinitions: async () => [],
      listReadableWorkflowHistories: async () => [{ definitionId: 'previous-person-definition' }],
      listWorkflowDeliveries: async () => [
        { hookId: 3, definitionId: 'previous-person-definition', revision: 4, commitId: 'a'.repeat(40), at: new Date(0), result: { outcome: 'succeeded', settledAt: new Date(1) } },
      ],
      getTriggerDefinition: async () => null,
      listTriggerControls: async () => [],
      listCollaborators: async () => [],
      getTriggerAssignment: async () => ({ enabled: true, assignment: null }),
      getGadget: (() => ({ listBindings: async () => [], [Symbol.dispose]: () => {} })) as unknown as Overseer['getGadget'],
    }
    let firstCommitAfterSwitch = ''
    const IdentitySwitchProbe = ({ overseer }: { overseer: RpcStub<Overseer> }) => {
      useLayoutEffect(() => {
        firstCommitAfterSwitch = container.textContent ?? ''
      }, [overseer])
      return <WorkflowTriggersPanel overseer={overseer} gadgets={[]} refreshKey="" pendingActionCount={0} onOpenActivity={() => {}} />
    }
    await act(async () => {
      root.render(<IdentitySwitchProbe overseer={previousOverseer as unknown as RpcStub<Overseer>} />)
    })
    await act(async () => {})
    expect(container.textContent).toContain('previous-person-definition')
    expect(container.textContent).toContain('Finished')

    let resolveNextHistories!: (rows: Awaited<ReturnType<Overseer['listReadableWorkflowHistories']>>) => void
    const nextOverseer: Partial<Overseer> = {
      listHooks: async () => [],
      listReadableWorkflowHistories: () => new Promise(resolve => { resolveNextHistories = resolve }),
    }
    const withDefaults: Partial<Overseer> = {
      listWorkflowDefinitions: async () => [],
      listReadableWorkflowHistories: async () => [],
      getTriggerDefinition: async () => null,
      listWorkflowDeliveries: async () => [],
      listTriggerControls: async () => [],
      listCollaborators: async () => [],
      getTriggerAssignment: async () => ({ enabled: true, assignment: null }),
      getGadget: (() => ({ listBindings: async () => [], [Symbol.dispose]: () => {} })) as unknown as Overseer['getGadget'],
      ...nextOverseer,
    }
    await act(async () => {
      root.render(<IdentitySwitchProbe overseer={withDefaults as unknown as RpcStub<Overseer>} />)
    })

    expect(firstCommitAfterSwitch).not.toContain('previous-person-definition')
    expect(firstCommitAfterSwitch).not.toContain('Finished')
    expect(firstCommitAfterSwitch).toContain('Loading available run histories…')
    expect(container.textContent).not.toContain('previous-person-definition')
    expect(container.textContent).not.toContain('Finished')
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Loading available run histories…')
    await act(async () => { resolveNextHistories([]) })
  })

  it('keeps discovery and per-definition failures distinct from empty, with retry', async () => {
    const listReadableWorkflowHistories = vi.fn<Overseer['listReadableWorkflowHistories']>()
      .mockRejectedValueOnce(new Error('hidden server detail'))
      .mockResolvedValue([{ definitionId: 'readable-definition' }])
    const listWorkflowDeliveries = vi.fn<Overseer['listWorkflowDeliveries']>()
      .mockRejectedValueOnce(new Error('hidden delivery detail'))
      .mockResolvedValue([])
    await render({ listHooks: async () => [], listReadableWorkflowHistories, listWorkflowDeliveries })
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Couldn't load available run histories.")
    expect(container.textContent).not.toContain('hidden server detail')
    await act(async () => { button('Retry histories')!.click() })
    await act(async () => {})
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Couldn't load this run history.")
    await act(async () => { button('Retry history')!.click() })
    await act(async () => {})
    expect(container.textContent).toContain('No run history yet.')
    expect(container.textContent).not.toContain('hidden delivery detail')
  })

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
    expect(container.querySelector('[aria-label="Runs act as"]')).toBeNull()
  })

  it("offers a pinned trigger its gadget's connections, once each, and disposes the gadget it read", async () => {
    const dispose = vi.fn<() => void>()
    const getGadget = vi.fn<(id: number) => unknown>(() => ({
      listBindings: async () => [
        { name: 'BOARD', target: 10, resourceTitle: 'Operations board', vendorId: 'inferops' },
        { name: 'BOARD_AGAIN', target: 10, resourceTitle: 'Operations board', vendorId: 'inferops' },
        { name: 'HELPER', target: 3, resourceTitle: 'Helper gadget' },
      ],
      [Symbol.dispose]: dispose,
    }))
    await render({
      listHooks: async () => [hook({ id: 7, gadgetId: 0 })], getTriggerDefinition: async () => PIN,
      getGadget: getGadget as unknown as Overseer['getGadget'],
    })
    const section = container.querySelector('[aria-label="Runs act as"]')!
    expect(getGadget).toHaveBeenCalledWith(0)
    expect(dispose).toHaveBeenCalledOnce()
    expect(section.textContent).toContain('Operations board')
    expect(section.textContent).not.toContain('Helper gadget')
    expect(section.textContent?.match(/Operations board/g)).toHaveLength(1)
  })

  it("shows a gadget whose connections can't be read as an error, not as having none", async () => {
    const dispose = vi.fn<() => void>()
    await render({
      listHooks: async () => [hook({ id: 7 })], getTriggerDefinition: async () => PIN,
      getGadget: (() => ({
        listBindings: async () => { throw new Error('gadget unavailable') }, [Symbol.dispose]: dispose,
      })) as unknown as Overseer['getGadget'],
    })
    const section = container.querySelector('[aria-label="Runs act as"]')!
    expect(section.querySelector('[role="alert"]')?.textContent).toBe("Couldn't read this trigger's connections.")
    expect(section.textContent).not.toContain("Bind this trigger's gadget to a connection")
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('says assignments are off on this instance when the server says so', async () => {
    await render({
      listHooks: async () => [hook({ id: 7 })], getTriggerDefinition: async () => PIN,
      getTriggerAssignment: async () => ({ enabled: false, assignment: null }),
    })
    const section = container.querySelector('[aria-label="Runs act as"]')!
    expect(section.textContent).toContain('Not enabled on this instance.')
    expect(section.querySelector('input, select')).toBeNull()
  })

  it("shows a pinned trigger's assignment and whether its key was given", async () => {
    await render({
      listHooks: async () => [hook({ id: 7 })], getTriggerDefinition: async () => PIN,
      getTriggerAssignment: async () => ({
        enabled: true,
        assignment: {
          hookId: 7, gatekeeperId: 10, credentialRef: '5b2c1d8e-0000-4000-8000-0000000000a1', assignedBy: ADA, assignedAt: new Date(0),
        },
      }),
    })
    expect(container.querySelector('[aria-label="Runs act as"]')?.textContent)
      .toContain('No key yet: runs are refused until an Admin gives one.')
  })

  it('lists trigger run history with retention and shows a refusal in the server\'s words', async () => {
    const control = { hookId: 7, label: 'Issue refunds now', invokers: ['ben'], definition: PIN, configuredBy: ADA, configuredAt: new Date(0) }
    await render({
      listHooks: async () => [hook({ id: 7 })], getTriggerDefinition: async () => PIN,
      listCollaborators: async () => [BEN_COLLABORATOR], listTriggerControls: async () => [control],
      listWorkflowDeliveries: async () => [
        { hookId: 7, definitionId: 'def-1', revision: 1, commitId: 'a'.repeat(40), at: new Date(0), historyExpiresAt: new Date('2026-12-01T00:00:00Z'), result: { outcome: 'succeeded', settledAt: new Date(0) } },
        {
          hookId: 7, definitionId: 'def-1', revision: 1, commitId: 'a'.repeat(40), at: new Date(1),
          invocation: { id: 'i1', requestedBy: 'ben' },
          run: {
            runId: 'run-1', correlationId: 'i1', company: null,
            requester: { kind: 'person', profileId: 'ben' }, executor: { kind: 'gadget_bindings' },
          },
          result: { outcome: 'waiting', settledAt: new Date(1) },
        },
      ],
      setTriggerControl: async () => { throw new Error("You don't have permission to share or publish configuration other people use.") },
    })
    await act(async () => {})
    const runs = container.querySelector('[aria-label="Recent workflow run history"]')!
    expect(runs.querySelectorAll('li')).toHaveLength(2)
    expect(runs.textContent).toContain('Finished')
    expect(runs.textContent).toContain('Kept until')
    expect(runs.querySelector('time')?.getAttribute('datetime')).toBe('2026-12-01T00:00:00.000Z')
    expect(runs.textContent).toContain('Waiting for approval')
    expect(runs.textContent).toContain("Kept while it's live, uncertain or waiting")
    expect(runs.textContent).toContain('Requested by Ben')
    await act(async () => { button('Remove')!.click() })
    expect(container.querySelector('[role="alert"]')?.textContent)
      .toBe("You don't have permission to share or publish configuration other people use.")
  })

  it('shows run history without a run-on-request control and separates loading from empty', async () => {
    let resolveDeliveries!: (rows: Awaited<ReturnType<Overseer['listWorkflowDeliveries']>>) => void
    await render({
      listHooks: async () => [hook({ id: 7 })], getTriggerDefinition: async () => PIN,
      listWorkflowDeliveries: () => new Promise(resolve => { resolveDeliveries = resolve }),
    })
    expect(container.querySelector('[aria-label="Run on request"]')).not.toBeNull()
    expect(container.textContent).toContain('Recent run history')
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Loading run history…')
    expect(container.textContent).not.toContain('No run history yet.')
    await act(async () => { resolveDeliveries([]) })
    expect(container.textContent).toContain('No run history yet.')
    expect(container.querySelector('[role="status"]')).toBeNull()
  })

  it('shows a history read failure as an error instead of an empty list', async () => {
    const control = { hookId: 7, label: 'Issue refunds now', invokers: ['ben'], definition: PIN, configuredBy: ADA, configuredAt: new Date(0) }
    await render({
      listHooks: async () => [hook({ id: 7 })], getTriggerDefinition: async () => PIN,
      listTriggerControls: async () => [control],
      listWorkflowDeliveries: async () => { throw new Error('backend detail must stay hidden') },
    })
    expect(container.querySelector('[aria-label="Recent workflow run history"]')).toBeNull()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Couldn't load run history.")
    expect(container.textContent).not.toContain('No run history yet.')
    expect(container.textContent).not.toContain('backend detail must stay hidden')
  })

  it('shows a listed person who has left, lets the builder untick them, and needs a current one ticked to save', async () => {
    const setTriggerControl = vi.fn<Overseer['setTriggerControl']>(async () => null)
    const control = { hookId: 7, label: 'Issue refunds now', invokers: ['ben', 'gone'], definition: PIN, configuredBy: ADA, configuredAt: new Date(0) }
    await render({
      listHooks: async () => [hook({ id: 7 })], getTriggerDefinition: async () => PIN,
      listCollaborators: async () => [BEN_COLLABORATOR], listTriggerControls: async () => [control],
      listWorkflowDeliveries: async () => [], setTriggerControl,
    })
    const former = container.querySelector<HTMLInputElement>('[aria-label="Let a former collaborator (1) run it"]')!
    expect(former.checked).toBe(true)
    expect(container.textContent).toContain('No longer a collaborator')
    // Untick Ben, the only current collaborator: the departed entry alone can't be saved.
    await act(async () => { container.querySelector<HTMLInputElement>('[aria-label="Let Ben run it"]')!.click() })
    expect(button('Save')?.disabled).toBe(true)
    // Tick Ben again and remove the departed one: only Ben is saved.
    await act(async () => { container.querySelector<HTMLInputElement>('[aria-label="Let Ben run it"]')!.click() })
    await act(async () => { former.click() })
    await act(async () => { button('Save')!.click() })
    expect(setTriggerControl).toHaveBeenCalledWith(7, { label: 'Issue refunds now', invokers: ['ben'] })
  })
})
