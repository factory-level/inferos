// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { BoundHookInfo, GadgetSummary, Overseer } from '@gadgets/workshop-shared/api'
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
  Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
  useKumoToastManager: () => ({ add: toast }),
}))

vi.mock('../../errorReporting', () => ({ reportIssue: vi.fn<(site: string, err: unknown) => void>() }))

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
  await act(async () => {
    root.render(
      <WorkflowTriggersPanel
        overseer={overseer as unknown as RpcStub<Overseer>}
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
})
