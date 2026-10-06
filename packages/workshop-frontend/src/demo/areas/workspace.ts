// Demo fixtures and scenarios for the "workspace" views: opening a workspace (the Overseer),
// its workpieces, presence, sharing, and the GadgetClient behind the preview pane.
// Other areas build on this: `workspaceIdOf(this)` inside an Overseer method names the workspace,
// `gadgetOf(this)` inside a GadgetClient method names the gadget, and `workspaceFixtures` holds the
// per-workspace data (workpieces, collaborators, share links) they may read or mutate.

import type {
  AffectedCollaborator,
  AuthenticatedApi,
  CollaboratorInfo,
  CollaboratorRole,
  GadgetClient,
  GadgetMetadata,
  ObserverBindingNeed,
  Overseer,
  PresenceParticipant,
  ShareLinkInfo,
  UserDirectoryRecord,
  WorkpieceId,
  WorkpieceSummary,
} from '@gadgets/workshop-shared/api'
import { createOpenGadgetError, type OpenGadgetErrorCode } from '@gadgets/workshop-shared/api'
import { demoContext, demoTarget, forever, provide, delay, type DemoMethods } from '../registry'
import { world } from '../world'
import { gadgetBundle } from './workspace/gadgetBundle'
import './workspace/scenarios'

// ─── fixture data ──────────────────────────────────────────────────────────────

const now = Date.now()
const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000)
const hash = (seed: string) => [...seed.repeat(8)].map(c => (c.charCodeAt(0) % 16).toString(16)).join('').slice(0, 40)

/** People who appear across workspaces: collaborators, presence, the user directory. */
export const demoPeople = {
  dana: { type: 'user', id: 'demo', name: 'Dana Demo' },
  sam: { type: 'user', id: 'sam', name: 'Sam Rivera' },
  priya: { type: 'user', id: 'priya@example.com', name: 'Priya Natarajan' },
  marcus: { type: 'user', id: 'marcus@example.com', name: 'Marcus Oyelaran-Whitfield' },
  lea: { type: 'user', id: 'lea@example.com', name: 'Léa Fontaine' },
  kenji: { type: 'user', id: 'kenji@example.com', name: 'Kenji Watanabe' },
} as const

export interface WorkspaceFixture {
  workpieces: WorkpieceSummary[]
  collaborators: CollaboratorInfo[]
  shareLinks: ShareLinkInfo[]
  /** Others currently viewing (the signed-in user is added automatically). */
  presence: PresenceParticipant[]
  /** Workspace metadata beyond what `world.workspaces` carries. */
  metadata?: Partial<GadgetMetadata>
  /** When set, opening asks the user to verify these connections (ObserverConfigModal). */
  observerNeeds?: ObserverBindingNeed[]
}

const gadget = (id: WorkpieceId, title: string, extra: Partial<WorkpieceSummary> = {}): WorkpieceSummary =>
  ({ id, type: 'gadget', title, commitId: hash(title), ...extra }) as WorkpieceSummary

const documentOutput = { id: 'document', noun: 'Document', plural: 'Documents', icon: 'fileText' } as const
const boardOutput = { id: 'board', noun: 'Board', plural: 'Boards', icon: 'kanban' } as const
const checklistOutput = { id: 'checklist', noun: 'Checklist', plural: 'Checklists', icon: 'listChecks' } as const
const dashboardOutput = { id: 'dashboard', noun: 'Dashboard', plural: 'Dashboards', icon: 'chartBar' } as const

const edgeFrom = (sharer: string, minutes: number, role: CollaboratorRole = 'build', note?: string) =>
  ({ type: 'user' as const, sharer, created: minutesAgo(minutes), role, note })

