// Demo fixtures and scenarios for the "chat" views: a workspace's conversations, served from the
// transcripts in ./chat/data.ts. Sending appends the user's message and streams a short canned
// agent reply through every chat subscriber, so the transcript visibly updates. See ../registry.ts
// and ../scenarios.ts.
//
// The fixture conversations belong to the default workspace (`world.defaultParams.id`); any other
// workspace starts with no conversations. `chatDemo` holds the knobs scenarios turn.

import { RpcTarget, type RpcStub } from 'capnweb'
import type {
  AiChatAuthorInfo,
  AiChatMessage,
  AiChatMessageBody,
  AiChatSubscriber,
  CapsuleSpecifier,
  ChatAttachmentHandle,
  ChatAttachmentRef,
  ChatCodeBase,
  ConsoleLogSubscriber,
  MessageFormatRef,
  Overseer,
  SlashCommandId,
  SlashCommandRequest,
  WorkpieceId,
} from '@gadgets/workshop-shared/api'
import { changedGadgets, composeCodeChange, type CodeChange } from '@gadgets/workshop-shared/code-change'
import { demoContext, provide, type DemoMethods, type DemoStub } from '../registry'
import { scenario, type DemoStep } from '../scenarios'
import { world } from '../world'
import { CODE_DEMO_CHAT_ID, CODE_HEAD_COMMIT, chatCodeBase, chatCodeChange } from './code'
import { connectionRequests } from './connections'
import { fixtureFor } from './workspace'
import { CSV_ATTACHMENT, MODELS, SLASH_COMMANDS, WORKPIECES, chats, historyPage, type DemoChat } from './chat/data'

// ─── knobs ─────────────────────────────────────────────────────────────────────

/** Knobs scenarios turn to show the chat's non-default states. */
export const chatDemo = {
  /** Leaves the in-progress turn (chat 9) streaming instead of finishing it. */
  holdStreaming: false,
  /** What `mergeChanges` reports; `stale` opens the "gadget changed since draft" dialog. */
  mergeOutcome: 'merged' as 'merged' | 'stale',
  /** Delivers a batch of gadget console logs shortly after the editor subscribes. */
  consoleLogs: false,
}

// ─── fixture wiring ────────────────────────────────────────────────────────────

const DEMO_WORKSPACE = world.defaultParams.id
const OPS_GADGET = 0 as WorkpieceId
const STREAMING_CHAT = 9
const STREAM_GENERATION = 1

// The build chat also carries the Code tab's pending edits to the workspace's main gadget, and its
// created Kanban gadget is listed (pending in that chat) so its card and preview resolve.
const buildChat = chats.get(CODE_DEMO_CHAT_ID)
const buildChanges = buildChat?.messages.find(msg => msg.type === 'changes')
if (buildChat && buildChanges?.type === 'changes') {
  buildChanges.change = { ...buildChanges.change, ...chatCodeChange(OPS_GADGET) }
  buildChanges.pins = [...(buildChanges.pins ?? []), { gadgetId: OPS_GADGET, baseCommit: CODE_HEAD_COMMIT }]
  buildChat.meta.codeBase = { ...chatCodeBase(OPS_GADGET), revision: buildChanges.watermark?.throughRevision ?? 0 }
  buildChat.meta.proposedChangeWorkpieces = [...(buildChat.meta.proposedChangeWorkpieces ?? []), OPS_GADGET]
}
fixtureFor(DEMO_WORKSPACE).workpieces.push({ id: WORKPIECES.kanban, type: 'gadget', title: 'DEMO Kanban', chatId: CODE_DEMO_CHAT_ID })

// Unsaved human edits replay as live change rows, so their chat needs a stream to sit on.
for (const chat of chats.values()) {
  if (chat.draftRows?.length && !chat.meta.codeBase) {
    chat.meta.codeBase = { pins: [], generation: STREAM_GENERATION, revision: chat.draftRows.length }
  }
}

