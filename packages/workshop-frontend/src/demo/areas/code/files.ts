// The demo gadget's source: a small but realistic multi-file project (an ops board gadget), its
// committed tree, and the chat's pending edits over it. Paths are relative to the gadget root.

import type { FileAtCommit, TreeNode } from '@gadgets/workshop-shared/api'

const README = `# Ops dashboard

A live board of the on-call team's open incidents, deploys and follow-ups, pulled from InferOps
through the workspace's \`OPS\` binding.

## Layout

- \`index.html\` mounts the app and loads \`src/main.ts\`.
- \`src/api/\` wraps the binding (board reads, status transitions).
- \`src/components/\` renders columns, cards and status pills.
- \`styles.css\` holds the board's layout and theme tokens.

## Development

Edits made in chat stay on the conversation's branch until you accept them.
`

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Ops dashboard</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <header class="topbar">
      <img src="./assets/logo.png" alt="" width="24" height="24" />
      <h1>Ops dashboard</h1>
      <span id="sync-status" class="sync">Syncing…</span>
    </header>
    <main id="board" class="board" aria-live="polite"></main>
    <script type="module" src="./src/main.ts"></script>
  </body>
</html>
`

const STYLES_CSS = `:root {
  --surface: #fffdfb;
  --surface-raised: #ffffff;
  --line: #e7e1d8;
  --text: #1f1d1a;
  --muted: #7a7268;
  --accent: #f6821f;
  --radius: 10px;
}

body {
  margin: 0;
  font: 14px/1.45 system-ui, sans-serif;
  background: var(--surface);
  color: var(--text);
}

.topbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--line);
}

.board {
  display: grid;
  grid-template-columns: repeat(4, minmax(220px, 1fr));
  gap: 16px;
  padding: 20px;
}

.card {
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface-raised);
}
`

const STYLES_CSS_NEW = STYLES_CSS.replace(
  `.card {
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface-raised);
}
`,
  `.card {
  display: grid;
  gap: 6px;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface-raised);
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.04);
}

.card[data-priority="p0"] {
  border-color: #d6433a;
}

@media (max-width: 720px) {
  .board {
    grid-template-columns: 1fr;
  }
}
`,
).replace('  --accent: #f6821f;\n', '  --accent: #f6821f;\n  --danger: #d6433a;\n')

const MAIN_TS = `import { fetchBoard, subscribeBoard } from './api/inferops'
import { renderColumn } from './components/BoardColumn'
import { formatRelative } from './lib/format'
import { loadCollapsed, saveCollapsed } from './lib/storage'

const board = document.querySelector<HTMLElement>('#board')!
const syncStatus = document.querySelector<HTMLElement>('#sync-status')!

