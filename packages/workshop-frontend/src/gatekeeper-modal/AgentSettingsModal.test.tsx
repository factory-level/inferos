// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// Reopening a configured agent (FAC-90): it shows what was saved, its name and instructions save
// without its capabilities, and its capabilities change only through their own save.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AgentSpawnerConfig, AuthenticatedApi, Overseer } from '@gadgets/workshop-shared/api'

vi.mock('../errorReporting', () => ({ reportIssue: vi.fn<() => void>() }))

import { AgentSettingsModal, agentsReaching, rowsFromOtherAgent, type AgentBindingRef } from './AgentSettingsModal'

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
  { target: 9, targetTitle: 'Cycler', name: 'CYCLER' },
]

// Agents by workpiece id: 7 is the one edited, 8 another agent of the gadget, 9 an agent bound
// to the gadget whose env reaches 7.
const CYCLER: AgentSpawnerConfig = { displayName: 'Cycler', modelId: null, env: { DESK: 7 } }

function fakes({ createdByYou = true }: { createdByYou?: boolean } = {}) {
  const configs: Record<number, AgentSpawnerConfig> = { 7: SAVED, 8: OTHER, 9: CYCLER }
  const overseer = {
    getAgentSpawner: vi.fn<(id: number) => Promise<{ config: AgentSpawnerConfig, createdByYou: boolean }>>(
      async (id) => {
        if (!configs[id]) throw new Error(`Workpiece ${id} is not an agent.`)
        return { config: configs[id], createdByYou: id === 7 ? createdByYou : true }
      }),
    updateAgentSpawner: vi.fn<(id: number, expected: AgentSpawnerConfig, behaviour: object) => Promise<AgentSpawnerConfig>>(
      async (_id, expected, behaviour) => ({ ...expected, ...behaviour })),
    setAgentSpawnerEnv: vi.fn<(id: number, expected: AgentSpawnerConfig, env: Record<string, number>) => Promise<AgentSpawnerConfig>>(
      async (_id, expected, env) => ({ ...expected, env })),
  }
  const authenticatedApi = { listModels: async () => [] } as unknown as RpcStub<AuthenticatedApi>
  return { overseer, authenticatedApi }
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

  it('never offers an agent that would let this one spawn itself', async () => {
    await open()
    expect(document.body.querySelector('[aria-label="Binding name for Cycler"]')).toBeNull()
    expect(byLabel('Binding name for Board')).toBeTruthy()
  })

  it("shows a non-creator the model, instructions and capabilities read-only, and saves their name", async () => {
    const f = await open(fakes({ createdByYou: false }))
    expect(document.body.textContent).toContain('Only the person who created this agent can change its model')
    expect(byLabel<HTMLTextAreaElement>('Agent instructions').readOnly).toBe(true)
    expect(byLabel<HTMLInputElement>('Binding name for Jobs').disabled).toBe(true)
    expect(Array.from(document.body.querySelectorAll('button')).some((b) => b.textContent === 'Save capabilities'))
      .toBe(false)
    await type(byLabel<HTMLInputElement>('Agent display name'), 'Service desk (EU)')
    await click(button('Save'))
    await settle()
    expect(f.overseer.updateAgentSpawner).toHaveBeenCalledWith(7, SAVED, { displayName: 'Service desk (EU)' })
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

  it('finds every agent that reaches this one, however far along', async () => {
    const envs: Record<number, Record<string, number>> = { 1: { B: 2 }, 2: { C: 3 }, 3: { SELF: 7 }, 4: { JOBS: 100 } }
    const read = vi.fn<(id: number) => Promise<Record<string, number> | null>>(async (id) => envs[id] ?? null)
    expect(await agentsReaching(7, [1, 4, 7, 100], read)).toEqual(new Set([1, 7]))
    expect(read).toHaveBeenCalledTimes(5)
    // Each workpiece is read once, and a cycle that doesn't include this agent ends.
    expect(await agentsReaching(7, [5], async (id): Promise<Record<string, number> | null> => (id === 5 ? { X: 6 } : id === 6 ? { Y: 5 } : null)))
      .toEqual(new Set())
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
