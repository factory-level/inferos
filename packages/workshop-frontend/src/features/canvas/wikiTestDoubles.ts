// A Wiki session double with the gatekeeper's semantics (InferOpsWikiSession in
// gatekeeper-inferops): reads overlay a live pending edit at the section's unchanged version,
// marked `pending: "update"`; an edit is checked against the version and an open edit; approval
// writes the body at the next version and rejection forgets it. Projections use the gatekeeper's
// own functions, so the agent text is built exactly as the gatekeeper builds it.
import { vi } from 'vitest'
import type { InferOpsWikiSession, WikiDocument, WikiDocumentNode, WikiSection } from '@inferos/gatekeeper-inferops/src/types'
import { documentText, embeddedReferences, wikilinksOf } from '@inferos/gatekeeper-inferops/src/wiki'

export type StoredSection = { id: string; documentId: string; tag: string; body: string; version: number }

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

const fail = (code: string, message: string) => { throw new Error(`Error: ${code}: ${message}`) }

export const fakeWiki = () => {
  let documents = wikiPages()
  let sections = wikiSections()
  const edits = new Map<string, { body: string; expectedVersion: number }>()
  const shown = (section: StoredSection): WikiSection => {
    const edit = edits.get(section.id)
    const live = edit !== undefined && edit.expectedVersion === section.version
    const body = live ? edit.body : section.body
    return { id: section.id, tag: section.tag, body, version: section.version, wikilinks: wikilinksOf(body), ...(live ? { pending: 'update' as const } : {}) }
  }
  const page = (slug: string) => {
    const head = documents.find(d => d.slug === slug) ?? fail('NOT_FOUND', 'No such page in this Wiki.')
    return { head, shownSections: sections.filter(s => s.documentId === head.id).map(shown) }
  }
  const session = {
    listDocuments: vi.fn<InferOpsWikiSession['listDocuments']>(async () => documents),
    readDocument: vi.fn<InferOpsWikiSession['readDocument']>(async slug => {
      const { head, shownSections } = page(slug)
      return { id: head.id, slug: head.slug, title: head.title, body: '', version: 1, masterRole: null, sections: shownSections, references: embeddedReferences(shownSections.map(s => s.body)) } satisfies WikiDocument
    }),
    readDocumentText: vi.fn<InferOpsWikiSession['readDocumentText']>(async slug => {
      const { head, shownSections } = page(slug)
      if (shownSections.length === 0) fail('NOT_FOUND', 'No section of this page is readable.')
      return documentText(head.title, shownSections.map(s => s.body))
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
    /** A change made in InferMind, not through this connection. */
    writeElsewhere: (id: string, body: string) => { sections = sections.map(s => s.id === id ? { ...s, body, version: s.version + 1 } : s) },
    setPages: (next: WikiDocumentNode[]) => { documents = next },
  }
}
