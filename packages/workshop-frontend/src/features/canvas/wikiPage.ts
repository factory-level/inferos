// Pure rules for showing an InferMind Wiki page on the canvas: the navigation (the Wiki structure,
// or the page tree), what a page reads as, how Markdown splits into prose and embedded references,
// what each reference names, and how a proposed edit was decided. The page itself comes from the
// workspace's Wiki connection; InferMind stays authoritative. What a page reads as is the
// gatekeeper's own page contract (`authoredContent`, `masterStructureText`, `composeDocumentText`,
// ported from InferOps), and the embed rule its `embeddedReferences`, applied paragraph by
// paragraph, so the page shows exactly what the gatekeeper reports and the agent reads.
import { parseWikiDocumentUrl } from '@inferos/gatekeeper-inferops/src/resources'
import type { WikiDocument, WikiDocumentNode, WikiSection, WikiStructure, WikiStructurePage } from '@inferos/gatekeeper-inferops/src/types'
import { authoredContent, composeDocumentText, embeddedReferences, masterStructureText } from '@inferos/gatekeeper-inferops/src/wiki'
import { canonicalBoardRef } from './boardData'

/** One page in the tree, with the pages under it in order. */
export type WikiTreeNode = { page: WikiDocumentNode; children: WikiTreeNode[] }

const byOrder = (a: WikiDocumentNode, b: WikiDocumentNode) => a.siblingOrder - b.siblingOrder || a.title.localeCompare(b.title)

/**
 * The page tree: children under their parent by `siblingOrder`, then title. A page whose parent is
 * not listed (one the person cannot open) is shown at the top level rather than hidden, and a
 * parent cycle cannot hide a page either.
 */
export const wikiTree = (documents: readonly WikiDocumentNode[]): WikiTreeNode[] => {
  const ids = new Set(documents.map(page => page.id))
  const children = new Map<string | null, WikiDocumentNode[]>()
  for (const page of documents) {
    const parent = page.parentId !== null && ids.has(page.parentId) && page.parentId !== page.id ? page.parentId : null
    children.set(parent, [...children.get(parent) ?? [], page])
  }
  const placed = new Set<string>()
  const node = (page: WikiDocumentNode): WikiTreeNode => {
    placed.add(page.id)
    return { page, children: (children.get(page.id) ?? []).toSorted(byOrder)
      .flatMap(child => placed.has(child.id) ? [] : [node(child)]) }
  }
  const tree = (children.get(null) ?? []).toSorted(byOrder).map(node)
  // Pages reachable only through a cycle among themselves start a top-level branch of their own.
  for (const page of documents.toSorted(byOrder)) if (!placed.has(page.id)) tree.push(node(page))
  return tree
}

/** The page shown when nothing is chosen: the first top-level page. */
export const firstPage = (tree: readonly WikiTreeNode[]): string | null => tree[0]?.page.slug ?? null

/** A pillar as the navigation shows it: its Master, then the pages it files, each marked when another pillar files it too. */
export type WikiNavPillar = {
  key: string
  title: string
  master: WikiStructurePage | null
  members: { page: WikiStructurePage; shared: boolean }[]
}

/**
 * How the Wiki is navigated: by its structure (the company root, each pillar's Master with the pages
 * it files, then the unfiled pages) once it is organized, else by the page tree.
 */
export type WikiNavigation =
  | { kind: 'tree'; tree: WikiTreeNode[] }
  | { kind: 'structure'; root: WikiStructurePage | null; pillars: WikiNavPillar[]; unfiled: WikiStructurePage[] }

/**
 * The navigation for the pages listed. A Wiki with no root and no pillars is not organized, and is
 * navigated by its tree, as is one whose structure is not read. The two reads are separate, so the
 * list decides what can be opened: a structure page the list does not hold is left out, and a listed
 * page the structure does not place is shown with the unfiled pages rather than hidden.
 */
