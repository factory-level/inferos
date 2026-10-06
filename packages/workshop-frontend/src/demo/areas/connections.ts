// Demo fixtures and scenarios for the "connections" views: the /gatekeepers page and its connect /
// manage dialog, the Create New Connection dialog and its resource configurators, a gadget's
// Connections tab (bindings and hooks), observer verification, connection requests in chat, and the
// gatekeeper management apps at /gatekeepers/$appId. Data lives in ./connections/fixtures.ts.
//
// Configurator and app frames reuse each gatekeeper's real generated UI (`src/generated/*.txt`,
// written by `pnpm build`), loaded on demand; a gatekeeper that was never built shows a note instead.

import type {
  AgentSpawnerConfig,
  AuthenticatedApi,
  BlueprintBindingAnnotation,
  BoundHookInfo,
  CollaboratorRole,
  ConnectedAccountsSubscriber,
  ConnectFlowStart,
  GadgetBindingInfo,
  GadgetClient,
  GatekeeperClient,
  GatekeeperCreationSpec,
  GatekeeperVendorInfo,
  Overseer,
  WorkpieceId,
} from '@gadgets/workshop-shared/api'
import type { AccountDescription, GatekeeperUiFrame, ResourceDescription, SupportedResource } from '@gadgets/workshop-shared/gatekeeper'
import { RpcTarget, type RpcStub } from 'capnweb'
import { delay, demoContext, demoTarget, forever, provide, type DemoMethods } from '../registry'
import { scenario, type DemoStep } from '../scenarios'
import { world } from '../world'
import { models } from './settings'
import { fixtureFor, gadgetOf, workspaceFixtures, workspaceIdOf } from './workspace'
import {
  configuratorOptions,
  createAccounts,
  createBindings,
  createGatekeepers,
  createHooks,
  createObserverNeeds,
  createObserverRetryNeeds,
  createVendors,
  GITHUB_REPO,
  GOOGLE_PATTERNS,
  INFEROPS_BOARD,
  initialsAvatar,
  type DemoAccount,
  type DemoGatekeeper,
  type DemoVendor,
} from './connections/fixtures'

// ─── state ─────────────────────────────────────────────────────────────────────

/** The deployment's gatekeepers and the user's accounts. Scenarios adjust these in `setup`. */
export const connections = {
  vendors: createVendors(),
  accounts: createAccounts(),
  /** `listGatekeeperVendors` / `subscribeConnectedAccounts`: normal, never settling, or failing. */
  load: 'ok' as 'ok' | 'loading' | 'error',
  /** `getGatekeeperApp`: normal or never settling. */
  app: 'ok' as 'ok' | 'loading',
  /** Milliseconds before a started connect / reconnect / grant flow "completes" in the opener tab. */
  flowCompletesAfterMs: 2500,
}

/** Workspaces whose gadgets start with the fixture connections; others start empty. */
const SEEDED = new Set(['ws-ops', 'ws-triage', 'ws-shared'])

type WorkspaceConnections = {
  gatekeepers: Map<WorkpieceId, DemoGatekeeper>
  hooks: BoundHookInfo[]
  /** Bindings by gadget id (provisional ones carry the chat id that added them). */
  bindings: Map<WorkpieceId, GadgetBindingInfo[]>
  annotations: Map<string, BlueprintBindingAnnotation>
}

const byWorkspace = new Map<string, WorkspaceConnections>()

/** A workspace's connections, seeded from the fixtures on first use. Other areas may read or mutate it. */
export function connectionsFor(workspaceId: string): WorkspaceConnections {
  let entry = byWorkspace.get(workspaceId)
  if (!entry) {
    const seeded = SEEDED.has(workspaceId)
    entry = {
      gatekeepers: seeded ? createGatekeepers() : new Map(),
      hooks: seeded ? createHooks() : [],
      bindings: new Map(),
      annotations: new Map(),
    }
    byWorkspace.set(workspaceId, entry)
  }
  return entry
}

function bindingsOf(workspaceId: string, gadgetId: WorkpieceId): GadgetBindingInfo[] {
  const { bindings } = connectionsFor(workspaceId)
  let list = bindings.get(gadgetId)
  if (!list) {
    list = SEEDED.has(workspaceId) ? createBindings() : []
    bindings.set(gadgetId, list)
  }
  return list
}

/** Outcomes of agent connection requests, for the chat area's inline cards. */
export const connectionRequests = {
  outcomes: new Map<string, { state: 'accepted'; gatekeeperId: WorkpieceId } | { state: 'denied' }>(),
  listeners: new Set<(requestId: string) => void>(),
}

function settleRequest(requestId: string, outcome: { state: 'accepted'; gatekeeperId: WorkpieceId } | { state: 'denied' }) {
  connectionRequests.outcomes.set(requestId, outcome)
  for (const listener of connectionRequests.listeners) listener(requestId)
}

// ─── helpers ───────────────────────────────────────────────────────────────────

type URLPatternLike = new (pattern: string) => { test(input: string): boolean }

/** Whether `url` matches a gatekeeper urlPattern (URLPattern where the browser has it). */
function matchesPattern(pattern: string, url: string): boolean {
  const Pattern = (globalThis as { URLPattern?: URLPatternLike }).URLPattern
  try {
    if (Pattern) return new Pattern(pattern).test(url)
  } catch {
    // Fall through to the prefix check for patterns this browser cannot parse.
  }
  const prefix = pattern.split(/[:*{]/, 1)[0]!
  return url.startsWith(prefix)
}

const vendorById = (vendorId: string) => connections.vendors.find(v => v.id === vendorId)

function vendorOrThrow(vendorId: string): DemoVendor {
  const vendor = vendorById(vendorId)
  if (!vendor || vendor.unavailable) throw new Error(`Gatekeeper "${vendorId}" is not available`)
  return vendor
}

function accountOrThrow(accountId: number): DemoAccount {
  const account = connections.accounts.find(a => a.id === accountId)
  if (!account) throw new Error(`Connected account ${accountId} not found`)
  return account
}

const hasAccountFor = (vendorId: string) => connections.accounts.some(a => a.vendorId === vendorId)

const randomHex = (bytes: number) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, '0')).join('')

