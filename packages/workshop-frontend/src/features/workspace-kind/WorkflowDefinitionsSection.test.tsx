// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// FAC-124: a dynamic, unsaved definition says it is temporary and when it expires, and offers its
// owner a save that keeps it (the same save, which retains it). A retained one says nothing of
// expiry. Nothing here creates a temporary definition: the Dot and agents do.
// FAC-122: an owner shares a saved definition; one shared with this person says so and what it
// lets them do, from the server's own answer, and an editor saves new revisions.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { GadgetSummary, Overseer } from '@gadgets/workshop-shared/api'
import {
  WORKFLOW_BINDINGS_NEEDED, WORKFLOW_BINDINGS_NOT_OWNERS, WORKFLOW_BINDINGS_UNATTRIBUTED, type WorkflowDefinition,
} from '@gadgets/workshop-shared/workflow-definition'
import { WorkflowDefinitionsSection } from './WorkflowDefinitionsSection'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const toast = vi.hoisted(() => vi.fn<(toast: { title: string }) => void>())
vi.mock('@cloudflare/kumo', () => ({
  Button: ({ children, onClick, disabled }: { children: ReactNode; onClick?: () => void; disabled?: boolean }) => (
    <button type="button" onClick={onClick} disabled={disabled}>{children}</button>
  ),
  Input: ({ value, onChange, 'aria-label': label }: {
    value: string; onChange: (e: { target: { value: string } }) => void; 'aria-label': string
  }) => <input aria-label={label} value={value} onChange={onChange} />,
  Select: Object.assign(({ children }: { children: ReactNode }) => <div>{children}</div>, {
    Option: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  }),
  useKumoToastManager: () => ({ add: toast }),
}))
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ currentUser: { id: 'ada', name: 'Ada' } }) }))
// The share dialog has its own tests (ShareWorkflowDialog.test.tsx); here, only that it opens.
vi.mock('./ShareWorkflowDialog', async (importActual) => ({
  ...(await importActual<typeof import('./ShareWorkflowDialog')>()),
  ShareWorkflowDialog: ({ definition }: { definition: WorkflowDefinition }) => <dialog open>Sharing {definition.title}</dialog>,
}))
// FAC-123: the duplicate and set-up dialogs have their own tests; here, what opens them and what follows.
const duplicated = vi.hoisted(() => ({ copy: null as WorkflowDefinition | null }))
vi.mock('./DuplicateWorkflowDialog', () => ({
  DuplicateWorkflowDialog: ({ source, onDuplicated }: { source: WorkflowDefinition; onDuplicated: (copy: WorkflowDefinition) => void }) => (
    <dialog open>Duplicating {source.title}<button type="button" onClick={() => onDuplicated(duplicated.copy!)}>Done</button></dialog>
  ),
}))
vi.mock('./SetUpConnectionsDialog', () => ({
  SetUpConnectionsDialog: ({ definition }: { definition: WorkflowDefinition }) => <dialog open>Setting up {definition.title}</dialog>,
}))

const ADA = { type: 'user' as const, id: 'ada', name: 'Ada' }
const revision = { revision: 1, source: { kind: 'gadget' as const, gadgetId: 3, commitId: 'a'.repeat(40) }, savedAt: new Date(0) }
// An hour from now, so it is still temporary however late the suite runs.
const EXPIRES = new Date(Date.now() + 60 * 60 * 1000)
const temporary: WorkflowDefinition = { id: 't', title: 'One-off', owner: ADA, revisions: [revision], published: null, expiresAt: EXPIRES }
const kept: WorkflowDefinition = { id: 'k', title: 'Kept', owner: ADA, revisions: [revision], published: null }
const GADGETS = [{ id: 3, title: 'Refunds' }] as unknown as GadgetSummary[]