/** Per-workspace fixture data, keyed by workspace id. Scenarios and other areas may mutate it. */
export const workspaceFixtures: Record<string, WorkspaceFixture> = {
  'ws-ops': {
    workpieces: [
      gadget(0, 'Ops dashboard', { output: dashboardOutput }),
      gadget(1, 'Incident runbook — payments & checkout', { output: documentOutput }),
      gadget(2, 'On-call rotation'),
    ],
    collaborators: [
      { profile: demoPeople.priya, role: 'build', addedBy: [edgeFrom('demo', 60 * 24 * 6)] },
      { profile: demoPeople.marcus, role: 'use', addedBy: [edgeFrom('demo', 60 * 24 * 3, 'use', 'Exec readout')] },
      { profile: demoPeople.lea, role: 'use', addedBy: [{ type: 'shareKey', keyId: 'link-standup', created: minutesAgo(60 * 20), role: 'use' }] },
    ],
    shareLinks: [
      { linkId: 'link-standup', note: 'Daily standup channel', created: minutesAgo(60 * 24 * 2), createdBy: demoPeople.dana, role: 'use' },
      { linkId: 'link-sre', note: 'SRE leads (edit access)', created: minutesAgo(60 * 5), createdBy: demoPeople.priya, role: 'build' },
    ],
    presence: [
      { key: 'p-priya', user: demoPeople.priya, role: 'build' },
      { key: 'p-marcus', user: demoPeople.marcus, role: 'use' },
      { key: 'p-lea', user: demoPeople.lea, role: 'use' },
    ],
  },
  'ws-triage': {
    workpieces: [gadget(0, 'Triage board', { output: boardOutput })],
    collaborators: [{ profile: demoPeople.kenji, role: 'build', addedBy: [edgeFrom('demo', 60 * 30)] }],
    shareLinks: [],
    presence: [{ key: 'p-kenji', user: demoPeople.kenji, role: 'build' }],
  },
  'ws-notes': {
    workpieces: [gadget(0, 'Meeting notes', { output: documentOutput })],
    collaborators: [],
    shareLinks: [],
    presence: [],
  },
  'ws-shared': {
    workpieces: [gadget(0, 'Launch checklist', { output: checklistOutput })],
    collaborators: [
      { profile: demoPeople.dana, role: 'use', addedBy: [edgeFrom('sam', 60 * 24 * 2, 'use')] },
      { profile: demoPeople.priya, role: 'build', addedBy: [edgeFrom('sam', 60 * 24)] },
    ],
    shareLinks: [],
    presence: [{ key: 'p-sam', user: demoPeople.sam, role: 'build' }],
  },
  // A brand-new workspace with nothing built yet (simple chat-only layout, "no gadgets" states).
  'ws-new': {
    workpieces: [],
    collaborators: [],
    shareLinks: [],
    presence: [],
    metadata: { title: 'Untitled Workspace' },
  },
}

/** Knobs scenarios turn to show the preview's and opening's non-default states. */
export const workspaceDemo = {
  /** `getUiBundle` result: a rendered fixture app, no UI yet, an endless load, or a failure. */
  uiBundle: 'app' as 'app' | 'none' | 'loading' | 'error',
  /** Holds `openGadget` (and the workpiece listing) forever, for the loading state. */
  openHangs: false,
  /** Fails `openGadget` with a generic, non-coded error. */
  openFailsUnexpectedly: false,
  /** Fails `openGadget` with this message (an observer-verification denial). */
  openDeniedMessage: null as string | null,
}

/** The user directory searched by the share dialog's people composer. */
export const demoDirectory: UserDirectoryRecord[] = [
  { id: 'priya@example.com', name: 'Priya Natarajan' },
  { id: 'marcus@example.com', name: 'Marcus Oyelaran-Whitfield' },
  { id: 'lea@example.com', name: 'Léa Fontaine' },
  { id: 'kenji@example.com', name: 'Kenji Watanabe' },
  { id: 'sam', name: 'Sam Rivera' },
  { id: 'jordan.mcallister@example.com', name: 'Jordan McAllister' },
  { id: 'aisha.k@example.com', name: 'Aisha Khalil' },
  { id: 'tomas@example.com', name: 'Tomás Herrera' },
  { id: 'mei.lin@example.com', name: 'Mei Lin' },
  { id: 'oluwaseun@example.com', name: 'Oluwaseun Adeyemi' },
  { id: 'nora.berg@example.com', name: 'Nora Berg' },
]

// ─── context helpers ───────────────────────────────────────────────────────────

type OverseerContext = { workspaceId: string }
type GadgetContext = { workspaceId: string; gadgetId: WorkpieceId }