/** A connect flow whose popup lands straight on the handoff page; `complete` runs in this tab. */
function startFlow(complete: () => void): ConnectFlowStart {
  setTimeout(complete, connections.flowCompletesAfterMs)
  return { url: `/connect/handoff#${randomHex(32)}`, nonce: crypto.randomUUID() }
}

/** Fires a call on a subscriber stub, ignoring a page that has since gone away. */
const quietly = (call: PromiseLike<unknown>) => { void Promise.resolve(call).catch(() => {}) }

// Live account subscribers, so connecting, reconnecting and disconnecting update open screens.
type AccountSubscription = { subscriber: RpcStub<ConnectedAccountsSubscriber>; resourceUrl?: string }
const accountSubscriptions = new Set<AccountSubscription>()

const accountVisibleTo = (account: DemoAccount, resourceUrl?: string) =>
  !resourceUrl || (vendorById(account.vendorId)?.supportedResources ?? []).some(r => matchesPattern(r.urlPattern, resourceUrl))

function sendAccount(subscription: AccountSubscription, account: DemoAccount) {
  if (!accountVisibleTo(account, subscription.resourceUrl)) return
  const vendor = vendorById(account.vendorId)
  if (!vendor) return
  quietly(subscription.subscriber.add(account.id, account.description, vendor.description, vendor.supportedResources,
    account.credentialsValid, account.vendorId))
}

function publishAccount(account: DemoAccount) {
  for (const subscription of accountSubscriptions) sendAccount(subscription, account)
}

function publishRemoval(accountId: number) {
  for (const { subscriber } of accountSubscriptions) quietly(subscriber.remove(accountId))
}

let nextAccountId = Math.max(...connections.accounts.map(a => a.id)) + 1

/** The account an ambient (auto-provisioned) vendor mints, with its singleton and app if it has them. */
function ambientAccount(vendor: DemoVendor): AccountDescription {
  const { displayName, logo } = vendor.description
  const avatar = logo ?? initialsAvatar(displayName, '#6e7781')
  const icon = { avatar }
  switch (vendor.id) {
    case 'context':
      return { displayName: 'Context Library', ...icon, singleton: { tsType: 'ContextSession' },
        providesUi: { title: 'Context & Skills', icon: avatar } }
    case 'scheduler':
      return { displayName, ...icon, singleton: { tsType: 'ScheduleSession' }, providesUi: { title: 'Scheduled', icon: avatar } }
    case 'inferops':
      return { displayName: 'InferOps demo workspace', uniqueName: 'demo.local', ...icon }
    default:
      return { displayName, ...icon }
  }
}

/** A freshly connected OAuth account for `vendor`, named after the signed-in user. */
function oauthAccount(vendor: DemoVendor, resourceUrlPatterns?: string[]): AccountDescription {
  const host = new URL(vendor.description.url).hostname.replace(/^www\./, '')
  const grantable = vendor.supportedResources.filter(r => r.grantable).map(r => r.urlPattern)
  const granted = resourceUrlPatterns ?? grantable
  return {
    displayName: world.user.name,
    uniqueName: `${world.user.id}@${host}`,
    avatar: initialsAvatar(world.user.name, '#3b5bdb'),
    ...(grantable.length ? { grantedResourceUrlPatterns: granted.filter(p => grantable.includes(p)) } : {}),
  }
}

// ─── AuthenticatedApi ──────────────────────────────────────────────────────────

const loadGate = <T,>(produce: () => T): T | Promise<T> => {
  if (connections.load === 'loading') return forever<T>()
  if (connections.load === 'error') throw new Error('Demo: the gatekeeper registry is unavailable')
  return produce()
}

function vendorInfo(vendor: DemoVendor): GatekeeperVendorInfo {
  if (vendor.unavailable) {
    return { id: vendor.id, unavailable: true, supportedResources: [],
      description: { displayName: vendor.id, url: '', tagline: 'Temporarily unavailable', description: 'This gatekeeper could not be loaded.' } }
  }
  return { id: vendor.id, description: vendor.description, supportedResources: vendor.supportedResources }
}

