// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// FAC-122: an owner shares one definition with people of the workspace by account, to read, run or
// edit, sees who it is shared with, and stops a share. The server decides everything; this shows
// each of its states (loading, empty, error, refused in its words) and never offers editing to
// someone who only uses the workspace.
import { act, type ChangeEvent, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { CollaboratorInfo, Overseer } from '@gadgets/workshop-shared/api'
import type { WorkflowDefinition, WorkflowDefinitionShare } from '@gadgets/workshop-shared/workflow-definition'
import { ShareWorkflowDialog, describeRights } from './ShareWorkflowDialog'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const toast = vi.hoisted(() => vi.fn<(toast: { title: string }) => void>())
vi.mock('@cloudflare/kumo', () => {
  const Dialog = Object.assign(
    ({ children }: { children: ReactNode }) => <dialog open>{children}</dialog>,
    {
      Root: ({ children }: { children: ReactNode }) => <>{children}</>,
      Title: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
      Description: ({ children }: { children: ReactNode }) => <p>{children}</p>,
      Close: ({ render }: { render: (props: object) => ReactElement }) => render({}),
    },
  )
  const Select = Object.assign(
    ({ children, onValueChange, value, 'aria-label': label }: {
      children: ReactNode; onValueChange: (value: string) => void; value?: string; 'aria-label': string
    }) => (
      <select aria-label={label} value={value ?? ''} onChange={(e: ChangeEvent<HTMLSelectElement>) => onValueChange(e.target.value)}>
        <option value="">none</option>
        {children}
      </select>
    ),
    { Option: ({ children, value }: { children: ReactNode; value: string }) => <option value={value}>{children}</option> },
  )
  return {
    Checkbox: ({ label, checked, disabled, onCheckedChange }: {
      label: string; checked?: boolean; disabled?: boolean; onCheckedChange?: (checked: boolean) => void
    }) => (
      <label>
        <input type="checkbox" aria-label={label} checked={checked ?? false} disabled={disabled}
          onChange={(e) => onCheckedChange?.(e.target.checked)} />
        {label}
      </label>
    ),
    Dialog,
    Select,
    useKumoToastManager: () => ({ add: toast }),
  }
})
vi.mock('../../components/WorkshopControls', () => ({
  WorkshopButton: ({ children, ...props }: ComponentProps<'button'>) => <button type="button" {...props}>{children}</button>,
  WorkshopIconButton: ({ children, ...props }: ComponentProps<'button'>) => <button type="button" {...props}>{children}</button>,
}))

const ADA = { type: 'user' as const, id: 'ada', name: 'Ada' }
const revision = { revision: 1, source: { kind: 'gadget' as const, gadgetId: 3, commitId: 'a'.repeat(40) }, savedAt: new Date(0) }
const DEFINITION: WorkflowDefinition = { id: 'd', title: 'Refunds', owner: ADA, revisions: [revision], published: null }
const collaborator = (id: string, name: string, role: 'build' | 'use') =>
  ({ profile: { type: 'user', id, name }, addedBy: ADA, role }) as unknown as CollaboratorInfo
const COLLABORATORS = [collaborator('ada', 'Ada', 'build'), collaborator('ben', 'Ben', 'build'), collaborator('cy', 'Cy', 'use')]
const shareOf = (profileId: string, rights: WorkflowDefinitionShare['rights']): WorkflowDefinitionShare =>
  ({ definitionId: 'd', profileId, rights, sharedBy: ADA, sharedAt: new Date(0) })

let container: HTMLDivElement
let root: Root
beforeEach(() => { toast.mockReset(); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

const button = (label: string) => [...container.querySelectorAll('button')].find(b => b.textContent === label)
const box = (label: string) => container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
const choose = async (profileId: string) => {
  let select = container.querySelector<HTMLSelectElement>('select[aria-label="Person to share with"]')!
  await act(async () => { select.value = profileId; select.dispatchEvent(new Event('change', { bubbles: true })) })
}
const render = async (overseer: Partial<Overseer>) => {
  await act(async () => root.render(<ShareWorkflowDialog overseer={overseer as unknown as RpcStub<Overseer>}
    definition={DEFINITION} collaborators={COLLABORATORS} onClose={() => {}} />))
}

it('says the rights as a person reads them', () => {
  expect(describeRights({ read: true, run: false, edit: false })).toBe('read')
  expect(describeRights({ read: true, run: true, edit: true })).toBe('edit, run, read')
})

it('says it is loading, then that it is shared with nobody yet, and never offers the owner to themselves', async () => {
  let answer!: (shares: WorkflowDefinitionShare[]) => void
  const listWorkflowDefinitionShares = vi.fn<() => Promise<WorkflowDefinitionShare[]>>(() => new Promise<WorkflowDefinitionShare[]>(resolve => { answer = resolve }))
  await render({ listWorkflowDefinitionShares })
  expect(container.textContent).toContain("Loading who it's shared with")
  await act(async () => answer([]))
  expect(container.textContent).toContain('Not shared with anyone by name yet.')
  const people = [...container.querySelectorAll('option')].map(o => o.textContent)
  expect(people).toEqual(['none', 'Ben', 'Cy'])
  // A share adds; nothing here claims it restricts anyone, or reaches a record.
  expect(container.textContent).toContain('it never removes what this workspace already lets them do')
  expect(container.textContent).toContain('it gives no access to records')
})

it('says it could not load who it is shared with, and tries again', async () => {
  const listWorkflowDefinitionShares = vi.fn<Overseer['listWorkflowDefinitionShares']>()
    .mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce([shareOf('ben', { read: true, run: false, edit: false })])
  await render({ listWorkflowDefinitionShares })
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load who it's shared with.")
  await act(async () => button('Try again')!.click())
  expect(container.textContent).toContain('Ben')
  expect(container.textContent).toContain('Can read')
})

it('shares with one person to read and run, by their account', async () => {
  const shareWorkflowDefinition = vi.fn<Overseer['shareWorkflowDefinition']>(async (_id, profileId, rights) => [shareOf(profileId, rights!)])
  await render({ listWorkflowDefinitionShares: async () => [], shareWorkflowDefinition })
  expect(button('Share')!.disabled).toBe(true)
  await choose('ben')
  expect(box('Read').checked).toBe(true)
  expect(box('Read').disabled).toBe(true)
  await act(async () => box('Run').click())
  await act(async () => button('Share')!.click())
  expect(shareWorkflowDefinition).toHaveBeenCalledWith('d', 'ben', { read: true, run: true, edit: false })
  expect(container.textContent).toContain('Can run, read')
})

it('offers editing only to someone who builds here', async () => {
  const shareWorkflowDefinition = vi.fn<Overseer['shareWorkflowDefinition']>(async (_id, profileId, rights) => [shareOf(profileId, rights!)])
  await render({ listWorkflowDefinitionShares: async () => [], shareWorkflowDefinition })
  await choose('cy')
  expect(box('Edit').disabled).toBe(true)
  expect(container.textContent).toContain('Only someone who can build in this workspace can edit a workflow.')
  await choose('ben')
  expect(box('Edit').disabled).toBe(false)
  await act(async () => box('Edit').click())
  await act(async () => button('Share')!.click())
  expect(shareWorkflowDefinition).toHaveBeenCalledWith('d', 'ben', { read: true, run: false, edit: true })
})

it('stops sharing with one person', async () => {
  const shareWorkflowDefinition = vi.fn<Overseer['shareWorkflowDefinition']>(async () => [])
  await render({ listWorkflowDefinitionShares: async () => [shareOf('ben', { read: true, run: true, edit: false })], shareWorkflowDefinition })
  await act(async () => button('Stop sharing')!.click())
  expect(shareWorkflowDefinition).toHaveBeenCalledWith('d', 'ben', null)
  expect(container.textContent).toContain('Not shared with anyone by name yet.')
})

it('shows a refusal in the server\'s words, and keeps the list as it was', async () => {
  const shareWorkflowDefinition = vi.fn<Overseer['shareWorkflowDefinition']>(async () => {
    throw new Error("Save this workflow before sharing it: a temporary workflow can't be shared.")
  })
  await render({ listWorkflowDefinitionShares: async () => [], shareWorkflowDefinition })
  await choose('ben')
  await act(async () => button('Share')!.click())
  expect(toast).toHaveBeenCalledWith({ title: "Save this workflow before sharing it: a temporary workflow can't be shared.", variant: 'error' })
  expect(container.textContent).toContain('Not shared with anyone by name yet.')
})
