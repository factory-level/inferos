// Demo fixtures and scenarios for the "admin", "activity" and "theme" views: the AdminApi
// capability, the Overseer's action log / auto-approval surface, and theme scenarios.
// See ../registry.ts and ../scenarios.ts.

import { RpcTarget, type RpcStub } from 'capnweb'
import type {
  ActionHistoryFilter,
  ActionLogEntry,
  ActionsSubscriber,
  AdminFormat,
  AdminResourceVendor,
  AiChatAuthorInfo,
  BlueprintOutput,
  PreApprovableAction,
} from '@gadgets/workshop-shared/api'
import { DEFAULT_SITE_NAME, matchesActionHistoryFilter } from '@gadgets/workshop-shared/api'
import type { ActionField, ActionKind } from '@gadgets/workshop-shared/gatekeeper'
import { forever, provide } from '../registry'
import { scenario, type DemoStep } from '../scenarios'
import { world } from '../world'

const now = Date.now()
const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000)

/** A square SVG badge as a data: URL, standing in for a vendor or deployment logo. */
const badge = (text: string, color: string, rounded = 6) => ({
  url: `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="${rounded}" fill="${color}"/>` +
      `<text x="16" y="21.5" font-family="Inter,Arial,sans-serif" font-size="${text.length > 1 ? 12 : 16}" font-weight="700" fill="#fff" text-anchor="middle">${text}</text></svg>`,
  )}`,
})

/** The custom deployment logo used by branding scenarios. */
export const DEMO_SITE_LOGO = badge('AC', '#0f766e', 9)

// ---------------------------------------------------------------------------------------------
// Admin settings
// ---------------------------------------------------------------------------------------------

const output = (id: string, noun: string, plural: string, icon: BlueprintOutput['icon']): BlueprintOutput =>
  ({ id, noun, plural, icon })

/** Admin-only settings; the branding fields shared with ServerConfig live in `world.serverConfig`. */
export const adminDemo = {
  /** 'loading' never resolves getSettings(); 'error' makes it throw. */
  settings: 'ok' as 'ok' | 'loading' | 'error',
  defaultTheme: 'system' as 'system' | 'light' | 'dark',
  instanceInstructions:
    'ACME Logistics runs freight forwarding for small and mid-sized importers across North America and the EU.\n\n' +
    '- Prefer the InferOps project board as the source of truth for work in progress; never copy issue data into gadgets.\n' +
    '- Use metric units and ISO dates (YYYY-MM-DD) in everything you build.\n' +
    '- Customer names and shipment IDs are confidential: do not post them to Slack channels outside #ops-internal.\n' +
    '- When in doubt, ask before sending anything externally.',
  featured: new Set(['bp-doc', 'bp-kanban']),
  resourceVendors: [
    { vendorId: 'context', displayName: 'Context Library', logo: badge('C', '#7c3aed'), autoProvisions: true, ambientMode: 'enabled' },
    { vendorId: 'scheduler', displayName: 'Scheduled Tasks', logo: badge('S', '#0891b2'), autoProvisions: true, ambientMode: 'optional' },
    { vendorId: 'mcp-portal', displayName: 'Company MCP Portal', logo: badge('M', '#475569'), autoProvisions: true, ambientMode: 'disabled' },
    {
      vendorId: 'github', displayName: 'GitHub', logo: badge('GH', '#24292f'), autoProvisions: false, enabled: true,
      resources: [
        { urlPattern: 'https://github.com/:owner/:repo', title: 'Repository', description: 'Read code, open branches and push commits to one repository.', enabled: true },
        { urlPattern: 'https://github.com/:owner/:repo/issues', title: 'Issues', description: 'Read, create and comment on issues in a repository.', enabled: true },
        { urlPattern: 'https://github.com/:owner/:repo/pulls', title: 'Pull requests', description: 'Open pull requests and post review comments.', enabled: false },
      ],
    },
    {
      vendorId: 'google', displayName: 'Google Workspace', logo: badge('G', '#1a73e8'), autoProvisions: false, enabled: true,
      resources: [
        { urlPattern: 'https://calendar.google.com/calendar/:id', title: 'Calendar', description: 'See events and propose new ones on a single calendar.', enabled: true },
        { urlPattern: 'https://drive.google.com/drive/folders/:id', title: 'Drive folder', description: 'Read and create documents inside one shared folder.', enabled: true },
        { urlPattern: 'https://mail.google.com/mail/:label', title: 'Gmail label', description: 'Read threads under a label and draft replies for approval.', enabled: false },
      ],
    },
    {
      vendorId: 'inferops', displayName: 'InferOps', logo: badge('IO', '#ea580c'), autoProvisions: false, enabled: true,
      resources: [
        { urlPattern: 'inferops://:host/project/board/:key', title: 'Project board', description: 'Read a board and request approved issue transitions.', enabled: true },
      ],
    },
    {
      vendorId: 'cloudflare', displayName: 'Cloudflare', logo: badge('CF', '#f38020'), autoProvisions: false, enabled: true,
      resources: [
        { urlPattern: 'cloudflare://account/:id/observability', title: 'Workers Observability (account)', description: 'Query logs and traces for every Worker in an account.', enabled: true },
        { urlPattern: 'cloudflare://account/:id/workers/:script/observability', title: 'Workers Observability (one Worker)', description: 'Query logs and traces for a single Worker.', enabled: true },
      ],
    },
    {
      vendorId: 'slack', displayName: 'Slack', logo: badge('S', '#4a154b'), autoProvisions: false, enabled: false,
      resources: [
        { urlPattern: 'https://slack.com/app_redirect?channel=:id', title: 'Channel', description: 'Read messages and post to one channel.', enabled: true },
        { urlPattern: 'https://slack.com/app_redirect?user=:id', title: 'Direct message', description: 'Send direct messages to one person.', enabled: true },
      ],
    },
  ] as AdminResourceVendor[],
  formats: [
    {
      blueprintId: 'bp-doc', blueprintTitle: 'Doc', bundled: true, enabled: true, missing: false,
      blueprintDescription: 'A rich-text document with headings, tables, checklists and inline comments. Exports to Markdown and PDF.',
      output: output('document', 'Doc', 'Docs', 'fileText'), declared: output('document', 'Doc', 'Docs', 'fileText'),
      agentHint: 'Use for anything people will read top to bottom: specs, notes, reports.',
    },
    {
      blueprintId: 'bp-slides', blueprintTitle: 'Slides', bundled: true, enabled: true, missing: false,
      blueprintDescription: 'A slide deck with speaker notes, themes and presenter mode.',
      output: output('presentation', 'Deck', 'Decks', 'presentation'), declared: output('presentation', 'Slides', 'Slides', 'presentation'),
      overrides: { noun: 'Deck', plural: 'Decks' },
      agentHint: 'Use for customer-facing presentations and weekly ops reviews.',
    },
    {
      blueprintId: 'bp-kanban', blueprintTitle: 'Shipment tracker board', bundled: false, enabled: true, missing: false,
      blueprintDescription: 'A Kanban board bound to an InferOps project, with swimlanes per carrier and SLA badges.',
      output: output('board', 'Board', 'Boards', 'kanban'), declared: output('board', 'Board', 'Boards', 'kanban'),
      agentHint: 'Prefer for tracking shipments or any work that moves through stages.',
    },
    {
      blueprintId: 'bp-sheet', blueprintTitle: 'Customs duty calculator', bundled: false, enabled: true, missing: false,
      blueprintDescription: 'Estimates landed cost from HS codes, origin and declared value.',
      agentHint: '',
    },
    {
      blueprintId: 'bp-dash', blueprintTitle: 'Carrier performance dashboard', bundled: false, enabled: false, missing: false,
      blueprintDescription: 'Charts on-time rate, damage claims and cost per kilo by carrier and lane.',
      output: output('dashboard', 'Dashboard', 'Dashboards', 'chartBar'), declared: output('dashboard', 'Dashboard', 'Dashboards', 'chartBar'),
      agentHint: 'Only when someone asks for carrier metrics.',
    },
    {
      blueprintId: 'bp-legacy-notes', blueprintTitle: 'Meeting notes (legacy)', bundled: false, enabled: true, missing: true,
      blueprintDescription: '', agentHint: 'Use for meeting notes.',
    },
  ] as AdminFormat[],
}

const blueprintTitles: Record<string, string> = {
  'bp-doc': 'Doc', 'bp-slides': 'Slides', 'bp-kanban': 'Shipment tracker board',
}

const bytesToDataUrl = (data: Uint8Array) => {
  let binary = ''
  for (const byte of data) binary += String.fromCharCode(byte)
  return `data:image/png;base64,${btoa(binary)}`
}

provide('AdminApi', {
  getSettings() {
    if (adminDemo.settings === 'loading') return forever()
    if (adminDemo.settings === 'error') throw new Error('Demo: admin settings unavailable')
    const config = world.serverConfig
    return {
      defaultTheme: adminDemo.defaultTheme,
      displayDensity: config.displayDensity ?? 'comfortable',
      signupsEnabled: config.signupsEnabled,
      userSearchEnabled: config.userSearchEnabled,
      siteName: config.siteName,
      siteLogo: config.siteLogo,
      instanceInstructions: adminDemo.instanceInstructions,
      announcement: config.announcement,
      banner: { text: config.banner, color: config.bannerColor },
      accentColor: config.accentColor,
      resourceVendors: structuredClone(adminDemo.resourceVendors),
      formats: structuredClone(adminDemo.formats),
    }
  },
  initializeProfile: () => 'already-initialized',
  setDefaultTheme(mode) { adminDemo.defaultTheme = mode; world.serverConfig.defaultTheme = mode },
  setDisplayDensity(density) { world.serverConfig.displayDensity = density },
  setSignupsEnabled(enabled) { world.serverConfig.signupsEnabled = enabled },
  setUserSearchEnabled(enabled) { world.serverConfig.userSearchEnabled = enabled },
  setSiteName(name) { world.serverConfig.siteName = name },
  setSiteLogo(data) {
    world.serverConfig.siteLogo = data ? { url: bytesToDataUrl(data) } : undefined
    return world.serverConfig.siteLogo
  },
  setInstanceInstructions(text) { adminDemo.instanceInstructions = text },
  setResourceEnabled(vendorId, urlPattern, enabled) {
    const vendor = adminDemo.resourceVendors.find(v => v.vendorId === vendorId)
    if (vendor && !vendor.autoProvisions) {
      const resource = vendor.resources.find(r => r.urlPattern === urlPattern)
      if (resource) resource.enabled = enabled
    }
  },
  setGatekeeperMode(vendorId, mode) {
    const vendor = adminDemo.resourceVendors.find(v => v.vendorId === vendorId)
    if (!vendor) throw new Error(`Demo: unknown gatekeeper ${vendorId}`)
    if (vendor.autoProvisions) vendor.ambientMode = mode
    else vendor.enabled = mode !== 'disabled'
  },
  setAnnouncement(text) { world.serverConfig.announcement = text },
  setBanner(text, color) { world.serverConfig.banner = text; world.serverConfig.bannerColor = color },
  setAccentColor(color) { world.serverConfig.accentColor = color },
  isBlueprintFeatured: id => adminDemo.featured.has(id),
  setBlueprintFeatured(id, featured) {
    if (featured) adminDemo.featured.add(id)
    else adminDemo.featured.delete(id)
  },
  promoteFormat(blueprintId) {
    if (adminDemo.formats.some(f => f.blueprintId === blueprintId)) return
    adminDemo.formats.push({
      blueprintId, blueprintTitle: blueprintTitles[blueprintId] ?? blueprintId,
      blueprintDescription: 'Promoted in the demo.', enabled: true, agentHint: '', missing: false, bundled: false,
    })
  },
  removeFormat(blueprintId) {
    const format = adminDemo.formats.find(f => f.blueprintId === blueprintId)
    if (format?.bundled) throw new Error('Demo: a bundled format can only be turned off')
    adminDemo.formats = adminDemo.formats.filter(f => f.blueprintId !== blueprintId)
  },
  updateFormat(blueprintId, patch) {
    const format = adminDemo.formats.find(f => f.blueprintId === blueprintId)
    if (!format) throw new Error(`Demo: ${blueprintId} is not promoted`)
    if (patch.enabled !== undefined) format.enabled = patch.enabled
    if (patch.agentHint !== undefined) format.agentHint = patch.agentHint
    if (patch.overrides) {
      const overrides: Record<string, unknown> = { ...format.overrides }
      for (const [key, value] of Object.entries(patch.overrides)) {
        if (value === null) delete overrides[key]
        else if (value !== undefined) overrides[key] = value
      }
      format.overrides = overrides as Partial<BlueprintOutput>
      const base = format.declared ?? format.output
      const merged = { ...base, ...format.overrides }
      format.output = merged.noun && merged.plural && merged.icon
        ? { id: merged.id ?? blueprintId, noun: merged.noun, plural: merged.plural, icon: merged.icon }
        : undefined
    }
  },
  setFormatOrder(blueprintIds) {
    adminDemo.formats = blueprintIds.map(id => adminDemo.formats.find(f => f.blueprintId === id)!).filter(Boolean)
  },
})

// ---------------------------------------------------------------------------------------------
// Activity: action log, approvals and auto-approval rules (Overseer)
// ---------------------------------------------------------------------------------------------

const GK = { github: 101, calendar: 102, inferops: 103, slack: 104, drive: 105 } as const
const sam: AiChatAuthorInfo = { type: 'user', id: 'sam', name: 'Sam Rivera' }

const KINDS = {
  issueComment: { tag: 'github.issue.comment', label: 'Comment on issues' },
  createIssue: { tag: 'github.issue.create', label: 'Open issues' },
  push: { tag: 'github.push', label: 'Push commits' },
  transition: { tag: 'inferops.issue.transition', label: 'Move issues between columns' },
  assign: { tag: 'inferops.issue.assign', label: 'Assign issues' },
  createEvent: { tag: 'calendar.event.create', label: 'Create calendar events' },
  postMessage: { tag: 'slack.message.post', label: 'Post messages' },
  createDoc: { tag: 'drive.file.create', label: 'Create documents' },
} satisfies Record<string, ActionKind>

const RESOURCES = {
  [GK.github]: { title: 'acme-logistics/shipment-portal', url: 'https://github.com/acme-logistics/shipment-portal', vendorId: 'github' },
  [GK.calendar]: { title: 'Ops team calendar', url: 'https://calendar.google.com/calendar/ops', vendorId: 'google' },
  [GK.inferops]: { title: 'OPS board (demo.local)', url: undefined, vendorId: 'inferops' },
  [GK.slack]: { title: '#ops-internal', url: 'https://slack.com/app_redirect?channel=C0OPS', vendorId: 'slack' },
  [GK.drive]: { title: 'Customer reports (Drive)', url: 'https://drive.google.com/drive/folders/reports', vendorId: 'google' },
}

const on = (gatekeeperId: keyof typeof RESOURCES) => ({
  gatekeeperId, resourceTitle: RESOURCES[gatekeeperId].title, resourceUrl: RESOURCES[gatekeeperId].url,
})

type ActionSeed = {
  gk: keyof typeof RESOURCES
  title: string
  description: string
  fields?: ActionField[]
  kind?: ActionKind
  autoApprovable?: boolean
  complete?: boolean
}

const ACTIONS: ActionSeed[] = [
  {
    gk: GK.inferops, kind: KINDS.transition, autoApprovable: true, complete: true,
    title: 'Move OPS-482 “Rotterdam reefer delayed at customs” to In progress',
    description: 'Transitions the issue from **Triage** to **In progress** on the OPS board, expected revision 31.',
    fields: [{ label: 'Issue', kind: 'inline', value: 'OPS-482' }, { label: 'From → To', kind: 'inline', value: 'Triage → In progress' }],
  },
  {
    gk: GK.slack, kind: KINDS.postMessage, autoApprovable: false, complete: true,
    title: 'Post the daily delay summary to #ops-internal',
    description: 'Sends one message to the channel as the ACME Ops bot.',
    fields: [{ label: 'Message', kind: 'text', syntax: 'markdown', value: '*Daily delays — 2026-10-02*\n• 3 containers held at Rotterdam (customs inspection)\n• OPS-479 Hamburg feeder rolled to next sailing\n• Air freight lane FRA→ORD back to normal' }],
  },
  {
    gk: GK.github, kind: KINDS.issueComment, autoApprovable: true, complete: true,
    title: 'Comment on #1287 “Tracking page shows stale ETA after carrier update”',
    description: 'Adds a comment with the reproduction steps the agent found.',
    fields: [{ label: 'Body', kind: 'text', syntax: 'markdown', value: 'Reproduced on staging: the ETA cache is keyed by booking ref only, so a carrier swap keeps the old ETA for up to 6 h.\n\nSuggested fix: include `carrier_id` in the cache key.' }],
  },
  {
    gk: GK.calendar, kind: KINDS.createEvent, autoApprovable: true,
    title: 'Create “Q4 peak season readiness review” on Oct 8, 14:00–15:00',
    description: 'Invites 6 people from the ops and customer-success teams.',
    fields: [{ label: 'Invitees', kind: 'list', items: ['dana@example.com', 'sam@example.com', 'priya@example.com', 'marco@example.com', 'li.wei@example.com', 'ops-leads@example.com'] }],
  },
  {
    gk: GK.github, kind: KINDS.push,
    title: 'Push 3 commits to branch fix/eta-cache-key',
    description: 'Pushes the ETA cache fix and its tests.',
    fields: [{ label: 'Commits', kind: 'list', items: ['a41c9e2 Key ETA cache by booking and carrier', '7be03f1 Add regression test for carrier swap', 'c09d2aa Update changelog'] }],
  },
  {
    gk: GK.inferops, kind: KINDS.assign, autoApprovable: true, complete: true,
    title: 'Assign OPS-477 “Missing commercial invoice for PO 88213” to Priya Natarajan',
    description: 'Sets the assignee on the OPS board.',
  },
  {
    gk: GK.drive, kind: KINDS.createDoc, autoApprovable: true,
    title: 'Create “Weekly carrier scorecard — week 39” in Customer reports',
    description: 'Creates a new Google Doc from the scorecard template.',
    fields: [{ label: 'Attachment', kind: 'file', name: 'scorecard-w39.csv', mediaType: 'text/csv', size: 18_432, origin: 'agent' }],
  },
  {
    gk: GK.github, kind: KINDS.createIssue, autoApprovable: false, complete: true,
    title: 'Open issue “Customs duty calculator rounds EUR values down”',
    description: 'Files a bug with the failing case the agent found while testing the calculator.',
    fields: [{ label: 'Payload', kind: 'json', value: '{\n  "title": "Customs duty calculator rounds EUR values down",\n  "labels": ["bug", "calculator"],\n  "assignees": ["marco-ops"]\n}' }],
  },
]

const OBSERVATIONS = [
  { gk: GK.inferops, title: 'Read the OPS board (42 issues)', description: 'Fetched columns, issues and revisions for board OPS.' },
  { gk: GK.github, title: 'Read issue #1287 and 14 comments', description: 'Fetched the issue thread including linked pull requests.' },
  { gk: GK.calendar, title: 'Listed events for the next 14 days', description: 'Read 23 events from the Ops team calendar.' },
  { gk: GK.slack, title: 'Read the last 50 messages in #ops-internal', description: 'Fetched channel history since Sep 30.' },
  { gk: GK.drive, title: 'Listed files in Customer reports', description: 'Read names and modified dates for 61 files.' },
] as const

const HOOKS = [
  { gk: GK.inferops, title: 'When an OPS issue changes column', description: 'Wakes the tracker gadget so it can refresh its swimlanes.' },
  { gk: GK.slack, title: 'When someone mentions @ops-bot in #ops-internal', description: 'Starts an agent turn to answer the question.' },
  { gk: GK.github, title: 'When a pull request is opened on shipment-portal', description: 'Posts a summary to the review queue gadget.' },
] as const

function actionEntry(id: number, seed: ActionSeed, createdAt: Date, state: ActionLogEntry['state'],
  resolved?: { by?: AiChatAuthorInfo; auto?: boolean; after?: number }): ActionLogEntry {
  return {
    id, ...on(seed.gk), createdAt, state, type: 'action',
    appliedAt: state === 'pending' ? undefined : new Date(createdAt.getTime() + (resolved?.after ?? 4) * 60_000),
    resolvedBy: state === 'pending' ? undefined : resolved?.by ?? world.user,
    autoApproved: resolved?.auto || undefined,
    description: {
      title: seed.title, description: seed.description, fields: seed.fields, implementsRevert: false,
      actionKind: seed.kind, autoApprovable: seed.autoApprovable, descriptionIsComplete: seed.complete,
    },
  }
}

/** The workspace's action log, oldest first by id. Every workspace shares it in the demo. */
function buildLog(): ActionLogEntry[] {
  const log: ActionLogEntry[] = []
  let id = 1
  // A long resolved history spread over the last ~12 days, newest last.
  for (let i = 0; i < 84; i++) {
    const createdAt = minutesAgo(60 * 24 * 12 - i * 200 - (i % 5) * 17)
    const pick = i % 6
    if (pick === 0 || pick === 3) {
      const seed = OBSERVATIONS[i % OBSERVATIONS.length]
      log.push({ id: id++, ...on(seed.gk), createdAt, state: 'approved', type: 'observation',
        description: { title: seed.title, description: seed.description } })
    } else if (pick === 5 && i % 4 === 1) {
      const seed = HOOKS[i % HOOKS.length]
      log.push({ id: id++, ...on(seed.gk), createdAt, state: 'approved', type: 'bindHook',
        description: { title: seed.title, description: seed.description }, hookId: 200 + i, enabled: i % 3 !== 0 })
    } else {
      const seed = ACTIONS[i % ACTIONS.length]
      const state = i % 9 === 4 ? 'rejected' : 'approved'
      const auto = state === 'approved' && seed.autoApprovable && i % 2 === 0
      log.push(actionEntry(id++, seed, createdAt, state, { by: i % 7 === 2 ? sam : world.user, auto, after: auto ? 0 : 3 + (i % 40) }))
    }
  }
  // Pending requests, oldest first.
  const pending = [0, 1, 3, 6, 4]
  pending.forEach((seedIndex, n) => log.push(actionEntry(id++, ACTIONS[seedIndex], minutesAgo(95 - n * 21), 'pending')))
  return log
}

/** Action-log state; scenarios may mutate it (e.g. `activityDemo.log = []`). */
export const activityDemo = {
  log: buildLog(),
  rules: [
    { gatekeeperId: GK.inferops, actionKind: KINDS.assign },
    { gatekeeperId: GK.github, actionKind: KINDS.issueComment },
    { gatekeeperId: GK.slack, actionKind: { tag: 'slack.reaction.add', label: 'Add emoji reactions' } },
  ] as Array<{ gatekeeperId: number; actionKind: ActionKind }>,
  /** 'loading' never answers the pending query; 'error' rejects it. */
  pending: 'ok' as 'ok' | 'loading' | 'error',
}

const PAGE_SIZE = 25
const subscribers = new Set<RpcStub<ActionsSubscriber>>()

function publish(record: ActionLogEntry) {
  for (const subscriber of subscribers) {
    subscriber.entry(structuredClone(record)).catch(() => subscribers.delete(subscriber))
  }
}

function resolve(id: number, state: 'approved' | 'rejected', auto = false) {
  const record = activityDemo.log.find(r => r.id === id)
  if (!record || record.type !== 'action' || record.state !== 'pending') throw new Error(`Demo: action ${id} is not pending`)
  Object.assign(record, { state, appliedAt: new Date(), resolvedBy: world.user, autoApproved: auto || undefined })
  publish(record)
}

const hasRule = (gatekeeperId: number, tag: string) =>
  activityDemo.rules.some(r => r.gatekeeperId === gatekeeperId && r.actionKind.tag === tag)

provide('Overseer', {
  listActions(options) {
    const filter: ActionHistoryFilter = options?.filter ?? 'all'
    if (filter === 'pending' && activityDemo.pending === 'loading') return forever()
    if (filter === 'pending' && activityDemo.pending === 'error') throw new Error('Demo: could not list pending actions')
    const matching = activityDemo.log
      .filter(r => matchesActionHistoryFilter(r, filter) && (options?.beforeId === undefined || r.id < options.beforeId))
      .toSorted((a, b) => b.id - a.id)
    const entries = matching.slice(0, PAGE_SIZE)
    return { entries, nextBeforeId: matching.length > PAGE_SIZE ? entries.at(-1)!.id : undefined }
  },
  approveAction(id) { resolve(id, 'approved') },
  rejectAction(id) { resolve(id, 'rejected') },
  subscribeToActions(subscriber) {
    const kept = subscriber.dup()
    subscribers.add(kept)
    return new (class extends RpcTarget {
      [Symbol.dispose]() {
        subscribers.delete(kept)
        kept[Symbol.dispose]()
      }
    })() as never
  },
  setAutoApprovedActionKind(gatekeeperId, actionKind) {
    if (!hasRule(gatekeeperId, actionKind.tag)) activityDemo.rules.push({ gatekeeperId, actionKind })
    for (const record of activityDemo.log) {
      if (record.type === 'action' && record.state === 'pending' && record.gatekeeperId === gatekeeperId &&
        record.description.actionKind?.tag === actionKind.tag && record.description.autoApprovable) {
        resolve(record.id, 'approved', true)
      }
    }
  },
  removeAutoApprovedActionKind(gatekeeperId, tag) {
    activityDemo.rules = activityDemo.rules.filter(r => !(r.gatekeeperId === gatekeeperId && r.actionKind.tag === tag))
  },
  listAutoApprovedActionKinds: () => structuredClone(activityDemo.rules),
  listPreApprovableActions() {
    const offered: PreApprovableAction[] = []
    for (const seed of ACTIONS) {
      if (!seed.kind || !seed.autoApprovable || offered.some(o => o.gatekeeperId === seed.gk && o.actionKind.tag === seed.kind!.tag)) continue
      offered.push({
        gatekeeperId: seed.gk, resourceTitle: RESOURCES[seed.gk].title, actionKind: seed.kind,
        alreadyEnabled: hasRule(seed.gk, seed.kind.tag), vendorId: RESOURCES[seed.gk].vendorId,
      })
    }
    return offered
  },
})

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

const ADMIN = '/admin'
const tab = (label: string): DemoStep[] => [{ wait: 'h1' }, { click: `text=${label}` }]
// Focusing a field scrolls its card into view; typing its saved value leaves it unchanged.
const scrollTo = (selector: string, value: () => string): DemoStep[] => [{ wait: selector }, { type: value(), into: selector }]

const BANNER_FIELD = 'textarea[placeholder^="e.g. 🎉"]'
const NOTICE_FIELD = 'textarea[placeholder^="e.g. Heads up"]'
const INSTRUCTIONS_FIELD = 'textarea[placeholder^="e.g. ACME"]'

const withBranding = () => {
  Object.assign(world.serverConfig, {
    siteName: 'ACME Ops Studio',
    siteLogo: DEMO_SITE_LOGO,
    accentColor: '#0f766e',
  })
}
const withBanner = () => {
  Object.assign(world.serverConfig, {
    banner: '**Scheduled maintenance** Saturday 04:00–06:00 UTC: workspaces will be read-only. [Status page](https://status.example.com)',
    bannerColor: 'warning',
    announcement: 'New: Kanban boards now sync with InferOps. [Learn more](https://example.com/kanban)',
  })
}

// Activity is opened from the workspace top bar's notifications popover.
const WORKSPACE = '/workspace/ws-ops'
const ACTIVITY_BUTTON = 'button[aria-label^="Activity"]'
const openActivity: DemoStep[] = [
  { click: ACTIVITY_BUTTON },
  { click: 'text=View all 5 requests' },
]
const openActivityEmpty: DemoStep[] = [{ click: ACTIVITY_BUTTON }, { click: 'text=View all activity' }]
const noPending = () => { activityDemo.log = activityDemo.log.filter(r => r.state !== 'pending') }

scenario({
  // Admin page
  'admin.state.loading': { path: ADMIN, setup: () => { adminDemo.settings = 'loading' } },
  'admin.state.error': { path: ADMIN, setup: () => { adminDemo.settings = 'error' } },
  'admin.state.no-access': { path: ADMIN, setup: w => { w.isAdmin = false } },
  'admin.general.logo': { path: ADMIN, setup: withBranding },
  'admin.general.theme': { path: ADMIN, setup: withBranding, steps: [{ wait: 'h1' }, { click: 'text=Purple' }] },
  'admin.general.banner': { path: ADMIN, setup: withBanner, steps: scrollTo(BANNER_FIELD, () => world.serverConfig.banner) },
  'admin.general.top-bar-notice': { path: ADMIN, setup: withBanner, steps: scrollTo(NOTICE_FIELD, () => world.serverConfig.announcement) },
  'admin.general.agent-instructions': { path: ADMIN, steps: scrollTo(INSTRUCTIONS_FIELD, () => adminDemo.instanceInstructions) },
  'admin.toast': {
    path: ADMIN,
    steps: [{ type: 'ACME Ops Studio', into: `input[placeholder="${DEFAULT_SITE_NAME}"]` }, { click: 'text=Save' }],
  },
  'admin.gatekeepers': { path: ADMIN, steps: tab('Gatekeepers') },
  'admin.gatekeepers.ambient-mode': { path: ADMIN, steps: tab('Gatekeepers') },
  'admin.gatekeepers.vendor': { path: ADMIN, steps: [...tab('Gatekeepers'), { wait: 'h3' }] },
  'admin.formats': { path: ADMIN, steps: tab('Formats') },
  'admin.formats.preview-strip': { path: ADMIN, steps: tab('Formats') },
  'admin.formats.empty': { path: ADMIN, setup: () => { adminDemo.formats = [] }, steps: tab('Formats') },
  'admin.formats.row': { path: ADMIN, steps: [...tab('Formats'), { click: 'button[aria-expanded="false"]' }] },
  'admin.formats.icon-picker': {
    path: ADMIN,
    steps: [...tab('Formats'), { click: 'button[aria-expanded="false"]' }, { click: 'text=Choose icon' }],
  },
  'admin.formats.promote-menu': { path: ADMIN, steps: [...tab('Formats'), { click: 'text=Promote a blueprint' }] },
  'admin.access': { path: ADMIN, steps: tab('Access') },

  // Activity pane (in the workspace editor's right pane)
  activity: { path: WORKSPACE, steps: openActivity },
  'activity.review': { path: WORKSPACE, steps: [...openActivity, { click: 'article button[aria-expanded="false"]' }] },
  'activity.auto-approve-dialog': { path: WORKSPACE, steps: [...openActivity, { click: 'text=Always approve' }] },
  'activity.auto-approval': { path: WORKSPACE, steps: [...openActivity, { click: 'text=Auto-approval' }] },
  'activity.history': { path: WORKSPACE, setup: noPending, steps: openActivityEmpty },
  'activity.review.empty': { path: WORKSPACE, setup: noPending, steps: [...openActivityEmpty, { click: 'text=Needs review' }] },
  'activity.notifications-popover': { path: WORKSPACE, steps: [{ click: ACTIVITY_BUTTON }] },

  // Theme surfaces
  'theme.dark-mode': { path: WORKSPACE, localStorage: { 'gadgets:theme-mode': 'dark' } },
  'theme.announcement-banner': {
    path: '/workspaces',
    setup: withBanner,
    localStorage: { dismissedBanner: '' },
  },
  'theme.admin-branding': {
    path: '/workspaces',
    setup: w => { withBranding(); w.serverConfig.displayDensity = 'compact'; w.serverConfig.defaultTheme = 'light' },
  },
})
