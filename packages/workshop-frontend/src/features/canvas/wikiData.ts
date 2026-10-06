// One InferMind workspace's Wiki, read through the workspace's Wiki connection for it
// (`inferops://<tenant>.<workspace>/knowledge/wiki`). Like a board, the reference is resolved only
// through a connection the workspace already holds (Overseer.getGatekeeperByResourceUrl), so it
// identifies a Wiki and authorizes nothing. InferMind stays authoritative: this keeps the latest
// reads (the page list, the Wiki structure, the pages), and a section or page body edit is only
// proposed through the gatekeeper's approval path. What became of an edit is read from the page,
// never assumed: a proposal is not a save.
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { InferOpsWikiSession, WikiDocument, WikiDocumentNode, WikiSection, WikiStructure } from '@inferos/gatekeeper-inferops/src/types'
import { canonicalBoardRef, codeOf, messageOf, type ProposalResult } from './boardData'
import { isOpenEdit, reconcileBodyEdit, reconcileEdit, type BodyEdit, type SectionEdit } from './wikiPage'

export type WikiListState =
  | { status: 'loading' }
  /** The workspace holds no connection to this Wiki. The cue to offer connecting, never to connect. */
  | { status: 'unbound' }
  /** The deployment has InferOps turned off (`DISABLED`). The connection is kept. */
  | { status: 'disabled'; message: string }
  /**
   * Nothing usable was read, or access was lost (`FORBIDDEN`, `UNAUTHORIZED`), which drops what was:
   * `code` is the gatekeeper's.
   */
  | { status: 'error'; code: string; message: string }
  /** `refreshing` while a newer read is under way; `error` when it failed and these are the previous pages. */
  | { status: 'ready'; documents: readonly WikiDocumentNode[]; refreshing: boolean; error?: string }

/**
 * How the Wiki is organized, read apart from the page list: a failure here leaves the pages
 * readable, and is stated rather than shown as an unorganized Wiki.
 */
export type WikiStructureState =
  | { status: 'loading' }
  | { status: 'error'; code: string; message: string }
  /** `refreshing` while a newer read is under way; `error` when it failed and this is the previous structure. */
  | { status: 'ready'; structure: WikiStructure; refreshing: boolean; error?: string }

export type WikiPageState =
  | { status: 'loading' }
  /** The Wiki has no such page, or none of it the person can read (`NOT_FOUND`). */
  | { status: 'missing'; message: string }
  | { status: 'error'; message: string }
  | { status: 'ready'; document: WikiDocument; refreshing: boolean; error?: string }

/** Everything the Wiki widget shows, replaced as a whole on every change. */
export type WikiSnapshot = {
  list: WikiListState
  structure: WikiStructureState
  /** Pages read so far, by slug. */
  pages: ReadonlyMap<string, WikiPageState>
  /** Section edits proposed here, by section id. */
  edits: ReadonlyMap<string, SectionEdit>
  /** Page body edits proposed here, by page id. */
  bodyEdits: ReadonlyMap<string, BodyEdit>
}

/** The agent's text of one page, or why it could not be read. */
export type AgentTextResult = { ok: true; text: string } | { ok: false; code: string; message: string }

/** Nothing read yet; one object, so snapshots compare equal. */
export const LOADING_WIKI: WikiSnapshot = { list: { status: 'loading' }, structure: { status: 'loading' }, pages: new Map(), edits: new Map(), bodyEdits: new Map() }
const NOT_CONNECTED = { ok: false, code: 'NOT_CONNECTED', message: 'No connection covers this Wiki any more.' } as const

// Access to the Wiki itself is gone: the credential or the knowledge permission was refused, or the
// connection was removed from the workspace.
const lostAccess = (error: unknown): boolean =>
  ['UNAUTHORIZED', 'FORBIDDEN'].includes(codeOf(error)) || messageOf(error).includes('No such gatekeeper')

