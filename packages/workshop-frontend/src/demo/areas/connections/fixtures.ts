// Fixture data for the connections area: vendor catalog, connected accounts, workspace
// gatekeepers, bindings and hooks. Mutable on purpose: scenarios and the fixture methods change it.

import type {
  BoundHookInfo,
  GadgetBindingInfo,
  GatekeeperCreationSpec,
  ObserverBindingNeed,
} from '@gadgets/workshop-shared/api'
import type {
  AccountDescription,
  AvatarImage,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from '@gadgets/workshop-shared/gatekeeper'

// Real vendor logos, read from the gatekeeper packages (committed SVGs).
const logoFiles = import.meta.glob<string>('../../../../../gatekeeper-*/src/*-logo.svg', {
  query: '?raw', import: 'default', eager: true,
})
const svgUrl = (svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`
function logo(name: string): AvatarImage | undefined {
  const entry = Object.entries(logoFiles).find(([path]) => path.endsWith(`/${name}-logo.svg`))
  return entry ? { url: svgUrl(entry[1]) } : undefined
}
const glyph = (path: string, color = 'currentColor'): AvatarImage => ({
  url: svgUrl(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='${color}'><path d='${path}'/></svg>`),
})

const CLOUDFLARE_LOGO: AvatarImage = {
  url: svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 209.51 94.74"><path fill="#f4801f" d="M143.05,93.42l1.07-3.71c1.27-4.41.8-8.48-1.34-11.48-2-2.76-5.26-4.38-9.25-4.57L58,72.7a1.47,1.47,0,0,1-1.35-2,2,2,0,0,1,1.75-1.34l76.26-1c9-.41,18.84-7.750,22.27-16.71l4.34-11.36a2.680,2.680,0,0,0,.18-1,3.310,3.310,0,0,0-.06-.54,49.67,49.67,0,0,0-95.49-5.14,22.35,22.35,0,0,0-35,23.42A31.73,31.73,0,0,0,.34,93.45a1.47,1.47,0,0,0,1.45,1.27l139.49,0h0A1.83,1.83,0,0,0,143.05,93.42Z"/><path fill="#f9ab41" d="M168.22,41.15q-1,0-2.1.06a.88.88,0,0,0-.32.07,1.17,1.17,0,0,0-.76.8l-3,10.26c-1.28,4.41-.81,8.48,1.34,11.48a11.65,11.65,0,0,0,9.24,4.57l16.11,1a1.44,1.44,0,0,1,1.14.62,1.5,1.5,0,0,1,.17,1.37,2,2,0,0,1-1.75,1.34l-16.73,1c-9.090.42-18.88,7.75-22.31,16.7l-1.21,3.16a.9.9,0,0,0,.79,1.22h57.63A1.550,1.550,0,0,0,208,93.63a41.34,41.34,0,0,0-39.76-52.48Z"/></svg>`),
}
const INFEROPS_ICON = glyph('M216,48H40A16,16,0,0,0,24,64V192a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V64A16,16,0,0,0,216,48ZM40,64H88V192H40Zm64,0h48V160H104Zm112,128H168V64h48V192Z')
const LIBRARY_ICON = glyph('M232,48H160a40,40,0,0,0-32,16A40,40,0,0,0,96,48H24a8,8,0,0,0-8,8V200a8,8,0,0,0,8,8H96a24,24,0,0,1,24,24,8,8,0,0,0,16,0,24,24,0,0,1,24-24h72a8,8,0,0,0,8-8V56A8,8,0,0,0,232,48ZM96,192H32V64H96a24,24,0,0,1,24,24V200A39.81,39.81,0,0,0,96,192Zm128,0H160a39.81,39.81,0,0,0-24,8V88a24,24,0,0,1,24-24h64Z')
const SCHEDULER_ICON = glyph('M128 24a104 104 0 1 0 104 104A104.11 104.11 0 0 0 128 24Zm0 192a88 88 0 1 1 88-88 88.1 88.1 0 0 1-88 88Zm40-88a8 8 0 0 1-8 8h-32a8 8 0 0 1-8-8V80a8 8 0 0 1 16 0v40h24a8 8 0 0 1 8 8Z')

