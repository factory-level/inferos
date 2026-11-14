// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ConsoleSummary } from '@gadgets/workshop-shared/api'
import type { MyConsolesState } from '../../features/operate/useMyConsoles'
import { ConsolesPage } from './ConsolesPage'

const navigate = vi.fn<(to: unknown) => Promise<void>>(async () => {})
const newConsole = vi.fn<(title: string) => Promise<ConsoleSummary>>()
const toast = vi.fn<(toast: unknown) => void>()
const listed = vi.hoisted(() => ({ state: { status: 'ready', consoles: [] } as import('../../features/operate/useMyConsoles').MyConsolesState, durable: true }))
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  Link: ({ children, params }: { children: React.ReactNode; params: { id: string } }) => <a href={`/consoles/${params.id}`}>{children}</a>,
}))
vi.mock('@cloudflare/kumo', async importOriginal => ({ ...await importOriginal<object>(), useKumoToastManager: () => ({ add: toast }) }))
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: { newConsole } }) }))
vi.mock('../../ServerConfigContext', () => ({ useServerConfig: () => ({ canvasFeatures: { durableViews: listed.durable } }) }))
vi.mock('../../features/operate/useMyConsoles', () => ({ useMyConsoles: () => listed.state, invalidateMyConsoles: () => {} }))

let root: Root
let container: HTMLDivElement
const onCreatingChange = vi.fn<(creating: boolean) => void>()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  navigate.mockClear(); newConsole.mockReset(); toast.mockClear(); onCreatingChange.mockClear()
  listed.state = { status: 'ready', consoles: [] } satisfies MyConsolesState; listed.durable = true
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })
const render = (creating: boolean) => act(() => root.render(<ConsolesPage creating={creating} onCreatingChange={onCreatingChange} />))
const button = (label: string) => [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === label)!
const type = (input: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})

it('creates a console from a name alone, asking for no workspace, and opens its creator', async () => {
  newConsole.mockResolvedValue({ id: 'c1', title: 'Dispatch', role: 'build', published: false, created: new Date(0) })
  render(true)
  // The only thing asked for is the name.
  const inputs = container.querySelectorAll('input, select')
  expect(inputs).toHaveLength(1)
  expect(container.textContent).not.toMatch(/workspace/i)
  expect(button('Create').disabled).toBe(true)
  type(inputs[0] as HTMLInputElement, 'Dispatch')
  expect(button('Create').disabled).toBe(false)
  await act(async () => { button('Create').click() })
  expect(newConsole).toHaveBeenCalledWith('Dispatch')
  expect(navigate).toHaveBeenCalledWith({ to: '/consoles/$id', params: { id: 'c1' } })
})

it('says why a console could not be created, and lets the person try again', async () => {
  newConsole.mockRejectedValue(new Error("You don't have permission to build shared configuration."))
  render(true)
  type(container.querySelector('input')!, 'Dispatch')
  await act(async () => { button('Create').click() })
  expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining('permission'), variant: 'error' }))
  expect(navigate).not.toHaveBeenCalled()
  expect(button('Create').disabled).toBe(false)
})

it('lists consoles, linking to the creator only for ones the person can build', () => {
  listed.state = { status: 'ready', consoles: [
    { id: 'c1', title: 'Dispatch', role: 'build', published: true, created: new Date(0) },
    { id: 'c2', title: 'Crew lead', role: 'use', published: true, created: new Date(0) },
  ] }
  render(false)
  expect([...container.querySelectorAll('a')].map(link => link.getAttribute('href'))).toEqual(['/consoles/c1'])
  expect(container.textContent).toContain('Crew lead')
  act(() => button('New console').click())
  expect(onCreatingChange).toHaveBeenCalledWith(true)
})

it('offers no creation while saved views are off, and says so', () => {
  listed.durable = false
  render(false)
  expect(button('New console').disabled).toBe(true)
  expect(container.querySelector('[role="status"]')?.textContent).toContain('not enabled')
})
