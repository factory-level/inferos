// Fixture data for the chat area: models, slash commands and a set of conversations, each built
// to show one family of transcript rows (tool runs, actions, connection requests, compaction,
// errors, streaming...). Mutable: chat.ts appends to these as the demo user sends messages.

import type {
  AiChatAuthorInfo,
  AiChatHistoryPage,
  AiChatMessage,
  AiChatMessageBody,
  AiChatMetadata,
  AiToolCall,
  SlashCommandChoice,
  WorkpieceId,
} from '@gadgets/workshop-shared/api'
import type { CodeChange } from '@gadgets/workshop-shared/code-change'
import { world } from '../../world'

const now = Date.now()
export const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000)

/** Workpiece ids the transcripts refer to. The workspace area's workpiece list should match. */
export const WORKPIECES = {
  /** The workspace's main app gadget. */
  opsApp: 1 as WorkpieceId,
  /** A gadget created (still pending) by the Kanban chat. */
  kanban: 7 as WorkpieceId,
  /** A permanent gadget the metrics chat edited and merged. */
  metrics: 2 as WorkpieceId,
  githubRepo: 11 as WorkpieceId,
  inferopsBoard: 12 as WorkpieceId,
  slackChannel: 13 as WorkpieceId,
  emailInbox: 14 as WorkpieceId,
} as const