/** The workspace an Overseer target was opened for. Use inside any `provide('Overseer', …)` method. */
export function workspaceIdOf(target: object): string {
  return demoContext<OverseerContext>(target).workspaceId
}

/** The workspace and gadget a GadgetClient target is for. */
export function gadgetOf(target: object): GadgetContext {
  return demoContext<GadgetContext>(target)
}

/** The fixture for a workspace id (created empty if a scenario opens an unknown one). */
export function fixtureFor(workspaceId: string): WorkspaceFixture {
  return (workspaceFixtures[workspaceId] ??= { workpieces: [], collaborators: [], shareLinks: [], presence: [] })
}

/** The metadata a workspace reports: the world's listing entry merged with fixture overrides. */
export function metadataFor(workspaceId: string): GadgetMetadata {
  const listed = world.workspaces.find(w => w.id === workspaceId)
  const base: GadgetMetadata = listed
    ? { id: listed.id, title: listed.title, pinned: listed.pinned, owner: listed.owner, role: listed.role, defaultGadgetId: listed.defaultGadgetId }
    : { id: workspaceId, title: 'Untitled Workspace', role: 'build', defaultGadgetId: 0 }
  return { totalCost: 4.82, ...base, ...workspaceFixtures[workspaceId]?.metadata }
}

const exists = (workspaceId: string) =>
  world.workspaces.some(w => w.id === workspaceId) || workspaceId in workspaceFixtures

// Live subscribers, so title edits and pins reach the open editor.
const metadataSubscribers = new Map<string, Set<(metadata: GadgetMetadata) => void>>()
const notifyMetadata = (workspaceId: string) => {
  for (const callback of metadataSubscribers.get(workspaceId) ?? []) callback(metadataFor(workspaceId))
}

function setListedField(workspaceId: string, patch: Partial<GadgetMetadata>) {
  const listed = world.workspaces.find(w => w.id === workspaceId)
  if (listed) Object.assign(listed, patch)
  else fixtureFor(workspaceId).metadata = { ...fixtureFor(workspaceId).metadata, ...patch }
  notifyMetadata(workspaceId)
}

/** A subscription handle: disposing it is all the frontend does. */
const subscription = () => demoTarget('DemoSubscription')

let shareKeyCounter = 0
const newKey = () => `demo${(++shareKeyCounter).toString(16).padStart(4, '0')}${'7c1e9a40b25d83f6'.repeat(2)}`.slice(0, 32)

// ─── AuthenticatedApi ──────────────────────────────────────────────────────────

let createdCount = 0

provide('AuthenticatedApi', {
  async openGadget(id, _shareKey?, configureObservers?) {
    if (workspaceDemo.openHangs) return forever<never>()
    if (workspaceDemo.openFailsUnexpectedly) throw new Error('Demo: the workspace Durable Object is unavailable')
    if (workspaceDemo.openDeniedMessage) throw new Error(workspaceDemo.openDeniedMessage)
    if (!exists(id)) throw createOpenGadgetError('WORKSPACE_NOT_FOUND')
    const needs = workspaceFixtures[id]?.observerNeeds
    if (needs?.length && configureObservers) await configureObservers.configure(needs)
    return demoTarget('Overseer', { workspaceId: id } satisfies OverseerContext)
  },
  newGadget() {
    const id = `ws-created-${++createdCount}`
    workspaceFixtures[id] = { workpieces: [], collaborators: [], shareLinks: [], presence: [], metadata: { title: 'Untitled Workspace' } }
    return demoTarget('Overseer', { workspaceId: id } satisfies OverseerContext)
  },
  newGadgetFromBlueprint(blueprintId) {
    const id = `ws-created-${++createdCount}`
    workspaceFixtures[id] = {
      workpieces: [gadget(0, blueprintId.replace(/[-_]/g, ' ').replace(/^\w/, c => c.toUpperCase()))],
      collaborators: [], shareLinks: [], presence: [], metadata: { title: 'New workspace from blueprint' },
    }
    return demoTarget('Overseer', { workspaceId: id } satisfies OverseerContext)
  },
  async searchUsers(query, excludeIds) {
    await delay(150)
    const q = query.toLowerCase()
    return demoDirectory
      .filter(u => u.id !== world.user.id && !excludeIds.includes(u.id))
      .filter(u => u.name.toLowerCase().includes(q) || u.id.toLowerCase().includes(q))
      .slice(0, 10)
  },
} satisfies DemoMethods<AuthenticatedApi>)