provide('AuthenticatedApi', {
  listGatekeeperVendors: filter => loadGate(() => connections.vendors
    .filter(v => v.unavailable || v.supportedResources.length > 0)
    .filter(v => !filter?.resourceUrl || v.supportedResources.some(r => matchesPattern(r.urlPattern, filter.resourceUrl!)))
    .map(vendorInfo)),

  listAddableGatekeepers: () => connections.vendors
    .filter(v => !v.unavailable && v.description.autoProvisionsAccount && !hasAccountFor(v.id))
    .map(v => ({ id: v.id, description: v.description, supportedResources: [] })),

  async provisionAmbientAccount(vendorId) {
    await delay(300)
    const vendor = vendorOrThrow(vendorId)
    if (!vendor.description.autoProvisionsAccount) throw new Error(`"${vendorId}" is not an auto-provisioned gatekeeper`)
    if (hasAccountFor(vendorId)) return
    const account: DemoAccount = { id: nextAccountId++, vendorId, credentialsValid: true, description: ambientAccount(vendor) }
    connections.accounts.push(account)
    publishAccount(account)
  },

  subscribeConnectedAccounts(subscriber, filter) {
    if (connections.load === 'loading') return forever()
    if (connections.load === 'error') throw new Error('Demo: could not read connected accounts')
    const subscription: AccountSubscription = { subscriber: subscriber.dup(), resourceUrl: filter?.resourceUrl }
    accountSubscriptions.add(subscription)
    for (const account of connections.accounts) sendAccount(subscription, account)
    quietly(subscription.subscriber.ready())
    return new (class extends RpcTarget {
      [Symbol.dispose]() {
        accountSubscriptions.delete(subscription)
        subscription.subscriber[Symbol.dispose]()
      }
    })() as never
  },

  connectAccount(vendorId, resourceUrlPatterns) {
    const vendor = vendorOrThrow(vendorId)
    return startFlow(() => {
      const account: DemoAccount = { id: nextAccountId++, vendorId, credentialsValid: true,
        description: oauthAccount(vendor, resourceUrlPatterns) }
      connections.accounts.push(account)
      publishAccount(account)
    })
  },

  reconnectAccount(accountId) {
    const account = accountOrThrow(accountId)
    return startFlow(() => {
      account.credentialsValid = true
      publishAccount(account)
    })
  },

  ensureAccountResources(accountId, resourceUrlPatterns) {
    const account = accountOrThrow(accountId)
    const granted = account.description.grantedResourceUrlPatterns ?? []
    const missing = resourceUrlPatterns.filter(p => !granted.includes(p))
    if (missing.length === 0) return null
    return startFlow(() => {
      account.description = { ...account.description, grantedResourceUrlPatterns: [...granted, ...missing] }
      publishAccount(account)
    })
  },

  async completeConnectHandoff() {
    await delay(500)
  },

  async disconnectAccount(accountId) {
    await delay(300)
    accountOrThrow(accountId)
    connections.accounts = connections.accounts.filter(a => a.id !== accountId)
    publishRemoval(accountId)
  },

  async startResourceConfigurator(accountId, resourceUrlPattern) {
    const account = accountOrThrow(accountId)
    if (!vendorOrThrow(account.vendorId).supportedResources.some(r => r.urlPattern === resourceUrlPattern)) {
      throw new Error(`${account.vendorId} offers no resource type ${resourceUrlPattern}`)
    }
    const html = await generatedHtml(CONFIGURATOR_FILES[`${account.vendorId} ${resourceUrlPattern}`])
    return {
      iframeHtml: html ?? notBuiltHtml('This resource picker'),
      ui: demoTarget('ResourceConfiguratorUi', { vendorId: account.vendorId } satisfies ConfiguratorContext),
    } as GatekeeperUiFrame
  },

  listGatekeeperApps: () => connections.accounts.flatMap(account => {
    const ui = account.description.providesUi
    return ui ? [{ id: account.vendorId, title: ui.title, ...(ui.icon ? { icon: ui.icon } : {}) }] : []
  }),

  async getGatekeeperApp(id) {
    if (connections.app === 'loading') return forever()
    await delay(200)
    const account = connections.accounts.find(a => a.vendorId === id && a.description.providesUi)
    const app = APPS[id]
    if (!account || !app) return null
    const html = await generatedHtml(app.file)
    return { iframeHtml: html ?? notBuiltHtml(account.description.providesUi!.title), ui: demoTarget(app.ui) } as GatekeeperUiFrame
  },
} satisfies DemoMethods<AuthenticatedApi>)

// ─── generated gatekeeper UIs ─────────────────────────────────────────────────

// Lazy, so the (large) app bundles load only when a screen opens them. Missing until `pnpm build`.
const generated = {
  ...import.meta.glob<string>('../../../../gatekeeper-*/src/generated/*.txt', { query: '?raw', import: 'default' }),
  ...import.meta.glob<string>('../../../../../custom-gatekeepers/gatekeeper-*/src/generated/*.txt', { query: '?raw', import: 'default' }),
}

async function generatedHtml(file: string | undefined): Promise<string | null> {
  if (!file) return null
  const entry = Object.entries(generated).find(([path]) => path.endsWith(`/${file}`))
  return entry ? entry[1]() : null
}

const notBuiltHtml = (what: string) => `<!doctype html><meta charset="utf-8">
<body style="margin:0;font:13px system-ui,sans-serif;color:#6b7280;padding:16px">
${what} has not been built in this checkout. Run <code>pnpm build</code> and reload the demo.</body>`

/** Each resource type's configurator, by `<vendorId> <urlPattern>`. */
const CONFIGURATOR_FILES: Record<string, string> = {
  [`github ${GITHUB_REPO}`]: 'gatekeeper-github/src/generated/github-repo-configurator-ui.txt',
  'github https://github.com/:owner/:repo/issues/:number': 'gatekeeper-github/src/generated/github-issue-configurator-ui.txt',
  'github https://github.com/:owner/:repo/pull/:number': 'gatekeeper-github/src/generated/github-pull-request-configurator-ui.txt',
  [`google ${GOOGLE_PATTERNS.gmail}`]: 'gatekeeper-google/src/generated/gmail-configurator-ui.txt',
  [`google ${GOOGLE_PATTERNS.doc}`]: 'gatekeeper-google/src/generated/google-doc-configurator-ui.txt',
  [`google ${GOOGLE_PATTERNS.sheet}`]: 'gatekeeper-google/src/generated/google-sheets-configurator-ui.txt',
  [`google ${GOOGLE_PATTERNS.drive}`]: 'gatekeeper-google/src/generated/drive-folder-configurator-ui.txt',
  [`google ${GOOGLE_PATTERNS.calendar}`]: 'gatekeeper-google/src/generated/calendar-configurator-ui.txt',
  'slack https://*': 'gatekeeper-slack/src/generated/workspace-configurator-ui.txt',
  'slack https://app.slack.com/client/:teamId/:conversationId': 'gatekeeper-slack/src/generated/conversation-configurator-ui.txt',
  'slack https://*.slack.com/archives/:conversationId/:messageId': 'gatekeeper-slack/src/generated/thread-configurator-ui.txt',
  'linear https://linear.app/:workspace': 'gatekeeper-linear/src/generated/linear-workspace-configurator-ui.txt',
  'linear https://linear.app/:workspace/team/:teamKey{/:rest}*': 'gatekeeper-linear/src/generated/linear-team-configurator-ui.txt',
  'linear https://linear.app/:workspace/issue/:issueId{/:rest}*': 'gatekeeper-linear/src/generated/linear-issue-configurator-ui.txt',
  'notion https://*': 'gatekeeper-notion/src/generated/notion-workspace-configurator-ui.txt',
  'notion https://www.notion.so/:path+': 'gatekeeper-notion/src/generated/notion-item-configurator-ui.txt',
  'cloudflare https://dash.cloudflare.com/:accountId/observability': 'gatekeeper-cloudflare/src/generated/cloudflare-account-configurator-ui.txt',
  'cloudflare https://dash.cloudflare.com/:accountId/workers/services/view/:worker': 'gatekeeper-cloudflare/src/generated/cloudflare-worker-configurator-ui.txt',
  'confluence https://:site.atlassian.net/wiki/spaces/:spaceKey': 'gatekeeper-confluence/src/generated/confluence-space-configurator-ui.txt',
  'supabase https://supabase.com/dashboard/project/:ref': 'gatekeeper-supabase/src/generated/supabase-project-configurator-ui.txt',
  'email mailto:*': 'gatekeeper-email/src/generated/email-configurator-ui.txt',
  'zoominfo https://*': 'gatekeeper-zoominfo/src/generated/account-configurator-ui.txt',
  [`inferops ${INFEROPS_BOARD}`]: 'gatekeeper-inferops/src/generated/project-ui.txt',
}

