// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// Reopening a configured agent (FAC-90): it shows what was saved, its name and instructions save
// without its capabilities, and its capabilities change only through their own save.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AgentSpawnerConfig, AuthenticatedApi, GadgetClient, Overseer } from '@gadgets/workshop-shared/api'

vi.mock('../errorReporting', () => ({ reportIssue: vi.fn<() => void>() }))

import { AgentSettingsModal, rowsFromOtherAgent, type AgentBindingRef } from './AgentSettingsModal'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// jsdom has no PointerEvent, which Kumo's checkbox dispatches on click.
if (!('PointerEvent' in window)) {
  Object.defineProperty(window, 'PointerEvent', { value: class extends MouseEvent {} })
}

const SAVED: AgentSpawnerConfig = {
  displayName: 'Service desk',
  modelId: null,
  env: { JOBS: 100 },
  instructions: 'Triage new service enquiries.',
}
const OTHER: AgentSpawnerConfig = { displayName: 'Planner', modelId: null, env: { BOARD: 200 } }

const AGENT: AgentBindingRef = { name: 'SERVICE_DESK', gatekeeperId: 7, title: 'Service desk' }
const PLANNER: AgentBindingRef = { name: 'PLANNER', gatekeeperId: 8, title: 'Planner' }
const CANDIDATES = [
  { target: 100, targetTitle: 'Jobs', name: 'JOBS' },
  { target: 200, targetTitle: 'Board', name: 'BOARD' },
]

function fakes(configs: Record<string, AgentSpawnerConfig> = { SERVICE_DESK: SAVED, PLANNER: OTHER }) {
  const gadget = {
    getBinding: vi.fn<(name: string) => Promise<unknown>>(async (name) => configs[name]
      ? {
        getCreationSpec: async () => ({ type: 'agentSpawner', config: configs[name] }),
        [Symbol.dispose]: () => {},
      }
      : null),
  } as unknown as RpcStub<GadgetClient>
  const overseer = {
    updateAgentSpawner: vi.fn<(id: number, expected: AgentSpawnerConfig, behaviour: object) => Promise<AgentSpawnerConfig>>(async (_id, expected, behaviour) =>
      ({ ...expected, ...behaviour })),
    setAgentSpawnerEnv: vi.fn<(id: number, expected: AgentSpawnerConfig, env: Record<string, number>) => Promise<AgentSpawnerConfig>>(async (_id, expected, env) =>
      ({ ...expected, env })),
  }
  const authenticatedApi = { listModels: async () => [] } as unknown as RpcStub<AuthenticatedApi>
  return { gadget, overseer, authenticatedApi }
}

const byLabel = <T extends HTMLElement>(label: string) => {
  const element = document.body.querySelector<T>(`[aria-label="${label}"]`)
  if (!element) throw new Error(`No element labelled ${label}`)
  return element
}

const button = (name: string) => {
  const element = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
    .find(b => b.textContent === name || b.getAttribute('aria-label') === name)
  if (!element) throw new Error(`No button ${name}`)
  return element
}

const type = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => act(() => {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
})

const click = (element: HTMLElement) => act(async () => { element.click() })

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

describe('AgentSettingsModal', () => {
  let root: Root | undefined

  afterEach(() => {
    act(() => root?.unmount())
    root = undefined
    document.body.innerHTML = ''
  })

  async function open(f = fakes()) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root!.render(
      <AgentSettingsModal
        target={AGENT}
        gadget={f.gadget}
        overseer={f.overseer as unknown as RpcStub<Overseer>}
        authenticatedApi={f.authenticatedApi}
        envCandidates={CANDIDATES}
        otherAgents={[PLANNER]}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    ))
    await settle()
    return f
  }

  it('reopens with the saved name, instructions and capabilities', async () => {
    await open()
    expect(byLabel<HTMLInputElement>('Agent display name').value).toBe('Service desk')
    expect(byLabel<HTMLTextAreaElement>('Agent instructions').value).toBe('Triage new service enquiries.')
    expect(byLabel<HTMLInputElement>('Binding name for Jobs').disabled).toBe(false)
    expect(byLabel<HTMLInputElement>('Binding name for Board').disabled).toBe(true)
  })

  it('saves name and instructions without sending any capability', async () => {
    const f = await open()
    await type(byLabel<HTMLTextAreaElement>('Agent instructions'), 'Also flag anything urgent.')
    await click(button('Save'))
    await settle()
    expect(f.overseer.updateAgentSpawner).toHaveBeenCalledWith(7, SAVED,
      { instructions: 'Also flag anything urgent.' })
    expect(f.overseer.setAgentSpawnerEnv).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Agents spawned from now on use these settings.')
  })

  it('changes capabilities only through their own save, against the latest config', async () => {
    const f = await open()
    expect(button('Save capabilities').disabled).toBe(true)
    await click(byLabel('Give spawned agents access to Board'))
    await click(button('Save capabilities'))
    await settle()
    expect(f.overseer.setAgentSpawnerEnv).toHaveBeenCalledWith(7, SAVED, { JOBS: 100, BOARD: 200 })
    expect(f.overseer.updateAgentSpawner).not.toHaveBeenCalled()
  })

  it("starts from another agent's capabilities by copying only what this gadget can offer", () => {
    const rows = [
      { target: 100, targetTitle: 'Jobs', name: 'JOBS', enabled: true },
      { target: 200, targetTitle: 'Board', name: 'BOARD', enabled: false },
    ]
    expect(rowsFromOtherAgent(rows, { PROJECT_BOARD: 200, ELSEWHERE: 999 })).toEqual([
      { target: 100, targetTitle: 'Jobs', name: 'JOBS', enabled: false },
      { target: 200, targetTitle: 'Board', name: 'PROJECT_BOARD', enabled: true },
    ])
  })

  it("shows the server's refusal in its own words", async () => {
    const f = fakes()
    f.overseer.setAgentSpawnerEnv.mockRejectedValueOnce(
      new Error('Only the person who created this agent can change its capabilities.'))
    await open(f)
    await click(byLabel('Give spawned agents access to Board'))
    await click(button('Save capabilities'))
    await settle()
    expect(document.body.querySelector('[role="alert"]')?.textContent)
      .toBe('Only the person who created this agent can change its capabilities.')
  })
})
