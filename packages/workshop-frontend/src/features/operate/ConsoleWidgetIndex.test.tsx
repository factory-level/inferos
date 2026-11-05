// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { WidgetIndexWorkspace } from '@gadgets/workshop-shared/gatekeeper'
import type { ConsoleWidgetIndexReport } from '@gadgets/workshop-shared/operate-console'
import { ConsoleWidgetIndex } from './ConsoleWidgetIndex'

// Kumo's Select, as a native select, so a test can choose a workspace.
vi.mock('@cloudflare/kumo', async importOriginal => {
  const actual = await importOriginal<typeof import('@cloudflare/kumo')>()
  const Select = ({ label, value, disabled, onValueChange, children }: { label: string; value: string; disabled?: boolean; onValueChange: (value: string) => void; children: ReactNode }) =>
    <label>{label}<select aria-label={label} value={value} disabled={disabled} onChange={event => onValueChange(event.target.value)}><option value="">None</option>{children}</select></label>
  Select.Option = ({ value, children }: { value: string; children: ReactNode }) => <option value={value}>{children}</option>
  return { ...actual, Select }
})

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

const OPS = { workspaceId: 'ws-ops', name: 'Operations' }
const KNOW = { workspaceId: 'ws-k', name: 'Knowledge' }
const empty: ConsoleWidgetIndexReport = { target: null, blocked: null, widgets: [], pendingWithdraws: [] }

function overseerWith(report: ConsoleWidgetIndexReport | null, workspaces: WidgetIndexWorkspace[], after?: ConsoleWidgetIndexReport) {
  const set = vi.fn<(consoleId: string, workspaceId: string | null) => Promise<ConsoleWidgetIndexReport>>(async () => after ?? report ?? empty)
  const stub = {
    getConsoleWidgetIndex: vi.fn<() => Promise<ConsoleWidgetIndexReport | null>>(async () => report),
    listConsoleWidgetIndexWorkspaces: vi.fn<() => Promise<WidgetIndexWorkspace[]>>(async () => workspaces),
    setConsoleWidgetIndexTarget: set,
  } as unknown as RpcStub<Overseer>
  return { stub, set }
}
const render = async (stub: RpcStub<Overseer>, editable = true) => {
  await act(async () => root.render(<ConsoleWidgetIndex overseer={stub} consoleId="c1" hasWidgets editable={editable} />))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

it('shows nothing where the deployment has no widget index', async () => {
  await render(overseerWith(null, []).stub)
  expect(container.textContent).toBe('')
})

it("says what InferOps answered for each widget, in the builder's words, and never calls a refusal listed", async () => {
  await render(overseerWith({ ...empty, target: OPS, widgets: [
    { versionId: 'bp@1', label: 'Technicians', outcome: { status: 'applied' } },
    { versionId: 'bp2@1', label: 'Rota', outcome: { status: 'refused', reason: 'InferOps refused: listing widgets needs the permission.' } },
    { versionId: 'bp3@1', label: 'Stock', outcome: { status: 'proposed', reason: 'awaiting review' } },
  ] }, [OPS]).stub)
  const items = [...container.querySelectorAll('li')].map(li => li.textContent)
  expect(items).toEqual([
    'Technicians: Listed for your company',
    'Rota: Not listed: InferOps refused: listing widgets needs the permission.',
    'Stock: Waiting in InferOps: awaiting review',
  ])
  expect(container.textContent).toContain('Listed in Operations.')
  expect(container.textContent).toContain('Listed for your company')
})

it('shows why nothing was listed, and an owed withdrawal', async () => {
  await render(overseerWith({ ...empty, blocked: "Not listed for your company: you can't publish shared configuration in any InferOps workspace you're signed in to.",
    pendingWithdraws: [{ versionId: 'bp@1', reason: "InferOps couldn't be reached." }] }, []).stub)
  expect(container.textContent).toContain("you can't publish shared configuration in any InferOps workspace")
  expect(container.textContent).toContain("bp@1: InferOps couldn't be reached.")
})

it('lets an editor choose among several workspaces, and shows the answer the kernel gives back', async () => {
  const { stub, set } = overseerWith({ ...empty, blocked: 'Not listed for your company: choose the InferOps workspace for this console in its settings.' },
    [OPS, KNOW], { ...empty, target: KNOW })
  await render(stub)
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="InferOps workspace"]')!
  expect([...select.options].map(option => option.textContent)).toEqual(['None', 'Operations', 'Knowledge'])
  await act(async () => { select.value = 'ws-k'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(set).toHaveBeenCalledWith('c1', 'ws-k')
  expect(container.textContent).not.toContain('choose the InferOps workspace')
})

it('offers no choice to someone who may not edit the console', async () => {
  await render(overseerWith({ ...empty, target: OPS }, [OPS, KNOW]).stub, false)
  expect(container.querySelector('select')).toBeNull()
  expect(container.textContent).toContain('Listed in Operations.')
})

it('says so when the index could not be read', async () => {
  const stub = { getConsoleWidgetIndex: async () => { throw new Error('down') }, listConsoleWidgetIndexWorkspaces: async () => [] } as unknown as RpcStub<Overseer>
  await render(stub)
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Couldn't read where this console's widgets are listed")
})