// ─── per-workspace state ───────────────────────────────────────────────────────

type Subscriber = RpcStub<AiChatSubscriber>

const stores = new Map<string, Map<number, DemoChat>>([[DEMO_WORKSPACE, chats]])
const subscribers = new Map<string, Set<Subscriber>>()
/** Running agent turns by `${workspaceId}:${chatId}`; calling one stops it. */
const turns = new Map<string, () => void>()
/** Uploaded attachments by id; kept after sending so non-image ones can still be downloaded. */
const uploads = new Map<string, Required<Pick<ChatAttachmentRef, 'content'>> & ChatAttachmentRef>()
let uploadCount = 0
let streamingStarted = false

// Overseers opened outside a workspace route (e.g. the canvas page) may carry no context.
const workspaceOf = (target: object) =>
  demoContext<{ workspaceId?: string } | undefined>(target)?.workspaceId ?? DEMO_WORKSPACE

const storeOf = (workspaceId: string) => {
  let store = stores.get(workspaceId)
  if (!store) stores.set(workspaceId, (store = new Map()))
  return store
}

const chatOf = (workspaceId: string, chatId: number) => {
  const chat = storeOf(workspaceId).get(chatId)
  if (!chat) throw new Error(`Demo: no chat ${chatId} in ${workspaceId}`)
  return chat
}

/** Calls every subscriber of the workspace, dropping any whose client has gone away. */
function broadcast(workspaceId: string, send: (subscriber: Subscriber) => unknown) {
  const set = subscribers.get(workspaceId)
  for (const subscriber of set ?? []) {
    Promise.resolve(send(subscriber)).catch(() => set?.delete(subscriber))
  }
}

const publish = (workspaceId: string, chat: DemoChat) => broadcast(workspaceId, s => s.metadata(chat.meta))

function setActiveAgent(workspaceId: string, chat: DemoChat, agent: AiChatAuthorInfo | null) {
  const { activeAgent: _, ...rest } = chat.meta
  chat.meta = agent ? { ...rest, activeAgent: agent } : rest
  publish(workspaceId, chat)
}

/** Appends a message to the chat and delivers it (with the refreshed metadata) to subscribers. */
function append(workspaceId: string, chat: DemoChat, author: AiChatAuthorInfo, body: AiChatMessageBody): AiChatMessage {
  const message: AiChatMessage = {
    chatId: chat.meta.id,
    sequence: (chat.messages.at(-1)?.sequence ?? -1) + 1,
    timestamp: new Date(),
    author,
    ...body,
  }
  chat.messages.push(message)
  chat.meta = { ...chat.meta, lastActive: message.timestamp }
  broadcast(workspaceId, s => s.message(message))
  publish(workspaceId, chat)
  return message
}

/** Moves the chat's change stream to a new generation: content-preserving after a merge, destructive otherwise. */
function bumpGeneration(chat: DemoChat, kind: 'merge' | 'erase') {
  const current: ChatCodeBase = chat.meta.codeBase ?? { pins: [], generation: 0, revision: 0 }
  chat.meta = {
    ...chat.meta,
    codeBase: kind === 'merge'
      ? { pins: [], generation: current.generation + 1, epoch: (current.epoch ?? 0) + 1, revision: 0,
          prior: { generation: current.generation, finalRevision: current.revision, discontinuousGadgets: [] } }
      : { pins: current.pins, generation: current.generation + 1, epoch: current.epoch, revision: 0 },
  }
}

// ─── agent turns ───────────────────────────────────────────────────────────────

const modelFor = (modelId: string): AiChatAuthorInfo =>
  MODELS.find(model => model.id === modelId) ?? { type: 'agent', id: modelId, name: modelId }

const CANNED_REPLY = `Here's how I'd take that on:

1. Read the relevant files in the workspace's gadgets and connections.
2. Make the change as a **draft**, so nothing goes live until you accept it.
3. Summarize what changed right here, with anything that needs your approval.

_This is demo mode: no model ran and nothing was changed._`