/** Gatekeeper management apps by vendor id: the generated SPA and the capability it is handed. */
const APPS: Record<string, { file: string; ui: string }> = {
  context: { file: 'gatekeeper-context/src/generated/app.txt', ui: 'ContextApi' },
  scheduler: { file: 'gatekeeper-scheduler/src/generated/app.txt', ui: 'ScheduleManagementApi' },
}

// ─── resource configurator capability ──────────────────────────────────────────

type ConfiguratorContext = { vendorId: string }
type Option = (typeof configuratorOptions)[string][number]

const moreOptions: Record<string, Option[]> = {
  listConversations: [
    { value: 'C05OPSINC', title: '#ops-incidents', subtitle: 'Incident coordination', meta: 'Channel' },
    { value: 'C02GENERAL', title: '#general', meta: 'Channel' },
    { value: 'D04PRIYA', title: 'Priya Natarajan', meta: 'Direct message' },
  ],
  listDriveFolders: [
    { value: '0BdRiVe1', title: 'Customer reports', subtitle: 'Shared with Ops' },
    { value: '0BdRiVe2', title: 'Postmortems' },
  ],
  listAccounts: [
    { value: '3f9c2a71d0b84e6f9a1c5e27b8d4f013', title: 'Dana Demo (Personal)' },
    { value: 'a81b7c0e5d2f4a9b8c6e1d3f7a2b9c40', title: 'Factory Level Engineering' },
  ],
  listWorkers: [
    { value: 'inferos-router', title: 'inferos-router', meta: 'Worker' },
    { value: 'inferos-workshop-backend', title: 'inferos-workshop-backend', meta: 'Worker' },
  ],
  listSites: [{ value: 'factorylevel', title: 'factorylevel.atlassian.net' }],
  listSpaces: [
    { value: 'ENG', title: 'Engineering', meta: 'ENG' },
    { value: 'OPS', title: 'Operations handbook', meta: 'OPS' },
  ],
  listPages: [{ value: 'p-1', title: 'Release checklist' }, { value: 'p-2', title: 'On-call guide' }],
  listItems: [{ value: 'n-1', title: 'Roadmap', meta: 'Database' }, { value: 'n-2', title: 'Team wiki', meta: 'Page' }],
}

// GitHub's issue and PR pickers pass the repository first and the typed query second.
const QUERY_SECOND = new Set(['listIssues', 'listPullRequests'])

function optionLister(name: string, options: Option[]) {
  return function (this: object, ...args: unknown[]) {
    if (name === 'listWorkspaces' && demoContext<ConfiguratorContext>(this).vendorId === 'inferops') return []
    const query = String((QUERY_SECOND.has(name) && args.length > 1 ? args[1] : args[0]) ?? '').trim().toLowerCase()
    return options.filter(o => !query || `${o.value} ${o.title} ${o.subtitle ?? ''}`.toLowerCase().includes(query))
  }
}

provide('ResourceConfiguratorUi', {
  ...Object.fromEntries(Object.entries({ ...configuratorOptions, ...moreOptions }).map(([name, options]) => [name, optionLister(name, options)])),
  defaultHost: () => 'demo.local',
  getPrimaryCalendarId: () => 'dana@example.com',
  getWorkspaceUrlKey: () => 'factory-level',
  getWorkspaceUrl: () => 'https://linear.app/factory-level',
  getTeamId: () => 'T024BE7LD',
})

// ─── gatekeeper management apps ────────────────────────────────────────────────

const now = Date.now()
const daysAgo = (days: number) => new Date(now - days * 86_400_000)

type DemoDocument = { path: string; description: string; body: string; skillName?: string; lastUpdated: Date }
type DemoCollection = {
  id: string; title: string; description: string; icon: string; visibility: 'public' | 'private'
  created: Date; documents: DemoDocument[]
}

const doc = (path: string, description: string, body: string, days: number, skillName?: string): DemoDocument =>
  ({ path, description, body, lastUpdated: daysAgo(days), ...(skillName ? { skillName } : {}) })

