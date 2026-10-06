// Demo fixtures and scenarios for the "browse" views: /workspaces, /blueprints, /explore,
// /blueprint/$id (signed in and public), /outputs, and the workspace editor's publish modal.
// See ../registry.ts and ../scenarios.ts.

import type {
  AiChatAuthorInfo,
  BlueprintBinding,
  BlueprintGadgetSummary,
  BlueprintLibrarySummary,
  BlueprintOutput,
  BlueprintPublicInfo,
  BlueprintUserSummary,
  OutputFormatOffer,
  OutputSummary,
} from '@gadgets/workshop-shared/api'
import { forever, provide } from '../registry'
import { scenario } from '../scenarios'
import { world } from '../world'

const now = Date.now()
const ago = (minutes: number) => new Date(now - minutes * 60_000)
const DAY = 60 * 24

// ─── screenshots ─────────────────────────────────────────────────────────────
// Real screenshots come from /blueprint-screenshot/* (no demo backend), so fixtures carry inline
// SVG mock-ups as data: URLs instead.

type Shot = 'dashboard' | 'kanban' | 'doc' | 'chart'

function screenshot(kind: Shot, accent: string, title: string): string {
  const bars = (x: number, y: number, n: number, w: number) =>
    Array.from({ length: n }, (_, i) =>
      `<rect x="${x}" y="${y + i * 34}" width="${w - (i % 3) * 60}" height="14" rx="7" fill="#e4e4e7"/>`).join('')
  let body: string
  if (kind === 'kanban') {
    body = [0, 1, 2, 3].map(c => {
      const x = 300 + c * 240
      const cards = Array.from({ length: 4 - (c % 2) }, (_, i) =>
        `<rect x="${x + 12}" y="${190 + i * 110}" width="196" height="92" rx="10" fill="#fff" stroke="#e4e4e7"/>
         <rect x="${x + 28}" y="${208 + i * 110}" width="120" height="10" rx="5" fill="#3f3f46"/>
         <rect x="${x + 28}" y="${230 + i * 110}" width="150" height="8" rx="4" fill="#d4d4d8"/>
         <circle cx="${x + 186}" cy="${262 + i * 110}" r="10" fill="${accent}" opacity="${0.4 + i * 0.15}"/>`).join('')
      return `<rect x="${x}" y="140" width="220" height="540" rx="12" fill="#f4f4f5"/>
        <rect x="${x + 14}" y="156" width="90" height="12" rx="6" fill="#71717a"/>${cards}`
    }).join('')
  } else if (kind === 'doc') {
    body = `<rect x="420" y="130" width="640" height="560" rx="8" fill="#fff" stroke="#e4e4e7"/>
      <rect x="480" y="180" width="380" height="26" rx="8" fill="#18181b"/>
      ${bars(480, 240, 5, 520)}
      <rect x="480" y="430" width="520" height="150" rx="10" fill="${accent}" opacity="0.12"/>
      ${bars(480, 610, 2, 480)}`
  } else if (kind === 'chart') {
    body = `<rect x="300" y="140" width="940" height="320" rx="12" fill="#fff" stroke="#e4e4e7"/>
      <polyline fill="none" stroke="${accent}" stroke-width="5" stroke-linejoin="round"
        points="340,400 430,360 520,380 610,300 700,320 790,250 880,270 970,200 1060,230 1150,170 1200,190"/>
      ${[0, 1, 2].map(i => `<rect x="${300 + i * 316}" y="490" width="300" height="190" rx="12" fill="#fff" stroke="#e4e4e7"/>
        <rect x="${324 + i * 316}" y="514" width="110" height="10" rx="5" fill="#a1a1aa"/>
        <rect x="${324 + i * 316}" y="544" width="160" height="32" rx="8" fill="#18181b"/>
        <rect x="${324 + i * 316}" y="610" width="${200 - i * 40}" height="12" rx="6" fill="${accent}" opacity="0.5"/>`).join('')}`
  } else {
    body = `${[0, 1, 2, 3].map(i => `<rect x="${300 + i * 236}" y="140" width="220" height="120" rx="12" fill="#fff" stroke="#e4e4e7"/>
        <rect x="${320 + i * 236}" y="162" width="90" height="10" rx="5" fill="#a1a1aa"/>
        <rect x="${320 + i * 236}" y="190" width="${120 - i * 12}" height="30" rx="8" fill="${i === 0 ? accent : '#27272a'}"/>`).join('')}
      <rect x="300" y="284" width="940" height="396" rx="12" fill="#fff" stroke="#e4e4e7"/>
      ${Array.from({ length: 8 }, (_, r) => `<rect x="324" y="${312 + r * 44}" width="16" height="16" rx="4" fill="${r % 3 ? '#d4d4d8' : accent}"/>
        <rect x="360" y="${315 + r * 44}" width="${260 - (r % 4) * 30}" height="10" rx="5" fill="#52525b"/>
        <rect x="700" y="${315 + r * 44}" width="120" height="10" rx="5" fill="#d4d4d8"/>
        <rect x="960" y="${312 + r * 44}" width="70" height="16" rx="8" fill="${accent}" opacity="0.25"/>`).join('')}`
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
    <rect width="1280" height="720" fill="#fafafa"/>
    <rect width="260" height="720" fill="#f4f4f5"/>
    <rect x="24" y="28" width="32" height="32" rx="9" fill="${accent}"/>
    <text x="70" y="51" font-family="Inter,Arial,sans-serif" font-size="18" font-weight="600" fill="#18181b">${title.replace(/[<&]/g, '')}</text>
    ${Array.from({ length: 7 }, (_, i) => `<rect x="24" y="${110 + i * 40}" width="${150 - (i % 3) * 25}" height="12" rx="6" fill="${i === 1 ? accent : '#d4d4d8'}" opacity="${i === 1 ? 0.7 : 1}"/>`).join('')}
    <rect x="300" y="40" width="420" height="30" rx="8" fill="#18181b"/>
    <rect x="300" y="84" width="300" height="12" rx="6" fill="#a1a1aa"/>
    <rect x="1100" y="36" width="140" height="38" rx="10" fill="${accent}"/>
    ${body}
  </svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

// ─── blueprints ──────────────────────────────────────────────────────────────

const people: Record<string, AiChatAuthorInfo> = {
  dana: world.user,
  sam: { type: 'user', id: 'sam', name: 'Sam Rivera' },
  priya: { type: 'user', id: 'priya', name: 'Priya Natarajan-Whitfield' },
  ops: { type: 'user', id: 'ops-team', name: 'Platform Operations' },
}

const github = (title: string, description = ''): BlueprintBinding => ({
  type: 'gatekeeper', title, description, gatekeeperName: 'github',
  typeUrlPattern: 'https://github.com/:owner/:repo', resourceUrl: 'https://github.com/factory-level/inferos',
})
const slack = (title: string): BlueprintBinding => ({
  type: 'gatekeeper', title, description: 'The channel to post summaries into.', gatekeeperName: 'slack',
  typeUrlPattern: 'https://app.slack.com/client/:teamId/:conversationId',
})
const model = (title: string): BlueprintBinding => ({
  type: 'aiModel', title, description: 'Used to summarize and classify incoming items.',
  suggestedModel: { provider: 'anthropic', modelName: 'claude-sonnet' },
})
const spawner: BlueprintBinding = {
  type: 'agentSpawner', title: 'Background agent', description: 'Runs follow-ups on a schedule.', env: { repo: { type: 'gadget' } },
}
// A vendor this demo deployment does not install: drives the "unavailable" configure state.
const unavailable: BlueprintBinding = {
  type: 'gatekeeper', title: 'Salesforce account', description: 'CRM records to sync opportunities from.',
  gatekeeperName: 'salesforce', typeUrlPattern: 'https://*.my.salesforce.com/:object',
}

const OUT = {
  doc: { id: 'document', noun: 'Document', plural: 'Documents', icon: 'fileText' },
  sheet: { id: 'spreadsheet', noun: 'Spreadsheet', plural: 'Spreadsheets', icon: 'gridNine' },
  slides: { id: 'slides', noun: 'Slide deck', plural: 'Slide decks', icon: 'presentation' },
  board: { id: 'board', noun: 'Board', plural: 'Boards', icon: 'kanban' },
  chart: { id: 'dashboard', noun: 'Dashboard', plural: 'Dashboards', icon: 'chartBar' },
  checklist: { id: 'checklist', noun: 'Checklist', plural: 'Checklists', icon: 'listChecks' },
  notebook: { id: 'notebook', noun: 'Notebook', plural: 'Notebooks', icon: 'notebook' },
} satisfies Record<string, BlueprintOutput>

function bp(
  id: string, title: string, description: string, author: AiChatAuthorInfo,
  opts: { shot?: [Shot, string]; bindings?: Record<string, BlueprintBinding>; version?: number; updated?: number; output?: BlueprintOutput } = {},
): BlueprintPublicInfo {
  return {
    id,
    metadata: {
      title, description, author,
      created: ago((opts.updated ?? 60) + 40 * DAY),
      version: opts.version ?? 3,
      lastUpdated: ago(opts.updated ?? 60),
      bindings: opts.bindings ?? {},
      ...(opts.output ? { output: opts.output } : {}),
      ...(opts.shot ? { screenshot: true as const } : {}),
    },
    ...(opts.shot ? { screenshotUrl: screenshot(opts.shot[0], opts.shot[1], title) } : {}),
  }
}

/** Every blueprint the demo knows, by id (what `PublicApi.getBlueprint` serves). */
export const blueprints = new Map<string, BlueprintPublicInfo>([
  bp('bp-triage', 'Issue triage board', 'Pulls new GitHub issues into a Kanban board, labels them with an AI model and posts a daily digest to Slack.',
    people.priya, { shot: ['kanban', '#f6821f'], version: 12, updated: 90, output: OUT.board,
      bindings: { repo: github('Source repository', 'Issues are read from this repository.'), digest: slack('Digest channel'), classifier: model('Classifier model'), followups: spawner } }),
  bp('bp-standup', 'Async standup notes', 'Collects yesterday/today/blockers from the team and compiles a tidy daily doc.',
    people.sam, { shot: ['doc', '#6366f1'], version: 5, updated: 3 * DAY, output: OUT.doc, bindings: { writer: model('Writing model') } }),
  bp('bp-metrics', 'Release health dashboard', 'Tracks deploy frequency, failure rate and time-to-restore across every service, with weekly trend lines.',
    people.ops, { shot: ['chart', '#10b981'], version: 21, updated: 2 * DAY, output: OUT.chart, bindings: { repo: github('Monorepo') } }),
  bp('bp-checklist', 'Launch checklist', 'A reusable go-live checklist with owners, due dates and sign-off.',
    people.dana, { version: 2, updated: 6 * DAY, output: OUT.checklist }),
  bp('bp-crm', 'Pipeline review deck', 'Builds a weekly slide deck of open opportunities straight from your CRM — needs a connector this workshop does not offer.',
    people.priya, { shot: ['dashboard', '#0ea5e9'], version: 4, updated: 11 * DAY, output: OUT.slides,
      bindings: { crm: unavailable, narrator: model('Narration model') } }),
  bp('bp-research', 'Research notebook with an exceptionally long title that keeps going to test truncation', '',
    people.sam, { version: 1, updated: 20 * DAY, output: OUT.notebook }),
  bp('bp-budget', 'Team budget tracker', 'Quarterly spend by category with variance against plan.',
    people.dana, { shot: ['dashboard', '#a855f7'], version: 8, updated: 25, output: OUT.sheet }),
  bp('bp-oncall', 'On-call handoff', 'Summarises the week’s incidents and open alerts for the next on-call engineer.',
    people.ops, { shot: ['doc', '#ef4444'], version: 6, updated: 4 * DAY, output: OUT.doc,
      bindings: { alerts: slack('Alerts channel'), summarizer: model('Summary model') } }),
  bp('bp-imported', 'Recipe planner', 'Imported from another Workshop: plan meals and generate a shopping list.',
    people.dana, { version: 1, updated: 8 * DAY }),
].map(b => [b.id, b]))

const get = (id: string) => blueprints.get(id)!

/** Fixture state for this area; scenarios (any area's) may mutate it. */
export const browse = {
  featured: ['bp-triage', 'bp-metrics', 'bp-standup', 'bp-oncall', 'bp-crm', 'bp-research'],
  own: [
    { id: 'bp-checklist', source: { type: 'workspace', workspaceId: 'ws-shared', workspaceTitle: 'Launch checklist' }, pinned: true },
    { id: 'bp-budget', source: { type: 'workspace', workspaceId: 'ws-ops', workspaceTitle: 'Ops dashboard' } },
    { id: 'bp-triage', source: { type: 'workspace', workspaceId: 'ws-triage', workspaceTitle: 'Issue triage' } },
    { id: 'bp-imported', source: { type: 'imported' } },
    { id: 'bp-old', source: { type: 'deletedWorkspace' } },
  ] as { id: string; source: BlueprintUserSummary['source']; pinned?: boolean }[],
  library: [
    { id: 'bp-standup', uploaded: false, pinned: true, addedAt: ago(2 * DAY) },
    { id: 'bp-oncall', uploaded: false, addedAt: ago(5 * DAY) },
    { id: 'bp-imported', uploaded: true, addedAt: ago(8 * DAY) },
  ] as { id: string; uploaded: boolean; pinned?: boolean; addedAt: Date }[],
  /** Blueprints published from the open workspace (the publish modal's list). */
  gadgetBlueprints: [
    { id: 'bp-budget', dirty: false },
    { id: 'bp-metrics', dirty: true },
    { id: 'bp-checklist', dirty: false },
  ],
  outputs: [] as OutputSummary[],
  formats: [] as OutputFormatOffer[],
  /** Per-surface failure mode: absent loads, 'loading' never settles, 'error' rejects. */
  mode: {} as Partial<Record<'blueprints' | 'explore' | 'blueprint' | 'outputs' | 'download', 'loading' | 'error'>>,
}

// A blueprint whose source workspace was deleted; not public anywhere else.
blueprints.set('bp-old', bp('bp-old', 'Quarterly OKR tracker', 'Objectives and key results with progress roll-ups.', people.dana, { version: 9, updated: 70 * DAY }))

const pinnedIds = new Set(['bp-checklist', 'bp-standup'])

function gate<T>(key: keyof typeof browse.mode, value: () => T): T | Promise<T> {
  const mode = browse.mode[key]
  if (mode === 'loading') return forever<T>()
  if (mode === 'error') throw new Error('Demo: the server could not be reached')
  return value()
}

// ─── outputs ─────────────────────────────────────────────────────────────────

const sam = people.sam
browse.outputs = [
  ['ws-ops', 1, 'Q3 infrastructure spend', 'Ops dashboard', OUT.sheet, 12],
  ['ws-ops', 2, 'Release health — weekly', 'Ops dashboard', OUT.chart, 12],
  ['ws-ops', 3, 'Service status page', 'Ops dashboard', undefined, 12],
  ['ws-triage', 1, 'Inbound issue board', 'Issue triage', OUT.board, 90],
  ['ws-triage', 2, 'Triage rules and escalation policy for weekend coverage', 'Issue triage', OUT.doc, 90],
  ['ws-notes', 1, 'Design review — Sept 30', 'Meeting notes', OUT.doc, 26 * 60],
  ['ws-notes', 2, 'Planning offsite agenda', 'Meeting notes', OUT.doc, 26 * 60],
  ['ws-notes', 3, 'Offsite pitch', 'Meeting notes', OUT.slides, 26 * 60],
  ['ws-notes', 4, 'Research log', 'Meeting notes', OUT.notebook, 26 * 60],
  ['ws-shared', 1, 'Go-live checklist', 'Launch checklist', OUT.checklist, 5 * 60, sam, 'build'],
  ['ws-shared', 2, 'Launch announcement', 'Launch checklist', OUT.doc, 5 * 60, sam, 'use'],
  ['ws-shared', 3, 'Launch metrics', 'Launch checklist', OUT.chart, 5 * 60, sam, 'use'],
].map(([workspaceId, workpieceId, title, workspaceTitle, output, minutes, owner, role]) => ({
  workspaceId, workpieceId, title, workspaceTitle,
  created: ago((minutes as number) + 3 * DAY), lastActive: ago(minutes as number),
  ...(output ? { output } : {}), ...(owner ? { owner, role } : {}),
} as OutputSummary))

browse.formats = [
  ['bp-standup', OUT.doc, 'A blank document with AI drafting.', false],
  ['bp-budget', OUT.sheet, 'Rows, columns and formulas.', false],
  ['bp-crm', OUT.slides, 'A slide deck with speaker notes.', false],
  ['bp-triage', OUT.board, 'A Kanban board synced from GitHub issues.', true],
  ['bp-metrics', OUT.chart, 'Charts over any connected data source.', true],
].map(([blueprintId, output, description, requiresSetup]) =>
  ({ blueprintId, output, description, requiresSetup } as OutputFormatOffer))

// ─── RPC ─────────────────────────────────────────────────────────────────────

function ownSummary(entry: (typeof browse.own)[number]): BlueprintUserSummary {
  const { metadata } = get(entry.id)
  return {
    id: entry.id, title: metadata.title, description: metadata.description, source: entry.source,
    version: metadata.version, lastUpdated: metadata.lastUpdated, pinned: pinnedIds.has(entry.id),
  }
}

function archive(id: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(JSON.stringify(get(id)?.metadata ?? {}))
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } })
}