const HEADER_REPLY = `The header is now sticky (\`position: sticky; top: 0\`) with a 1px bottom border in the muted line color.

- The workspace switcher stays pinned on the left.
- The header actions moved into a right-aligned group, so they no longer collide on narrow screens.
- A translucent background keeps cards readable as they scroll underneath.

Accept the changes when it looks right.`

const REASONING = 'Check how the request maps onto the existing gadget code before changing anything, and keep the edit small.'

/**
 * Streams `reply` into the chat word by word, then records it as the agent's message and ends the
 * turn. With `hold`, the turn keeps running after the last word (the streaming state).
 */
function runTurn(workspaceId: string, chat: DemoChat, agent: AiChatAuthorInfo, reply: string, hold = false) {
  const chatId = chat.meta.id
  const key = `${workspaceId}:${chatId}`
  turns.get(key)?.()
  setActiveAgent(workspaceId, chat, agent)
  const words = reply.match(/\S+\s*/g) ?? []
  let streamed = ''
  let timer: ReturnType<typeof setTimeout>

  const finish = (text: string) => {
    turns.delete(key)
    clearTimeout(timer)
    if (text) append(workspaceId, chat, agent, { type: 'message', message: text, reasoning: REASONING })
    setActiveAgent(workspaceId, chat, null)
  }
  const tick = () => {
    const word = words.shift()
    if (word === undefined) {
      if (!hold) finish(reply)
      return
    }
    streamed += word
    broadcast(workspaceId, s => s.stream(chatId, { type: 'textDelta', delta: word }))
    timer = setTimeout(tick, 70)
  }

  broadcast(workspaceId, s => s.stream(chatId, { type: 'reasoningDelta', delta: REASONING }))
  timer = setTimeout(tick, 600)
  turns.set(key, () => finish(streamed))
}

/** `/compact`: shows "Compacting…", then checkpoints everything before the command. */
function runCompaction(workspaceId: string, chat: DemoChat, agent: AiChatAuthorInfo, commandSequence: number) {
  const chatId = chat.meta.id
  setActiveAgent(workspaceId, chat, agent)
  broadcast(workspaceId, s => s.stream(chatId, { type: 'compacting' }))
  const timer = setTimeout(() => {
    turns.delete(`${workspaceId}:${chatId}`)
    chat.compacted = {
      to: commandSequence,
      summary: `**Context so far**\n- ${chat.meta.title}\n- ${commandSequence} earlier messages summarized (demo).`,
    }
    chat.meta = { ...chat.meta, compactedTo: commandSequence }
    broadcast(workspaceId, s => s.stream(chatId, { type: 'compacted' }))
    setActiveAgent(workspaceId, chat, null)
  }, 1500)
  turns.set(`${workspaceId}:${chatId}`, () => {
    clearTimeout(timer)
    turns.delete(`${workspaceId}:${chatId}`)
    broadcast(workspaceId, s => s.stream(chatId, { type: 'compacted' }))
    setActiveAgent(workspaceId, chat, null)
  })
}

const sameCommand = (a: SlashCommandId, b: SlashCommandId) =>
  a.commandId === b.commandId && (a.builtin ? b.builtin === true : !b.builtin && a.gatekeeperId === b.gatekeeperId)

const attachmentRef = (handle: ChatAttachmentHandle): ChatAttachmentRef => {
  const upload = uploads.get(handle.id)
  if (!upload) throw new Error('Demo: attachment not found')
  const { content: _, ...meta } = upload
  return meta.mimeType.startsWith('image/') ? upload : meta
}