type Edit = SectionEdit & { slug: string; queued?: number }
type PageEdit = BodyEdit & { slug: string; queued?: number }

export class WikiData {
  /** The canonical Wiki reference this instance reads. */
  readonly target: string
  readonly #overseer: RpcStub<Overseer>
  readonly #listeners = new Set<() => void>()
  #snapshot: WikiSnapshot = LOADING_WIKI
  readonly #edits = new Map<string, Edit>()
  readonly #bodyEdits = new Map<string, PageEdit>()
  #session?: Promise<RpcStub<InferOpsWikiSession> | null>
  // Orders reads: a result older than the newest read of the same thing never lands.
  #clock = 0
  #listRead = 0
  #structureRead = 0
  readonly #pageReads = new Map<string, number>()
  #disposed = false

  constructor(overseer: RpcStub<Overseer>, targetRef: string) {
    this.#overseer = overseer
    this.target = canonicalBoardRef(targetRef)
    void this.#readList()
    void this.#readStructure()
  }

  get snapshot(): WikiSnapshot {
    return this.#snapshot
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  /** Read a page unless it is already held or being read. */
  openPage(slug: string): void {
    if (this.#disposed || this.#snapshot.pages.has(slug)) return
    void this.#readPage(slug)
  }

  /** Re-read the page list, the structure and every page held, keeping what is shown until the reads land. */
  refresh = (): void => {
    if (this.#disposed) return
    void this.#readList()
    void this.#readStructure()
    for (const slug of this.#snapshot.pages.keys()) void this.#readPage(slug)
  }

  /**
   * Propose replacing a section's Markdown at the version the page was read at. It is pending
   * (`proposing`, then `awaiting` once queued) until a page read made after it was queued shows how
   * it was decided; the page is re-read either way.
   */
  async proposeEdit(slug: string, section: Pick<WikiSection, 'id' | 'body' | 'version' | 'pending'>, body: string): Promise<ProposalResult> {
    if (section.pending || isOpenEdit(this.#edits.get(section.id))) {
      return { ok: false, code: 'CONFLICT', message: 'This section already has an edit that has not taken effect yet.' }
    }
    if (body === section.body) return { ok: false, code: 'UNCHANGED', message: 'Nothing changed.' }
    const edit: Edit = { slug, sectionId: section.id, body, expectedVersion: section.version, phase: 'proposing' }
    this.#putEdit(edit)
    try {
      const session = await this.#sessionOf()
      if (!session) {
        this.#putEdit({ ...edit, phase: 'refused', code: NOT_CONNECTED.code, message: NOT_CONNECTED.message })
        return NOT_CONNECTED
      }
      await session.updateSection(section.id, body, section.version)
      this.#putEdit({ ...edit, phase: 'awaiting', queued: ++this.#clock })
      return { ok: true }
    } catch (error) {
      const code = codeOf(error)
      const message = messageOf(error)
      this.#putEdit({ ...edit, phase: 'refused', code, message })
      return { ok: false, code, message }
    } finally {
      if (!this.#disposed) void this.#readPage(slug)
    }
  }

  /**
   * Propose replacing the page's body at the version the page was read at, decided like a section
   * edit: pending until a page read made after it was queued shows how it was decided (the
   * `pendingBody` overlay keeps it awaiting); the page is re-read either way.
   */
  async proposeBodyEdit(document: Pick<WikiDocument, 'id' | 'slug' | 'body' | 'version' | 'pendingBody'>, body: string): Promise<ProposalResult> {
    if (document.pendingBody || isOpenEdit(this.#bodyEdits.get(document.id))) {
      return { ok: false, code: 'CONFLICT', message: 'This page already has a body edit that has not taken effect yet.' }
    }
    if (body === document.body) return { ok: false, code: 'UNCHANGED', message: 'Nothing changed.' }
    const edit: PageEdit = { slug: document.slug, documentId: document.id, body, expectedVersion: document.version, phase: 'proposing' }
    this.#putBodyEdit(edit)
    try {
      const session = await this.#sessionOf()
      if (!session) {
        this.#putBodyEdit({ ...edit, phase: 'refused', code: NOT_CONNECTED.code, message: NOT_CONNECTED.message })
        return NOT_CONNECTED
      }
      await session.updateDocumentBody(document.id, body, document.version)
      this.#putBodyEdit({ ...edit, phase: 'awaiting', queued: ++this.#clock })
      return { ok: true }
    } catch (error) {
      const code = codeOf(error)
      const message = messageOf(error)
      this.#putBodyEdit({ ...edit, phase: 'refused', code, message })
      return { ok: false, code, message }
    } finally {
      if (!this.#disposed) void this.#readPage(document.slug)
    }
  }

  /** Forget a decided or refused body edit, e.g. when the person starts another. */
  dismissBodyEdit(documentId: string): void {
    const edit = this.#bodyEdits.get(documentId)
    if (!edit || isOpenEdit(edit)) return
    this.#bodyEdits.delete(documentId)
    this.#publish({})
  }

  /** Forget a decided or refused edit, e.g. when the person starts another. */
  dismissEdit(sectionId: string): void {
    const edit = this.#edits.get(sectionId)
    if (!edit || isOpenEdit(edit)) return
    this.#edits.delete(sectionId)
    this.#publish({})
  }

  /** The page as the agent reads it (`readDocumentText`), through the same connection. Each read is an observation. */
  async readAgentText(slug: string): Promise<AgentTextResult> {
    try {
      const session = await this.#sessionOf()
      if (!session) return NOT_CONNECTED
      return { ok: true, text: await session.readDocumentText(slug) }
    } catch (error) {
      return { ok: false, code: codeOf(error), message: messageOf(error) }
    }
  }

  /** Drop the session; late results are discarded. */
  dispose(): void {
    this.#disposed = true
    this.#listeners.clear()
    this.#forgetSession()
  }

  #publish(update: Partial<WikiSnapshot>): void {
    if (this.#disposed) return
    this.#snapshot = { ...this.#snapshot, ...update, edits: new Map(this.#edits), bodyEdits: new Map(this.#bodyEdits) }
    for (const listener of this.#listeners) listener()
  }

  #putEdit(edit: Edit): void {
    this.#edits.set(edit.sectionId, edit)
    this.#publish({})
  }

  #putBodyEdit(edit: PageEdit): void {
    this.#bodyEdits.set(edit.documentId, edit)
    this.#publish({})
  }

  #setPage(slug: string, state: WikiPageState): void {
    this.#publish({ pages: new Map(this.#snapshot.pages).set(slug, state) })
  }

  // Access to the whole Wiki changed: what was read under it is dropped, not shown as current, and
  // no read started before the loss may land after it.
  #lose(list: WikiListState): void {
    this.#forgetSession()
    this.#pageReads.clear()
    this.#listRead = this.#structureRead = ++this.#clock
    this.#publish({ list, structure: { status: 'loading' }, pages: new Map() })
  }

  #failed(error: unknown): boolean {
    if (codeOf(error) === 'DISABLED') {
      this.#lose({ status: 'disabled', message: messageOf(error) })
      return true
    }
    if (messageOf(error).includes('No such gatekeeper')) {
      this.#lose({ status: 'unbound' })
      return true
    }
    if (lostAccess(error)) {
      this.#lose({ status: 'error', code: codeOf(error), message: messageOf(error) })
      return true
    }
    // Re-resolve the connection on the next read rather than reuse a session that just failed.
    this.#forgetSession()
    return false
  }

  async #readList(): Promise<void> {
    const clock = this.#listRead = ++this.#clock
    const before = this.#snapshot.list
    if (before.status === 'ready') this.#publish({ list: { ...before, refreshing: true } })
    try {
      const session = await this.#sessionOf()
      if (this.#disposed || clock !== this.#listRead) return
      if (!session) {
        this.#lose({ status: 'unbound' })
        return
      }
      const documents = await session.listDocuments()
      if (this.#disposed || clock !== this.#listRead) return
      this.#publish({ list: { status: 'ready', documents, refreshing: false } })
    } catch (error) {
      if (this.#disposed || clock !== this.#listRead || this.#failed(error)) return
      const current = this.#snapshot.list
      this.#publish({ list: current.status === 'ready'
        ? { ...current, refreshing: false, error: messageOf(error) }
        : { status: 'error', code: codeOf(error), message: messageOf(error) } })
    }
  }

  async #readStructure(): Promise<void> {
    const clock = this.#structureRead = ++this.#clock
    const current = (): boolean => !this.#disposed && clock === this.#structureRead
    const before = this.#snapshot.structure
    if (before.status === 'ready') this.#publish({ structure: { ...before, refreshing: true } })
    try {
      const session = await this.#sessionOf()
      // No connection is the list's to report; the structure just stays unread.
      if (!current() || !session) return
      const structure = await session.readStructure()
      if (!current()) return
      this.#publish({ structure: { status: 'ready', structure, refreshing: false } })
    } catch (error) {
      if (!current() || this.#failed(error)) return
      const shown = this.#snapshot.structure
      this.#publish({ structure: shown.status === 'ready'
        ? { ...shown, refreshing: false, error: messageOf(error) }
        : { status: 'error', code: codeOf(error), message: messageOf(error) } })
    }
  }

  async #readPage(slug: string): Promise<void> {
    const clock = ++this.#clock
    this.#pageReads.set(slug, clock)
    const current = (): boolean => !this.#disposed && this.#pageReads.get(slug) === clock
    const before = this.#snapshot.pages.get(slug)
    this.#setPage(slug, before?.status === 'ready' ? { ...before, refreshing: true } : before ?? { status: 'loading' })
    try {
      const session = await this.#sessionOf()
      if (!current()) return
      if (!session) {
        this.#lose({ status: 'unbound' })
        return
      }
      const document = await session.readDocument(slug)
      if (!current()) return
      // Only a read started after an edit was queued can say how it was decided.
      for (const edit of this.#edits.values()) {
        if (edit.slug === slug && edit.queued !== undefined && edit.queued < clock) this.#edits.set(edit.sectionId, reconcileEdit(edit, document))
      }
      for (const edit of this.#bodyEdits.values()) {
        if (edit.slug === slug && edit.queued !== undefined && edit.queued < clock) this.#bodyEdits.set(edit.documentId, reconcileBodyEdit(edit, document))
      }
      this.#setPage(slug, { status: 'ready', document, refreshing: false })
    } catch (error) {
      if (!current() || this.#failed(error)) return
      const shown = this.#snapshot.pages.get(slug)
      this.#setPage(slug, codeOf(error) === 'NOT_FOUND' ? { status: 'missing', message: messageOf(error) }
        : shown?.status === 'ready' ? { ...shown, refreshing: false, error: messageOf(error) }
          : { status: 'error', message: messageOf(error) })
    }
  }

  #sessionOf(): Promise<RpcStub<InferOpsWikiSession> | null> {
    if (this.#disposed) return Promise.resolve(null)
    if (!this.#session) {
      const session = (async () => {
        const client = await this.#overseer.getGatekeeperByResourceUrl(this.target)
        if (!client) return null
        try {
          return await client.openSession() as RpcStub<InferOpsWikiSession>
        } finally {
          client[Symbol.dispose]()
        }
      })()
      this.#session = session
      // No binding is not cached: the next read looks the connection up again.
      void session.then(stub => { if (stub === null && this.#session === session) this.#session = undefined }, () => {})
    }
    return this.#session
  }

  #forgetSession(): void {
    const session = this.#session
    if (!session) return
    this.#session = undefined
    void session.then(stub => stub?.[Symbol.dispose](), () => {})
  }
}