provide('PublicApi', {
  getBlueprint: id => gate('blueprint', () => blueprints.get(id) ?? null),
  downloadBlueprint: id => gate('download', () => {
    if (!blueprints.has(id)) throw new Error('Blueprint not found')
    return archive(id)
  }),
})

provide('AuthenticatedApi', {
  listOutputs: () => gate('outputs', () => ({ outputs: browse.outputs, catchingUp: false })),
  listOutputFormats: () => browse.formats,
  listOwnBlueprints: () => gate('blueprints', () => browse.own.map(ownSummary)),
  getOwnBlueprint(id) {
    const entry = browse.own.find(b => b.id === id)
    return entry ? ownSummary(entry) : null
  },
  listLibraryBlueprints: () => gate('blueprints', () => browse.library.map(
    (entry): BlueprintLibrarySummary => ({ id: entry.id, metadata: get(entry.id).metadata, addedAt: entry.addedAt,
      uploaded: entry.uploaded, pinned: pinnedIds.has(entry.id) }))),
  setBlueprintPinned(id, pinned) {
    if (pinned) pinnedIds.add(id)
    else pinnedIds.delete(id)
  },
  isBlueprintPinned: id => pinnedIds.has(id),
  listFeaturedBlueprints: () => gate('explore', () => browse.featured.map(get)),
  addBlueprintToLibrary(id) {
    if (!browse.library.some(b => b.id === id)) browse.library.unshift({ id, uploaded: false, addedAt: new Date() })
  },
  removeBlueprintFromLibrary(id) { browse.library = browse.library.filter(b => b.id !== id) },
  isBlueprintInLibrary(id) {
    const entry = browse.library.find(b => b.id === id)
    return entry ? { uploaded: entry.uploaded } : null
  },
  deleteOrphanedBlueprint(id) { browse.own = browse.own.filter(b => b.id !== id) },
  async importBlueprint(stream) {
    await new Response(stream).arrayBuffer()
    const id = `bp-upload-${browse.library.length}`
    blueprints.set(id, { ...get('bp-imported'), id })
    browse.library.unshift({ id, uploaded: true, addedAt: new Date() })
    return id
  },
  dismissSharedGadget(id) { world.workspaces = world.workspaces.filter(w => w.id !== id) },
})