/** What sending does: the user's message (or command), then the agent's turn unless `modelId` is null. */
function deliver(
  workspaceId: string,
  chat: DemoChat,
  message: string | SlashCommandRequest,
  modelId: string | null,
  capsules?: CapsuleSpecifier[],
  attachments?: ChatAttachmentHandle[],
  formats?: MessageFormatRef[],
) {
  const agent = modelId === null ? null : modelFor(modelId)
  if (typeof message !== 'string') {
    const command = SLASH_COMMANDS.find(choice => sameCommand(choice.selection, message.id))
    const invoked = append(workspaceId, chat, world.user, {
      type: 'slashCommand', request: message, ...(command && !message.id.builtin ? { skillName: command.name } : {}),
    })
    if (message.id.builtin) {
      if (agent) runCompaction(workspaceId, chat, agent, invoked.sequence)
      return
    }
    append(workspaceId, chat, world.user, {
      type: 'message', generatedBySlashCommandSequence: invoked.sequence,
      message: `${command?.description ?? `Run /${message.id.commandId}`}${message.args ? ` (${message.args})` : ''}.`,
    })
  } else {
    const refs = (attachments ?? []).map(attachmentRef)
    append(workspaceId, chat, world.user, {
      type: 'message', message,
      ...(capsules?.length ? { capsules } : {}),
      ...(refs.length ? { attachments: refs } : {}),
      ...(formats?.length ? { formats } : {}),
    })
  }
  if (agent) runTurn(workspaceId, chat, agent, CANNED_REPLY)
}

const titleFor = (message: string | SlashCommandRequest) => {
  const text = typeof message === 'string' ? message.split('\n')[0]!.trim() : `/${message.id.commandId} ${message.args}`.trim()
  return text.length > 60 ? `${text.slice(0, 57)}…` : text || 'New conversation'
}

/** Gadgets whose changes are still proposed after reverting from `revertFrom`. */
function proposedBefore(chat: DemoChat, revertFrom: number): WorkpieceId[] {
  const lastMerge = Math.max(-1, ...chat.messages.filter(msg => msg.type === 'merge').map(msg => msg.sequence))
  const kept = chat.messages.filter(msg => msg.type === 'changes' && msg.sequence > lastMerge && msg.sequence < revertFrom)
  return [...new Set(kept.flatMap(msg => (msg.type === 'changes' && msg.change ? changedGadgets(msg.change) : [])))] as WorkpieceId[]
}

/** Removes the gadgets a chat created and never accepted from the workspace listing. */
function dropPendingGadgets(workspaceId: string, chatId: number) {
  const fixture = fixtureFor(workspaceId)
  fixture.workpieces = fixture.workpieces.filter(w => w.type !== 'gadget' || w.chatId !== chatId)
}

/** Materializes a chat's unsaved edits into a `changes` message. */
function finalizeDraft(workspaceId: string, chat: DemoChat) {
  const rows = chat.draftRows ?? []
  if (!rows.length) return
  const change = rows.reduce<CodeChange>((all, row) => composeCodeChange(all, row), {})
  const codeBase = chat.meta.codeBase
  chat.draftRows = undefined
  const proposed = new Set([...(chat.meta.proposedChangeWorkpieces ?? []), ...(changedGadgets(change) as WorkpieceId[])])
  chat.meta = { ...chat.meta, proposedChangeWorkpieces: [...proposed] }
  append(workspaceId, chat, world.user, {
    type: 'changes', change,
    ...(codeBase ? { watermark: { changesGeneration: codeBase.generation, throughRevision: codeBase.revision } } : {}),
  })
}

// ─── subscriptions ─────────────────────────────────────────────────────────────