/** The Context Library's collections. Scenarios may empty or extend this. */
export const contextLibrary: DemoCollection[] = [
  { id: 'c0ffee01', title: 'Ops runbooks', icon: '🛟', visibility: 'public', created: daysAgo(40),
    description: 'How the platform team handles incidents, deploys and on-call handovers.',
    documents: [
      doc('incidents/triage.md', 'First 15 minutes of an incident: severity, roles and comms.',
        '# Incident triage\n\n1. Declare severity (SEV1–SEV4).\n2. Assign an incident commander.\n3. Open #ops-incidents thread.\n', 3),
      doc('deploys/rollback.md', 'Rolling back a bad Workers deploy.',
        '# Rollback\n\nUse `wrangler rollback` with the previous version id, then post in #ops-incidents.\n', 9),
      doc('skills/handover/SKILL.md', 'Writes the weekly on-call handover note.',
        '---\nname: oncall-handover\ndescription: Writes the weekly on-call handover note.\n---\n\nSummarise open incidents, alerts and follow-ups.\n', 2, 'oncall-handover'),
    ] },
  { id: 'c0ffee02', title: 'InferOps conventions', icon: '🧭', visibility: 'public', created: daysAgo(20),
    description: 'Board workflow states, issue labels and what “done” means for each project.',
    documents: [
      doc('workflow.md', 'Workflow states and when to move an issue between them.',
        '# Workflow\n\nBacklog → In progress → Review → Done. Moves need an approved transition.\n', 5),
      doc('labels.md', 'The label taxonomy shared by every project.', '# Labels\n\n- `bug`\n- `chore`\n- `customer`\n', 12),
    ] },
  { id: 'c0ffee03', title: 'My writing style', icon: '✍️', visibility: 'private', created: daysAgo(6),
    description: 'Tone and formatting preferences for drafts written on my behalf.',
    documents: [doc('style.md', 'Tone, length and sign-off preferences.', '# Style\n\nShort sentences. No exclamation marks. Sign off with “— Dana”.\n', 1)] },
]

const nameOf = (path: string) => path.split('/').pop()!
const collectionOrThrow = (id: string) => {
  const collection = contextLibrary.find(c => c.id === id)
  if (!collection) throw new Error('Collection not found')
  return collection
}
const canWrite = (collection: DemoCollection) => collection.visibility === 'private' || world.isAdmin
const metadataOf = (c: DemoCollection) => ({
  id: c.id, icon: c.icon, title: c.title, description: c.description, visibility: c.visibility, created: c.created,
  lastUpdated: c.documents.reduce((latest, d) => (d.lastUpdated > latest ? d.lastUpdated : latest), c.created),
  documentCount: c.documents.length, content: { source: 'web' as const },
})
const contentTypeOf = (path: string) => (path.endsWith('.md') ? 'text/markdown' : 'text/plain')

provide('ContextApi', {
  getViewerInfo: () => ({ isAdmin: world.isAdmin, supportsGitCollections: false }),
  listEnabledContextCollections: () => contextLibrary.map(c => {
    const { id, title, description, icon, lastUpdated } = metadataOf(c)
    return { id, title, description, icon, lastUpdated, source: c.visibility }
  }),
  getContextCollectionMetadata: (id: string) => {
    const collection = contextLibrary.find(c => c.id === id)
    return collection ? metadataOf(collection) : null
  },
  canWriteContextCollection: (id: string) => canWrite(collectionOrThrow(id)),
  listContextDocuments: (id: string, prefix?: string) => collectionOrThrow(id).documents
    .filter(d => !prefix || d.path.startsWith(prefix))
    .map(({ path, description, skillName, lastUpdated }) =>
      ({ path, name: nameOf(path), description, contentType: contentTypeOf(path), lastUpdated, ...(skillName ? { skillName } : {}) })),
  getContextDocument: (id: string, path: string) => {
    const found = collectionOrThrow(id).documents.find(d => d.path === path)
    return found ? { ...found, name: nameOf(path), contentType: contentTypeOf(path) } : null
  },
  async createContextCollection(title: string, description: string, visibility: 'public' | 'private', icon?: string) {
    await delay(200)
    const collection: DemoCollection = { id: randomHex(4), title, description, visibility, icon: icon ?? '📁', created: new Date(), documents: [] }
    contextLibrary.push(collection)
    return metadataOf(collection)
  },
  updateContextCollection(id: string, options: { title?: string; description?: string; icon?: string }) {
    const collection = collectionOrThrow(id)
    Object.assign(collection, Object.fromEntries(Object.entries(options).filter(([key, value]) => key !== 'branch' && value !== undefined)))
  },
  deleteContextCollection(id: string) {
    contextLibrary.splice(contextLibrary.findIndex(c => c.id === id), 1)
  },
  putContextDocument(id: string, path: string, body: { description: string; body: string }) {
    const collection = collectionOrThrow(id)
    collection.documents = [...collection.documents.filter(d => d.path !== path), doc(path, body.description, body.body, 0)]
  },
  deleteContextDocument(id: string, path: string) {
    const collection = collectionOrThrow(id)
    collection.documents = collection.documents.filter(d => d.path !== path)
  },
  moveContextDocument(id: string, fromPath: string, toPath: string) {
    const found = collectionOrThrow(id).documents.find(d => d.path === fromPath)
    if (found) found.path = toPath
  },
  listContextCollectionGitTokens: () => ({ tokens: [] }),
})

const DAY = 86_400_000
const LA = 'America/Los_Angeles'

/** Scheduled Tasks' schedules across the account, as its management app lists them. */
export const schedules = [
  { scheduleId: 'sch-standup', title: 'Weekday standup digest', description: 'Posts the DEMO board summary before standup.',
    cadence: { kind: 'calendar', timeZone: LA, rule: { freq: 'weekly', interval: 1, byDay: ['MO', 'TU', 'WE', 'TH', 'FR'], hour: 9, minute: 0, anchorMs: now - 30 * DAY } },
    status: 'active', nextFire: now + 14 * 3_600_000, workspaceId: 'ws-ops', gadgetId: 0 },
  { scheduleId: 'sch-health', title: 'Gatekeeper health check', description: 'Pings each connection and files an issue on failure.',
    cadence: { kind: 'interval', everyMs: 3_600_000, anchorMs: now - 5 * DAY },
    status: 'active', nextFire: now + 22 * 60_000, workspaceId: 'ws-ops', gadgetId: 2 },
  { scheduleId: 'sch-triage', title: 'Inbox sweep', description: 'Files unanswered support emails as DEMO issues.',
    cadence: { kind: 'calendar', timeZone: LA, rule: { freq: 'daily', interval: 1, hour: 17, minute: 30, anchorMs: now - 12 * DAY } },
    status: 'dead', failedAt: now - 2 * 3_600_000, failureCode: 'authorization_failed', workspaceId: 'ws-triage', gadgetId: 0 },
  { scheduleId: 'sch-retro', title: 'Q3 retro reminder', description: 'One-shot reminder to collect retro notes.',
    cadence: { kind: 'once', fireAt: now - 3 * DAY, timeZone: LA },
    status: 'completed', completedAt: now - 3 * DAY, workspaceId: 'ws-notes' },
]

