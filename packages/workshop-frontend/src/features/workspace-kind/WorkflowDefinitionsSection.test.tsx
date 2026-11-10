// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// FAC-124: a dynamic, unsaved definition says it is temporary and when it expires, and offers its
// owner a save that keeps it (the same save, which retains it). A retained one says nothing of
// expiry. Nothing here creates a temporary definition: the Dot and agents do.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { GadgetSummary, Overseer } from '@gadgets/workshop-shared/api'
import type { WorkflowDefinition } from '@gadgets/workshop-shared/workflow-definition'
import { WorkflowDefinitionsSection } from './WorkflowDefinitionsSection'

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
  Input: ({ value, onChange, 'aria-label': label }: {
    value: string; onChange: (e: { target: { value: string } }) => void; 'aria-label': string
  }) => <input aria-label={label} value={value} onChange={onChange} />,
  Select: Object.assign(({ children }: { children: ReactNode }) => <div>{children}</div>, {
    Option: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  }),
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ currentUser: { id: 'ada', name: 'Ada' } }) }))

const ADA = { type: 'user' as const, id: 'ada', name: 'Ada' }
const revision = { revision: 1, source: { kind: 'gadget' as const, gadgetId: 3, commitId: 'a'.repeat(40) }, savedAt: new Date(0) }
const EXPIRES = new Date(Date.UTC(2026, 10, 11, 9, 0))
const temporary: WorkflowDefinition = { id: 't', title: 'One-off', owner: ADA, revisions: [revision], published: null, expiresAt: EXPIRES }
const kept: WorkflowDefinition = { id: 'k', title: 'Kept', owner: ADA, revisions: [revision], published: null }
const GADGETS = [{ id: 3, title: 'Refunds' }] as unknown as GadgetSummary[]

let container: HTMLDivElement
let root: Root
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

const rowOf = (title: string) => [...container.querySelectorAll('li')].find(li => li.textContent?.includes(title))!
const buttonIn = (row: Element, label: string) => [...row.querySelectorAll('button')].find(b => b.textContent === label)

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
