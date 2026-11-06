// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { TriggerAssignment } from '@gadgets/workshop-shared/workflow-definition'
import { TriggerAssignmentEditor } from './TriggerAssignmentEditor'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

vi.mock('@cloudflare/kumo', () => ({
  Button: ({ children, onClick, disabled, type }: {
    children: ReactNode; onClick?: () => void; disabled?: boolean; type?: 'submit' | 'button'
  }) => (
    <button type={type ?? 'button'} onClick={onClick} disabled={disabled}>{children}</button>
  ),
  Input: ({ value, onChange, type, autoComplete, 'aria-label': label }: {
    value: string
    onChange: (e: { target: { value: string } }) => void
    type?: string
    autoComplete?: string
    'aria-label': string
  }) => <input aria-label={label} type={type} autoComplete={autoComplete} value={value} onChange={onChange} />,
  Select: Object.assign(({ children, label, value, onValueChange }: {
    children: ReactNode; label: string; value: unknown; onValueChange: (value: unknown) => void
  }) => (
    <select aria-label={label} value={String(value)} onChange={e => onValueChange(e.target.value)}>{children}</select>
  ), {
    Option: ({ children, value }: { children: ReactNode; value: unknown }) => <option value={String(value)}>{children}</option>,
  }),
}))

const KEY = 'iex_test_never_shown_key'
const ADA = { type: 'user' as const, id: 'ada', name: 'Ada' }
const CONNECTIONS = [{ id: 10, title: 'Operations board' }, { id: 11, title: 'Sales board' }]
const assignment = (overrides: Partial<TriggerAssignment> = {}): TriggerAssignment => ({
  hookId: 1,
  gatekeeperId: 10,
  credentialRef: '5b2c1d8e-0000-4000-8000-0000000000a1',
  assignedBy: ADA,
  assignedAt: new Date(0),
  ...overrides,
})

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const overseerWith = (methods: Partial<Record<'setTriggerAssignment' | 'provisionTriggerCredential', unknown>>) =>
  methods as unknown as RpcStub<Overseer>

const render = async (overseer: RpcStub<Overseer>, current: TriggerAssignment | null, onChanged = vi.fn<() => void>()) => {
  await act(async () => {
    root.render(<TriggerAssignmentEditor overseer={overseer} hookId={1} assignment={current}
      connections={CONNECTIONS} onChanged={onChanged} />)
  })
  return onChanged
}
const button = (label: string) =>
  [...container.querySelectorAll('button')].find(b => b.textContent === label)!
const keyField = () => container.querySelector<HTMLInputElement>('input[aria-label="Service account key"]')!
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const submit = async () => {
  await act(async () => { keyField().form!.requestSubmit() })
}

describe('TriggerAssignmentEditor', () => {
  it('assigns the chosen connection', async () => {
    const setTriggerAssignment = vi.fn<Overseer['setTriggerAssignment']>(async () => assignment({ gatekeeperId: 11 }))
    const onChanged = await render(overseerWith({ setTriggerAssignment }), null)
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Connection"]')!
    await act(async () => {
      select.value = '11'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => { button('Assign').click() })
    expect(setTriggerAssignment).toHaveBeenCalledWith(1, { gatekeeperId: 11 })
    expect(onChanged).toHaveBeenCalled()
  })

  it('says how to get a connection when the gadget binds none', async () => {
    await act(async () => {
      root.render(<TriggerAssignmentEditor overseer={overseerWith({})} hookId={1} assignment={null}
        connections={[]} onChanged={vi.fn<() => void>()} />)
    })
    expect(container.textContent).toContain("Bind this trigger's gadget to a connection")
    expect(container.querySelector('select')).toBeNull()
  })

  it('takes the key in a password field and gives it once, then empties the field', async () => {
    const provisionTriggerCredential = vi.fn<Overseer['provisionTriggerCredential']>(async () => assignment({ provisionedBy: ADA, provisionedAt: new Date() }))
    const onChanged = await render(overseerWith({ provisionTriggerCredential }), assignment())
    expect(keyField().type).toBe('password')
    expect(keyField().autocomplete).toBe('off')
    await type(keyField(), KEY)
    await submit()
    expect(provisionTriggerCredential).toHaveBeenCalledExactlyOnceWith(1, KEY)
    expect(keyField().value).toBe('')
    expect(onChanged).toHaveBeenCalled()
    expect(container.innerHTML).not.toContain(KEY)
  })

  it("empties the field when the key is refused too, and shows the server's words", async () => {
    const provisionTriggerCredential = vi.fn<Overseer['provisionTriggerCredential']>(async () => { throw new Error("The key wasn't accepted.") })
    const onChanged = await render(overseerWith({ provisionTriggerCredential }), assignment())
    await type(keyField(), KEY)
    await submit()
    expect(keyField().value).toBe('')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("The key wasn't accepted.")
    expect(container.innerHTML).not.toContain(KEY)
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('says no key has been given yet, then who gave it and when', async () => {
    await render(overseerWith({}), assignment())
    expect(container.textContent).toContain('Operations board')
    expect(container.textContent).toContain('No key yet: runs are refused until an Admin gives one.')
    const at = new Date(Date.UTC(2026, 10, 5, 12, 0))
    await render(overseerWith({}), assignment({ provisionedBy: ADA, provisionedAt: at }))
    expect(container.textContent).toContain(`Key given by Ada on ${at.toLocaleString()}.`)
  })

  it('removes the assignment', async () => {
    const setTriggerAssignment = vi.fn<Overseer['setTriggerAssignment']>(async () => null)
    await render(overseerWith({ setTriggerAssignment }), assignment())
    await act(async () => { button('Remove').click() })
    expect(setTriggerAssignment).toHaveBeenCalledWith(1, null)
  })

  it("shows a refused assignment in the server's words", async () => {
    const setTriggerAssignment = vi.fn<Overseer['setTriggerAssignment']>(async () => { throw new Error('Only an Admin can assign a trigger.') })
    await render(overseerWith({ setTriggerAssignment }), null)
    await act(async () => { button('Assign').click() })
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Only an Admin can assign a trigger.')
  })
})