provide('ScheduleManagementApi', {
  list: (options?: { query?: string; statuses?: string[] }) => ({
    schedules: schedules.filter(s =>
      (!options?.statuses?.length || options.statuses.includes(s.status)) &&
      (!options?.query || `${s.title} ${s.description}`.toLowerCase().includes(options.query.toLowerCase()))),
  }),
})

// ─── Overseer: connections, hooks, requests ────────────────────────────────────

type GatekeeperContext = { workspaceId: string; gatekeeperId: WorkpieceId }

const gatekeeperClient = (workspaceId: string, gatekeeperId: WorkpieceId) =>
  demoTarget<GatekeeperClient<any>>('GatekeeperClient', { workspaceId, gatekeeperId } satisfies GatekeeperContext)

function gatekeeperOf(target: object): DemoGatekeeper {
  const { workspaceId, gatekeeperId } = demoContext<GatekeeperContext>(target)
  const found = connectionsFor(workspaceId).gatekeepers.get(gatekeeperId)
  if (!found) throw new Error(`Connection ${gatekeeperId} no longer exists`)
  return found
}

/** A new workpiece id, past every gadget and connection in the workspace. */
function nextWorkpieceId(workspaceId: string): WorkpieceId {
  const used = [...fixtureFor(workspaceId).workpieces.map(w => w.id), ...connectionsFor(workspaceId).gatekeepers.keys()]
  return Math.max(19, ...used) + 1
}

function addGatekeeper(workspaceId: string, title: string, spec: GatekeeperCreationSpec, description: ResourceDescription) {
  const id = nextWorkpieceId(workspaceId)
  connectionsFor(workspaceId).gatekeepers.set(id, { title, spec, description })
  return gatekeeperClient(workspaceId, id)
}

const screamingCase = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '') || 'RESOURCE'
const pascalCase = (text: string) => text.replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ?? '').toUpperCase()).replace(/^./, c => c.toUpperCase())