export const SAM: AiChatAuthorInfo = { type: 'user', id: 'sam', name: 'Sam Rivera' }
export const MODELS: AiChatAuthorInfo[] = [
  { type: 'agent', id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
  { type: 'agent', id: 'gpt-5.1', name: 'GPT-5.1', billing: 'chatgpt-plan' },
  { type: 'agent', id: 'claude-opus-4-1', name: 'Claude Opus 4.1' },
  { type: 'agent', id: '@cf/moonshotai/kimi-k2-instruct', name: 'Kimi K2 (Workers AI)' },
  { type: 'agent', id: 'mock-scripted', name: 'Scripted mock model', managed: true },
]
const [SONNET, GPT] = MODELS
const EMAIL_GADGET: AiChatAuthorInfo = { type: 'gadget', id: 'demo', name: 'Support inbox triage' }

export const SLASH_COMMANDS: SlashCommandChoice[] = [
  { selection: { builtin: true, commandId: 'compact' }, name: 'compact', providerLabel: 'Workshop',
    description: 'Summarize earlier messages so the agent has room to keep working' },
  { selection: { gatekeeperId: WORKPIECES.githubRepo, commandId: 'triage' }, name: 'triage',
    providerLabel: 'GitHub', resourceLabel: 'factory-level/inferos',
    description: 'Label, deduplicate and prioritize open issues using the repository triage guide' },
  { selection: { gatekeeperId: WORKPIECES.githubRepo, commandId: 'release-notes' }, name: 'release-notes',
    providerLabel: 'GitHub', resourceLabel: 'factory-level/inferos',
    description: 'Draft release notes from merged pull requests since the last tag' },
  { selection: { gatekeeperId: WORKPIECES.inferopsBoard, commandId: 'standup' }, name: 'standup',
    providerLabel: 'InferOps', resourceLabel: 'DEMO board',
    description: 'Summarize what moved on the board since yesterday, grouped by assignee' },
  { selection: { gatekeeperId: WORKPIECES.inferopsBoard, commandId: 'plan-sprint' }, name: 'plan-sprint',
    providerLabel: 'InferOps', resourceLabel: 'DEMO board',
    description: 'Propose a sprint plan from the backlog, respecting WIP limits and estimates' },
  { selection: { gatekeeperId: WORKPIECES.slackChannel, commandId: 'digest' }, name: 'digest',
    providerLabel: 'Slack', resourceLabel: '#ops-alerts',
    description: 'Summarize the channel since you last looked, with links to threads' },
  { selection: { gatekeeperId: WORKPIECES.githubRepo, commandId: 'review' }, name: 'review',
    providerLabel: 'GitHub', resourceLabel: 'factory-level/inferops',
    description: 'Review an open pull request against the repository review bar' },
]

// A small SVG "screenshot" so image attachments render without binary fixtures.
const encoder = new TextEncoder()
export const SCREENSHOT_SVG = encoder.encode(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">
<rect width="640" height="400" fill="#f6f4f1"/><rect x="0" y="0" width="640" height="44" fill="#1f2937"/>
<text x="20" y="28" font-family="sans-serif" font-size="16" fill="#fff">DEMO board</text>
${['Backlog', 'In progress', 'Review', 'Done'].map((col, i) => `<rect x="${16 + i * 156}" y="60" width="144" height="320" rx="10" fill="#e9e5df"/>
<text x="${28 + i * 156}" y="84" font-family="sans-serif" font-size="13" fill="#374151">${col}</text>
${[0, 1, 2].slice(0, 3 - (i % 2)).map(j => `<rect x="${26 + i * 156}" y="${98 + j * 76}" width="124" height="64" rx="8" fill="#fff"/>
<rect x="${36 + i * 156}" y="${110 + j * 76}" width="${60 + ((i + j) % 3) * 18}" height="8" rx="4" fill="#9ca3af"/>
<rect x="${36 + i * 156}" y="${126 + j * 76}" width="80" height="6" rx="3" fill="#d1d5db"/>`).join('')}`).join('')}
</svg>`)
export const CSV_ATTACHMENT = encoder.encode(
  'issue,title,status,assignee,points\nDEMO-101,Sign-in redirect loop,In progress,Sam Rivera,3\n' +
  'DEMO-102,Export board as CSV,Backlog,,2\nDEMO-103,WIP limit per column,Review,Dana Demo,5\n')

type Row = [author: AiChatAuthorInfo, minutesAgo: number, body: AiChatMessageBody]

/** Everything the demo knows about one conversation. */
export interface DemoChat {
  meta: AiChatMetadata
  messages: AiChatMessage[]
  /** History before `compacted.to`, served by getChatHistory(chatId, beforeSequence). */
  compacted?: { to: number; summary: string }
  /** Unsaved human edits replayed through changeApplied() on subscribe. */
  draftRows?: CodeChange[]
}

export const chats = new Map<number, DemoChat>()

function addChat(meta: Omit<AiChatMetadata, 'started' | 'lastActive'>, rows: Row[], extra: Partial<DemoChat> = {}) {
  const messages = rows.map(([author, mins, body], sequence): AiChatMessage =>
    ({ chatId: meta.id, sequence, timestamp: minutesAgo(mins), author, ...body }))
  const started = messages[0]?.timestamp ?? minutesAgo(1)
  const lastActive = messages.at(-1)?.timestamp ?? started
  chats.set(meta.id, { meta: { ...meta, started, lastActive }, messages, ...extra })
}

const me = () => world.user
const tool = (call: AiToolCall) => call
let toolSeq = 0
const id = () => `toolu_demo_${String(++toolSeq).padStart(3, '0')}`

const KANBAN_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>DEMO Kanban</title><link rel="stylesheet" href="./board.css"></head>
  <body><main id="board" aria-live="polite"></main><script type="module" src="./board.ts"></script></body>
</html>
`
const KANBAN_TS = `import type { BoardResponse } from "inferops:project";

const COLUMNS = ["Backlog", "In progress", "Review", "Done"] as const;

export async function render(board: BoardResponse, root: HTMLElement) {
  root.replaceChildren(...COLUMNS.map((name) => {
    const column = document.createElement("section");
    column.className = "column";
    column.append(heading(name, board.issues.filter((i) => i.status === name).length));
    for (const issue of board.issues.filter((i) => i.status === name)) {
      column.append(card(issue));
    }
    return column;
  }));
}
`

// ── 1. The main build conversation: attachments, tool runs, a created gadget, pending changes. ──
addChat({ id: 1, title: 'Add an InferOps Kanban for the DEMO board', proposedChangeWorkpieces: [WORKPIECES.kanban],
  totalTokens: 48_213, totalCost: 0.1832, promptTokens: 212_400, cacheReadTokens: 160_120, cacheWriteTokens: 18_900 }, [
  [me(), 34, { type: 'message',
    message: 'Add a Kanban view of the DEMO board to the canvas — four columns (Backlog, In progress, Review, Done) with WIP limits. ' +
      "Here's roughly what I have in mind, plus the current issue export so you can check the column names.",
    attachments: [
      { id: 'att-board-sketch', name: 'board-sketch.svg', mimeType: 'image/svg+xml', size: SCREENSHOT_SVG.byteLength, content: SCREENSHOT_SVG },
      { id: 'att-issues-csv', name: 'demo-issues-export.csv', mimeType: 'text/csv', size: CSV_ATTACHMENT.byteLength },
    ] }],
  [SONNET, 33, { type: 'message', message: '',
    reasoning: 'The user wants a Kanban for the DEMO board. First check which canvases exist and whether a board ' +
      'composition is already in the catalog, then look at the export to confirm the status names match the board DTO.',
    toolCalls: [
      tool({ toolCallId: id(), toolName: 'listCanvases', input: {},
        output: 'Canvases (1):\n- operations (rev 14): "Operations" — 3 widgets\n\nCatalog:\n- inferops.kanban — Kanban board for an InferOps project board\n- inferops.activity — Agent activity feed' }),
      tool({ toolCallId: id(), toolName: 'grep', input: { workpiece: 'OPS_APP', pattern: 'status ===', path: 'src' },
        output: 'src/widgets/summary.ts:42:  const open = issues.filter((i) => i.status === "In progress");\nsrc/widgets/summary.ts:57:  if (issue.status === "Review") badge.dataset.tone = "warning";' }),
      tool({ toolCallId: id(), toolName: 'readFile', input: { workpiece: 'OPS_APP', filename: 'src/widgets/summary.ts', startLine: 30, lineCount: 40 } }),
    ] }],
  [SONNET, 32, { type: 'action', actionId: 41, actionLog: {
    id: 41, type: 'observation', state: 'approved', gatekeeperId: WORKPIECES.inferopsBoard,
    resourceTitle: 'DEMO board', resourceUrl: 'inferops://demo.local/project/board/DEMO', createdAt: minutesAgo(32), appliedAt: minutesAgo(32),
    description: { title: 'Read board DEMO', description: 'Fetched the board, its 4 columns and 23 issues at revision 1882.',
      fields: [
        { label: 'Columns', kind: 'list', items: ['Backlog (9)', 'In progress (6, WIP 5)', 'Review (3, WIP 3)', 'Done (5)'] },
        { label: 'Revision', kind: 'inline', value: '1882' },
      ] } } }],
  [SONNET, 30, { type: 'message', message: '',
    reasoning: 'Statuses match. I will create a dedicated gadget for the board so the operations canvas can embed it, then bind the board connection into it.',
    toolCalls: [
      tool({ toolCallId: id(), toolName: 'createGadget', input: { title: 'DEMO Kanban', bindingName: 'KANBAN' },
        output: { gadgetId: WORKPIECES.kanban, changeId: 1 } }),
      tool({ toolCallId: id(), toolName: 'writeFile', input: { workpiece: 'KANBAN', filename: 'index.html', content: KANBAN_HTML } }),
      tool({ toolCallId: id(), toolName: 'writeFile', input: { workpiece: 'KANBAN', filename: 'board.ts', content: KANBAN_TS } }),
      tool({ toolCallId: id(), toolName: 'editFile', input: { workpiece: 'KANBAN', filename: 'board.ts',
        textToReplace: 'const COLUMNS = ["Backlog", "In progress", "Review", "Done"] as const;',
        replacement: 'const COLUMNS = ["Backlog", "In progress", "Review", "Done"] as const;\nconst WIP_LIMITS: Partial<Record<typeof COLUMNS[number], number>> = { "In progress": 5, Review: 3 };' } }),
      tool({ toolCallId: id(), toolName: 'setGadgetBinding', input: { gadget: 'KANBAN', source: 'DEMO_BOARD', name: 'BOARD' },
        output: { gadgetId: WORKPIECES.kanban, name: 'BOARD', target: WORKPIECES.inferopsBoard, changeId: 2 } }),
      tool({ toolCallId: id(), toolName: 'executeCode',
        input: { code: 'const board = await env.DEMO_BOARD.getBoard();\nreturn board.columns.map((c) => `${c.name}: ${c.issueIds.length}`);' },
        output: '[\n  "Backlog: 9",\n  "In progress: 6",\n  "Review: 3",\n  "Done: 5"\n]' }),
      tool({ toolCallId: id(), toolName: 'editCanvas', input: { canvasId: 'operations', expectedRevision: '14',
        operations: [{ type: 'addWidget' } as never] },
        output: 'Applied 1 operation. Canvas "operations" is now at revision 15.' }),
    ] }],
  [SONNET, 29, { type: 'changes',
    createdGadgets: [{ gadgetId: WORKPIECES.kanban, title: 'DEMO Kanban', bindingName: 'KANBAN' }],
    addedBindings: [{ gadgetId: WORKPIECES.kanban, name: 'BOARD', target: WORKPIECES.inferopsBoard }],
    change: { [WORKPIECES.kanban]: [['board.ts', { set: KANBAN_TS }], ['index.html', { set: KANBAN_HTML }]] },
    watermark: { changesGeneration: 1, throughRevision: 3 } }],
  [SONNET, 28, { type: 'message',
    reasoning: 'Summarize what changed and call out the WIP-limit behavior, since "In progress" is already over its limit.',
    message: `I added a **DEMO Kanban** gadget and placed it on the *Operations* canvas.

### What's in it
- Four columns read live from \`inferops://demo.local/project/board/DEMO\` — nothing is copied out of InferOps.
- WIP limits: **In progress ≤ 5**, **Review ≤ 3**. Columns over their limit get an amber header.
- Moving a card goes through the board's approve flow, so you'll see an approval card here before anything changes.

| Column | Issues | WIP limit |
| --- | ---: | ---: |
| Backlog | 9 | — |
| In progress | 6 | 5 ⚠️ |
| Review | 3 | 3 |
| Done | 5 | — |

The limits live at the top of \`board.ts\`:

\`\`\`ts
const WIP_LIMITS: Partial<Record<Column, number>> = {
  "In progress": 5,
  Review: 3,
};
\`\`\`

> **Heads-up:** *In progress* is already over its limit (6 / 5), so it renders highlighted right away.

Accept the changes when it looks right, or tell me what to adjust.` }],
  [me(), 20, { type: 'slashCommand', skillName: 'issue-triage',
    request: { id: { gatekeeperId: WORKPIECES.githubRepo, commandId: 'triage' }, args: 'only the ones tagged board-ui', commandPosition: 0 } }],
  [me(), 20, { type: 'message', generatedBySlashCommandSequence: 6,
    message: 'Triage the open issues in factory-level/inferos labelled board-ui using the repository triage guide.' }],
  [SONNET, 18, { type: 'message',
    message: 'Three open **board-ui** issues — two are duplicates of the WIP-limit request this Kanban now covers:\n\n' +
      '1. `#212` *Kanban columns ignore WIP limits* — **fixed by this draft**, I suggest closing once accepted.\n' +
      '2. `#219` *Highlight overloaded columns* — duplicate of #212.\n' +
      '3. `#224` *Drag-and-drop on touch devices* — still open; needs pointer-event handling, estimated **3 points**.' }],
])

// ── 2. GitHub triage: observations, resolved actions, a hook, and a blocking approval. ──
const REPO = { gatekeeperId: WORKPIECES.githubRepo, resourceTitle: 'factory-level/inferos', resourceUrl: 'https://github.com/factory-level/inferos' }
addChat({ id: 2, title: 'Label stale issues in factory-level/inferos', totalTokens: 21_877, totalCost: 0.0641 }, [
  [me(), 95, { type: 'message', message: 'Find issues with no activity for 30 days, label them stale, and close anything older than 90 days. Ping me in a comment before closing.' }],
  [SONNET, 94, { type: 'message', message: '', toolCalls: [
    tool({ toolCallId: id(), toolName: 'describeBinding', input: { name: 'REPO' },
      output: 'REPO: GitHubRepository (factory-level/inferos)\n  listIssues(filter?: IssueFilter): Promise<Issue[]>\n  addLabels(issue: number, labels: string[]): Promise<void>\n  comment(issue: number, body: string): Promise<void>\n  close(issue: number): Promise<void>' }),
    tool({ toolCallId: id(), toolName: 'executeCode', input: { code: 'const issues = await env.REPO.listIssues({ state: "open", updatedBefore: "2026-09-02" });\nreturn issues.map((i) => ({ n: i.number, title: i.title, idle: i.idleDays }));' },
      output: '[\n  { "n": 198, "title": "Gatekeeper retries leak sockets", "idle": 121 },\n  { "n": 204, "title": "Docs: wrangler dev ports", "idle": 47 },\n  { "n": 207, "title": "Flaky canvas snapshot test", "idle": 38 }\n]' }),
  ] }],
  [SONNET, 94, { type: 'action', actionId: 51, actionLog: { id: 51, type: 'observation', state: 'approved', ...REPO,
    createdAt: minutesAgo(94), appliedAt: minutesAgo(94),
    description: { title: 'List open issues', description: 'Listed 3 open issues idle for more than 30 days.',
      fields: [{ label: 'Query', kind: 'inline', value: 'is:open updated:<2026-09-02' }] } } }],
  [SONNET, 93, { type: 'action', actionId: 52, actionLog: { id: 52, type: 'action', state: 'approved', ...REPO,
    createdAt: minutesAgo(93), appliedAt: minutesAgo(90), resolvedBy: world.user,
    description: { title: 'Add label “stale” to 3 issues', description: 'Adds the `stale` label to #198, #204 and #207.', implementsRevert: true,
      fields: [{ label: 'Issues', kind: 'list', items: ['#198 Gatekeeper retries leak sockets', '#204 Docs: wrangler dev ports', '#207 Flaky canvas snapshot test'] }] } } }],
  [SONNET, 92, { type: 'action', actionId: 53, actionLog: { id: 53, type: 'action', state: 'rejected', ...REPO,
    createdAt: minutesAgo(92), appliedAt: minutesAgo(89), resolvedBy: world.user,
    description: { title: 'Close issue #198', description: 'Closes #198 as stale (idle 121 days).', implementsRevert: true } } }],
  [SONNET, 91, { type: 'action', actionId: 54, actionLog: { id: 54, type: 'bindHook', state: 'approved', ...REPO,
    createdAt: minutesAgo(91), hookId: 3, enabled: true,
    description: { title: 'New issue opened', description: 'Wakes the Ops dashboard whenever an issue is opened, so new reports are labelled within a minute.' } } }],
  [SONNET, 89, { type: 'message', message: "Labelled all three as **stale**. You denied closing #198, so I left it open. I also set up a hook so new issues get triaged as they're opened." }],
  [me(), 12, { type: 'message', message: 'Thanks. For #204, leave a comment asking the reporter whether the docs fix in #231 covers it.' }],
  [SONNET, 11, { type: 'message', message: '', toolCalls: [
    tool({ toolCallId: id(), toolName: 'executeCode', input: { code: 'await env.REPO.comment(204, draft);' }, output: 'Waiting for approval…' }),
  ] }],
  [SONNET, 11, { type: 'action', actionId: 55, actionLog: { id: 55, type: 'action', state: 'pending', ...REPO, createdAt: minutesAgo(11),
    description: { title: 'Comment on issue #204', description: 'Posts a comment on **#204 Docs: wrangler dev ports** as you.',
      implementsRevert: false, awaitDecision: true,
      fields: [
        { label: 'Comment', kind: 'text', syntax: 'markdown',
          value: 'Hi @mkaplan — the port table in #231 should cover this (it documents the `offset × 100` shift per worktree).\n\nCould you confirm whether that resolves it? If we don\'t hear back in a week we\'ll close this as stale.' },
        { label: 'Issue', kind: 'inline', value: '#204' },
      ] } } }],
])

// ── 3. Slack digest: a pending, auto-approvable (non-blocking) action. ──
const SLACK = { gatekeeperId: WORKPIECES.slackChannel, resourceTitle: '#ops-alerts', resourceUrl: 'https://factory-level.slack.com/archives/C07OPSALRT' }
addChat({ id: 3, title: 'Post the morning ops digest to #ops-alerts', totalTokens: 9_412, totalCost: 0.0213 }, [
  [me(), 70, { type: 'message', message: 'Every morning, post a short digest of overnight alerts to #ops-alerts.' }],
  [GPT, 69, { type: 'action', actionId: 61, actionLog: { id: 61, type: 'observation', state: 'approved', ...SLACK,
    createdAt: minutesAgo(69), appliedAt: minutesAgo(69),
    description: { title: 'Read channel history', description: 'Read 48 messages posted to #ops-alerts since 18:00 yesterday.' } } }],
  [GPT, 68, { type: 'message', message: "Here's today's digest. I'll post it now — after this one you can let me post these without asking." }],
  [GPT, 68, { type: 'action', actionId: 62, actionLog: { id: 62, type: 'action', state: 'pending', ...SLACK, createdAt: minutesAgo(68),
    description: { title: 'Post message to #ops-alerts', description: 'Posts the overnight digest as the Workshop bot.',
      implementsRevert: true, autoApprovable: true, actionKind: { tag: 'chat.postMessage', label: 'Post messages' },
      fields: [{ label: 'Message', kind: 'text', syntax: 'markdown', value:
        '*Overnight digest — Oct 2*\n• 3 alerts, all resolved\n• `api-gateway` p99 latency spiked to 1.8s at 02:14 (deploy rollback)\n• Disk 85% on `ci-runner-4` — cleaned up by cron' }] } } }],
])

// ── 4. A pending connection request (blocks the composer). ──
addChat({ id: 4, title: 'Show the DEMO board on the operations canvas', totalTokens: 6_120, totalCost: 0.0158 }, [
  [me(), 150, { type: 'message', message: 'Put the DEMO project board on the operations canvas.' }],
  [SONNET, 149, { type: 'message', message: '', toolCalls: [
    tool({ toolCallId: id(), toolName: 'listConnectableResources', input: { vendorId: 'inferops' },
      output: 'inferops resources:\n- Project board — inferops://:host/project/board/:key' }),
    tool({ toolCallId: id(), toolName: 'requestConnection', input: { vendorId: 'inferops', resourceUrl: 'inferops://demo.local/project/board/DEMO',
      reason: 'Read the DEMO board to render it on the canvas', bindingName: 'DEMO_BOARD' }, output: 'Connection requested; waiting for the user.' }),
  ] }],
  [SONNET, 149, { type: 'connectionRequest', requestId: 'req-demo-board', vendorId: 'inferops', vendorName: 'InferOps',
    resourceTitle: 'Project board', resourceUrl: 'inferops://demo.local/project/board/DEMO',
    resourceUrlPattern: 'inferops://:host/project/board/:key', bindingName: 'DEMO_BOARD', state: 'pending',
    reason: "I need read access to the DEMO project board to show its columns and issues on the canvas. I won't move any cards without asking." }],
])

// ── 5. A long, compacted conversation: compaction, model change, merges, reverts, saved edits. ──
const METRICS_SUMMARY = `**Context so far**
- Building a *Weekly metrics* gadget (\`METRICS\`) that charts deploys, incidents and lead time.
- Data comes from the GitHub repo binding (\`REPO\`); the chart uses inline SVG, no external libraries.
- Dana prefers ISO week labels (\`2026-W39\`) and a muted palette.
- Accepted: first chart and CSV export. Reverted: the dark-mode experiment.`
addChat({ id: 5, title: 'Weekly metrics rollup', totalTokens: 31_004, totalCost: 0.4127 }, [
  [me(), 60 * 26, { type: 'message', message: 'Build a weekly metrics gadget: deploys, incidents and lead time per ISO week.' }],
  [SONNET, 60 * 26 - 2, { type: 'message', message: 'Created the **Weekly metrics** gadget with a bar chart per week.', toolCalls: [
    tool({ toolCallId: id(), toolName: 'writeFile', input: { workpiece: 'METRICS', filename: 'chart.ts', content: '// chart' } }),
  ] }],
  [SONNET, 60 * 26 - 2, { type: 'changes', change: { [WORKPIECES.metrics]: [['chart.ts', { set: '// chart\n' }]] },
    pins: [{ gadgetId: WORKPIECES.metrics, baseCommit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' }] }],
  [me(), 60 * 25, { type: 'merge', mergeThrough: 2, epochBoundary: true,
    commits: [{ gadgetId: WORKPIECES.metrics, commitId: 'b2c3d4e5f60718293a4b5c6d7e8f901234567890' }] }],
  [me(), 60 * 25, { type: 'message', message: 'Try a dark mode variant?' }],
  [SONNET, 60 * 25 - 1, { type: 'message', message: 'Added a dark palette behind `prefers-color-scheme`.' }],
  [SONNET, 60 * 25 - 1, { type: 'changes', change: { [WORKPIECES.metrics]: [['theme.css', { set: ':root { color-scheme: dark; }\n' }]] },
    pins: [{ gadgetId: WORKPIECES.metrics, baseCommit: 'b2c3d4e5f60718293a4b5c6d7e8f901234567890' }] }],
  [me(), 60 * 24, { type: 'revert', revertFrom: 6 }],
  [me(), 60 * 3, { type: 'slashCommand', request: { id: { builtin: true, commandId: 'compact' }, args: '' } }],
  [me(), 60 * 2, { type: 'message', message: 'Switching to GPT-5.1 for this part — add a lead-time trend line and a CSV export.' }],
  [GPT, 60 * 2 - 1, { type: 'message', message: '', toolCalls: [
    tool({ toolCallId: id(), toolName: 'readFile', input: { workpiece: 'METRICS', filename: 'chart.ts' } }),
    tool({ toolCallId: id(), toolName: 'editFile', input: { workpiece: 'METRICS', filename: 'chart.ts', textToReplace: '// chart', replacement: '// chart with trend line' } }),
  ] }],
  [GPT, 60 * 2 - 1, { type: 'useGadget' }],
  [GPT, 60 * 2 - 2, { type: 'message', message: 'Added a 4-week moving average for lead time (dashed line) and an **Export CSV** button in the header.' }],
  [me(), 50, { type: 'changes', change: { [WORKPIECES.metrics]: [['chart.ts', { set: '// chart with trend line, tweaked by hand\n' }]] },
    pins: [{ gadgetId: WORKPIECES.metrics, baseCommit: 'b2c3d4e5f60718293a4b5c6d7e8f901234567890' }] }],
  [me(), 49, { type: 'message', message: 'I nudged the axis labels by hand. Looks good now.' }],
], { compacted: { to: 8, summary: METRICS_SUMMARY } })
chats.get(5)!.meta.proposedChangeWorkpieces = [WORKPIECES.metrics]
chats.get(5)!.meta.compactedTo = 8

// ── 6. Started by an agent spawner: agent callbacks from a gadget. ──
addChat({ id: 6, title: 'Reply to: Q3 invoice question', spawnerName: 'Support inbox triage', totalTokens: 4_980, totalCost: 0.0094 }, [
  [EMAIL_GADGET, 45, { type: 'message', message: 'New email from **jordan@northwind.example** — "Q3 invoice shows 14 seats, we have 12". Draft a reply and flag it for billing.' }],
  [EMAIL_GADGET, 45, { type: 'agentCallback', methodName: 'handleEmail', bindingName: 'EMAIL',
    argsSummary: '{ from: "jordan@northwind.example", subject: "Q3 invoice shows 14 seats", thread: EmailThread(3 messages) }' }],
  [SONNET, 44, { type: 'message', message: "I drafted a reply confirming we'll review the seat count and flagged the thread for billing. The draft is waiting in the inbox for a human to send." }],
  [EMAIL_GADGET, 8, { type: 'agentCallback', methodName: 'followUp', bindingName: 'EMAIL',
    argsSummary: '{ thread: EmailThread(4 messages), reason: "customer replied" }' }],
])

// ── 7. Failures: a failing tool call and a model error. ──
addChat({ id: 7, title: 'Fix the CSV export crash', totalTokens: 12_330, totalCost: 0.0377 }, [
  [me(), 200, { type: 'message', message: 'Exporting the board as CSV crashes when an issue has no assignee. Can you fix it?' }],
  [SONNET, 199, { type: 'message', message: '', toolCalls: [
    tool({ toolCallId: id(), toolName: 'readFile', input: { workpiece: 'OPS_APP', filename: 'src/export.ts' } }),
    tool({ toolCallId: id(), toolName: 'executeCode', input: { code: 'const rows = await env.OPS_APP.exportCsv({ board: "DEMO" });\nreturn rows.slice(0, 3);' },
      error: "TypeError: Cannot read properties of null (reading 'name')\n    at toRow (src/export.ts:18:34)\n    at Array.map (<anonymous>)\n    at exportCsv (src/export.ts:9:22)" }),
    tool({ toolCallId: id(), toolName: 'webFetch', input: { url: 'https://inferops.example/docs/api/board#assignee' },
      error: 'Fetch failed: 503 Service Unavailable' }),
  ] }],
  [SONNET, 198, { type: 'message', message: 'Found it: `toRow` reads `issue.assignee.name` without checking for unassigned issues. Patching it now.' }],
  [SONNET, 197, { type: 'error', message: 'Model request failed: 529 Overloaded — the provider is temporarily over capacity. Your conversation is saved; retry in a moment.\n\nanthropic: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' }],
])

// ── 8. Out of credits (the modal opens on its own). ──
addChat({ id: 8, title: 'Summarize last week’s incidents', totalTokens: 2_310 }, [
  [me(), 60 * 30, { type: 'message', message: 'Summarize last week’s incidents for the Monday review.' }],
  [{ ...MODELS[3] }, 60 * 30 - 1, { type: 'error', code: 'usage_limit',
    message: 'You have used all of your included Workers AI usage for today. Connect a Cloudflare account or add credits to continue.' }],
])

// ── 9. An agent mid-turn (chat.ts streams its reply). ──
addChat({ id: 9, title: 'Restyle the dashboard header', activeAgent: SONNET, totalTokens: 15_870, totalCost: 0.0512 }, [
  [me(), 3, { type: 'message', message: 'Make the dashboard header sticky and give it a subtle bottom border. Keep the workspace switcher on the left.' }],
])

// ── 10. Unsaved human edits (live draft rows). ──
addChat({ id: 10, title: 'Tweak card spacing by hand', proposedChangeWorkpieces: [WORKPIECES.kanban], totalTokens: 3_002 }, [
  [me(), 25, { type: 'message', message: "I'm adjusting the card padding myself — just checking in with you after." }],
  [SONNET, 24, { type: 'message', message: 'Sounds good. Save the draft when you are done and I can review the CSS.' }],
], { draftRows: [{ [WORKPIECES.kanban]: [['board.css', { set: '.card {\n  padding: 10px 12px;\n  border-radius: 10px;\n}\n' }]] }] })

// ── Older conversations, so the list has every time bucket and both scopes. ──
const filler: [number, string, number, AiChatAuthorInfo, string?][] = [
  [11, 'Sam: can we pin the incident widget above the fold?', 60 * 6, SAM],
  [12, 'Draft release notes for v0.14', 60 * 30, world.user],
  [13, 'Investigate the 02:14 latency spike', 60 * 52, world.user],
  [14, 'Nightly backlog grooming', 60 * 50, EMAIL_GADGET, 'Backlog groomer'],
  [15, 'Rename widgets to match the InferOps glossary and update every reference in the operations canvas', 60 * 24 * 4, world.user],
  [16, 'Onboarding checklist for new operators', 60 * 24 * 12, SAM],
  [17, 'Escalation from #ops-alerts: disk usage on ci-runner-4', 60 * 24 * 20, EMAIL_GADGET, 'Alert responder'],
  [18, 'Prototype a status page gadget', 60 * 24 * 41, world.user],
]
for (const [chatId, title, mins, author, spawnerName] of filler) {
  addChat({ id: chatId, title, ...(spawnerName ? { spawnerName } : {}), totalTokens: 1_000 + chatId * 377, totalCost: chatId / 400 }, [
    [author, mins + 3, { type: 'message', message: title.replace(/^Sam: /, '') }],
    [SONNET, mins, { type: 'message', message: 'Done — I left a summary of the changes in the gadget README and nothing needs accepting.' }],
  ])
}

/** The page getChatHistory returns, honoring a chat's compaction boundary. */
export function historyPage(chat: DemoChat, beforeSequence?: number): AiChatHistoryPage {
  const live = chat.messages.filter(msg => beforeSequence === undefined || msg.sequence < beforeSequence)
  const boundary = chat.compacted
  if (boundary && (beforeSequence === undefined || beforeSequence > boundary.to)) {
    return { messages: live.filter(msg => msg.sequence >= boundary.to), compacted: boundary }
  }
  return { messages: live }
}