// ─── Overseer ──────────────────────────────────────────────────────────────────

const affected = (info: CollaboratorInfo, newRole: CollaboratorRole | null): AffectedCollaborator =>
  ({ profile: info.profile, addedBy: info.addedBy, oldRole: info.role ?? 'build', newRole })

provide('Overseer', {
  getMetadata() { return metadataFor(workspaceIdOf(this)) },
  subscribeToMetadata(callback) {
    const workspaceId = workspaceIdOf(this)
    const set = metadataSubscribers.get(workspaceId) ?? new Set()
    metadataSubscribers.set(workspaceId, set)
    const listener = (metadata: GadgetMetadata) => { void callback(metadata) }
    set.add(listener)
    listener(metadataFor(workspaceId))
    return subscription()
  },
  subscribeToPresence(subscriber) {
    const { presence } = fixtureFor(workspaceIdOf(this))
    void subscriber.init([{ key: 'p-self', user: world.user, role: metadataFor(workspaceIdOf(this)).role ?? 'build' }, ...presence])
    return subscription()
  },
  setTitle(title) { setListedField(workspaceIdOf(this), { title }) },
  setPinned(pinned) { setListedField(workspaceIdOf(this), { pinned }) },
  async deleteSelf() {
    await delay(400)
    const workspaceId = workspaceIdOf(this)
    world.workspaces = world.workspaces.filter(w => w.id !== workspaceId)
  },
  subscribeToWorkpieces(subscriber) {
    for (const summary of fixtureFor(workspaceIdOf(this)).workpieces) void subscriber.entry(summary)
    void subscriber.ready()
    return subscription()
  },
  createGadget(title, chatId) {
    const fixture = fixtureFor(workspaceIdOf(this))
    const id = Math.max(-1, ...fixture.workpieces.map(w => w.id)) + 1
    fixture.workpieces.push(gadget(id, title, chatId === undefined ? {} : { chatId, commitId: undefined }))
    return demoTarget('GadgetClient', { workspaceId: workspaceIdOf(this), gadgetId: id } satisfies GadgetContext)
  },
  getGadget(id) {
    const workspaceId = workspaceIdOf(this)
    if (!fixtureFor(workspaceId).workpieces.some(w => w.id === id && w.type === 'gadget')) {
      throw new Error(`Demo: no gadget ${id} in ${workspaceId}`)
    }
    return demoTarget('GadgetClient', { workspaceId, gadgetId: id } satisfies GadgetContext)
  },

  // Sharing
  listCollaborators() { return fixtureFor(workspaceIdOf(this)).collaborators },
  async addCollaborator(username, role, note) {
    await delay(300)
    const person = demoDirectory.find(u => u.id === username)
    if (!person) return null
    const info: CollaboratorInfo = {
      profile: { type: 'user', id: person.id, name: person.name },
      role,
      addedBy: [edgeFrom(world.user.id, 0, role, note)],
    }
    const fixture = fixtureFor(workspaceIdOf(this))
    fixture.collaborators = [...fixture.collaborators.filter(c => c.profile.id !== username), info]
    return info
  },
  previewRemoveCollaborator(profileId) {
    const { collaborators } = fixtureFor(workspaceIdOf(this))
    const target = collaborators.find(c => c.profile.id === profileId)
    if (!target) return []
    // Anyone the removed person invited loses access with them.
    const dependents = collaborators.filter(c => c.addedBy.some(e => e.type === 'user' && e.sharer === profileId))
    return [affected(target, null), ...dependents.map(c => affected(c, null))]
  },
  removeCollaborator(profileId, keepUsers) {
    const fixture = fixtureFor(workspaceIdOf(this))
    const target = fixture.collaborators.find(c => c.profile.id === profileId)
    if (!target) return []
    const lost = fixture.collaborators.filter(c =>
      c.profile.id === profileId ||
      (!keepUsers.includes(c.profile.id) && c.addedBy.every(e => e.type === 'user' && e.sharer === profileId)))
    fixture.collaborators = fixture.collaborators.filter(c => !lost.includes(c))
    return lost.map(c => affected(c, null))
  },
  createShareLink(role, note) {
    const fixture = fixtureFor(workspaceIdOf(this))
    const linkId = `link-${fixture.shareLinks.length + 1}-${Date.now().toString(36)}`
    fixture.shareLinks = [...fixture.shareLinks, { linkId, note, role, created: new Date(), createdBy: world.user }]
    return { key: newKey(), linkId }
  },
  newShareLinkKey() { return { key: newKey() } },
  listShareLinks() { return fixtureFor(workspaceIdOf(this)).shareLinks },
  updateShareLink(linkId, note) {
    const fixture = fixtureFor(workspaceIdOf(this))
    fixture.shareLinks = fixture.shareLinks.map(link => (link.linkId === linkId ? { ...link, note } : link))
  },
  previewRevokeShareLink(linkId) {
    return fixtureFor(workspaceIdOf(this)).collaborators
      .filter(c => c.addedBy.some(e => e.type === 'shareKey' && e.keyId === linkId))
      .map(c => affected(c, null))
  },
  revokeShareLink(linkId, keepUsers) {
    const fixture = fixtureFor(workspaceIdOf(this))
    const lost = fixture.collaborators.filter(c =>
      !keepUsers.includes(c.profile.id) && c.addedBy.every(e => e.type === 'shareKey' && e.keyId === linkId))
    fixture.shareLinks = fixture.shareLinks.filter(link => link.linkId !== linkId)
    fixture.collaborators = fixture.collaborators.filter(c => !lost.includes(c))
    return lost.map(c => affected(c, null))
  },
} satisfies DemoMethods<Overseer>)

