// Demo fixtures and scenarios for the "code" views (the workspace's Code tab). See
// ../registry.ts and ../scenarios.ts.
//
// Committed code is served by Overseer.listTree()/readFilesAtCommit() from the fixture project in
// ./code/files.ts. Any commit id reads as that project, so whatever head commit the workspace
// area gives its gadgets works. A chat's pending edits come from the chat area: it puts
// `chatCodeBase(gadgetId)` on the chat's metadata and a "changes" message carrying
// `chatCodeChange(gadgetId)` in its history (see CODE_DEMO_CHAT_ID).

import type {
  ChatCodeBase, CommitInfo, FileAtCommit, TreeNode, WorkpieceId,
} from '@gadgets/workshop-shared/api'
import type { CodeChange } from '@gadgets/workshop-shared/code-change'
import { delay, forever, provide } from '../registry'
import { scenario, type DemoStep } from '../scenarios'
import { committedFiles, committedTree, pendingEdits } from './code/files'

/** The demo gadget's accepted (head) commit; the workspace area's gadget summaries may use it. */
export const CODE_HEAD_COMMIT = '9c4e2a7b1d3f5e8a0b6c2d4f7e9a1b3c5d7e9f02'

/** The chat whose history carries the pending change set (chat area: deliver it there). */
export const CODE_DEMO_CHAT_ID = 1

/** Knobs scenarios turn to reach the Code tab's loading, error and empty states. */
export const codeFixtures = {
  tree: 'ok' as 'ok' | 'empty' | 'loading' | 'error',
  files: 'ok' as 'ok' | 'loading' | 'error',
  /** `offline` makes submissions fail like a dropped WebSocket (the connection banner). */
  submit: 'ok' as 'ok' | 'offline',
}

/** The selected chat's code base: the gadget pinned at the head commit, nothing merged since. */
export function chatCodeBase(gadgetId: WorkpieceId): ChatCodeBase {
  return {
    pins: [{ gadgetId, baseCommit: CODE_HEAD_COMMIT, mergedCommit: CODE_HEAD_COMMIT }],
    generation: 1,
    revision: 0,
  }
}

/** The chat's pending edits to `gadgetId`, for a "changes" message's `change`. */
export function chatCodeChange(gadgetId: WorkpieceId): CodeChange {
  return { [gadgetId]: pendingEdits }
}

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000)
const dana = { name: 'Dana Demo', email: 'dana@example.com' }
const agent = { name: 'Workshop agent', email: 'agent@gadgets.local' }
const commitLog: CommitInfo[] = ([
  [CODE_HEAD_COMMIT, 'Group the board by on-call rotation and show assignees', dana, 3],
  ['4b1d7e93c0a25f68e1d2c3b4a5968778695a4b3c', 'Add relative timestamps to cards (formatRelative)', agent, 20],
  ['e07a3c51d9b84f26a1c3e5f7092b4d6f8a0c2e41', 'Read the board through the OPS gatekeeper binding', agent, 26],
  ['71f2b8d40e6c93a5b7d9f1e3c5a7092b4d6f8a13', 'Collapse columns and remember them in localStorage', dana, 50],
  ['0d93e6a2f4b1c8d7e5f3a1b9c7d5e3f1a9b7c5d3', 'Initial board layout with four columns', agent, 74],
] as const).map(([oid, message, author, hours], index, all) => ({
  oid,
  parents: index + 1 < all.length ? [all[index + 1][0]] : [],
  message: `${message}\n`,
  author,
  timestamp: hoursAgo(hours),
}))

const treeFor = async (): Promise<TreeNode[]> => {
  await delay(120)
  if (codeFixtures.tree === 'loading') return forever()
  if (codeFixtures.tree === 'error') throw new Error('Demo: failed to read the commit tree')
  return codeFixtures.tree === 'empty' ? [] : committedTree
}