/** A readable title for a configured resource URL. */
function titleFor(resource: SupportedResource, resourceUrl: string): string {
  const board = /\/project\/board\/([^/?#]+)/.exec(resourceUrl)
  if (board) return `${board[1]} project board`
  try {
    const url = new URL(resourceUrl)
    if (url.protocol === 'mailto:') return url.pathname
    const path = url.pathname.split('/').filter(Boolean)
    if (url.hostname === 'github.com' && path.length >= 2) return path.slice(0, 2).join('/') + (path[3] ? ` #${path[3]}` : '')
    return path.length ? `${resource.title}: ${decodeURIComponent(path.at(-1)!)}` : `${resource.title} (${url.hostname})`
  } catch {
    return resource.title
  }
}

const describeAs = (url: string, title: string, snippet: string, bindingName: string, tsType: string): ResourceDescription =>
  ({ url, title, snippet, suggestedBindingName: bindingName, tsType })

provide('Overseer', {
  getGatekeeperById(id) {
    const workspaceId = workspaceIdOf(this)
    if (!connectionsFor(workspaceId).gatekeepers.has(id)) throw new Error(`No connection ${id} in this workspace`)
    return gatekeeperClient(workspaceId, id)
  },
  getGatekeeperByResourceUrl(resourceUrl) {
    const workspaceId = workspaceIdOf(this)
    for (const [id, gk] of connectionsFor(workspaceId).gatekeepers) {
      if (gk.spec.type === 'gatekeeper' && gk.spec.resourceUrl === resourceUrl) return gatekeeperClient(workspaceId, id)
    }
    return null
  },
  async newGatekeeper(accountId, resourceUrl) {
    await delay(300)
    const workspaceId = workspaceIdOf(this)
    const account = accountOrThrow(accountId)
    if (!account.credentialsValid) throw new Error('This account needs to be reconnected before it can be used')
    const vendor = vendorOrThrow(account.vendorId)
    const resource = vendor.supportedResources.find(r => matchesPattern(r.urlPattern, resourceUrl))
    if (!resource) return null
    for (const [id, gk] of connectionsFor(workspaceId).gatekeepers) {
      if (gk.spec.type === 'gatekeeper' && gk.spec.resourceUrl === resourceUrl) return gatekeeperClient(workspaceId, id)
    }
    const title = titleFor(resource, resourceUrl)
    const bindingName = screamingCase(resource.title.split(/\s+/).at(-1)!)
    return addGatekeeper(workspaceId, title,
      { type: 'gatekeeper', vendorId: vendor.id, resourceUrl, typeUrlPattern: resource.urlPattern },
      describeAs(resourceUrl, title, `${resource.title} via ${account.description.displayName ?? vendor.description.displayName}`,
        bindingName, pascalCase(resource.title)))
  },
  newAiModelGatekeeper(modelId) {
    const entry = models.entries.find(e => e.profile.id === modelId)
    if (!entry) throw new Error(`Model "${modelId}" not found`)
    return addGatekeeper(workspaceIdOf(this), entry.profile.name,
      { type: 'aiModel', modelId, provider: entry.config.provider, modelName: entry.config.model },
      describeAs('', entry.profile.name, `${entry.config.provider} model`, 'MODEL', 'AiModel'))
  },
  newAgentSpawnerGatekeeper(config: AgentSpawnerConfig) {
    const entry = config.modelId ? models.entries.find(e => e.profile.id === config.modelId) : undefined
    const names = Object.keys(config.env)
    return addGatekeeper(workspaceIdOf(this), config.displayName,
      { type: 'agentSpawner', config, ...(entry ? { modelProvider: entry.config.provider, modelName: entry.config.model } : {}) },
      describeAs('', config.displayName, names.length ? `Spawns agents with ${names.join(' and ')}` : 'Spawns agents with no bindings',
        screamingCase(config.displayName), 'AgentSpawner'))
  },

  listHooks() { return connectionsFor(workspaceIdOf(this)).hooks },
  enableHook(id) { setHookEnabled(workspaceIdOf(this), id, true) },
  disableHook(id) { setHookEnabled(workspaceIdOf(this), id, false) },
  deleteHook(id) {
    const entry = connectionsFor(workspaceIdOf(this))
    entry.hooks = entry.hooks.filter(h => h.id !== id)
  },

  async acceptConnectionRequest(requestId, { gatekeeperId }) {
    await delay(300)
    if (!connectionsFor(workspaceIdOf(this)).gatekeepers.has(gatekeeperId)) throw new Error(`No connection ${gatekeeperId} in this workspace`)
    settleRequest(requestId, { state: 'accepted', gatekeeperId })
  },
  async denyConnectionRequest(requestId) {
    await delay(200)
    settleRequest(requestId, { state: 'denied' })
  },

  listObserverRequirements(role: CollaboratorRole) {
    const { gatekeepers } = connectionsFor(workspaceIdOf(this))
    // A "use" recipient verifies every resource connection; a "build" one only those an app reads live.
    return createObserverNeeds()
      .filter(need => gatekeepers.has(need.gatekeeperId))
      .filter(need => role === 'use' || need.vendorId !== 'github')
  },
} satisfies DemoMethods<Overseer>)

// Hook ids from other areas' fixtures (e.g. the activity log) toggle as no-ops.
function setHookEnabled(workspaceId: string, id: number, enabled: boolean) {
  const hook = connectionsFor(workspaceId).hooks.find(h => h.id === id)
  if (hook) hook.enabled = enabled
}

// ─── GatekeeperClient ──────────────────────────────────────────────────────────

/** Session interfaces opened through a connection, by vendor; other areas provide their methods. */
const SESSION_INTERFACES: Record<string, string> = { inferops: 'InferOpsProjectSession' }

provide('GatekeeperClient', {
  getId() { return demoContext<GatekeeperContext>(this).gatekeeperId },
  getTitle() { return gatekeeperOf(this).title },
  setTitle(title) { gatekeeperOf(this).title = title },
  remove() {
    const { workspaceId, gatekeeperId } = demoContext<GatekeeperContext>(this)
    const entry = connectionsFor(workspaceId)
    entry.gatekeepers.delete(gatekeeperId)
    entry.hooks = entry.hooks.filter(h => h.gatekeeperId !== gatekeeperId)
    for (const [gadgetId, list] of entry.bindings) entry.bindings.set(gadgetId, list.filter(b => b.target !== gatekeeperId))
  },
  describe() { return gatekeeperOf(this).description },
  getCreationSpec() { return gatekeeperOf(this).spec },
  openSession() {
    const { spec } = gatekeeperOf(this)
    const vendorId = spec.type === 'gatekeeper' || spec.type === 'ambient' ? spec.vendorId : spec.type
    return demoTarget(SESSION_INTERFACES[vendorId] ?? `${pascalCase(vendorId)}Session`, demoContext<GatekeeperContext>(this))
  },
} satisfies DemoMethods<GatekeeperClient<any>>)

// ─── GadgetClient: bindings ────────────────────────────────────────────────────

function bindingInfo(workspaceId: string, name: string, target: WorkpieceId, chatId?: number): GadgetBindingInfo {
  const gk = connectionsFor(workspaceId).gatekeepers.get(target)
  if (!gk) throw new Error(`No connection ${target} in this workspace`)
  const vendorId = gk.spec.type === 'gatekeeper' || gk.spec.type === 'ambient' ? gk.spec.vendorId : undefined
  return { name, target, resourceTitle: gk.title, ...(vendorId ? { vendorId } : {}), ...(chatId === undefined ? {} : { chatId }) }
}

function bindingsFor(target: object) {
  const { workspaceId, gadgetId } = gadgetOf(target)
  return { workspaceId, gadgetId, list: bindingsOf(workspaceId, gadgetId) }
}

function setBindings(workspaceId: string, gadgetId: WorkpieceId, list: GadgetBindingInfo[]) {
  connectionsFor(workspaceId).bindings.set(gadgetId, list)
}

const annotationKey = (gadgetId: WorkpieceId, name: string) => `${gadgetId}:${name}`

provide('GadgetClient', {
  listBindings(chatId) {
    return bindingsFor(this).list.filter(b => b.chatId === undefined || b.chatId === chatId)
  },
  getBinding(name) {
    const { workspaceId, list } = bindingsFor(this)
    const binding = list.find(b => b.name === name)
    return binding ? gatekeeperClient(workspaceId, binding.target) : null
  },
  bind(name, target, chatId) {
    const { workspaceId, gadgetId, list } = bindingsFor(this)
    setBindings(workspaceId, gadgetId, [...list.filter(b => b.name !== name), bindingInfo(workspaceId, name, target, chatId)])
  },
  bindWithSuggestedName(target, chatId) {
    const { workspaceId, gadgetId, list } = bindingsFor(this)
    const existing = list.find(b => b.target === target)
    if (existing) return existing.name
    const base = connectionsFor(workspaceId).gatekeepers.get(target)?.description.suggestedBindingName ?? 'RESOURCE'
    let name = base
    for (let n = 2; list.some(b => b.name === name); n++) name = `${base}_${n}`
    setBindings(workspaceId, gadgetId, [...list, bindingInfo(workspaceId, name, target, chatId)])
    return name
  },
  unbind(name) {
    const { workspaceId, gadgetId, list } = bindingsFor(this)
    setBindings(workspaceId, gadgetId, list.filter(b => b.name !== name))
  },
  renameBinding(oldName, newName) {
    const { workspaceId, gadgetId, list } = bindingsFor(this)
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(newName)) throw new Error('Binding names must be valid JavaScript identifiers')
    if (list.some(b => b.name === newName)) throw new Error(`A binding named ${newName} already exists`)
    setBindings(workspaceId, gadgetId, list.map(b => (b.name === oldName ? { ...b, name: newName } : b)))
    const { annotations } = connectionsFor(workspaceId)
    const annotation = annotations.get(annotationKey(gadgetId, oldName))
    if (annotation) annotations.set(annotationKey(gadgetId, newName), annotation)
  },
  getBlueprintAnnotation(name) {
    const { workspaceId, gadgetId } = gadgetOf(this)
    return connectionsFor(workspaceId).annotations.get(annotationKey(gadgetId, name)) ?? null
  },
  setBlueprintAnnotation(name, annotation) {
    const { workspaceId, gadgetId } = gadgetOf(this)
    connectionsFor(workspaceId).annotations.set(annotationKey(gadgetId, name), annotation)
  },
} satisfies DemoMethods<GadgetClient>)

// ─── scenarios ─────────────────────────────────────────────────────────────────

const PAGE = '/gatekeepers'
const WORKSPACE = '/workspace/ws-ops'
const CONNECTED_CARD = 'section[aria-labelledby="gk-connected"] [role="button"]'
const AVAILABLE_CARD = 'section[aria-labelledby="gk-available"] [role="button"]'
const openConnectionsTab: DemoStep[] = [{ click: 'text=Connections' }, { wait: 'text=Connect resource' }]
const openNewConnection: DemoStep[] = [...openConnectionsTab, { click: 'text=Connect resource' }]
const group = (key: string): DemoStep[] => [{ click: `button[aria-controls="connection-group-panel-${key}"]` }]
const inferopsBoardStep: DemoStep[] = [
  ...openNewConnection,
  ...group('vendor:inferops'),
  { click: '[id="connection-group-panel-vendor:inferops"] button' },
]
const manageGoogle: DemoStep[] = [{ click: `${CONNECTED_CARD}:nth-child(2)` }]

/** The shared workspace asks its "use" collaborator to verify connections while opening. */
const verifying = (needs: typeof createObserverNeeds) => () => {
  const shared = workspaceFixtures['ws-shared']
  if (shared) shared.observerNeeds = needs()
}

scenario({
  // ── /gatekeepers ──
  'connections.connector-card.list': { path: PAGE, localStorage: { 'gatekeepers-view': 'list' } },
  'connections.loading': { path: PAGE, setup: () => { connections.load = 'loading' } },
  'connections.error': { path: PAGE, setup: () => { connections.load = 'error' } },
  'connections.empty': { path: PAGE, steps: [{ type: 'quantum ledger', into: 'input[aria-label="Search gatekeepers"]' }] },
  'connections.unavailable-toast': {
    path: PAGE,
    setup: () => { for (const vendor of connections.vendors) if (vendor.id === 'zoominfo' || vendor.id === 'supabase') vendor.unavailable = true },
  },

  // ── connect / manage dialog ──
  'modal.connect-connector': { path: PAGE, steps: [{ click: AVAILABLE_CARD }] },
  'modal.connect-connector.connect': { path: PAGE, steps: [{ click: AVAILABLE_CARD }] },
  'modal.connect-connector.opt-in': { path: PAGE, steps: [{ click: `${AVAILABLE_CARD}:last-child` }] },
  'modal.connect-connector.manage': { path: PAGE, steps: [{ click: CONNECTED_CARD }] },
  'modal.connect-connector.manage.disconnect-confirm': { path: PAGE, steps: [{ click: CONNECTED_CARD }, { click: 'text=Disconnect' }] },
  'modal.connect-connector.manage.pending-grants': {
    path: PAGE, steps: [...manageGoogle, { click: '[aria-label="Grant Google Sheets"]' }],
  },

  // ── Create New Connection ──
  'modal.gatekeeper': { path: WORKSPACE, steps: openNewConnection },
  'modal.gatekeeper.type-picker': { path: WORKSPACE, steps: openNewConnection },
  'modal.gatekeeper.resource': { path: WORKSPACE, steps: inferopsBoardStep },
  'modal.gatekeeper.account-chooser': { path: WORKSPACE, steps: inferopsBoardStep },
  'modal.gatekeeper.configurator': { path: WORKSPACE, steps: [...inferopsBoardStep, { wait: 'iframe[title="Resource configurator"]' }] },
  'modal.gatekeeper.ai-model': { path: WORKSPACE, steps: [...openNewConnection, ...group('platform:ai-model')] },
  'modal.gatekeeper.agent-spawner': { path: WORKSPACE, steps: [...openNewConnection, ...group('platform:agent-spawner')] },

  // ── a gadget's Connections tab ──
  'workspace.connections': { path: WORKSPACE, steps: openConnectionsTab },
  'workspace.connections.binding-row': { path: WORKSPACE, steps: openConnectionsTab },
  'workspace.connections.hooks': { path: WORKSPACE, steps: [...openConnectionsTab, { wait: 'text=Delete hook' }] },
  'workspace.connections.empty': { path: '/workspace/ws-notes', steps: [{ click: 'text=Connections' }] },
  'workspace.connections.binding-row.rename': {
    path: WORKSPACE, steps: [...openConnectionsTab, { click: 'button[aria-label="Edit name used in code"]' }],
  },
  'workspace.connections.binding-row.delete-confirm': {
    path: WORKSPACE, steps: [...openConnectionsTab, { click: 'button[aria-label="Delete connection"]' }],
  },
  'workspace.connections.blueprint-settings': {
    path: WORKSPACE, steps: [...openConnectionsTab, { click: 'button[aria-label="Edit blueprint settings"]' }],
  },

  // ── observer verification while opening a shared workspace ──
  'workspace.observer-config-modal': { path: '/workspace/ws-shared', setup: verifying(createObserverNeeds) },
  'modal.observer-config': { path: '/workspace/ws-shared', setup: verifying(createObserverNeeds) },
  'modal.observer-config.retry': { path: '/workspace/ws-shared', setup: verifying(createObserverRetryNeeds) },

  // ── gatekeeper management apps ──
  'gatekeeper-app.loading': { setup: () => { connections.app = 'loading' } },
  'gatekeeper-app.unavailable': { path: '/gatekeepers/nope' },
})
