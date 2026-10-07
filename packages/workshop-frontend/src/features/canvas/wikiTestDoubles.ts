// A Wiki session double with the gatekeeper's semantics (InferOpsWikiSession in
// gatekeeper-inferops): reads overlay a live pending edit at the unchanged version, marked
// `pending: "update"` on a section and `pendingBody` on a page; an edit is checked against the
// version and an open edit; approval writes the text at the next version and rejection forgets it.
// Projections use the gatekeeper's own functions, so the agent text is built exactly as the
// gatekeeper builds it (the page contract: body, else sections, then a Master's generated block).
import { vi } from 'vitest'
import type { InferOpsWikiSession, WikiDocument, WikiDocumentNode, WikiSection, WikiStructure } from '@inferos/gatekeeper-inferops/src/types'
import { authoredContent, composeDocumentText, embeddedReferences, masterStructureText, wikilinksOf } from '@inferos/gatekeeper-inferops/src/wiki'

export type StoredSection = { id: string; documentId: string; tag: string; body: string; version: number }
export type StoredPage = WikiDocumentNode & Pick<WikiDocument, 'body' | 'version' | 'masterRole'>

export const WIKI = 'inferops://acme.kb/knowledge/wiki'

export const wikiPages = (): WikiDocumentNode[] => [
  { id: 'd1', slug: 'handbook', title: 'Team handbook', parentId: null, siblingOrder: 0 },
  { id: 'd2', slug: 'release-process', title: 'Release process', parentId: 'd1', siblingOrder: 1 },
  { id: 'd3', slug: 'onboarding', title: 'Onboarding', parentId: 'd1', siblingOrder: 0 },
  { id: 'd4', slug: 'drafts', title: 'Drafts', parentId: null, siblingOrder: 1 },
]

export const wikiSections = (): StoredSection[] => [
  { id: 's1', documentId: 'd1', tag: 'purpose', body: '## Purpose\n\nHow the team **works**. <script>alert(1)</script><b>raw</b>\n\nSee [x](javascript:alert(1)), [y](data:text/html,hi) and [the docs](https://example.com/docs).', version: 1 },
  { id: 's2', documentId: 'd1', tag: 'current-work', version: 3,
    body: 'Work is on the board.\n\n[ENG board](inferops://acme.ops/project/board/ENG)\n\n[ENG-1](inferops://acme.ops/project/issue-card/ENG-1)\n\n[OPS-2](inferops://other.ops/project/issue-card/OPS-2)\n\n[Onboarding](inferops://acme.kb/knowledge/document/onboarding)' },
  { id: 's3', documentId: 'd3', tag: 'first-week', body: 'Pair on one small issue.', version: 1 },
]

/** An unorganized Wiki: no root and no pillars, so it is navigated by its tree. */
export const EMPTY_STRUCTURE: WikiStructure = { root: null, pillars: [], unfiled: [] }

const plainPages = (): StoredPage[] => wikiPages().map(page => ({ ...page, body: '', version: 1, masterRole: null }))
const at = ({ id, slug, title, parentId }: WikiDocumentNode) => ({ id, slug, title, parentId })

/**
 * The same Wiki once onboarded: a company root with a body, an Engineering Master without one, an
 * Operations Master with one, and an Incident response SOP with a body (whose leading heading
 * repeats its title) and a section, filed in both pillars. The first four pages stay unfiled.
 */
export const organizedWiki = () => {
  const pages: StoredPage[] = [
    ...plainPages(),
    { id: 'r1', slug: 'company', title: 'Acme', parentId: null, siblingOrder: 2, body: 'Acme builds **bridges**.', version: 2, masterRole: 'root' },
    { id: 'm1', slug: 'engineering', title: 'Engineering', parentId: 'r1', siblingOrder: 0, body: '', version: 1, masterRole: 'pillar' },
    { id: 'm2', slug: 'operations', title: 'Operations', parentId: 'r1', siblingOrder: 1, body: 'How the team runs day to day.', version: 3, masterRole: 'pillar' },
    { id: 'p1', slug: 'ops/incident-response', title: 'Incident response', parentId: 'm2', siblingOrder: 0, version: 4, masterRole: null,
      body: '# Incident response\n\n1. Page the on-call engineer.\n2. Write the timeline.\n\n[ENG board](inferops://acme.ops/project/board/ENG)' },
  ]
  const byId = (id: string) => at(pages.find(page => page.id === id)!)
  const structure: WikiStructure = {
    root: byId('r1'),
    pillars: [
      { key: 'engineering', title: 'Engineering', position: 0, master: byId('m1'),
        members: [{ ...byId('p1'), source: 'human' }, { ...byId('d2'), source: 'intake' }] },
      { key: 'operations', title: 'Operations', position: 1, master: byId('m2'), members: [{ ...byId('p1'), source: 'intake' }] },
    ],
    unfiled: ['d1', 'd3', 'd4'].map(byId),
  }
  const sections: StoredSection[] = [...wikiSections(), { id: 's9', documentId: 'p1', tag: 'index-only', body: 'Section text that is never part of the page.', version: 1 }]
  return { pages, structure, sections }
}

const fail = (code: string, message: string) => { throw new Error(`Error: ${code}: ${message}`) }