/** A round initials avatar, for connected-account fixtures. */
export function initialsAvatar(name: string, background: string): AvatarImage {
  const initials = name.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map(part => part[0]!.toUpperCase()).join('')
  return {
    url: svgUrl(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><circle cx='32' cy='32' r='32' fill='${background}'/><text x='32' y='41' font-family='system-ui,sans-serif' font-size='24' font-weight='600' text-anchor='middle' fill='white'>${initials}</text></svg>`),
  }
}

export type DemoVendor = {
  id: string
  description: VendorDescription
  supportedResources: SupportedResource[]
  /** Listed by listGatekeeperVendors with `unavailable` (a failing gatekeeper worker). */
  unavailable?: boolean
}

const res = (urlPattern: string, title: string, description: string, grantable?: boolean): SupportedResource =>
  ({ urlPattern, title, description, ...(grantable ? { grantable } : {}) })

export const GITHUB_REPO = 'https://github.com/:owner/:repo'
export const GOOGLE_PATTERNS = {
  gmail: 'https://mail.google.com/mail/u/:email',
  doc: 'https://docs.google.com/document/d/:documentId{/*}?',
  sheet: 'https://docs.google.com/spreadsheets/d/:spreadsheetId{/*}?',
  drive: 'https://drive.google.com/drive/folders/:folderId',
  calendar: 'https://calendar.google.com/calendar/u/0/r?cid=:calendarId',
}
export const INFEROPS_BOARD = 'inferops://*/project/board/*'

/** The deployment's gatekeepers, in the order the backend lists them. */
export function createVendors(): DemoVendor[] {
  return [
    { id: 'github', description: {
      displayName: 'GitHub', url: 'https://github.com', logo: logo('github'), color: '#f0f0f0',
      tagline: 'Triage issues, review PRs, and manage repos',
      description: 'Connect your GitHub account so Cloudflare OS can read and update issues, pull requests, and reviews on the repositories you choose.',
      providesAuth: true,
    }, supportedResources: [
      res(GITHUB_REPO, 'GitHub Repository', 'Read and manage issues, pull requests, reviews, and discussions in a GitHub repository.'),
      res('https://github.com/:owner/:repo/issues/:number', 'GitHub Issue', 'Read and manage a specific GitHub issue.'),
      res('https://github.com/:owner/:repo/pull/:number', 'GitHub Pull Request', 'Read and manage a specific GitHub pull request and its review threads.'),
    ] },
    { id: 'google', description: {
      displayName: 'Google', url: 'https://google.com', logo: logo('google'), color: '#e8f0fe',
      tagline: 'Draft replies, edit docs, read sheets, search Drive, manage calendars, post to Chat, and analyze data',
      description: 'Connect your Google account to give Cloudflare OS access to Gmail, Google Docs, Google Sheets, Google Drive, Google Calendar, Google Chat, and BigQuery. Build agents that triage email, draft and edit documents, read spreadsheets, or find focus time.',
      providesAuth: true,
    }, supportedResources: [
      res(GOOGLE_PATTERNS.gmail, 'Gmail Mailbox', 'Read, label, and draft replies to email in one mailbox.', true),
      res(GOOGLE_PATTERNS.doc, 'Google Doc', 'Read and edit a single Google Doc, including its tabs.', true),
      res(GOOGLE_PATTERNS.sheet, 'Google Sheets', 'Read and update cells, ranges, and tabs of one spreadsheet.', true),
      res(GOOGLE_PATTERNS.drive, 'Google Drive Folder', 'Search and read files in one Drive folder and its subfolders.', true),
      res(GOOGLE_PATTERNS.calendar, 'Google Calendar', 'Read events, check availability, and schedule meetings on one calendar.', true),
    ] },
    { id: 'slack', description: {
      displayName: 'Slack', url: 'https://slack.com', logo: logo('slack'), color: '#f4ede4',
      tagline: 'Read channels, DMs, and threads',
      description: 'Connect your Slack account to give Cloudflare OS read-only access to the workspaces, channels, direct messages, and threads you can see.',
    }, supportedResources: [
      res('https://*', 'Slack Workspace', 'Read channels, direct messages, members, and search across the whole connected workspace.', true),
      res('https://app.slack.com/client/:teamId/:conversationId', 'Slack Conversation', 'Read a single channel, direct message, or group DM.', true),
      res('https://*.slack.com/archives/:conversationId/:messageId', 'Slack Thread', 'Read a single message thread and its replies.', true),
    ] },
    { id: 'linear', description: {
      displayName: 'Linear', url: 'https://linear.app', logo: logo('linear'), color: '#f4f5f8',
      tagline: 'Triage, create, and update issues',
      description: 'Connect your Linear account so Cloudflare OS can read and manage issues, projects, and comments across the teams you choose.',
    }, supportedResources: [
      res('https://linear.app/:workspace', 'Linear Workspace', 'Read and manage every team and issue in a Linear workspace. This is the broadest option.'),
      res('https://linear.app/:workspace/team/:teamKey{/:rest}*', 'Linear Team', 'Read and manage the issues, labels, states, and cycles of a single Linear team.'),
      res('https://linear.app/:workspace/issue/:issueId{/:rest}*', 'Linear Issue', 'Read and manage a single Linear issue and its comments.'),
    ] },
    { id: 'notion', description: {
      displayName: 'Notion', url: 'https://www.notion.so', logo: logo('notion'), color: '#f7f6f3',
      tagline: 'Read and write your Notion pages and databases',
      description: 'Connect your Notion workspace to let Cloudflare OS search, read, and edit the pages and databases you share.',
    }, supportedResources: [
      res('https://*', 'Notion Workspace', 'Search, read, and edit any page or database shared with this connection.'),
      res('https://www.notion.so/:path+', 'Notion Page or Database', 'Read and edit a specific Notion page or database (and its rows).'),
    ] },
    { id: 'cloudflare', description: {
      displayName: 'Cloudflare', url: 'https://cloudflare.com', logo: CLOUDFLARE_LOGO, color: '#fbece0',
      tagline: 'Sign in, use AI Gateway, and inspect Workers Observability',
      description: 'Sign in with your Cloudflare account and use your own AI Gateway credits for usage beyond the free tier. You can also connect Workers Observability to inspect logs, invocations, traces, and metrics.',
      providesAuth: true,
    }, supportedResources: [
      res('https://dash.cloudflare.com/:accountId/observability', 'Cloudflare account observability', 'Query logs, invocations, and traces across every Worker in one account.', true),
      res('https://dash.cloudflare.com/:accountId/workers/services/view/:worker', 'Cloudflare Worker observability', 'Query logs and invocations for a single Worker.', true),
    ] },
    { id: 'confluence', description: {
      displayName: 'Confluence', url: 'https://www.atlassian.com/software/confluence', logo: logo('confluence'), color: '#e9f2ff',
      tagline: 'Read and write your Confluence pages and spaces',
      description: 'Connect your Atlassian account to read and edit Confluence pages and spaces you can access.',
    }, supportedResources: [
      res('https://:site.atlassian.net/wiki/spaces/:spaceKey', 'Confluence Space', 'Read and edit the pages in one Confluence space.'),
    ] },
    { id: 'supabase', description: {
      displayName: 'Supabase', url: 'https://supabase.com', logo: logo('supabase'), color: '#e9f7ef',
      tagline: 'Query Postgres, inspect schema, and manage projects',
      description: 'Connect Supabase to query your Postgres databases, inspect schemas, and manage projects.',
    }, supportedResources: [
      res('https://supabase.com/dashboard/project/:ref', 'Supabase Project', 'Run SQL and inspect the schema of one project.'),
    ] },
    { id: 'email', description: {
      displayName: 'Email', url: 'https://demo.example.com', logo: logo('email'), color: '#fff5df',
      tagline: 'Trigger gadgets from incoming email',
      description: 'Give Cloudflare OS an email address it can receive messages from. Useful for triage agents, ticket-from-email workflows, or anything driven by mail.',
    }, supportedResources: [
      res('mailto:*', 'Email Mailbox', 'Receive messages sent to a dedicated address.'),
    ] },
    { id: 'zoominfo', description: {
      displayName: 'ZoomInfo', url: 'https://www.zoominfo.com', logo: logo('zoominfo'), color: '#EE3524',
      tagline: 'Search and enrich B2B company & contact intelligence',
      description: 'Search companies and contacts and enrich records with ZoomInfo data.',
    }, supportedResources: [res('https://*', 'ZoomInfo Account', 'Search and enrich companies and contacts.')] },
    { id: 'inferops', description: {
      displayName: 'InferOps', url: 'https://github.com/factory-level/inferops', logo: INFEROPS_ICON,
      tagline: 'Read project boards and propose issue moves',
      description: 'Gives Gadgets access to one InferOps project board at a time: read its issues and propose moving them between workflow states, each move approved by you. This deployment serves demo data, not a live InferOps workspace.',
      autoProvisionsAccount: true, providesAuth: false,
    }, supportedResources: [
      res(INFEROPS_BOARD, 'InferOps project board', "Read one InferOps project's board and propose moving its issues between workflow states."),
    ] },
    { id: 'context', description: {
      displayName: 'Context', url: 'https://workers.cloudflare.com/', logo: LIBRARY_ICON,
      tagline: 'Author and consult shared context collections',
      description: 'The Context Library lets you and your team author collections of context documents that agents can consult to learn how to perform tasks. It is always available — no connection needed.',
      autoProvisionsAccount: true, providesAuth: false,
    }, supportedResources: [] },
    { id: 'scheduler', description: {
      displayName: 'Scheduled Tasks', url: 'https://workers.cloudflare.com/', logo: SCHEDULER_ICON,
      tagline: 'Run workspace tasks on a schedule',
      description: 'Register recurring and one-shot workspace tasks.',
      autoProvisionsAccount: true, providesAuth: false,
    }, supportedResources: [] },
  ]
}

export type DemoAccount = {
  id: number
  vendorId: string
  description: AccountDescription
  credentialsValid: boolean
}

export function createAccounts(): DemoAccount[] {
  return [
    { id: 1, vendorId: 'github', credentialsValid: true, description: {
      displayName: 'Dana Demo', uniqueName: 'dana-demo', avatar: initialsAvatar('Dana Demo', '#24292f') } },
    { id: 2, vendorId: 'google', credentialsValid: true, description: {
      displayName: 'Dana Demo', uniqueName: 'dana@example.com', avatar: initialsAvatar('Dana Demo', '#1a73e8'),
      grantedResourceUrlPatterns: [GOOGLE_PATTERNS.gmail, GOOGLE_PATTERNS.doc, GOOGLE_PATTERNS.calendar] } },
    { id: 3, vendorId: 'slack', credentialsValid: false, description: {
      displayName: 'Acme Corp', uniqueName: 'acme-corp.slack.com', avatar: initialsAvatar('Acme Corp', '#4a154b') } },
    { id: 4, vendorId: 'linear', credentialsValid: true, description: {
      displayName: 'Factory Level', uniqueName: 'dana@factorylevel.dev', avatar: initialsAvatar('Factory Level', '#5e6ad2') } },
    { id: 5, vendorId: 'github', credentialsValid: true, description: {
      displayName: 'Factory Level Release Bot', uniqueName: 'factory-level-release-bot', avatar: initialsAvatar('Release Bot', '#6e7781') } },
    { id: 6, vendorId: 'inferops', credentialsValid: true, description: {
      displayName: 'InferOps demo workspace', uniqueName: 'demo.local', avatar: INFEROPS_ICON } },
    { id: 7, vendorId: 'context', credentialsValid: true, description: {
      displayName: 'Context Library', avatar: LIBRARY_ICON, singleton: { tsType: 'ContextSession' },
      providesUi: { title: 'Context & Skills', icon: LIBRARY_ICON } } },
  ]
}

export type DemoGatekeeper = {
  title: string
  spec: GatekeeperCreationSpec
  description: ResourceDescription
}

const describe = (url: string, title: string, snippet: string, suggestedBindingName: string, tsType: string, hookTsType?: string): ResourceDescription =>
  ({ url, title, snippet, suggestedBindingName, tsType, ...(hookTsType ? { hookTsType } : {}) })

/** Gatekeepers (connections) in the open workspace, by workpiece id. */
export function createGatekeepers(): Map<number, DemoGatekeeper> {
  return new Map<number, DemoGatekeeper>([
    [11, { title: 'DEMO project board', spec: { type: 'gatekeeper', vendorId: 'inferops', resourceUrl: 'inferops://demo.local/project/board/DEMO', typeUrlPattern: INFEROPS_BOARD },
      description: describe('inferops://demo.local/project/board/DEMO', 'DEMO project board', '24 issues across Backlog, In Progress, Review and Done', 'BOARD', 'InferOpsBoard') }],
    [12, { title: 'factory-level/inferos', spec: { type: 'gatekeeper', vendorId: 'github', resourceUrl: 'https://github.com/factory-level/inferos', typeUrlPattern: GITHUB_REPO },
      description: describe('https://github.com/factory-level/inferos', 'factory-level/inferos', 'Sandboxed agent and Gadget surface for InferOps', 'REPO', 'GitHubRepo', 'GitHubRepoHook') }],
    [13, { title: 'Support inbox (dana@example.com)', spec: { type: 'gatekeeper', vendorId: 'google', resourceUrl: 'https://mail.google.com/mail/u/dana@example.com', typeUrlPattern: GOOGLE_PATTERNS.gmail },
      description: describe('https://mail.google.com/mail/u/dana@example.com', 'Support inbox (dana@example.com)', 'Gmail mailbox', 'INBOX', 'GmailMailbox', 'GmailHook') }],
    [14, { title: '#ops-incidents', spec: { type: 'gatekeeper', vendorId: 'slack', resourceUrl: 'https://app.slack.com/client/T024BE7LD/C05OPSINC', typeUrlPattern: 'https://app.slack.com/client/:teamId/:conversationId' },
      description: describe('https://app.slack.com/client/T024BE7LD/C05OPSINC', '#ops-incidents', 'Slack channel in Acme Corp', 'INCIDENTS_CHANNEL', 'SlackConversation') }],
    [15, { title: 'Claude Sonnet 4.6', spec: { type: 'aiModel', modelId: 'model-sonnet', provider: 'anthropic', modelName: 'claude-sonnet-4-6' },
      description: describe('', 'Claude Sonnet 4.6', 'Anthropic model', 'MODEL', 'AiModel') }],
    [16, { title: 'Ticket triage agent', spec: { type: 'agentSpawner', config: { displayName: 'Ticket triage agent', modelId: 'model-sonnet', env: { BOARD: 11, INBOX: 13 } }, modelProvider: 'anthropic', modelName: 'claude-sonnet-4-6' },
      description: describe('', 'Ticket triage agent', 'Spawns agents with BOARD and INBOX', 'TRIAGE_AGENT', 'AgentSpawner') }],
    [17, { title: 'Weekday standup digest', spec: { type: 'ambient', vendorId: 'scheduler', accountId: 8 },
      description: describe('', 'Scheduled Tasks', 'Workspace schedules', 'SCHEDULER', 'Scheduler') }],
  ])
}

/**
 * The open gadget's bindings, for the workspace area's GadgetClient.listBindings() (the
 * Connections tab). Targets are gatekeeper ids served by getGatekeeperById().
 */
export function createBindings(): GadgetBindingInfo[] {
  return [
    { name: 'BOARD', target: 11, resourceTitle: 'DEMO project board', vendorId: 'inferops' },
    { name: 'REPO', target: 12, resourceTitle: 'factory-level/inferos', vendorId: 'github' },
    { name: 'SUPPORT_INBOX', target: 13, resourceTitle: 'Support inbox (dana@example.com)', vendorId: 'google' },
    { name: 'INCIDENTS_CHANNEL', target: 14, resourceTitle: '#ops-incidents', vendorId: 'slack' },
    { name: 'MODEL', target: 15, resourceTitle: 'Claude Sonnet 4.6' },
    { name: 'TRIAGE_AGENT', target: 16, resourceTitle: 'Ticket triage agent' },
  ]
}

/**
 * Hooks for the open gadget. The Connections tab keeps only hooks whose gadgetId matches the
 * gadget's id, which the workspace area chooses, so each hook is listed for the low ids it may use.
 */
export function createHooks(gadgetIds: number[] = [0, 1, 2, 3]): BoundHookInfo[] {
  const base: Omit<BoundHookInfo, 'id' | 'gadgetId'>[] = [
    { gatekeeperId: 13, resourceTitle: 'Support inbox (dana@example.com)', resourceUrl: 'https://mail.google.com/mail/u/dana@example.com',
      description: { title: 'New email received', description: 'Wakes the gadget when a message arrives in the inbox, so it can file a ticket on the DEMO board.' }, enabled: true },
    { gatekeeperId: 12, resourceTitle: 'factory-level/inferos', resourceUrl: 'https://github.com/factory-level/inferos',
      description: { title: 'Issue opened or labeled', description: 'Delivers new and relabeled issues from the repository.' }, enabled: false },
    { gatekeeperId: 17, resourceTitle: 'Scheduled Tasks',
      description: { title: 'Weekday standup digest', description: 'Every weekday at 09:00 America/Los_Angeles.' }, enabled: true },
  ]
  return gadgetIds.flatMap((gadgetId, g) => base.map((hook, i) => ({ ...hook, id: 100 + g * 10 + i, gadgetId })))
}

/** What a "use" collaborator must verify before opening a shared workspace (ObserverConfigModal). */
export function createObserverNeeds(): ObserverBindingNeed[] {
  return [
    { gatekeeperId: 11, vendorId: 'inferops', resourceTitle: 'DEMO project board', resourceUrl: 'inferops://demo.local/project/board/DEMO' },
    { gatekeeperId: 12, vendorId: 'github', resourceTitle: 'factory-level/inferos', resourceUrl: 'https://github.com/factory-level/inferos' },
    { gatekeeperId: 13, vendorId: 'google', resourceTitle: 'Support inbox (dana@example.com)', resourceUrl: 'https://mail.google.com/mail/u/dana@example.com' },
  ]
}

/** The same needs as a re-prompt after verification failed (ObserverConfigModal retry state). */
export function createObserverRetryNeeds(): ObserverBindingNeed[] {
  return [
    { gatekeeperId: 14, vendorId: 'slack', resourceTitle: '#ops-incidents', resourceUrl: 'https://app.slack.com/client/T024BE7LD/C05OPSINC',
      failure: { accountId: 3, reason: 'Slack rejected the stored token (token_expired). Re-authenticate the account to continue.' } },
    { gatekeeperId: 12, vendorId: 'github', resourceTitle: 'factory-level/inferos', resourceUrl: 'https://github.com/factory-level/inferos',
      failure: { accountId: 5, reason: 'factory-level-release-bot does not have access to factory-level/inferos.' } },
  ]
}

/** Options the resource configurators' autocompletes offer, by configurator RPC method. */
export const configuratorOptions: Record<string, { value: string; title: string; subtitle?: string; meta?: string }[]> = {
  listProjects: [
    { value: 'DEMO', title: 'DEMO — Demo project', subtitle: '24 issues', meta: 'demo.local' },
    { value: 'OPS', title: 'OPS — Platform operations', subtitle: '57 issues', meta: 'demo.local' },
    { value: 'MIND', title: 'MIND — InferMind research', subtitle: '12 issues', meta: 'demo.local' },
  ],
  listRepos: [
    { value: 'factory-level/inferos', title: 'factory-level/inferos', subtitle: 'Sandboxed agent and Gadget surface', meta: 'Private' },
    { value: 'factory-level/inferops', title: 'factory-level/inferops', subtitle: 'Composable monolith', meta: 'Private' },
    { value: 'dana-demo/dotfiles', title: 'dana-demo/dotfiles', meta: 'Public' },
  ],
  listIssues: [
    { value: '412', title: '#412 Board drag-and-drop loses revision on retry', meta: 'open' },
    { value: '398', title: '#398 Gatekeeper modal overflows on small screens', meta: 'open' },
  ],
  listPullRequests: [
    { value: '46', title: '#46 Consumer skill packs', meta: 'merged' },
    { value: '47', title: '#47 Demo mode for every view', meta: 'open' },
  ],
  listTeams: [
    { value: 'ENG', title: 'Engineering', meta: 'ENG' },
    { value: 'OPS', title: 'Operations', meta: 'OPS' },
  ],
  listWorkspaces: [{ value: 'factory-level', title: 'Factory Level' }],
  listDocs: [
    { value: '1AbCdEf', title: 'Q4 launch plan', subtitle: 'Edited 2 hours ago' },
    { value: '1GhIjKl', title: 'Incident review: 2026-09-14', subtitle: 'Edited yesterday' },
  ],
  listSpreadsheets: [
    { value: '1SpReAd', title: 'Support volume by week', subtitle: 'Edited today' },
    { value: '1BuDgEt', title: 'FY27 budget', subtitle: 'Edited last week' },
  ],
  listCalendars: [
    { value: 'dana@example.com', title: 'Dana Demo', subtitle: 'Primary' },
    { value: 'team-ops@example.com', title: 'Ops on-call' },
  ],
}