export const wikiNavigation = (documents: readonly WikiDocumentNode[], structure: WikiStructure | null): WikiNavigation => {
  if (!structure || (structure.root === null && structure.pillars.length === 0)) return { kind: 'tree', tree: wikiTree(documents) }
  const listed = new Set(documents.map(page => page.id))
  const shown = <P extends WikiStructurePage>(page: P | null): P | null => page && listed.has(page.id) ? page : null
  const filings = new Map<string, number>()
  const pillars = structure.pillars.toSorted((a, b) => a.position - b.position).map(pillar => {
    const members = pillar.members.filter(member => listed.has(member.id))
    for (const member of members) filings.set(member.id, (filings.get(member.id) ?? 0) + 1)
    return { key: pillar.key, title: pillar.title, master: shown(pillar.master), members }
  })
  const root = shown(structure.root)
  const unfiled = structure.unfiled.filter(page => listed.has(page.id))
  const placed = new Set([root, ...pillars.flatMap(pillar => [pillar.master, ...pillar.members]), ...unfiled]
    .flatMap(page => page ? [page.id] : []))
  for (const page of documents.toSorted(byOrder)) {
    if (!placed.has(page.id)) unfiled.push({ id: page.id, slug: page.slug, title: page.title, parentId: page.parentId })
  }
  return {
    kind: 'structure', root, unfiled,
    pillars: pillars.map(pillar => ({ ...pillar, members: pillar.members.map(page => ({ page, shared: (filings.get(page.id) ?? 0) > 1 })) })),
  }
}

/** The page shown when nothing is chosen: the company root, else the first Master or filed page, else the first page. */
export const firstNavigationPage = (navigation: WikiNavigation): string | null => navigation.kind === 'tree'
  ? firstPage(navigation.tree)
  : (navigation.root ?? navigation.pillars.flatMap(pillar => [pillar.master, ...pillar.members.map(member => member.page)]).find(page => page !== null)
    ?? navigation.unfiled[0])?.slug ?? null

/**
 * The page's authored body as it reads (without a leading heading repeating the title), or null when
 * it has none and reads as its sections. A page with a body never reads as its sections as well.
 */
export const authoredBody = (document: Pick<WikiDocument, 'title' | 'body'>): string | null =>
  document.body.trim() ? authoredContent(document.title, { body: document.body, visibleSections: [] })[0] ?? '' : null

/** A Master's generated block, the gatekeeper's own: null for any other page, and for a pillar Master no pillar names. */
export const generatedBlock = (document: Pick<WikiDocument, 'id' | 'masterRole'>, structure: WikiStructure): string | null =>
  masterStructureText(document, structure)

/**
 * Whether the page's body may be edited: any page that is not a Master, and a Master that has a body.
 * A Master without one reads only as its generated block.
 */
export const bodyEditable = (document: Pick<WikiDocument, 'masterRole' | 'body'>): boolean =>
  document.masterRole === null || document.body.trim() !== ''

