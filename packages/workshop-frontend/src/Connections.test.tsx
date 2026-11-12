// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { RpcStub } from 'capnweb'
import type { GadgetClient, Overseer } from '@gadgets/workshop-shared/api'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ toast: vi.fn<(value: unknown) => void>() }))

vi.mock('@cloudflare/kumo', () => ({
  Dialog: Object.assign(({ children }: { children?: React.ReactNode }) => <div>{children}</div>, {
    Root: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    Title: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    Description: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    Close: () => null,
  }),
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useKumoToastManager: () => ({ add: mocks.toast }),
}))
vi.mock('@phosphor-icons/react', () => ({
  Pencil: () => null, Trash: () => null, Blueprint: () => null, Robot: () => null,
  Warning: () => null, X: () => null,
}))
vi.mock('./GatekeeperModal', () => ({ default: () => null }))
vi.mock('./gatekeeper-modal/AgentSettingsModal', () => ({ AgentSettingsModal: () => null }))
vi.mock('./components/GatekeeperIcon', () => ({ GatekeeperIcon: () => null }))
vi.mock('./components/HookToggle', () => ({
  HookToggle: ({ enabled, disabled }: { enabled: boolean; disabled: boolean }) => (
    <span aria-label="Hook status">{disabled ? 'disabled' : enabled ? 'enabled' : 'paused'}</span>
  ),
}))
vi.mock('./useVendorBranding', () => ({ useVendorBranding: () => new Map() }))
vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: ({ children, tone: _tone, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: string }) => (
    <button type="button" {...props}>{children}</button>
  ),
  WorkshopIconButton: ({ children, danger: _danger, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }) => (
    <button type="button" {...props}>{children}</button>
  ),
  WorkshopInput: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}))
vi.mock('./components/EmptyState', () => ({ EmptyState: () => null }))
vi.mock('./components/BlueprintBindingCard', () => ({
  BlueprintBindingCard: () => null,
  loadBindingCardData: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}))

import Connections from './Connections'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
testGlobal.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  mocks.toast.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const trigger = {
  id: 42,
  gadgetId: 1,
  gatekeeperId: 'gatekeeper-1',
  resourceTitle: 'Calendar',
  enabled: true,
  description: { title: 'Calendar updates', description: 'New event' },
} as unknown as Awaited<ReturnType<Overseer['listHooks']>>[number]

function button(label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll('button')).find((candidate) => candidate.textContent?.trim() === label)
  if (!match) throw new Error(`Missing button: ${label}`)
  return match
}

async function renderConnections(deleteHook: (id: number) => Promise<void>, listHooks?: () => Promise<typeof trigger[]>) {
  let hooks = [trigger]
  const overseer = {
    listHooks: vi.fn<Overseer['listHooks']>(async () => listHooks ? listHooks() : hooks),
    deleteHook: vi.fn<Overseer['deleteHook']>(async (id) => {
      await deleteHook(id)
      hooks = []
    }),
  } as unknown as RpcStub<Overseer>
  const gadget = {
    getId: vi.fn<GadgetClient['getId']>(async () => 1),
    getTitle: vi.fn<GadgetClient['getTitle']>(async () => 'Calendar gadget'),
    listBindings: vi.fn<GadgetClient['listBindings']>(async () => []),
  } as unknown as RpcStub<GadgetClient>

  await act(async () => root.render(
    <Connections overseer={overseer} gadget={gadget} authenticatedApi={{} as never} />,
  ))
  return { overseer }
}

async function requestDelete() {
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Delete hook"]')?.click())
  await act(async () => button('Delete').click())
}

describe('Connections trigger draining', () => {
  it('keeps a draining trigger visible and paused with an informational status', async () => {
    const { overseer } = await renderConnections(async () => {
      throw new Error('TRIGGER_DRAINING: This workflow is paused while its run finishes.')
    })

    await requestDelete()

    expect(container.textContent).toContain('Calendar updates is paused')
    expect(container.textContent).toContain('New runs are stopped; it is removed once the run finishes.')
    expect(container.textContent).toContain('Retry removal')
    await act(async () => button('Cancel').click())
    expect(container.querySelector('[aria-label="Hook status"]')?.textContent).toBe('disabled')
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'warning' }))
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.objectContaining({ variant: 'error' }))
    expect(overseer.deleteHook).toHaveBeenCalledTimes(1)
  })

  it('removes the trigger when retry succeeds after the run ends', async () => {
    let draining = true
    const { overseer } = await renderConnections(async () => {
      if (draining) throw new Error('TRIGGER_DRAINING: run active')
    })
    await requestDelete()
    draining = false

    await act(async () => button('Retry removal').click())

    expect(overseer.deleteHook).toHaveBeenCalledTimes(2)
    expect(container.textContent).not.toContain('Calendar updates')
    expect(container.querySelector('[role="status"]')).toBeNull()
  })

  it('keeps unrelated delete failures as errors', async () => {
    await renderConnections(async () => { throw new Error('network unavailable') })
    await requestDelete()

    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Failed to delete hook',
      variant: 'error',
    }))
    expect(container.textContent).not.toContain('Retry removal')
  })
})