let container: HTMLDivElement
let root: Root
beforeEach(() => { toast.mockReset(); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

const rowOf = (title: string) => [...container.querySelectorAll('li')].find(li => li.textContent?.includes(title))!
const buttonIn = (row: Element, label: string) => [...row.querySelectorAll('button')].find(b => b.textContent === label)
const labelsIn = (row: Element) => [...row.querySelectorAll('button')].map(b => b.textContent)

it('says a temporary definition expires, and when, and saves it to keep it', async () => {
  const saveWorkflowDefinition = vi.fn<Overseer['saveWorkflowDefinition']>(async input => ({ ...kept, id: input.id ?? 'k' }))
  const onChanged = vi.fn<() => void>()
  await act(async () => root.render(<WorkflowDefinitionsSection overseer={{ saveWorkflowDefinition } as unknown as RpcStub<Overseer>}
    gadgets={GADGETS} definitions={[temporary, kept]} onChanged={onChanged} />))
  const row = rowOf('One-off')
  expect(row.textContent).toContain('Temporary')
  expect(row.querySelector('time')?.getAttribute('dateTime')).toBe(EXPIRES.toISOString())
  expect(rowOf('Kept').textContent).not.toContain('Temporary')
  expect(buttonIn(rowOf('Kept'), 'Save to keep')).toBeUndefined()

  await act(async () => buttonIn(row, 'Save to keep')!.click())
  // The same save, which retains it: no retain: false, and the definition's own id and gadget.
  expect(saveWorkflowDefinition).toHaveBeenCalledWith({ id: 't', title: 'One-off', gadgetId: 3 })
  expect(onChanged).toHaveBeenCalledOnce()
})

it('keeps temporary definitions out of Saved and limits Shared with me to shared definitions', async () => {
  const shared: WorkflowDefinition = {
    ...kept, id: 'shared', title: 'Shared workflow', owner: { ...ADA, id: 'ben', name: 'Ben' },
    sharedWithMe: true, access: { read: true, run: true, edit: false },
  }
  const overseer = {} as RpcStub<Overseer>
  await act(async () => root.render(<WorkflowDefinitionsSection overseer={overseer} gadgets={GADGETS}
    definitions={[temporary, kept, shared]} view="saved" onChanged={() => {}} />))
  expect(container.textContent).toContain('Kept')
  expect(container.textContent).toContain('Shared workflow')
  expect(container.textContent).not.toContain('One-off')

  await act(async () => root.render(<WorkflowDefinitionsSection overseer={overseer} gadgets={GADGETS}
    definitions={[temporary, kept, shared]} view="shared" onChanged={() => {}} />))
  expect(container.textContent).toContain('Shared workflow')
  expect(container.textContent).not.toContain('Kept')
})

it('says plainly when a save lost the race with expiry, and reloads so the definition leaves the list', async () => {
  const saveWorkflowDefinition = vi.fn<Overseer['saveWorkflowDefinition']>(async () => {
    throw new Error('Error: This workflow expired. Create it again.')
  })
  const onChanged = vi.fn<() => void>()
  await act(async () => root.render(<WorkflowDefinitionsSection overseer={{ saveWorkflowDefinition } as unknown as RpcStub<Overseer>}
    gadgets={GADGETS} definitions={[temporary]} onChanged={onChanged} />))
  await act(async () => buttonIn(rowOf('One-off'), 'Save to keep')!.click())
  const told = toast.mock.calls[0]![0].title
  expect(told).toContain('expired before it was saved')
  expect(told).toContain('stay in their history')
  expect(told).not.toMatch(/not found|went wrong/i)
  expect(onChanged).toHaveBeenCalledOnce()
})

it('reads a definition whose expiry has passed as expired, with nothing left to save', async () => {
  const lapsed: WorkflowDefinition = { ...temporary, id: 'x', title: 'Lapsed', expiresAt: new Date(Date.now() - 1000) }
  await act(async () => root.render(<WorkflowDefinitionsSection overseer={{} as unknown as RpcStub<Overseer>}
    gadgets={GADGETS} definitions={[lapsed]} onChanged={vi.fn<() => void>()} />))
  const row = rowOf('Lapsed')
  expect(row.textContent).toContain('Expired')
  expect(row.textContent).toContain('stay in their history')
  expect(buttonIn(row, 'Save to keep')).toBeUndefined()
  expect(buttonIn(row, 'Save new revision')).toBeUndefined()
})

it('shows any other refusal in the server\'s own words', async () => {
  const saveWorkflowDefinition = vi.fn<Overseer['saveWorkflowDefinition']>(async () => {
    throw new Error('A workflow definition is saved from a workflow gadget with committed code.')
  })
  await act(async () => root.render(<WorkflowDefinitionsSection overseer={{ saveWorkflowDefinition } as unknown as RpcStub<Overseer>}
    gadgets={GADGETS} definitions={[kept]} onChanged={vi.fn<() => void>()} />))
  await act(async () => buttonIn(rowOf('Kept'), 'Save new revision')!.click())
  expect(toast.mock.calls[0]![0].title).toBe('A workflow definition is saved from a workflow gadget with committed code.')
})

const BEN = { type: 'user' as const, id: 'ben', name: 'Ben' }
const published = { revision: 1, at: new Date(0), by: BEN }
const revision2 = { ...revision, revision: 2 }

it('offers its owner to share a saved definition, never a temporary one', async () => {
  await act(async () => root.render(<WorkflowDefinitionsSection overseer={{} as unknown as RpcStub<Overseer>}
    gadgets={GADGETS} definitions={[temporary, kept]} onChanged={vi.fn<() => void>()} />))
  expect(buttonIn(rowOf('One-off'), 'Share')).toBeUndefined()
  await act(async () => buttonIn(rowOf('Kept'), 'Share')!.click())
  expect(container.querySelector('dialog')?.textContent).toBe('Sharing Kept')
})

it('says a definition is shared with this person, and lets them do only what the server says', async () => {
  const readOnly: WorkflowDefinition = { id: 'r', title: 'Read me', owner: BEN, revisions: [revision], published,
    access: { read: true, run: true, edit: false }, sharedWithMe: true }
  const editable: WorkflowDefinition = { id: 'e', title: 'Edit me', owner: BEN, revisions: [revision, revision2], published,
    access: { read: true, run: true, edit: true }, sharedWithMe: true }
  // Seen through the workspace, not a share: no "shared with you", whatever it allows.
  const workspaceWide: WorkflowDefinition = { id: 'w', title: 'Everyone', owner: BEN, revisions: [revision], published,
    access: { read: true, run: false, edit: false } }
  const saveWorkflowDefinition = vi.fn<Overseer['saveWorkflowDefinition']>(async () => editable)
  await act(async () => root.render(<WorkflowDefinitionsSection
    overseer={{ saveWorkflowDefinition } as unknown as RpcStub<Overseer>}
    gadgets={GADGETS} definitions={[readOnly, editable, workspaceWide]} onChanged={vi.fn<() => void>()} />))

  expect(rowOf('Read me').textContent).toContain('Shared with you · you can run, read')
  // Anyone who can see it may ask to duplicate it; the server decides who builds here (FAC-123).
  expect(labelsIn(rowOf('Read me'))).toEqual(['Duplicate'])
  expect(rowOf('Everyone').textContent).not.toContain('Shared with you')
  expect(labelsIn(rowOf('Everyone'))).toEqual(['Duplicate'])

  const row = rowOf('Edit me')
  expect(row.textContent).toContain('Shared with you · you can edit, run, read')
  // Only its owner shares it.
  expect(buttonIn(row, 'Share')).toBeUndefined()
  await act(async () => buttonIn(row, 'Save new revision')!.click())
  expect(saveWorkflowDefinition).toHaveBeenCalledWith({ id: 'e', title: 'Edit me', gadgetId: 3 })
  // Its owner publishes it: an editor's publish is refused outside shared configuration.
  expect(buttonIn(row, 'Publish revision 2')).toBeUndefined()
})

// FAC-123: duplicating, where a duplicate came from, and the connections it still needs.
const NEEDS = [{ name: 'BOARD', type: 'gatekeeper' as const, vendorId: 'inferops', typeUrlPattern: 'inferops://*', unmet: 'missing' as const }]

it('duplicates a definition, then takes its owner straight to setting up the copy\'s connections', async () => {
  duplicated.copy = { ...kept, id: 'c', title: 'Kept (copy)', duplicatedFrom: { at: new Date(0), definitionId: 'k', title: 'Kept', revision: 1 }, bindingsNeeded: NEEDS }
  const onChanged = vi.fn<() => void>()
  await act(async () => root.render(<WorkflowDefinitionsSection overseer={{} as unknown as RpcStub<Overseer>}
    gadgets={GADGETS} definitions={[kept]} onChanged={onChanged} />))
  await act(async () => buttonIn(rowOf('Kept'), 'Duplicate')!.click())
  expect(container.querySelector('dialog')?.textContent).toContain('Duplicating Kept')
  await act(async () => (container.querySelector('dialog button') as HTMLButtonElement).click())
  expect(onChanged).toHaveBeenCalledOnce()
  expect(container.querySelector('dialog')?.textContent).toBe('Setting up Kept (copy)')
})

it('offers no duplicate of an expired definition', async () => {
  const lapsed: WorkflowDefinition = { ...temporary, id: 'x', title: 'Lapsed', expiresAt: new Date(Date.now() - 1000) }
  await act(async () => root.render(<WorkflowDefinitionsSection overseer={{} as unknown as RpcStub<Overseer>}
    gadgets={GADGETS} definitions={[lapsed]} onChanged={vi.fn<() => void>()} />))
  expect(buttonIn(rowOf('Lapsed'), 'Duplicate')).toBeUndefined()
})

it('says where a duplicate came from only as far as the server lets this person know', async () => {
  const known: WorkflowDefinition = { ...kept, id: 'a', title: 'Mine', duplicatedFrom: { at: new Date(0), definitionId: 'k', title: 'Refunds', revision: 2 } }
  const unknown: WorkflowDefinition = { ...kept, id: 'b', title: 'Other', duplicatedFrom: { at: new Date(0) } }
  await act(async () => root.render(<WorkflowDefinitionsSection overseer={{} as unknown as RpcStub<Overseer>}
    gadgets={GADGETS} definitions={[known, unknown]} onChanged={vi.fn<() => void>()} />))
  expect(rowOf('Mine').textContent).toContain('Duplicated from “Refunds”, revision 2')
  expect(rowOf('Other').textContent).toContain('Duplicated from a workflow')
  expect(rowOf('Other').textContent).not.toContain('Refunds')
})

it('tells its owner why a duplicate can\'t run yet, in the words its runs are refused with, and offers the set-up', async () => {
  const fresh: WorkflowDefinition = { ...kept, id: 'n', title: 'Fresh', bindingsNeeded: NEEDS }
  const borrowed: WorkflowDefinition = { ...kept, id: 'o', title: 'Borrowed', bindingsNeeded: [{ ...NEEDS[0]!, unmet: 'not-owners' }] }
  const older: WorkflowDefinition = { ...kept, id: 'u', title: 'Older',
    bindingsNeeded: [{ ...NEEDS[0]!, unmet: 'not-owners' }, { ...NEEDS[0]!, name: 'MODEL', unmet: 'unattributed' }] }
  await act(async () => root.render(<WorkflowDefinitionsSection overseer={{} as unknown as RpcStub<Overseer>}
    gadgets={GADGETS} definitions={[fresh, borrowed, older]} onChanged={vi.fn<() => void>()} />))
  expect(rowOf('Fresh').textContent).toContain(WORKFLOW_BINDINGS_NEEDED)
  expect(rowOf('Borrowed').textContent).toContain(WORKFLOW_BINDINGS_NOT_OWNERS)
  // The server's order: an older connection first.
  expect(rowOf('Older').textContent).toContain(WORKFLOW_BINDINGS_UNATTRIBUTED)
  await act(async () => buttonIn(rowOf('Fresh'), 'Set up connections')!.click())
  expect(container.querySelector('dialog')?.textContent).toBe('Setting up Fresh')
})

it('shows no set-up to anyone but the owner, and none once every connection is set up', async () => {
  const theirs: WorkflowDefinition = { ...kept, id: 'z', title: 'Theirs', owner: BEN, published, bindingsNeeded: NEEDS }
  const done: WorkflowDefinition = { ...kept, id: 'd', title: 'Done', bindingsNeeded: [] }
  await act(async () => root.render(<WorkflowDefinitionsSection overseer={{} as unknown as RpcStub<Overseer>}
    gadgets={GADGETS} definitions={[theirs, done]} onChanged={vi.fn<() => void>()} />))
  for (const title of ['Theirs', 'Done']) {
    expect(rowOf(title).textContent).not.toContain('before it can run')
    expect(buttonIn(rowOf(title), 'Set up connections')).toBeUndefined()
  }
})