const WIKI_PAGE_PATH = /^\/wiki\/([^/?#]+)$/

/** The slug a Wiki route (`wikiPagePath`, as a generated block links pages) names, or null for any other link. */
export const wikiPageSlug = (href: string | undefined): string | null => {
  const encoded = href === undefined ? undefined : WIKI_PAGE_PATH.exec(href)?.[1]
  if (encoded === undefined) return null
  try { return decodeURIComponent(encoded) } catch { return null }
}

/** A section body in display order: Markdown runs, and the references that stand alone as a paragraph. */
export type WikiBlock = { type: 'markdown'; text: string } | { type: 'embed'; label: string; href: string }

const PARAGRAPH_SPLIT = /\r?\n[ \t]*\r?\n/
const LABEL = /^\[([^\]]*)\]/

export const sectionBlocks = (body: string): WikiBlock[] => {
  const blocks: WikiBlock[] = []
  for (const paragraph of body.split(PARAGRAPH_SPLIT)) {
    const href = embeddedReferences([paragraph])[0]
    if (href !== undefined) {
      blocks.push({ type: 'embed', label: LABEL.exec(paragraph.trim())?.[1] ?? '', href })
      continue
    }
    const last = blocks.at(-1)
    if (last?.type === 'markdown') last.text += `\n\n${paragraph}`
    else blocks.push({ type: 'markdown', text: paragraph })
  }
  return blocks.filter(block => block.type === 'embed' || block.text.trim() !== '')
}

/** The references the page shows, each once, in order: what the gatekeeper reports as `references`. */
export const pageReferences = (sections: readonly Pick<WikiSection, 'body'>[]): string[] =>
  [...new Set(sections.flatMap(section => sectionBlocks(section.body))
    .flatMap(block => block.type === 'embed' ? [block.href] : []))]

/**
 * The page as the agent reads it, from what is shown: what `readDocumentText` returns for the same
 * reads. `structure` is needed only for a Master; without it a Master's text cannot be built (null),
 * as it is null for a page with nothing to read.
 */
export const pageText = (document: Pick<WikiDocument, 'id' | 'title' | 'body' | 'masterRole' | 'sections'>, structure: WikiStructure | null): string | null =>
  document.masterRole !== null && structure === null ? null : composeDocumentText(document.title, {
    body: document.body, visibleSections: document.sections.map(section => section.body),
    generated: structure ? masterStructureText(document, structure) : null,
  })

/** What an embedded reference names. Naming grants nothing: each is resolved through its own connection. */
export type WikiReference =
  /** A project board (`project/board/<KEY>`), shown as the live Kanban. */
  | { kind: 'board'; href: string; boardRef: string; workflow: 'software' | 'content' }
  /** One issue (`project/issue-card/<KEY>-<n>`), read from its project's board. */
  | { kind: 'issue'; href: string; boardRef: string; identifier: string }
  /** A Wiki page (`knowledge/document/<slug>`). */
  | { kind: 'page'; href: string; host: string; slug: string }
  /** Anything else InferOps can embed that this canvas does not show. */
  | { kind: 'unsupported'; href: string }

const KEY = /^[A-Za-z0-9_-]+$/
// InferOps' `projectIdentifierOf`: the project key is the issue key before its number.
const ISSUE_KEY = /^([A-Za-z0-9]+)-\d+$/

export const parseWikiReference = (href: string): WikiReference => {
  const page = parseWikiDocumentUrl(href)
  if (page) return { kind: 'page', href, host: page.host.toLowerCase(), slug: page.slug }
  let url: URL
  try { url = new URL(href) } catch { return { kind: 'unsupported', href } }
  const host = url.hostname.toLowerCase()
  const segments = url.pathname.split('/').filter(Boolean)
  if (url.protocol !== 'inferops:' || host.split('.').length !== 2 || segments.length !== 3 || segments[0] !== 'project') {
    return { kind: 'unsupported', href }
  }
  const [, widget, id] = segments as [string, string, string]
  if (widget === 'board' && KEY.test(id)) {
    const workflow = url.searchParams.get('workflow')?.replace(/^["']|["']$/g, '') === 'content' ? 'content' : 'software'
    return { kind: 'board', href, boardRef: canonicalBoardRef(`inferops://${host}/project/board/${id}`), workflow }
  }
  const project = widget === 'issue-card' ? ISSUE_KEY.exec(id)?.[1] : undefined
  if (project) return { kind: 'issue', href, boardRef: `inferops://${host}/project/board/${project}`, identifier: id }
  return { kind: 'unsupported', href }
}

/**
 * An edit proposed from this canvas, until the person moves on. `proposing` while the call is in
 * flight; `awaiting` once queued for approval, not saved; then how the Wiki shows it was decided:
 * `applied` (saved), `rejected`, or `stale` (the text changed in InferMind first, so the edit was not
 * applied). `matched` is a body edit whose page moved on to the proposed text: matching text does not
 * show that this approval wrote it (another writer may have), so it is never called saved. `refused`
 * is a proposal the gatekeeper turned down, with its reason.
 */
export type ProposedEdit = {
  body: string
  expectedVersion: number
  phase: 'proposing' | 'awaiting' | 'applied' | 'matched' | 'rejected' | 'stale' | 'refused'
  /** The gatekeeper's code for a refused or stale proposal. */
  code?: string
  message?: string
}

/** A section edit (`updateSection`), at the section's version. */
export type SectionEdit = ProposedEdit & { sectionId: string }

/**
 * A page body edit (`updateDocumentBody`), at the page's version. `approved` is set when this
 * session saw the approval it raised decided as approved (see {@link bodyEditActionTitle}).
 */
export type BodyEdit = ProposedEdit & { documentId: string; approved?: boolean }

/**
 * The title the InferOps gatekeeper gives the approval a body edit of the page titled `title`
 * raises (`updateDocumentBody`: `sanitizeTitle(\`Edit Wiki page ${title}\`)`). The proposal returns
 * no action id, so this, the Wiki reference and the order the records arrive in correlate the two.
 */
export const bodyEditActionTitle = (title: string): string => `Edit Wiki page ${title}`.replace(/[\r\n]+/g, ' ').slice(0, 200)

// Shared by both kinds: the gatekeeper overlays a live pending edit at the unchanged version; once
// decided, a new version with the edit's body was applied, the same version without the mark was
// rejected, and a new version with another body means the text changed first.
const decided = <E extends ProposedEdit>(edit: E, shown: { version: number; body: string; pending: boolean }): E => {
  if (shown.version === edit.expectedVersion) return shown.pending ? edit : { ...edit, phase: 'rejected' }
  return shown.body === edit.body ? { ...edit, phase: 'applied' } : { ...edit, phase: 'stale' }
}

/**
 * How an awaiting section edit stands in a page read made after it was queued: the section's
 * overlay is `pending: "update"`.
 */
export const reconcileEdit = <E extends SectionEdit>(edit: E, document: WikiDocument): E => {
  if (edit.phase !== 'awaiting') return edit
  const section = document.sections.find(item => item.id === edit.sectionId)
  if (!section) return { ...edit, phase: 'stale', message: 'The section is no longer on this page.' }
  return decided(edit, { version: section.version, body: section.body, pending: section.pending === 'update' })
}

/**
 * How an awaiting body edit stands in a read of its page made after it was queued: the page's
 * overlay is `pendingBody`. A new version showing the edit's body is `applied` only when the
 * edit's own approval was seen approved: InferOps' compare-and-swap means a different writer's
 * same text fails this approval, and the page read alone cannot tell the two apart, so without it
 * the edit is only `matched`.
 */
export const reconcileBodyEdit = <E extends BodyEdit>(edit: E, document: WikiDocument): E => {
  if (edit.phase !== 'awaiting') return edit
  if (document.id !== edit.documentId) return { ...edit, phase: 'stale', message: 'The page is no longer in this Wiki.' }
  const outcome = decided(edit, { version: document.version, body: document.body, pending: document.pendingBody === true })
  return outcome.phase === 'applied' && !edit.approved ? { ...outcome, phase: 'matched' } : outcome
}

/** Whether an edit still stands between the person and the text: one in flight or waiting for a decision. */
export const isOpenEdit = (edit: ProposedEdit | undefined): boolean => edit?.phase === 'proposing' || edit?.phase === 'awaiting'

/** What an edit that is not refused or stale means for the person, in words that never call it saved before it was applied. */
export const editStatus = (edit: ProposedEdit | undefined): { label: string; variant: 'warning' | 'success' | 'neutral' } | null => {
  switch (edit?.phase) {
    case 'proposing': return { label: 'Sending for approval…', variant: 'neutral' }
    case 'awaiting': return { label: 'Waiting for approval, not saved yet', variant: 'warning' }
    case 'applied': return { label: 'Saved', variant: 'success' }
    case 'matched': return { label: 'The page now has this text', variant: 'neutral' }
    case 'rejected': return { label: 'Rejected, not saved', variant: 'neutral' }
    default: return null
  }
}

/** What a refused or stale edit tells the person, by the gatekeeper's code; `subject` is what was edited. */
export const editErrorText = (edit: ProposedEdit, subject: 'section' | 'page' = 'section'): string => {
  if (edit.phase === 'stale') {
    return edit.message ?? `Not saved: the ${subject} changed in InferMind before this edit was decided. The page shows the current text; edit it again.`
  }
  switch (edit.code) {
    case 'STALE_REVISION': return `Not sent: the ${subject} changed since the page was read. The page was read again; edit the current text.`
    case 'CONFLICT': return `Not sent: ${edit.message ?? `another edit of this ${subject} is waiting for a decision.`}`
    case 'FORBIDDEN': return `Not sent: ${edit.message ?? 'you cannot edit this Wiki.'}`
    case 'NOT_FOUND': return `Not sent: the ${subject} is no longer in this Wiki.`
    case 'DISABLED': return 'Not sent: InferOps is turned off for this deployment.'
    default: return `Not sent: ${edit.message ?? 'the edit could not be proposed.'}`
  }
}