provide('Overseer', {
  listBlueprints: () => browse.gadgetBlueprints.map(({ id, dirty }): BlueprintGadgetSummary => {
    const { metadata, screenshotUrl } = get(id)
    return {
      id, title: metadata.title, description: metadata.description, version: metadata.version,
      codeVersionDate: metadata.lastUpdated, ...(screenshotUrl ? { screenshotUrl } : {}), ...(dirty ? { dirty } : {}),
    }
  }),
  updateBlueprint(id, options) {
    const current = get(id)
    if (!current) return
    const { title = current.metadata.title, description = current.metadata.description } = options
    blueprints.set(id, { ...current, metadata: { ...current.metadata, title, description,
      version: current.metadata.version + (options.updateCode ? 1 : 0), lastUpdated: new Date() } })
  },
  deleteBlueprint(id) { browse.gadgetBlueprints = browse.gadgetBlueprints.filter(b => b.id !== id) },
  retryBlueprintPublish(id) {
    browse.gadgetBlueprints = browse.gadgetBlueprints.map(b => (b.id === id ? { ...b, dirty: false } : b))
  },
})

// ─── scenarios ───────────────────────────────────────────────────────────────

/** A large workspace list, for scroll and density checks. */
function manyWorkspaces() {
  const titles = ['Customer interviews synthesis', 'Hiring pipeline', 'Incident postmortems', 'Pricing experiments',
    'Roadmap Q4 — platform and developer experience initiatives', 'Vendor contracts', 'Onboarding guide', 'Weekly metrics']
  world.workspaces = [...world.workspaces, ...titles.map((title, i) => ({
    id: `ws-extra-${i}`, title, defaultGadgetId: 0, role: 'build' as const, totalCost: 0.37 * (i + 1),
    created: ago((i + 10) * DAY), lastActive: ago((i + 2) * DAY),
  }))]
}

