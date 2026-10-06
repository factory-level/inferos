// Demo fixtures and scenarios for the "settings" views: /profile, /providers, the add-model and
// ChatGPT-plan model dialogs. See ../registry.ts and ../scenarios.ts.

import type {
  AiChatAuthorInfo,
  AiGatewayInfo,
  CloudflareAccountOption,
  CloudflareUsageInfo,
  RedactedAiModelConfig,
} from '@gadgets/workshop-shared/api'
import type { OpenAiAssistantPluginApi, OpenAiPlanModel, OpenAiPluginState } from '@gadgets/workshop-shared/openai-plugin'
import { demoTarget, forever, provide, type DemoMethods } from '../registry'
import { scenario } from '../scenarios'
import { world } from '../world'

type ModelEntry = { profile: AiChatAuthorInfo; config: RedactedAiModelConfig }

const agent = (id: string, name: string, extra: Partial<AiChatAuthorInfo> = {}): AiChatAuthorInfo =>
  ({ type: 'agent', id, name, ...extra })

/** The user's AI models and model preferences. Exported so other areas' scenarios can adjust them. */
export const models = {
  entries: [
    { profile: agent('claude-opus-5-5', 'Claude Opus 5.5'),
      config: { billing: 'api-key', provider: 'anthropic', model: 'claude-opus-5-5', apiToken: null } },
    { profile: agent('claude-sonnet-5-5', 'Claude Sonnet 5.5'),
      config: { billing: 'api-key', provider: 'anthropic', model: 'claude-sonnet-5-5', apiToken: null,
        apiUrl: 'https://gateway.ai.cloudflare.com/v1/acct/ops-gateway/anthropic',
        extraHeaders: { 'cf-aig-authorization': null, 'x-team': 'platform-ops' } } },
    { profile: agent('gpt-6.1-sol', 'GPT-6.1 Sol'),
      config: { billing: 'api-key', provider: 'openai', model: 'gpt-6.1-sol', apiToken: null } },
    { profile: agent('gpt-6-luna-plan', 'GPT-6 Luna (ChatGPT Plus)', { billing: 'chatgpt-plan' }),
      config: { billing: 'chatgpt-plan', provider: 'openai', model: 'gpt-6-luna', registrationId: 'reg-dana-plus' } },
    { profile: agent('gemini-3.6-flash', 'Gemini 3.6 Flash'),
      config: { billing: 'api-key', provider: 'google', model: 'gemini-3.6-flash', apiToken: null } },
    { profile: agent('@cf/moonshotai/kimi-k2.7-code', 'Kimi K2.7 Code (Workers AI)'),
      config: { billing: 'api-key', provider: 'cloudflare', model: '@cf/moonshotai/kimi-k2.7-code',
        apiToken: null, accountId: '3f9c2a71d0b84e6f9a1c5e27b8d4f013' } },
    { profile: agent('llama-local', 'Llama 4 Scout (home lab Ollama, quantized q4_K_M)'),
      config: { billing: 'api-key', provider: 'ollama', model: 'llama4:scout-q4_K_M', apiToken: '',
        apiUrl: 'http://192.168.1.40:11434', contextWindow: 131072, outputLimit: 8192 } },
  ] as ModelEntry[],
  /** Managed (runtime-provided) models: listed, but not editable. */
  managed: [agent('mock-local-model', 'Mock model (local runtime)', { managed: true })],
  quickModelId: 'claude-sonnet-5-5' as string | null,
  preferredModelId: 'claude-opus-5-5' as string | null,
  chatGptFallbackId: 'gpt-6.1-sol' as string | null,
  aiConfig: { enabled: false } as AiGatewayInfo,
}

/** Cloudflare usage and billing accounts; the auth area's billing-modal scenarios mutate these. */
export const usage = {
  info: {
    cloudflareLimitsEnabled: true,
    unlimited: false,
    dailyUsed: 37,
    dailyLimit: 50,
    remaining: 13,
    resetAt: new Date(Date.now() + 5.5 * 3600_000).toISOString(),
    connected: true,
    balance: 18.42,
    accountId: '3f9c2a71d0b84e6f9a1c5e27b8d4f013',
    accountName: 'Dana Demo (Personal)',
  } as CloudflareUsageInfo,
  accounts: [
    { accountId: '3f9c2a71d0b84e6f9a1c5e27b8d4f013', accountName: 'Dana Demo (Personal)' },
    { accountId: 'a81b7c0e5d2f4a9b8c6e1d3f7a2b9c40', accountName: 'Factory Level Engineering' },
    { accountId: '0d4e6f8a1b3c5d7e9f0a2b4c6d8e0f12', accountName: 'Acme Platform Operations — Staging' },
  ] as CloudflareAccountOption[],
}