export const fakeWiki = (seed: { pages?: StoredPage[]; structure?: WikiStructure; sections?: StoredSection[] } = {}) => {
  let documents = seed.pages ?? plainPages()
  let sections = seed.sections ?? wikiSections()
  let structure = seed.structure ?? EMPTY_STRUCTURE
  const edits = new Map<string, { body: string; expectedVersion: number }>()
  const bodyEdits = new Map<string, { body: string; expectedVersion: number }>()
  const shown = (section: StoredSection): WikiSection => {
    const edit = edits.get(section.id)
    const live = edit !== undefined && edit.expectedVersion === section.version
    const body = live ? edit.body : section.body
    return { id: section.id, tag: section.tag, body, version: section.version, wikilinks: wikilinksOf(body), ...(live ? { pending: 'update' as const } : {}) }
  }
  const page = (slugOrId: string) => {
    const head = documents.find(d => d.slug === slugOrId || d.id === slugOrId) ?? fail('NOT_FOUND', 'No such page in this Wiki.')
    const edit = bodyEdits.get(head.id)
    const live = edit !== undefined && edit.expectedVersion === head.version ? edit : undefined
    return { head, body: live?.body ?? head.body, pendingBody: live !== undefined, shownSections: sections.filter(s => s.documentId === head.id).map(shown) }
  }
  const session = {
    listDocuments: vi.fn<InferOpsWikiSession['listDocuments']>(async () =>
      documents.map(({ id, slug, title, parentId, siblingOrder }) => ({ id, slug, title, parentId, siblingOrder }))),
    readStructure: vi.fn<InferOpsWikiSession['readStructure']>(async () => structure),
    readDocument: vi.fn<InferOpsWikiSession['readDocument']>(async slug => {
      const { head, body, pendingBody, shownSections } = page(slug)
      return { id: head.id, slug: head.slug, title: head.title, body, version: head.version, masterRole: head.masterRole,
        ...(pendingBody ? { pendingBody: true as const } : {}), sections: shownSections,
        references: embeddedReferences(authoredContent(head.title, { body, visibleSections: shownSections.map(s => s.body) })) } satisfies WikiDocument
    }),
    readDocumentText: vi.fn<InferOpsWikiSession['readDocumentText']>(async slug => {
      const { head, body, shownSections } = page(slug)
      const text = composeDocumentText(head.title, { body, visibleSections: shownSections.map(s => s.body),
        generated: head.masterRole === null ? null : masterStructureText(head, structure) })
      return text ?? fail('NOT_FOUND', 'Nothing on this page is readable.')
    }),
    updateDocumentBody: vi.fn<InferOpsWikiSession['updateDocumentBody']>(async (slugOrId, body, expectedVersion) => {
      const { head, body: current, pendingBody } = page(slugOrId)
      if (head.version !== expectedVersion) fail('STALE_REVISION', `Page ${head.slug} is at version ${head.version}, not ${expectedVersion}. Read it again.`)
      if (current === body) return
      if (pendingBody) fail('CONFLICT', `Page ${head.slug} already has a body edit that has not taken effect yet.`)
      bodyEdits.set(head.id, { body, expectedVersion })
    }),
    updateSection: vi.fn<InferOpsWikiSession['updateSection']>(async (id, body, expectedVersion) => {
      const stored = sections.find(s => s.id === id) ?? fail('NOT_FOUND', 'No such section in this Wiki.')
      if (stored.version !== expectedVersion) fail('STALE_REVISION', `Section ${stored.tag} is at version ${stored.version}, not ${expectedVersion}. Read it again.`)
      if (edits.get(id)?.expectedVersion === stored.version) fail('CONFLICT', `Section ${stored.tag} already has an edit that has not taken effect yet.`)
      edits.set(id, { body, expectedVersion })
    }),
    dispose: vi.fn<() => void>(),
    [Symbol.dispose]() { session.dispose() },
  }
  return {
    session,
    approve: (id: string) => {
      const edit = edits.get(id)!
      edits.delete(id)
      sections = sections.map(s => s.id === id ? { ...s, body: edit.body, version: s.version + 1 } : s)
    },
    reject: (id: string) => { edits.delete(id) },
    /** Decide a page's pending body edit, by page id. */
    approveBody: (id: string) => {
      const edit = bodyEdits.get(id)!
      bodyEdits.delete(id)
      documents = documents.map(d => d.id === id ? { ...d, body: edit.body, version: d.version + 1 } : d)
    },
    rejectBody: (id: string) => { bodyEdits.delete(id) },
    /** A change made in InferMind, not through this connection. */
    writeElsewhere: (id: string, body: string) => { sections = sections.map(s => s.id === id ? { ...s, body, version: s.version + 1 } : s) },
    /** A page body changed in InferMind, not through this connection. */
    writeBodyElsewhere: (id: string, body: string) => { documents = documents.map(d => d.id === id ? { ...d, body, version: d.version + 1 } : d) },
    setPages: (next: WikiDocumentNode[]) => {
      documents = next.map(node => ({ body: '', version: 1, masterRole: null, ...documents.find(d => d.id === node.id), ...node }))
    },
    setStructure: (next: WikiStructure) => { structure = next },
  }
}