/** Makes core's `listGadgets` (which returns `world.workspaces`) hang or fail. */
function workspacesMode(mode: 'loading' | 'error') {
  Object.defineProperty(world, 'workspaces', {
    configurable: true,
    get: () => { if (mode === 'error') throw new Error('Demo: listGadgets failed'); return forever() },
  })
}

const compact = () => { world.serverConfig = { ...world.serverConfig, displayDensity: 'compact' } }
const wsRowMenu = { click: 'a[href="/workspace/ws-ops"] button' }
const bpRowMenu = (id: string) => ({ click: `a[href="/blueprint/${id}"] button` })
const outputMenu = [{ hover: 'text=Output actions' }, { click: 'text=Output actions' }]
const publishModal = { click: 'button[aria-label="Blueprints"]' }

scenario({
  // /workspaces
  workspaces: { setup: manyWorkspaces },
  'workspaces.list.row': { setup: () => { manyWorkspaces(); compact() } },
  'workspaces.state.loading': { setup: () => workspacesMode('loading') },
  'workspaces.state.error': { setup: () => workspacesMode('error') },
  'workspaces.state.no-results': { steps: [{ type: 'zzz-no-match', into: 'input[placeholder="Search workspaces…"]' }] },
  'workspaces.featured-gallery': { setup: w => { w.workspaces = [] } },
  'workspaces.featured-gallery.card': { setup: w => { w.workspaces = []; compact() } },
  'workspaces.list.row-menu': { steps: [wsRowMenu] },
  'workspaces.list.row.rename': { steps: [wsRowMenu, { click: 'text=Rename' }] },
  'workspaces.info-dialog': { setup: w => { w.workspaces[0] = { ...w.workspaces[0], totalCost: 14.82 } }, steps: [wsRowMenu, { click: 'text=Information' }] },
  'workspaces.share-modal': { steps: [wsRowMenu, { click: 'text=Share' }] },
  'workspaces.delete-dialog': { steps: [wsRowMenu, { click: 'text=Delete' }] },

  // /blueprints
  'blueprints.list.row-menu': { steps: [bpRowMenu('bp-standup')] },
  'blueprints.toast.upload': { steps: [bpRowMenu('bp-oncall'), { click: 'text=Remove from library' }] },
  'blueprints.state.empty': { setup: () => { browse.own = []; browse.library = [] } },
  'blueprints.state.error': { setup: () => { browse.mode.blueprints = 'error' } },
  'blueprints.state.loading': { setup: () => { browse.mode.blueprints = 'loading' } },
  'blueprints.state.no-results': { steps: [{ type: 'zzz-no-match', into: 'input[placeholder="Search blueprints…"]' }] },

  // /explore
  'explore.list': { localStorage: { 'explore-view': 'list' } },
  'explore.list.row': { localStorage: { 'explore-view': 'list' }, setup: compact },
  'explore.grid': { localStorage: { 'explore-view': 'grid' } },
  'explore.grid.card': { localStorage: { 'explore-view': 'grid' }, setup: compact },
  'explore.state.empty': { localStorage: { 'explore-view': 'grid' }, setup: () => { browse.featured = [] } },
  'explore.state.loading': { setup: () => { browse.mode.explore = 'loading' } },

  // /blueprint/$id
  blueprint: { path: '/blueprint/bp-triage' },
  'blueprint.public': { path: '/blueprint/bp-triage', setup: w => { w.signedIn = false } },
  'blueprint.login': { path: '/blueprint/bp-triage', setup: w => { w.signedIn = false }, steps: [{ click: 'text=Log in to create a gadget' }] },
  'blueprint.aside.screenshot-hero': { path: '/blueprint/bp-metrics' },
  'blueprint.screenshot-lightbox': { path: '/blueprint/bp-metrics', steps: [{ click: 'button[aria-label^="Open larger screenshot"]' }] },
  'blueprint.header.featured-pill': { path: '/blueprint/bp-metrics' },
  'blueprint.connections': { path: '/blueprint/bp-triage' },
  'blueprint.connections.row': { path: '/blueprint/bp-oncall' },
  'blueprint.connections.none': { path: '/blueprint/bp-checklist' },
  'blueprint.actions-menu': { path: '/blueprint/bp-budget', steps: [{ click: 'text=More blueprint actions' }] },
  'blueprint.delete-dialog': { path: '/blueprint/bp-budget', steps: [{ click: 'text=More blueprint actions' }, { click: 'text=Delete blueprint' }] },
  'blueprint.configure-dialog': { path: '/blueprint/bp-triage', steps: [{ click: 'text=Configure' }] },
  'blueprint.configure-dialog.gatekeeper': { path: '/blueprint/bp-metrics', steps: [{ click: 'text=Configure' }] },
  'blueprint.configure-dialog.model': { path: '/blueprint/bp-standup', steps: [{ click: 'text=Configure' }] },
  'blueprint.configure-dialog.unavailable': { path: '/blueprint/bp-crm', steps: [{ click: 'text=Configure' }] },
  'blueprint.error-banner': {
    path: '/blueprint/bp-oncall',
    setup: () => {
      browse.mode.download = 'error'
      // Skip the native save picker so the failing download stream is requested straight away.
      Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined })
    },
    steps: [{ click: 'text=More blueprint actions' }, { click: 'text=Download archive' }],
  },
  'blueprint.state.loading': { path: '/blueprint/bp-triage', setup: () => { browse.mode.blueprint = 'loading' } },
  'blueprint.state.error': { path: '/blueprint/bp-triage', setup: () => { browse.mode.blueprint = 'error' } },
  'blueprint.state.not-found': { path: '/blueprint/bp-does-not-exist' },

  // Publish modal (workspace editor header → Blueprints)
  'blueprint.publish-modal': { steps: [publishModal] },
  'blueprint.publish-modal.list': { steps: [publishModal] },
  'blueprint.publish-modal.row': { steps: [publishModal] },
  'blueprint.publish-modal.row-delete': { steps: [publishModal, { click: 'button[aria-label="Delete blueprint"]' }] },
  'blueprint.publish-modal.form': { steps: [publishModal, { click: 'text=Create blueprint' }] },
  'blueprint.publish-modal.connections': { steps: [publishModal, { click: 'text=Create blueprint' }] },
  'blueprint.publish-modal.binding-card': { steps: [publishModal, { click: 'text=Create blueprint' }] },
  'blueprint.publish-modal.screenshot': { steps: [publishModal, { click: 'button[aria-label="Edit blueprint"]' }] },

  // /outputs
  'outputs.grid': { localStorage: { 'outputs-view': 'grid' } },
  'outputs.grid.card': { localStorage: { 'outputs-view': 'grid' }, setup: compact },
  'outputs.grid.card.thumbnail': { localStorage: { 'outputs-view': 'grid' } },
  'outputs.list': { localStorage: { 'outputs-view': 'list' } },
  'outputs.list.row': { localStorage: { 'outputs-view': 'list' }, setup: compact },
  'outputs.item-menu': { localStorage: { 'outputs-view': 'grid' }, steps: outputMenu },
  'outputs.rename-dialog': { localStorage: { 'outputs-view': 'grid' }, steps: [...outputMenu, { click: 'text=Rename' }] },
  'outputs.remove-dialog': { localStorage: { 'outputs-view': 'grid' }, steps: [...outputMenu, { click: 'text=Remove' }] },
  'outputs.scope-menu': { steps: [{ click: 'text=Yours and shared' }] },
  'outputs.state.empty': { setup: () => { browse.outputs = []; browse.formats = [] } },
  'outputs.state.empty.format-row': { setup: () => { browse.outputs = [] } },
  'outputs.state.error': { setup: () => { browse.mode.outputs = 'error' } },
  'outputs.state.loading': { setup: () => { browse.mode.outputs = 'loading' } },
})
