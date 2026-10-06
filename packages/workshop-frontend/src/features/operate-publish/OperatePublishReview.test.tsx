// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkpieceId } from '@gadgets/workshop-shared/api'
import { OperatePublishReview, type ReviewedSpace } from './OperatePublishReview'
import type { Candidate } from './operatePublish'

const candidate: Candidate = { blueprintId: 'bp', title: 'Counter', version: 2, kind: 'app', dataContract: 1, bindings: [] }
const space = (overrides: Partial<ReviewedSpace> = {}): ReviewedSpace => ({
  id: 'space', title: 'Night shift', testOnly: false, stale: false,
  installs: [{ gadgetId: 7, title: 'Counter', installedFrom: { blueprintId: 'bp', version: 1, kind: 'app', dataContract: 1 } }],
  ...overrides,
})

let container: HTMLDivElement
let root: Root
const handlers = {
  onBackToBuild: vi.fn<() => void>(),
  onPublish: vi.fn<(dataContract: number | undefined) => Promise<void>>(),
  onSelectSpace: vi.fn<(id: string) => void>(),
  onInstall: vi.fn<(requestKey: string) => Promise<void>>(),
  onUpgrade: vi.fn<(gadgetId: WorkpieceId, version: number) => Promise<void>>(),
  onSetTestOnly: vi.fn<(testOnly: boolean) => Promise<void>>(),
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  for (const handler of Object.values(handlers)) handler.mockReset()
  handlers.onPublish.mockResolvedValue(); handlers.onInstall.mockResolvedValue(); handlers.onUpgrade.mockResolvedValue(); handlers.onSetTestOnly.mockResolvedValue()
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

const render = (props: Partial<ComponentProps<typeof OperatePublishReview>> = {}) => act(() => root.render(
  <OperatePublishReview sourceKind="app" candidate={candidate} spaces={[{ id: 'space', title: 'Night shift' }]}
    space={space()} installWithBindingsHref={null} {...handlers} {...props} />))
const button = (name: string | RegExp) => [...container.querySelectorAll('button')]
  .find(item => typeof name === 'string'
    ? (item.getAttribute('aria-label') ?? item.textContent?.trim()) === name
    : name.test(item.getAttribute('aria-label') ?? item.textContent ?? ''))
const alertText = () => container.querySelector('[role="alert"]')?.textContent ?? null
const contractInput = () => {
  const label = [...container.querySelectorAll('label')].find(item => item.textContent === 'Data contract')!
  return document.getElementById(label.htmlFor) as HTMLInputElement
}
const type = (input: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})