const findModel = (id: string) => {
  const entry = models.entries.find(e => e.profile.id === id)
  if (!entry) throw new Error(`Model "${id}" not found`)
  return entry
}

provide('AuthenticatedApi', {
  listModels: () => [...models.entries.map(e => e.profile), ...models.managed],
  getModelConfig: (id) => structuredClone(findModel(id)),
  addModel(profile, config) {
    if (models.entries.some(e => e.profile.id === profile.id)) throw new Error(`A model with ID "${profile.id}" already exists`)
    models.entries.push({ profile, config })
  },
  updateModel(profile, config) {
    const entry = findModel(profile.id)
    entry.profile = profile
    entry.config = config
  },
  deleteModel(id) { models.entries = models.entries.filter(e => e.profile.id !== id) },
  getQuickModel: () => models.quickModelId,
  setQuickModel(id) { models.quickModelId = id },
  getPreferredModel: () => models.preferredModelId,
  setPreferredModel(id) { models.preferredModelId = id },
  getAiConfig: () => models.aiConfig,
  getChatGptFallback: () => ({
    modelId: models.chatGptFallbackId,
    models: models.entries.filter(e => e.config.billing !== 'chatgpt-plan').map(e => e.profile),
  }),
  setChatGptFallback(id) { models.chatGptFallbackId = id },

  getCloudflareUsage: () => usage.info,
  listCloudflareAccounts: () => usage.accounts,
  selectCloudflareAccount(accountId) {
    const account = usage.accounts.find(a => a.accountId === accountId)
    usage.info = { ...usage.info, accountId, accountName: account?.accountName, needsAccountSelection: false }
  },

  setOwnDisplayName(name) { world.user = { ...world.user, name } },
  setOwnCommitEmail(email) { world.user = { ...world.user, commitEmail: email ?? undefined } },
  changePassword() {},
  setAvatar() {},
})

// ─── ChatGPT plan companion ────────────────────────────────────────────────────

