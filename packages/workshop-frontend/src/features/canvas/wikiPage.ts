// Pure rules for showing an InferMind Wiki page on the canvas: the page tree, how a section body
// splits into Markdown and embedded references, what each reference names, and how a proposed
// section edit was decided. The page itself comes from the workspace's Wiki connection; InferMind
// stays authoritative. The embed rule is the gatekeeper's own (`embeddedReferences`, ported from
// InferOps), applied paragraph by paragraph, so the page shows exactly the references the
// gatekeeper reports and the agent reads.
import { parseWikiDocumentUrl } from '@inferos/gatekeeper-inferops/src/resources'
import type { WikiDocument, WikiDocumentNode, WikiSection } from '@inferos/gatekeeper-inferops/src/types'
import { documentText, embeddedReferences } from '@inferos/gatekeeper-inferops/src/wiki'
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

/** The page as the agent reads it, from the sections shown: what `readDocumentText` returns for the same read. */
export const pageText = (document: { title: string; sections: readonly Pick<WikiSection, 'body'>[] }): string =>
  documentText(document.title, document.sections.map(section => section.body))

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
 * A section edit proposed from this canvas, until the person moves on. `proposing` while the call
 * is in flight; `awaiting` once queued for approval, not saved; then how the Wiki shows it was
 * decided: `applied` (saved), `rejected`, or `stale` (the section changed in InferMind first, so
 * the edit was not applied). `refused` is a proposal the gatekeeper turned down, with its reason.
 */
export type SectionEdit = {
  sectionId: string
  body: string
  expectedVersion: number
  phase: 'proposing' | 'awaiting' | 'applied' | 'rejected' | 'stale' | 'refused'
  /** The gatekeeper's code for a refused or stale proposal. */
  code?: string
  message?: string
}

/**
 * How an awaiting edit stands in a page read made after it was queued. The gatekeeper shows a live
 * pending edit at the section's unchanged version, marked `pending: "update"`; once decided, a new
 * version with the edit's body was applied, the same version without the mark was rejected, and a
 * new version with another body means the section changed first and the edit no longer applies.
 */
export const reconcileEdit = <E extends SectionEdit>(edit: E, document: WikiDocument): E => {
  if (edit.phase !== 'awaiting') return edit
  const section = document.sections.find(item => item.id === edit.sectionId)
  if (!section) return { ...edit, phase: 'stale', message: 'The section is no longer on this page.' }
  if (section.version === edit.expectedVersion) return section.pending === 'update' ? edit : { ...edit, phase: 'rejected' }
  return section.body === edit.body ? { ...edit, phase: 'applied' } : { ...edit, phase: 'stale' }
}

/** Whether an edit still stands between the person and the section: one in flight or waiting for a decision. */
export const isOpenEdit = (edit: SectionEdit | undefined): boolean => edit?.phase === 'proposing' || edit?.phase === 'awaiting'

/** What a refused or stale edit tells the person, by the gatekeeper's code. */
export const editErrorText = (edit: SectionEdit): string => {
  if (edit.phase === 'stale') {
    return edit.message ?? 'Not saved: the section changed in InferMind before this edit was decided. The page shows the current text; edit it again.'
  }
  switch (edit.code) {
    case 'STALE_REVISION': return 'Not sent: the section changed since the page was read. The page was read again; edit the current text.'
    case 'CONFLICT': return `Not sent: ${edit.message ?? 'another edit of this section is waiting for a decision.'}`
    case 'FORBIDDEN': return `Not sent: ${edit.message ?? 'you cannot edit this Wiki.'}`
    case 'NOT_FOUND': return 'Not sent: the section is no longer in this Wiki.'
    case 'DISABLED': return 'Not sent: InferOps is turned off for this deployment.'
    default: return `Not sent: ${edit.message ?? 'the edit could not be proposed.'}`
  }
}
