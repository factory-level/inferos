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

const render = async (overseer: RpcStub<Overseer>, current: TriggerAssignment | null, onChanged = vi.fn<() => void>(),
  enabled = true) => {
  await act(async () => {
    root.render(<TriggerAssignmentEditor overseer={overseer} hookId={1} enabled={enabled} assignment={current}
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
const pressEnter = async () => {
  await act(async () => {
    keyField().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

/**
 * Whether `secret` appears anywhere React holds for the rendered tree: every fiber's props and
 * its hooks' state. DOM nodes are skipped, since the input element itself is where the key is
 * meant to live while it is typed.
 */
const reactTreeHolds = (secret: string): boolean => {
  const rootKey = Object.keys(container).find(k => k.startsWith('__reactContainer$'))!
  const seen = new Set<unknown>()
  const holds = (value: unknown, depth: number): boolean => {
    if (typeof value === 'string') return value.includes(secret)
    if (value === null || typeof value !== 'object' || depth > 8 || seen.has(value)) return false
    if (value instanceof Node) return false
    seen.add(value)
    return Object.entries(value).some(([k, v]) =>
      !['return', 'child', 'sibling', 'alternate', '_owner', 'stateNode'].includes(k) && holds(v, depth + 1))
  }
  type Fiber = { memoizedProps?: unknown; memoizedState?: unknown; child?: Fiber | null; sibling?: Fiber | null }
  const visit = (fiber: Fiber | null | undefined): boolean => {
    for (let f = fiber; f; f = f.sibling) {
      if (holds(f.memoizedProps, 0) || holds(f.memoizedState, 0) || visit(f.child)) return true
    }
    return false
  }
  // The container keeps the root fiber it was created with, which may now be the stale alternate;
  // its FiberRoot (stateNode) points at the committed tree.
  const hostRoot = (container as unknown as Record<string, { stateNode: { current: Fiber } }>)[rootKey]!
  return visit(hostRoot.stateNode.current)
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
      root.render(<TriggerAssignmentEditor overseer={overseerWith({})} hookId={1} enabled assignment={null}
        connections={[]} onChanged={vi.fn<() => void>()} />)
    })
    expect(container.textContent).toContain("Bind this trigger's gadget to a connection")
    expect(container.querySelector('select')).toBeNull()
  })

  it("says the gadget's connections couldn't be read, and retries", async () => {
    const onChanged = vi.fn<() => void>()
    await act(async () => {
      root.render(<TriggerAssignmentEditor overseer={overseerWith({})} hookId={1} enabled assignment={null}
        connections={null} onChanged={onChanged} />)
    })
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Couldn't read this trigger's connections.")
    expect(container.textContent).not.toContain("Bind this trigger's gadget to a connection")
    await act(async () => { button('Retry').click() })
    expect(onChanged).toHaveBeenCalledOnce()
  })

  it('keeps password managers off the key field, and submits no form', async () => {
    await render(overseerWith({}), assignment())
    const field = keyField()
    expect(field.type).toBe('password')
    expect(field.autocomplete).toBe('new-password')
    for (const optOut of ['data-1p-ignore', 'data-lpignore', 'data-bwignore', 'data-keeper-ignore']) {
      expect(field.getAttribute(optOut)).toBe('true')
    }
    expect(container.querySelector('form')).toBeNull()
    expect(field.form).toBeNull()
  })

  it('gives the key once from the field alone, never through React state or props, then empties it', async () => {
    const provisionTriggerCredential = vi.fn<Overseer['provisionTriggerCredential']>(async () => assignment({ provisionedBy: ADA, provisionedAt: new Date() }))
    const onChanged = await render(overseerWith({ provisionTriggerCredential }), assignment())
    await type(keyField(), KEY)
    expect(button('Give key').disabled).toBe(false)
    // While it is typed, the key is only the DOM input's value.
    expect(reactTreeHolds(KEY)).toBe(false)
    await act(async () => { button('Give key').click() })
    expect(provisionTriggerCredential).toHaveBeenCalledExactlyOnceWith(1, KEY)
    expect(keyField().value).toBe('')
    expect(button('Give key').disabled).toBe(true)
    expect(onChanged).toHaveBeenCalled()
    expect(container.innerHTML).not.toContain(KEY)
    expect(reactTreeHolds(KEY)).toBe(false)
  })

  it("gives it on Enter too, empties the field when it is refused, and shows the server's words", async () => {
    const provisionTriggerCredential = vi.fn<Overseer['provisionTriggerCredential']>(async () => { throw new Error("The key wasn't accepted.") })
    const onChanged = await render(overseerWith({ provisionTriggerCredential }), assignment())
    await type(keyField(), KEY)
    await pressEnter()
    expect(provisionTriggerCredential).toHaveBeenCalledExactlyOnceWith(1, KEY)
    expect(keyField().value).toBe('')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("The key wasn't accepted.")
    expect(container.innerHTML).not.toContain(KEY)
    expect(reactTreeHolds(KEY)).toBe(false)
    expect(onChanged).not.toHaveBeenCalled()
  })

  // The manager, 2026-11-06: assignments are off by default; the server decides, the editor says so.
  it('says assignments are off on this instance and offers no way to assign or give a key', async () => {
    await render(overseerWith({}), null, undefined, false)
    expect(container.textContent).toContain('Not enabled on this instance.')
    expect(container.querySelector('select')).toBeNull()
    expect(container.querySelector('input')).toBeNull()
    expect([...container.querySelectorAll('button')].map(b => b.textContent)).toEqual([])
  })

  it('still lets an Admin remove an assignment made before they were turned off', async () => {
    const setTriggerAssignment = vi.fn<Overseer['setTriggerAssignment']>(async () => null)
    const onChanged = await render(overseerWith({ setTriggerAssignment }), assignment(), undefined, false)
    expect(container.textContent).toContain('Not enabled on this instance.')
    expect(container.textContent).toContain('Operations board')
    expect(container.querySelector('input')).toBeNull()
    expect([...container.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Remove'])
    await act(async () => { button('Remove').click() })
    expect(setTriggerAssignment).toHaveBeenCalledWith(1, null)
    expect(onChanged).toHaveBeenCalled()
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