const planModels: OpenAiPlanModel[] = [
  { slug: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol' },
  { slug: 'gpt-6-luna', displayName: 'GPT-6 Luna' },
  { slug: 'gpt-6-astra', displayName: 'GPT-6 Astra' },
  { slug: 'gpt-6-luna-mini', displayName: 'GPT-6 Luna mini' },
]

/** The local ChatGPT companion: `connection` picks how acquiring/reading it behaves. */
export const chatGpt = {
  connection: 'ready' as 'ready' | 'disabled' | 'loading' | 'error',
  state: {
    accounts: [
      { id: 'reg-dana-plus', label: 'Dana Demo — ChatGPT Plus', email: 'dana@example.com', status: 'ready', allowBackground: true },
      { id: 'reg-dana-work', label: 'Factory Level Team workspace', email: 'dana@factorylevel.example', status: 'usage-paused',
        allowBackground: false,
        error: { status: 429, code: 'usage_limit_reached', recovery: 'usage', requestId: 'req_8f2c41a7e9',
          message: 'This account reached its 5-hour usage limit. It resets at 6:40 PM.' } },
    ],
    activeAccountId: 'reg-dana-plus',
    needsWelcome: false,
  } as OpenAiPluginState,
}

const setAccount = (id: string, patch: Partial<OpenAiPluginState['accounts'][number]>) => {
  chatGpt.state = { ...chatGpt.state, accounts: chatGpt.state.accounts.map(a => (a.id === id ? { ...a, ...patch } : a)) }
}

provide('OpenAiAssistantPluginApi', {
  getState: () => {
    if (chatGpt.connection === 'error') throw new Error('Demo: companion unreachable')
    return chatGpt.state
  },
  startSignIn: () => ({ url: 'about:blank', nonce: 'demo-nonce' }),
  completeSignIn() {},
  selectAccount(accountId) { chatGpt.state = { ...chatGpt.state, activeAccountId: accountId } },
  listModels: () => planModels,
  signOut(accountId) { setAccount(accountId, { status: 'signed-out' }); return { revoked: true } },
  setBackgroundUsage(accountId, allowed) { setAccount(accountId, { allowBackground: allowed }) },
  retryPlanUsage(accountId) { setAccount(accountId, { status: 'ready', error: undefined }) },
  acknowledgeWelcome() { chatGpt.state = { ...chatGpt.state, needsWelcome: false } },
} satisfies DemoMethods<OpenAiAssistantPluginApi>)

provide('AuthenticatedApi', {
  getOpenAiAssistantPlugin: () => {
    if (chatGpt.connection === 'disabled') return null
    if (chatGpt.connection === 'loading') return forever()
    return demoTarget('OpenAiAssistantPluginApi')
  },
})

// ─── scenarios ─────────────────────────────────────────────────────────────────

/** Moves a model to the top of /providers, so the first row's ⋮ menu acts on it. */
const first = (id: string) => () => {
  models.entries.sort((a, b) => Number(b.profile.id === id) - Number(a.profile.id === id))
}
const fail = (method: 'listModels' | 'setQuickModel') => () =>
  provide('AuthenticatedApi', { [method]: () => { throw new Error('Demo: request failed') } }, { override: true })
const withLimits = (patch: Partial<CloudflareUsageInfo> = {}) => () => {
  world.serverConfig.cloudflareLimitsEnabled = true
  usage.info = { ...usage.info, ...patch }
}

const addProvider = { click: 'text=Add provider' }
const openSelect = { click: 'text=Choose an AI model...' }
const editFirst = [{ click: 'text=Provider actions' }, { click: 'text=Edit provider' }]
const usePlan = [addProvider, { click: 'text=Use ChatGPT plan' }]

scenario({
  'profile.loading': { setup: () => provide('AuthenticatedApi', { whoami: forever }, { override: true }) },
  'profile.account.display-name': { steps: [{ click: 'text=Edit display name' }] },
  'profile.account.commit-email': { steps: [
    { click: 'text=Edit commit email' },
    { type: 'dana at example', into: 'input[aria-label="Commit email"]' },
    { click: 'text=Save commit email' },
  ] },
  'profile.toasts': { steps: [
    { click: 'text=Edit display name' },
    { type: 'Dana Demo-Okonkwo', into: 'input[aria-label="Display name"], input[value="Dana Demo"]' },
    { click: 'text=Save display name' },
  ] },
  'profile.chatgpt.connecting': { setup: () => { chatGpt.connection = 'loading' } },
  'profile.chatgpt.signed-out': { setup: () => { chatGpt.state = { accounts: [], activeAccountId: null, needsWelcome: false } } },
  'profile.chatgpt.welcome': { setup: () => { chatGpt.state = { ...chatGpt.state, needsWelcome: true } } },
  'profile.usage': { setup: withLimits() },
  'profile.usage.connected': { setup: withLimits() },
  'profile.usage.not-connected': { setup: withLimits({ connected: false, balance: null, accountId: undefined, accountName: undefined }) },
  'profile.usage.account-selection': { setup: withLimits({ needsAccountSelection: true, accountId: undefined, accountName: undefined, balance: null }) },

  'providers.loading': { setup: () => provide('AuthenticatedApi', { listModels: forever }, { override: true }) },
  'providers.error': { setup: fail('listModels') },
  'providers.empty': { setup: () => { models.entries = []; models.managed = []; models.quickModelId = null } },
  'providers.no-results': { steps: [{ type: 'mistral-large', into: 'input[placeholder="Search providers…"]' }] },
  'providers.notices': { setup: () => { models.aiConfig = { enabled: true, enabledProviders: ['anthropic', 'openai', 'cloudflare'] } } },
  'providers.row-menu': { steps: [{ click: 'text=Provider actions' }] },
  'providers.toasts': { setup: fail('setQuickModel'), steps: [{ click: '[title="Click to set as quick model"]' }] },

  'modal.add-model': { steps: [addProvider] },
  'modal.add-model.select': { steps: [addProvider] },
  'modal.add-model.suggested': { steps: [addProvider, openSelect, { click: 'text=Claude Opus 5.5' }] },
  // Custom fields after an empty submit, so the validation errors show too.
  'modal.add-model.custom': { steps: [addProvider, openSelect, { click: 'text=Other Anthropic...' }, { click: 'text=Add Model' }] },
  'modal.add-model.stored-secret': { setup: first('claude-sonnet-5-5'), steps: [...editFirst,
    { type: 'sk-ant-api03-', into: 'input[aria-label="API Token"]' }] },
  'modal.add-model.advanced': { setup: first('claude-sonnet-5-5'), steps: [...editFirst, { click: 'text=Advanced Settings' }] },
  'modal.add-model.extra-headers': { setup: first('claude-sonnet-5-5'),
    steps: [...editFirst, { click: 'text=Advanced Settings' }, { click: 'text=Add header' }] },

  'modal.chatgpt-model': { steps: usePlan },
  'modal.chatgpt-model.loading': { setup: () => { chatGpt.connection = 'loading' }, steps: usePlan },
  'modal.chatgpt-model.no-account': { setup: () => { chatGpt.state.accounts.forEach(a => { a.status = 'signed-out' }) }, steps: usePlan },
  'modal.chatgpt-model.ready': { setup: first('gpt-6-luna-plan'), steps: editFirst },
})
