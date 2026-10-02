// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, ChatGptPlanModelConfig } from '@gadgets/workshop-shared/api'
import type { OpenAiAssistantPluginApi, OpenAiPlanModel, OpenAiPluginState } from '@gadgets/workshop-shared/openai-plugin'
import type { ModelModalMode } from '../../AddModelModal'
import { ChatGptModelModal } from './ChatGptModelModal'
import { ChatGptFallbackSettings } from './ChatGptFallbackSettings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent === name)!
const choose = async (index: number, name: string) => {
  await act(async () => document.querySelectorAll<HTMLElement>('[role="combobox"]')[index].click())
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(element => element.textContent?.includes(name))
  if (!option) throw new Error('Missing option ' + name)
  await act(async () => {
    option!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    option!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
    option!.click()
  })
}

describe('ChatGPT model selection and API-key fallback', () => {
  let root: Root | undefined
  afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ''; vi.useRealTimers() })
  const config: ChatGptPlanModelConfig = { provider: 'openai', billing: 'chatgpt-plan', model: 'gpt-test', registrationId: 'a', contextWindow: 8000, outputLimit: 1000 }
  const source = { profile: { type: 'agent' as const, id: 'saved', name: 'Saved model' }, config }
  const render = async (mode: ModelModalMode = { type: 'add' }, fallback = false) => {
    const state: OpenAiPluginState = { activeAccountId: 'a', needsWelcome: false, accounts: [
      { id: 'a', label: 'Account A', status: 'ready', allowBackground: false },
      { id: 'b', label: 'Account B', status: 'ready', allowBackground: false },
    ] }
    const catalog: OpenAiPlanModel[] = [{ slug: 'gpt-test', displayName: 'GPT Test' }]
    const plugin = {
      getState: vi.fn<OpenAiAssistantPluginApi['getState']>(async () => state),
      listModels: vi.fn<OpenAiAssistantPluginApi['listModels']>(async () => catalog),
      [Symbol.dispose]: vi.fn<() => void>(),
    }
    let fallbackId: string | null = null
    const api = {
      getOpenAiAssistantPlugin: async () => plugin,
      addModel: vi.fn<AuthenticatedApi['addModel']>(async () => {}),
      updateModel: vi.fn<AuthenticatedApi['updateModel']>(async () => {}),
      getChatGptFallback: vi.fn<AuthenticatedApi['getChatGptFallback']>(async () => ({ modelId: fallbackId, models: [{ type: 'agent', id: 'key-model', name: 'My API model' }] })),
      setChatGptFallback: vi.fn<AuthenticatedApi['setChatGptFallback']>(async id => { fallbackId = id }),
    }
    const authenticatedApi = api as unknown as RpcStub<AuthenticatedApi>
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    const onSuccess = vi.fn<() => void>()
    await act(async () => root!.render(fallback ? <ChatGptFallbackSettings authenticatedApi={authenticatedApi} /> :
      <ChatGptModelModal authenticatedApi={authenticatedApi} visible mode={mode} onCancel={() => {}} onSuccess={onSuccess} />))
    return { api, plugin, state, onSuccess }
  }

  it('adds a model bound to the explicitly selected registration', async () => {
    const { api, onSuccess } = await render()
    await choose(0, 'Account B')
    await choose(1, 'GPT Test')
    await act(async () => button('Add Model').click())
    expect(api.addModel).toHaveBeenCalledWith(expect.objectContaining({ name: 'GPT Test' }),
      { provider: 'openai', billing: 'chatgpt-plan', model: 'gpt-test', registrationId: 'b' })
    expect(onSuccess).toHaveBeenCalledOnce()
  })
  it.each(['edit', 'clone'] as const)('%s preserves the source token budgets', async type => {
    const { api } = await render({ type, source })
    await act(async () => button(type === 'edit' ? 'Save Changes' : 'Add Model').click())
    const save = type === 'edit' ? api.updateModel : api.addModel
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: source.profile.name }), config)
    expect(save.mock.calls[0][0].id === source.profile.id).toBe(type === 'edit')
  })
  it('ignores a late catalog after the selected account changes', async () => {
    const { plugin, api } = await render()
    let resolve!: (models: OpenAiPlanModel[]) => void
    const delayed = new Promise<OpenAiPlanModel[]>(done => { resolve = done })
    plugin.listModels.mockImplementationOnce(() => delayed)
    await choose(0, 'Account B')
    expect(button('Add Model').disabled).toBe(true)
    await choose(0, 'Account A')
    await choose(1, 'GPT Test')
    await act(async () => resolve([{ slug: 'foreign-model', displayName: 'Foreign model' }]))
    await act(async () => button('Add Model').click())
    expect(api.addModel).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ registrationId: 'a', model: 'gpt-test' }))
  })
  it('blocks saving when the registration signs out while its catalog is open', async () => {
    vi.useFakeTimers()
    const { plugin, state, api } = await render({ type: 'edit', source })
    plugin.getState.mockResolvedValue({ ...state, accounts: state.accounts.map(account => ({ ...account, status: 'signed-out' })) })
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(button('Save Changes').disabled).toBe(true)
    expect(api.updateModel).not.toHaveBeenCalled()
  })
  it('persists an explicit fallback choice and can disable it', async () => {
    const { api } = await render({ type: 'add' }, true)
    expect(api.setChatGptFallback).not.toHaveBeenCalled()
    await choose(0, 'My API model')
    expect(api.setChatGptFallback).toHaveBeenLastCalledWith('key-model')
    await choose(0, 'No fallback')
    expect(api.setChatGptFallback).toHaveBeenLastCalledWith(null)
  })
});