// ─── GadgetClient (the preview pane) ───────────────────────────────────────────

const summaryOf = (target: object) => {
  const { workspaceId, gadgetId } = gadgetOf(target)
  return fixtureFor(workspaceId).workpieces.find(w => w.id === gadgetId)
}

provide('GadgetClient', {
  getId() { return gadgetOf(this).gadgetId },
  getTitle() { return summaryOf(this)?.title ?? 'Untitled' },
  setTitle(title) {
    const summary = summaryOf(this)
    if (summary) summary.title = title
  },
  remove() {
    const { workspaceId, gadgetId } = gadgetOf(this)
    const fixture = fixtureFor(workspaceId)
    fixture.workpieces = fixture.workpieces.filter(w => w.id !== gadgetId)
  },
  async getUiBundle() {
    switch (workspaceDemo.uiBundle) {
      case 'none': return null
      case 'loading': return forever<never>()
      case 'error': throw new Error('Demo: failed to build the gadget UI bundle')
    }
    const { workspaceId } = gadgetOf(this)
    return { jsCode: gadgetBundle(summaryOf(this)?.title ?? 'Untitled', metadataFor(workspaceId).title) }
  },
  connectToGadget() { return demoTarget('DemoGadgetServer') },
  getExportFormats() {
    return [
      { id: 'pdf', label: 'PDF document', mode: 'browser', contentType: 'application/pdf', fileExtension: '.pdf' },
      { id: 'png', label: 'PNG snapshot', mode: 'browser', contentType: 'image/png', fileExtension: '.png' },
      { id: 'csv', label: 'CSV (incidents table)', mode: 'server', contentType: 'text/csv', fileExtension: '.csv' },
      { id: 'json', label: 'JSON data', mode: 'server', contentType: 'application/json', fileExtension: '.json' },
    ]
  },
  export(id) {
    const body = id === 'csv' ? 'service,status,p95_ms\ncheckout,degraded,812\npayments,healthy,143\n' : '{"demo":true}\n'
    return new Blob([body]).stream() as ReadableStream<Uint8Array>
  },
} satisfies DemoMethods<GadgetClient>)

// Re-exported for scenarios that set an open error by code.
export type { OpenGadgetErrorCode }