/** A subscription handle that releases the retained subscriber when the client disposes it. */
class Subscription extends RpcTarget {
  #release: () => void
  constructor(release: () => void) {
    super()
    this.#release = release
  }
  [Symbol.dispose]() { this.#release() }
}
const subscription = (release: () => void) => new Subscription(release) as unknown as DemoStub

function replayDrafts(chat: DemoChat, subscriber: Subscriber) {
  const generation = chat.meta.codeBase?.generation ?? STREAM_GENERATION
  chat.draftRows?.forEach((change, index) => {
    Promise.resolve(subscriber.changeApplied(chat.meta.id, generation, index + 1, world.user, change,
      { clientId: 'demo-earlier-session', seq: index + 1 })).catch(() => {})
  })
}

/** The fixture turn already running in chat 9, started once the editor has subscribed. */
function startStreamingChat(workspaceId: string) {
  const chat = storeOf(workspaceId).get(STREAMING_CHAT)
  if (streamingStarted || !chat?.meta.activeAgent) return
  streamingStarted = true
  const agent = chat.meta.activeAgent
  // Wait out StrictMode's subscribe/unsubscribe/subscribe so the live subscription sees every word.
  setTimeout(() => runTurn(workspaceId, chat, agent, HEADER_REPLY, chatDemo.holdStreaming), 800)
}

const msAgo = (ms: number) => new Date(Date.now() - ms)

// The connections area settles agent connection requests; reflect each outcome on its inline card.
connectionRequests.listeners.add(requestId => {
  const outcome = connectionRequests.outcomes.get(requestId)
  if (!outcome) return
  for (const [workspaceId, store] of stores) {
    for (const chat of store.values()) {
      const index = chat.messages.findIndex(msg => msg.type === 'connectionRequest' && msg.requestId === requestId)
      const card = chat.messages[index]
      if (card?.type !== 'connectionRequest') continue
      const updated: AiChatMessage = { ...card, ...outcome }
      chat.messages[index] = updated
      broadcast(workspaceId, s => s.message(updated))
    }
  }
})

// ─── Overseer ──────────────────────────────────────────────────────────────────

provide('Overseer', {
  listChats() { return [...storeOf(workspaceOf(this)).values()].map(chat => chat.meta) },
  listModels: () => MODELS,
  getChatHistory(chatId, beforeSequence) { return historyPage(chatOf(workspaceOf(this), chatId), beforeSequence) },
  getChatMessage(chatId, sequence) {
    return storeOf(workspaceOf(this)).get(chatId)?.messages.find(msg => msg.sequence === sequence)
  },
  subscribeToChat(subscriber, startAfter) {
    const workspaceId = workspaceOf(this)
    const retained = subscriber.dup()
    const set = subscribers.get(workspaceId) ?? new Set()
    subscribers.set(workspaceId, set)
    set.add(retained)
    void retained.streamGeneration(STREAM_GENERATION)
    for (const chat of storeOf(workspaceId).values()) {
      if (startAfter) for (const msg of chat.messages) if (msg.timestamp > startAfter) void retained.message(msg)
      replayDrafts(chat, retained)
    }
    if (workspaceId === DEMO_WORKSPACE) startStreamingChat(workspaceId)
    return subscription(() => {
      set.delete(retained)
      retained[Symbol.dispose]()
    })
  },
  listSlashCommands: () => SLASH_COMMANDS,

  newChat(initialMessage, modelId, capsules, attachments, formats) {
    const workspaceId = workspaceOf(this)
    const store = storeOf(workspaceId)
    const id = Math.max(0, ...store.keys()) + 1
    const now = new Date()
    const chat: DemoChat = { meta: { id, title: titleFor(initialMessage), started: now, lastActive: now }, messages: [] }
    store.set(id, chat)
    publish(workspaceId, chat)
    deliver(workspaceId, chat, initialMessage, modelId, capsules, attachments, formats)
    return id
  },
  sendChatMessage(chatId, message, modelId, capsules, attachments, formats) {
    const workspaceId = workspaceOf(this)
    deliver(workspaceId, chatOf(workspaceId, chatId), message, modelId, capsules, attachments, formats)
  },
  uploadChatAttachment({ mimeType, content, name }) {
    const id = `att-upload-${++uploadCount}`
    uploads.set(id, { id, mimeType, content, size: content.byteLength, ...(name ? { name } : {}) })
    return { id }
  },
  getChatAttachmentContent(chatId, id) {
    const attached = storeOf(workspaceOf(this)).get(chatId)?.messages
      .flatMap(msg => (msg.type === 'message' ? msg.attachments ?? [] : []))
      .find(ref => ref.id === id)
    const content = attached?.content ?? (id === 'att-issues-csv' ? CSV_ATTACHMENT : uploads.get(id)?.content)
    if (!content) throw new Error('Demo: attachment not found')
    return content
  },
  deleteChatAttachment(id) { uploads.delete(id) },
  setChatTitle(chatId, title) {
    const workspaceId = workspaceOf(this)
    const chat = chatOf(workspaceId, chatId)
    chat.meta = { ...chat.meta, title }
    publish(workspaceId, chat)
  },

  mergeChanges(chatId) {
    if (chatDemo.mergeOutcome === 'stale') return { outcome: 'stale' }
    const workspaceId = workspaceOf(this)
    const chat = chatOf(workspaceId, chatId)
    finalizeDraft(workspaceId, chat)
    const merged = chat.meta.proposedChangeWorkpieces ?? []
    const mergeThrough = chat.messages.at(-1)?.sequence ?? 0
    const commits = merged.map(gadgetId => ({ gadgetId, commitId: crypto.randomUUID().replace(/-/g, '').padEnd(40, '0') }))
    // Gadgets the chat created become permanent at their new commit.
    for (const workpiece of fixtureFor(workspaceId).workpieces) {
      const commit = commits.find(c => c.gadgetId === workpiece.id)
      if (workpiece.type === 'gadget' && commit && workpiece.chatId === chatId) {
        delete workpiece.chatId
        workpiece.commitId = commit.commitId
      }
    }
    bumpGeneration(chat, 'merge')
    chat.meta = { ...chat.meta, proposedChangeWorkpieces: [] }
    append(workspaceId, chat, world.user, { type: 'merge', mergeThrough, epochBoundary: true, commits })
    return { outcome: 'merged' }
  },
  updateChatFromMainline(chatId) {
    const workspaceId = workspaceOf(this)
    const chat = chatOf(workspaceId, chatId)
    chatDemo.mergeOutcome = 'merged'
    append(workspaceId, chat, world.user, { type: 'changes', mainlineMerge: { conflictPaths: [] } })
    return { conflictPaths: [] }
  },
  revertChanges(chatId, revertFrom) {
    const workspaceId = workspaceOf(this)
    const chat = chatOf(workspaceId, chatId)
    chat.draftRows = undefined
    const proposed = proposedBefore(chat, revertFrom)
    if (revertFrom === 0) dropPendingGadgets(workspaceId, chatId)
    bumpGeneration(chat, 'erase')
    chat.meta = { ...chat.meta, proposedChangeWorkpieces: proposed }
    append(workspaceId, chat, world.user, { type: 'revert', revertFrom })
  },
  finalizeChatDraft(chatId) {
    const workspaceId = workspaceOf(this)
    finalizeDraft(workspaceId, chatOf(workspaceId, chatId))
  },
  discardChatDraftChanges(chatId) {
    const workspaceId = workspaceOf(this)
    const chat = chatOf(workspaceId, chatId)
    chat.draftRows = undefined
    bumpGeneration(chat, 'erase')
    publish(workspaceId, chat)
  },
  deleteChat(chatId) {
    const workspaceId = workspaceOf(this)
    turns.get(`${workspaceId}:${chatId}`)?.()
    storeOf(workspaceId).delete(chatId)
    dropPendingGadgets(workspaceId, chatId)
    broadcast(workspaceId, s => s.deleted(chatId))
  },
  stopAgent(chatId) { turns.get(`${workspaceOf(this)}:${chatId}`)?.() },
  retryAgent(chatId, modelId) {
    const workspaceId = workspaceOf(this)
    const chat = chatOf(workspaceId, chatId)
    if (chat.meta.activeAgent) throw new Error('An agent is already running in this chat')
    runTurn(workspaceId, chat, modelFor(modelId), CANNED_REPLY)
  },

  subscribeToConsoleLogs(subscriber) {
    if (!chatDemo.consoleLogs) return subscription(() => {})
    const retained: RpcStub<ConsoleLogSubscriber> = subscriber.dup()
    const timer = setTimeout(() => {
      Promise.resolve(retained.event(null, [
        { timestamp: msAgo(2400), level: 'log', message: ['board: rendered', { columns: 4, issues: 23 }] },
        { timestamp: msAgo(1800), level: 'warn', message: ['WIP limit exceeded for "In progress" (6 / 5)'] },
        { timestamp: msAgo(900), level: 'error', message: ["TypeError: Cannot read properties of null (reading 'name')\n    at toRow (src/export.ts:18:34)"] },
      ])).catch(() => {})
    }, 900)
    return subscription(() => {
      clearTimeout(timer)
      retained[Symbol.dispose]()
    })
  },
} satisfies DemoMethods<Overseer>)

// ─── scenarios ─────────────────────────────────────────────────────────────────

const inChat = (chatId: number) => `/workspace/${DEMO_WORKSPACE}?chat=${chatId}`
const LIST = `/workspace/${DEMO_WORKSPACE}`
const COMPOSER = 'textarea[role="combobox"]'
const addMenu: DemoStep[] = [{ click: 'button[aria-label="Add to conversation"]' }]
const optionsMenu: DemoStep[] = [{ click: 'button[aria-label="More chat options"]' }]
const expandFirstTool: DemoStep[] = [{ click: '.chat-panel button[aria-expanded="false"]' }]
// Clicking the composer after typing moves the caret into the URL, which is what opens the picker.
const typeUrl: DemoStep[] = [{ type: 'https://github.com/factory-level/inferos/issues/212', into: COMPOSER }, { click: COMPOSER }]
const holdStreaming = () => { chatDemo.holdStreaming = true }

// The build chat (1) shows attachments, tool runs, a created gadget, a slash command and pending
// changes; 2 approvals and hooks; 3 a non-blocking action; 4 a connection request; 5 compaction,
// merges and reverts; 6 agent callbacks; 7 errors; 8 a usage limit; 9 a running turn; 10 drafts.
scenario({
  'workspace.chat': { path: inChat(1) },
  'workspace.chat.header': { path: inChat(1) },
  'workspace.chat.list': { path: LIST },
  'workspace.chat.list.composer': { path: LIST },
  'workspace.chat.list.row-actions': { path: LIST, steps: [{ click: 'button[aria-label^="Actions for "]' }] },
  'workspace.chat.list.scope-menu': { path: LIST, steps: [{ click: 'button[aria-label="Filter conversations"]' }] },
  'workspace.chat.delete-dialog': { path: inChat(1), steps: [{ click: 'button[aria-label="Delete chat"]' }] },
  'workspace.chat.toasts': { path: inChat(1), steps: [{ click: 'text=Accept changes' }] },
  'workspace.chat.stale-accept-dialog': {
    path: inChat(1),
    setup: () => { chatDemo.mergeOutcome = 'stale' },
    steps: [{ click: 'text=Accept changes' }],
  },
  'workspace.chat.out-of-credits-modal': {
    path: inChat(8),
    setup: w => { w.serverConfig.cloudflareLimitsEnabled = true },
  },
  'workspace.chat.connection-setup-modal': { path: inChat(4), steps: [{ click: 'text=Set up' }] },
  'workspace.chat.auto-approve-dialog': { path: inChat(3), steps: [{ click: 'text=Always approve' }] },

  'workspace.chat.composer': { path: inChat(1) },
  'workspace.chat.composer.add-menu': { path: inChat(1), steps: addMenu },
  'workspace.chat.composer.add-connection-modal': { path: inChat(1), steps: [...addMenu, { click: 'text=Add a new connection' }] },
  'workspace.chat.composer.agent-active': { path: inChat(STREAMING_CHAT), setup: holdStreaming },
  'workspace.chat.composer.blocked': { path: inChat(4) },
  'modal.resource-picker': {
    path: inChat(1),
    steps: typeUrl,
  },
  'workspace.chat.composer.capsule-overlay': {
    path: inChat(1),
    steps: typeUrl,
  },
  'workspace.chat.composer.console-logs-prompt': { path: inChat(1), setup: () => { chatDemo.consoleLogs = true } },
  'workspace.chat.composer.pending-changes-banner': { path: inChat(1) },
  'workspace.chat.composer.discard-changes-popover': { path: inChat(1), steps: [{ click: 'text=Discard…' }] },
  'workspace.chat.composer.slash-commands': { path: inChat(1), steps: [{ type: '/', into: COMPOSER }] },
  'workspace.chat.composer.inline-tokens': {
    path: inChat(1),
    steps: [{ type: '/triage', into: COMPOSER }, { click: COMPOSER }, { wait: '[role="listbox"][aria-label="Slash commands"]' }, { press: 'Enter', on: COMPOSER }],
  },
  'workspace.chat.composer.model-selector': { path: inChat(1), steps: [{ click: 'button[aria-label="Select model"]' }] },
  'workspace.chat.composer.options-menu': { path: inChat(1), steps: optionsMenu },

  'workspace.chat.messages': { path: inChat(5) },
  'workspace.chat.messages.user-message': { path: inChat(1) },
  'workspace.chat.messages.attachment-preview': { path: inChat(1), steps: [{ click: 'button[aria-label="Preview board-sketch.svg"]' }] },
  'workspace.chat.messages.agent-message': { path: inChat(1) },
  'workspace.chat.messages.slash-command-message': { path: inChat(1) },
  'workspace.chat.messages.created-workpiece-card': { path: inChat(1) },
  'workspace.chat.messages.tool-group': { path: inChat(1) },
  'workspace.chat.messages.tool-group.expanded': { path: inChat(1), steps: expandFirstTool },
  'workspace.chat.messages.tool-group.error': { path: inChat(7), steps: expandFirstTool },
  'workspace.chat.messages.thinking-trace': { path: inChat(1), steps: [...optionsMenu, { click: 'text=Show thinking' }] },
  'workspace.chat.messages.observation': { path: inChat(2) },
  'workspace.chat.messages.action-inline': { path: inChat(3) },
  'workspace.chat.messages.action-blocking': { path: inChat(2) },
  'workspace.chat.messages.action-restricted': {
    path: inChat(2),
    setup: () => {
      const fixture = fixtureFor(DEMO_WORKSPACE)
      fixture.metadata = { ...fixture.metadata, containsRestrictedData: true }
    },
  },
  'workspace.chat.messages.hook-card': { path: inChat(2) },
  'workspace.chat.messages.connection-request': { path: inChat(4) },
  'workspace.chat.messages.compaction': { path: inChat(5), steps: [{ click: '[role="separator"][aria-label="Context compacted"]' }] },
  'workspace.chat.messages.model-change': { path: inChat(5) },
  'workspace.chat.messages.merge-revert': { path: inChat(5) },
  'workspace.chat.messages.saved-changes': { path: inChat(5) },
  'workspace.chat.messages.use-gadget': { path: inChat(5) },
  'workspace.chat.messages.agent-callback': { path: inChat(6) },
  'workspace.chat.messages.error': { path: inChat(7) },
  'workspace.chat.messages.streaming': { path: inChat(STREAMING_CHAT), setup: holdStreaming },
  'workspace.chat.messages.draft-pending': { path: inChat(10) },
})