async function render() {
  const snapshot = await fetchBoard(env.OPS, 'OPS')
  const collapsed = loadCollapsed()
  board.replaceChildren(
    ...snapshot.columns.map(column => renderColumn(column, {
      collapsed: collapsed.has(column.id),
      onToggle: id => saveCollapsed(id),
    })),
  )
  syncStatus.textContent = \`Updated \${formatRelative(snapshot.fetchedAt)}\`
}

subscribeBoard(env.OPS, 'OPS', render)
void render()
`

const MAIN_TS_NEW = `import { fetchBoard, subscribeBoard } from './api/inferops'
import { renderColumn } from './components/BoardColumn'
import { formatRelative } from './lib/format'

const board = document.querySelector<HTMLElement>('#board')!
const syncStatus = document.querySelector<HTMLElement>('#sync-status')!
const collapsed = new Set<string>()

async function render() {
  syncStatus.textContent = 'Syncing…'
  try {
    const snapshot = await fetchBoard(env.OPS, 'OPS')
    board.replaceChildren(
      ...snapshot.columns.map(column => renderColumn(column, {
        collapsed: collapsed.has(column.id),
        onToggle: id => {
          if (!collapsed.delete(id)) collapsed.add(id)
          void render()
        },
      })),
    )
    syncStatus.textContent = \`Updated \${formatRelative(snapshot.fetchedAt)}\`
  } catch (error) {
    syncStatus.textContent = 'Offline — showing the last board'
    console.warn('board refresh failed', error)
  }
}

subscribeBoard(env.OPS, 'OPS', render)
void render()
`

const API_INFEROPS_TS = `import type { BoardSnapshot, IssueTransition } from './types'

/** Reads the project board through the gatekeeper binding. */
export async function fetchBoard(ops: OpsBinding, key: string): Promise<BoardSnapshot> {
  const board = await ops.getBoard({ key })
  return { ...board, fetchedAt: new Date() }
}

/** Calls \`onChange\` whenever the board's revision advances. */
export function subscribeBoard(ops: OpsBinding, key: string, onChange: () => void) {
  return ops.watchBoard({ key }, onChange)
}

/** Proposes a status transition; InferOps applies it after approval. */
export function proposeTransition(ops: OpsBinding, transition: IssueTransition) {
  return ops.simulateTransition(transition).then(plan => ops.requestApproval(plan))
}
`

const API_TYPES_TS = `export interface Issue {
  id: string
  key: string
  title: string
  priority: 'p0' | 'p1' | 'p2' | 'p3'
  assignee?: { name: string; avatarUrl?: string }
  updatedAt: string
}

export interface Column {
  id: string
  title: string
  issues: Issue[]
}

export interface BoardSnapshot {
  key: string
  revision: string
  columns: Column[]
  fetchedAt: Date
}

export interface IssueTransition {
  issueId: string
  toColumn: string
  expectedRevision: string
}
`

const BOARD_COLUMN_TS = `import type { Column } from '../api/types'
import { renderIssueCard } from './IssueCard'

export function renderColumn(
  column: Column,
  options: { collapsed: boolean; onToggle: (id: string) => void },
): HTMLElement {
  const section = document.createElement('section')
  section.className = 'column'
  const header = document.createElement('button')
  header.className = 'column-header'
  header.textContent = \`\${column.title} · \${column.issues.length}\`
  header.addEventListener('click', () => options.onToggle(column.id))
  section.append(header)
  if (!options.collapsed) section.append(...column.issues.map(renderIssueCard))
  return section
}
`

const ISSUE_CARD_TS = `import type { Issue } from '../api/types'
import { renderStatusPill } from './StatusPill'

export function renderIssueCard(issue: Issue): HTMLElement {
  const card = document.createElement('article')
  card.className = 'card'
  card.innerHTML = \`
    <span class="key">\${issue.key}</span>
    <h3>\${issue.title}</h3>
  \`
  card.append(renderStatusPill(issue.priority))
  return card
}
`

const ISSUE_CARD_TS_NEW = `import type { Issue } from '../api/types'
import { formatRelative } from '../lib/format'
import { renderPriorityBadge } from './PriorityBadge'

export function renderIssueCard(issue: Issue): HTMLElement {
  const card = document.createElement('article')
  card.className = 'card'
  card.dataset.priority = issue.priority

  const key = document.createElement('span')
  key.className = 'key'
  key.textContent = issue.key

  const title = document.createElement('h3')
  title.textContent = issue.title

  const meta = document.createElement('footer')
  meta.textContent = [issue.assignee?.name ?? 'Unassigned', formatRelative(new Date(issue.updatedAt))]
    .join(' · ')

  card.append(key, renderPriorityBadge(issue.priority), title, meta)
  return card
}
`

const STATUS_PILL_TS = `const LABELS = { p0: 'Critical', p1: 'High', p2: 'Medium', p3: 'Low' } as const

export function renderStatusPill(priority: keyof typeof LABELS): HTMLElement {
  const pill = document.createElement('span')
  pill.className = \`pill pill-\${priority}\`
  pill.textContent = LABELS[priority]
  return pill
}
`

const PRIORITY_BADGE_TS = `import type { Issue } from '../api/types'

const BADGES: Record<Issue['priority'], { label: string; tone: string }> = {
  p0: { label: 'P0 · Critical', tone: 'danger' },
  p1: { label: 'P1 · High', tone: 'warning' },
  p2: { label: 'P2 · Medium', tone: 'neutral' },
  p3: { label: 'P3 · Low', tone: 'subtle' },
}

/** A compact priority badge; replaces the older StatusPill on cards. */
export function renderPriorityBadge(priority: Issue['priority']): HTMLElement {
  const { label, tone } = BADGES[priority]
  const badge = document.createElement('span')
  badge.className = \`badge badge-\${tone}\`
  badge.textContent = label
  badge.title = \`Priority \${priority.toUpperCase()}\`
  return badge
}
`

const FORMAT_TS = `const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
]

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

/** "3 minutes ago", "yesterday", or "just now". */
export function formatRelative(date: Date, now = Date.now()): string {
  const delta = date.getTime() - now
  for (const [unit, ms] of UNITS) {
    if (Math.abs(delta) >= ms) return rtf.format(Math.round(delta / ms), unit)
  }
  return 'just now'
}
`

const STORAGE_TS = `const KEY = 'ops-dashboard:collapsed'

export function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]'))
  } catch {
    return new Set()
  }
}

export function saveCollapsed(id: string) {
  const collapsed = loadCollapsed()
  if (!collapsed.delete(id)) collapsed.add(id)
  localStorage.setItem(KEY, JSON.stringify([...collapsed]))
}
`

const FORMAT_TEST_TS = `import { describe, expect, it } from 'vitest'
import { formatRelative } from '../src/lib/format'

describe('formatRelative', () => {
  const now = Date.parse('2026-10-02T12:00:00Z')

  it('says just now under a minute', () => {
    expect(formatRelative(new Date(now - 20_000), now)).toBe('just now')
  })

  it('rounds to the largest unit', () => {
    expect(formatRelative(new Date(now - 3 * 3_600_000), now)).toBe('3 hours ago')
  })
})
`

const BUILD_SH = `#!/usr/bin/env bash
set -euo pipefail
# Bundles the gadget for a local preview outside the Workshop.
npx esbuild src/main.ts --bundle --format=esm --outfile=dist/main.js
cp index.html styles.css dist/
`

const GADGET_JSON = `{
  "name": "ops-dashboard",
  "title": "Ops dashboard",
  "bindings": {
    "OPS": { "gatekeeper": "inferops", "resource": "inferops://demo.local/project/board/OPS" }
  },
  "permissions": ["board:read", "board:transition"]
}
`

/** Committed file contents (the gadget's accepted commit). */
export const committedFiles: Record<string, FileAtCommit> = {
  'README.md': { kind: 'text', text: README },
  'index.html': { kind: 'text', text: INDEX_HTML },
  'styles.css': { kind: 'text', text: STYLES_CSS },
  'gadget.json': { kind: 'text', text: GADGET_JSON },
  'src/main.ts': { kind: 'text', text: MAIN_TS },
  'src/api/inferops.ts': { kind: 'text', text: API_INFEROPS_TS },
  'src/api/types.ts': { kind: 'text', text: API_TYPES_TS },
  'src/components/BoardColumn.ts': { kind: 'text', text: BOARD_COLUMN_TS },
  'src/components/IssueCard.ts': { kind: 'text', text: ISSUE_CARD_TS },
  'src/components/StatusPill.ts': { kind: 'text', text: STATUS_PILL_TS },
  'src/lib/format.ts': { kind: 'text', text: FORMAT_TS },
  'src/lib/storage.ts': { kind: 'text', text: STORAGE_TS },
  'tests/format.test.ts': { kind: 'text', text: FORMAT_TEST_TS },
  'scripts/build.sh': { kind: 'text', text: BUILD_SH },
  'assets/logo.png': {
    kind: 'unreadable',
    message: 'assets/logo.png is a binary file (24.6 KB) and cannot be shown as text',
  },
  'assets/brand': { kind: 'unreadable', message: 'assets/brand is a symbolic link to ../../shared/brand' },
}

/** The committed tree, in git order (directories sort as if suffixed with `/`). */
export const committedTree: TreeNode[] = [
  { name: 'README.md', kind: 'file' },
  { name: 'assets', kind: 'dir', children: [
    { name: 'brand', kind: 'symlink' },
    { name: 'logo.png', kind: 'file' },
  ] },
  { name: 'gadget.json', kind: 'file' },
  { name: 'index.html', kind: 'file' },
  { name: 'scripts', kind: 'dir', children: [{ name: 'build.sh', kind: 'executable' }] },
  { name: 'src', kind: 'dir', children: [
    { name: 'api', kind: 'dir', children: [
      { name: 'inferops.ts', kind: 'file' },
      { name: 'types.ts', kind: 'file' },
    ] },
    { name: 'components', kind: 'dir', children: [
      { name: 'BoardColumn.ts', kind: 'file' },
      { name: 'IssueCard.ts', kind: 'file' },
      { name: 'StatusPill.ts', kind: 'file' },
    ] },
    { name: 'lib', kind: 'dir', children: [
      { name: 'format.ts', kind: 'file' },
      { name: 'storage.ts', kind: 'file' },
    ] },
    { name: 'main.ts', kind: 'file' },
  ] },
  { name: 'styles.css', kind: 'file' },
  { name: 'tests', kind: 'dir', children: [{ name: 'format.test.ts', kind: 'file' }] },
]

/** The chat's pending edits: two modified files, a new component, a deleted module, a restyle. */
export const pendingEdits: [path: string, change: { set: string } | { remove: true }][] = [
  ['src/components/IssueCard.ts', { set: ISSUE_CARD_TS_NEW }],
  ['src/components/PriorityBadge.ts', { set: PRIORITY_BADGE_TS }],
  ['src/lib/storage.ts', { remove: true }],
  ['src/main.ts', { set: MAIN_TS_NEW }],
  ['styles.css', { set: STYLES_CSS_NEW }],
]