provide('Overseer', {
  listTree: () => treeFor(),
  async readFilesAtCommit(_commitId, paths) {
    await delay(80)
    if (codeFixtures.files === 'loading') return forever()
    if (codeFixtures.files === 'error') throw new Error('Demo: failed to read files')
    return paths.map((path): [string, FileAtCommit] => [path, committedFiles[path] ?? { kind: 'absent' }])
  },
  getCommitLog(fromCommit, depth) {
    const start = Math.max(0, commitLog.findIndex(commit => commit.oid === fromCommit))
    return commitLog.slice(start, depth === undefined ? undefined : start + depth)
  },
  async submitCodeChange(_chatId, submission) {
    await delay(150)
    // capnweb's own wording for a dropped socket, which the OT client treats as transient.
    if (codeFixtures.submit === 'offline') throw new Error('Peer closed WebSocket')
    return { generation: submission.generation, revision: submission.revision + 1 }
  },
})

// ---- scenarios ---------------------------------------------------------------------------------

const WORKSPACE = '/workspace/ws-ops'
const IN_CHAT = `${WORKSPACE}?chat=${CODE_DEMO_CHAT_ID}`
const openCode: DemoStep[] = [{ click: 'text=Code' }]
const rowMenu = (path: string): DemoStep[] => [
  ...openCode,
  { wait: `button[aria-label="Actions for ${path}"]` },
  { click: `button[aria-label="Actions for ${path}"]` },
]
const newFile = (name: string): DemoStep[] => [
  ...openCode,
  { click: 'button[aria-label="New file"]:not([disabled])' },
  { type: name, into: 'input[aria-label="Filename"]' },
  { click: 'text=Create file' },
]

scenario({
  'workspace.code': { path: WORKSPACE, steps: openCode },
  'workspace.code.editor': { path: WORKSPACE, steps: openCode },
  'workspace.code.locked-banner': { path: WORKSPACE, steps: openCode },
  'workspace.code.file-header': { path: WORKSPACE, steps: openCode },
  'workspace.code.file-browser': { path: WORKSPACE, steps: openCode },
  'workspace.code.editor.unreadable': {
    path: WORKSPACE,
    steps: [...openCode, { click: 'text=logo.png' }],
  },
  'workspace.code.empty': { path: IN_CHAT, setup: () => { codeFixtures.tree = 'empty' }, steps: openCode },
  'workspace.code.loading': { path: WORKSPACE, setup: () => { codeFixtures.tree = 'loading' }, steps: openCode },
  'workspace.code.error': { path: WORKSPACE, setup: () => { codeFixtures.tree = 'error' }, steps: openCode },
  'workspace.code.diff': {
    path: IN_CHAT,
    steps: [...openCode, { click: 'text=src/main.ts' }],
    localStorage: { 'gadgets:workshop:diffLayout': 'stacked' },
  },
  'workspace.code.diff.split': {
    path: IN_CHAT,
    steps: [...openCode, { click: 'text=src/components/IssueCard.ts' }],
    localStorage: { 'gadgets:workshop:diffLayout': 'split' },
  },
  'workspace.code.file-browser.changes': { path: IN_CHAT, steps: openCode },
  'workspace.code.file-browser.row-menu': { path: IN_CHAT, steps: rowMenu('src/api/inferops.ts') },
  'workspace.code.file-browser.rename': {
    path: IN_CHAT,
    steps: [...rowMenu('src/api/inferops.ts'), { click: 'text=Rename' }],
  },
  'workspace.code.file-browser.delete-file': {
    path: IN_CHAT,
    steps: [...rowMenu('src/api/inferops.ts'), { click: 'text=Delete' }],
  },
  'workspace.code.file-browser.new-file': {
    path: IN_CHAT,
    steps: [
      ...openCode,
      { click: 'button[aria-label="New file"]:not([disabled])' },
      { type: 'src/components/OnCallBanner.ts', into: 'input[aria-label="Filename"]' },
    ],
  },
  'workspace.code.toasts': { path: IN_CHAT, steps: newFile('src/components/OnCallBanner.ts') },
  'workspace.code.connection-banner': {
    path: IN_CHAT,
    setup: () => { codeFixtures.submit = 'offline' },
    steps: newFile('src/lib/retry.ts'),
  },
  'workspace.code.file-drawer': {
    path: WORKSPACE,
    steps: [
      { click: 'button[aria-label="More workspace views and actions"]' },
      { click: 'text=Code' },
      { click: 'button[aria-label="Open files"]' },
    ],
  },
})