describe('OperatePublishReview', () => {
  it('returns to Build when nothing has been published, inventing nothing', () => {
    render({ candidate: null })
    expect(container.textContent).toContain('No version of this workspace has been published yet')
    expect(button('Install version 2')).toBeUndefined()
    act(() => button('Back to Build')!.click())
    expect(handlers.onBackToBuild).toHaveBeenCalledOnce()
  })

  it('shows the version, kind, data contract and connections under review', () => {
    render({ candidate: { ...candidate, dataContract: undefined, bindings: ['DATA'] } })
    expect(container.querySelector('dl')?.textContent).toContain('Version2')
    expect(container.textContent).toContain('not declared (unknown)')
    expect(container.textContent).toContain('DATA')
  })

  it('publishes the next version with the declared contract, and refuses an invalid one', async () => {
    render()
    const input = contractInput()
    expect(input.value).toBe('1')
    expect(input.getAttribute('aria-describedby')).toBeTruthy()
    type(input, '-3')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(button('Publish version 3')!.disabled).toBe(true)
    type(input, '2')
    await act(async () => button('Publish version 3')!.click())
    expect(handlers.onPublish).toHaveBeenCalledWith(2)
    type(input, '')
    await act(async () => button('Publish version 3')!.click())
    expect(handlers.onPublish).toHaveBeenLastCalledWith(undefined)
  })

  it('names each install with its version and offers an upgrade only when compatible', async () => {
    render({ space: space({ installs: [
      { gadgetId: 7, title: 'Counter', installedFrom: { blueprintId: 'bp', version: 1, kind: 'app', dataContract: 1 } },
      { gadgetId: 8, title: 'Old counter', installedFrom: { blueprintId: 'bp', version: 1, kind: 'app', dataContract: 0 } },
      { gadgetId: 9, title: 'Legacy', installedFrom: { blueprintId: 'bp', version: 1, kind: 'app' } },
    ] }) })
    const list = container.querySelector('[aria-label="Installs in this space"]')!
    expect(list.textContent).toContain('Version 1, data contract 1')
    expect(list.textContent).toContain('Needs migration')
    expect(list.textContent).toContain('compatibility is unknown')
    expect(button('Upgrade Old counter from version 1 to 2')).toBeUndefined()
    await act(async () => button('Upgrade Counter from version 1 to 2')!.click())
    expect(handlers.onUpgrade).toHaveBeenCalledWith(7, 2)
  })

  it('disables every action while one is pending, so a double click submits once', async () => {
    let finish = () => {}
    handlers.onInstall.mockReturnValue(new Promise<void>(resolve => { finish = resolve }))
    render()
    act(() => button('Install version 2')!.click())
    expect(button('Installing…')!.disabled).toBe(true)
    expect(button(/^Upgrade Counter/)!.disabled).toBe(true)
    expect(button('Publish version 3')!.disabled).toBe(true)
    act(() => button('Installing…')!.click())
    await act(async () => finish())
    expect(handlers.onInstall).toHaveBeenCalledOnce()
    expect(button('Install version 2')!.disabled).toBe(false)
  })

  it('sends one request key per install intent: the same on a retry, a new one after it installed', async () => {
    handlers.onInstall.mockRejectedValueOnce(new Error('Peer closed WebSocket'))
    render()
    await act(async () => button('Install version 2')!.click())
    const [[first]] = handlers.onInstall.mock.calls
    expect(first).toMatch(/^[0-9a-f-]{36}$/)
    // The retry may reach a kernel that already installed it; the same key gets that install back.
    await act(async () => button('Install version 2')!.click())
    expect(handlers.onInstall.mock.calls[1]![0]).toBe(first)
    // Installed: installing again is a new intent.
    await act(async () => button('Install version 2')!.click())
    expect(handlers.onInstall.mock.calls[2]![0]).not.toBe(first)
    // So is the same version into another space.
    handlers.onInstall.mockRejectedValueOnce(new Error('Peer closed WebSocket'))
    await act(async () => button('Install version 2')!.click())
    const fourth = handlers.onInstall.mock.calls[3]![0]
    render({ space: space({ id: 'other' }) })
    await act(async () => button('Install version 2')!.click())
    expect(handlers.onInstall.mock.calls[4]![0]).not.toBe(fourth)
  })

  it('shows a refused install with what it means, and moves focus to it', async () => {
    handlers.onInstall.mockRejectedValue(new Error(
        'This workspace is not test-only, so it cannot install mock dependencies: the binding "DATA" names mock data (x).'))
    render()
    await act(async () => button('Install version 2')!.click())
    await act(async () => {})
    expect(alertText()).toContain('the binding "DATA" names mock data')
    expect(alertText()).toContain('mark the space test-only')
    expect(document.activeElement).toBe(container.querySelector('[role="alert"]'))
  })

  it('explains a wrong-kind refusal and keeps the draft contract', async () => {
    handlers.onUpgrade.mockRejectedValue(new Error('Blueprint version 2 is a widget, not a app; an upgrade cannot change the install\'s kind.'))
    render()
    type(contractInput(), '5')
    await act(async () => button(/^Upgrade Counter/)!.click())
    expect(alertText()).toContain('Publish a version of the kind this install runs')
    expect(contractInput().value).toBe('5')
  })

  it('marks a test space and holds actions while the space is stale', () => {
    render({ space: space({ testOnly: true, stale: true }) })
    expect(container.textContent).toContain('Test space')
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Reconnecting')
    expect(button('Install version 2')!.disabled).toBe(true)
    expect(button(/^Upgrade Counter/)!.disabled).toBe(true)
  })

  it('marks a space as a test space, and reports a refusal to unmark one holding mocks', async () => {
    render()
    await act(async () => button('Mark as a test space')!.click())
    expect(handlers.onSetTestOnly).toHaveBeenCalledWith(true)
    handlers.onSetTestOnly.mockRejectedValue(new Error('This workspace holds installs with mock dependencies ("Counter"), so it must stay test-only. Remove them first.'))
    render({ space: space({ testOnly: true }) })
    await act(async () => button('Mark as a normal space')!.click())
    expect(handlers.onSetTestOnly).toHaveBeenLastCalledWith(false)
    expect(alertText()).toContain('must stay test-only')
  })

  it('sends a version that needs connections to the blueprint page to choose them', () => {
    render({ installWithBindingsHref: '/blueprint/bp?space=space' })
    const link = [...container.querySelectorAll('a')].find(item => item.textContent?.includes('Choose connections'))!
    expect(link.getAttribute('href')).toBe('/blueprint/bp?space=space')
    expect(button('Install version 2')).toBeUndefined()
  })
})
