// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import type { OpenAiAssistantPluginApi, OpenAiPluginState } from '@gadgets/workshop-shared/openai-plugin'
import { ChatGptSettings } from './ChatGptSettings'
import { openDisownedPopup } from '../../connectHandoff'

vi.mock('../../connectHandoff', () => ({ openDisownedPopup: vi.fn<typeof openDisownedPopup>(), uniquePopupName: () => 'test-popup' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('ChatGPT plan controls', () => {
  let root: Root | undefined
  afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ''; vi.clearAllMocks(); vi.useRealTimers() })
  const render = async (state: OpenAiPluginState | null, unavailable = false) => {
    const api = {
      getState: vi.fn<OpenAiAssistantPluginApi['getState']>(async () => state!),
      startSignIn: vi.fn<OpenAiAssistantPluginApi['startSignIn']>(async () => ({ url: 'http://127.0.0.1:1234/authorize/ticket', nonce: 'b'.repeat(64) })),
      retryPlanUsage: vi.fn<OpenAiAssistantPluginApi['retryPlanUsage']>(async () => {}), setBackgroundUsage: vi.fn<OpenAiAssistantPluginApi['setBackgroundUsage']>(async () => {}),
      signOut: vi.fn<OpenAiAssistantPluginApi['signOut']>(async () => ({ revoked: true })), [Symbol.dispose]: vi.fn<() => void>(),
      acknowledgeWelcome: vi.fn<OpenAiAssistantPluginApi['acknowledgeWelcome']>(async () => {}),
    }
    const authenticatedApi = {
      getOpenAiAssistantPlugin: async () => { if (unavailable) throw new Error('offline'); return state ? api : null },
      getChatGptFallback: async () => ({ modelId: null, models: [] }),
    } as unknown as RpcStub<AuthenticatedApi>
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    await act(async () => root!.render(<ChatGptSettings authenticatedApi={authenticatedApi} />))
    return { api, container }
  }
  const state: OpenAiPluginState = { accounts: [{ id: 'account', label: 'Alice', status: 'ready', allowBackground: false }], activeAccountId: 'account', needsWelcome: false }
  const button = (name: string) => [...document.querySelectorAll('button')].find(value => value.textContent === name)!

  it('hides the feature when no server capability is available', async () => {
    const { container } = await render(null)
    expect(container.textContent).toBe('')
  })
  it('reauthorizes the selected issued registration through a disowned popup', async () => {
    const { api } = await render(state)
    await act(async () => button('Continue with ChatGPT').click())
    expect(api.startSignIn).toHaveBeenCalledWith('account', undefined)
    expect(openDisownedPopup).toHaveBeenCalledWith('http://127.0.0.1:1234/authorize/ticket', 'test-popup', { kind: 'openai', nonce: 'b'.repeat(64) })
    act(() => root!.unmount()); root = undefined
    expect(api[Symbol.dispose]).toHaveBeenCalledOnce()
  })
  it('offers explicit quota recovery and leaves background billing disabled', async () => {
    const { api, container } = await render({ ...state, accounts: [{ ...state.accounts[0], status: 'usage-paused' }],
      error: { status: 429, code: 'subscription_sharing_usage_limit_exceeded', recovery: 'usage', message: 'Review your app limit.' } })
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Review your app limit.')
    expect(container.querySelector('a')?.href).toBe('https://chatgpt.com/settings/usage')
    expect(api.retryPlanUsage).not.toHaveBeenCalled()
    expect(api.setBackgroundUsage).not.toHaveBeenCalled()
    await act(async () => button('Retry plan usage').click())
    expect(api.retryPlanUsage).toHaveBeenCalledWith('account')
    expect(api.startSignIn).not.toHaveBeenCalled()
  })
  it('requests consent only through Enable plan usage', async () => {
    const { api } = await render({ ...state, accounts: [{ ...state.accounts[0], status: 'plan-disabled' }] })
    await act(async () => button('Enable plan usage').click())
    expect(api.startSignIn).toHaveBeenCalledWith('account', true)
  })
  it('shows capability failures instead of hiding the settings', async () => {
    const { container } = await render(null, true)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not load')
    expect(button('Retry connection')).toBeDefined()
  })
  it('shows failures only for the selected registration', async () => {
    vi.useFakeTimers()
    const second = { ...state.accounts[0], id: 'other', label: 'Other', status: 'plan-disabled' as const,
      error: { status: 403, code: 'plan_disabled', recovery: 'consent' as const, message: 'Other needs consent.' } }
    const accounts = [...state.accounts, second]
    const { api, container } = await render({ ...state, accounts })
    expect(container.textContent).not.toContain('Other needs consent.')
    expect(button('Enable plan usage')).toBeUndefined()
    api.getState.mockResolvedValue({ ...state, accounts, activeAccountId: 'other' })
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Other needs consent.')
    await act(async () => button('Enable plan usage').click())
    expect(api.startSignIn).toHaveBeenCalledWith('other', true)
  })
  it('refreshes immediately after sign-out and ignores a stale poll', async () => {
    vi.useFakeTimers()
    const { api, container } = await render({ ...state, needsWelcome: true })
    let resolve!: (state: OpenAiPluginState) => void
    const oldPoll = new Promise<OpenAiPluginState>(done => { resolve = done })
    api.getState.mockImplementationOnce(() => oldPoll)
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    api.getState.mockResolvedValue({ ...state, accounts: [{ ...state.accounts[0], status: 'signed-out' }] })
    await act(async () => button('Sign out of ChatGPT').click())
    expect(button('Sign out of ChatGPT')).toBeUndefined()
    await act(async () => resolve(state))
    expect(button('Sign out of ChatGPT')).toBeUndefined()
    expect(container.textContent).not.toContain('ChatGPT is connected.')
  })
})
