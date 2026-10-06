import { expect, it } from 'vitest'
import type { WikiDocument, WikiDocumentNode } from '@inferos/gatekeeper-inferops/src/types'
import { documentText, embeddedReferences } from '@inferos/gatekeeper-inferops/src/wiki'
import demo from '@inferos/gatekeeper-inferops/src/fixtures/demo-wiki.json'
import { firstPage, pageReferences, pageText, parseWikiReference, reconcileEdit, sectionBlocks, wikiTree, type SectionEdit } from './wikiPage'

const node = (slug: string, parentId: string | null, siblingOrder: number, title = slug): WikiDocumentNode =>
  ({ id: slug, slug, title, parentId, siblingOrder })

const shape = (nodes: ReturnType<typeof wikiTree>): unknown => nodes.map(n => n.children.length ? [n.page.slug, shape(n.children)] : n.page.slug)

it('builds the page tree by parent and sibling order, keeping pages whose parent is not listed or that form a cycle', () => {
  const tree = wikiTree([
    node('release', 'handbook', 1), node('handbook', null, 0), node('onboarding', 'handbook', 0),
    node('orphan', 'unreadable-parent', 0), node('drafts', null, 1), node('a', 'b', 0), node('b', 'a', 0),
  ])
  expect(shape(tree)).toEqual([['handbook', ['onboarding', 'release']], 'orphan', 'drafts', ['a', ['b']]])
  expect(firstPage(tree)).toBe('handbook')
  expect(firstPage([])).toBeNull()
})

it('splits a section into Markdown runs and the references the gatekeeper reports, by the same rule', () => {
  const body = 'Intro with [an inline link](inferops://demo.local/project/board/DEMO).\n\nMore prose.\n\n[DEMO board](inferops://demo.local/project/board/DEMO)\n\n  \n[ENG-4](inferops://acme.ops/project/issue-card/ENG-4)\n\nAfter.'
  expect(sectionBlocks(body)).toEqual([
    { type: 'markdown', text: 'Intro with [an inline link](inferops://demo.local/project/board/DEMO).\n\nMore prose.' },
    { type: 'embed', label: 'DEMO board', href: 'inferops://demo.local/project/board/DEMO' },
    { type: 'embed', label: 'ENG-4', href: 'inferops://acme.ops/project/issue-card/ENG-4' },
    { type: 'markdown', text: 'After.' },
  ])
  // Every fixture page: what the page shows as embeds is exactly what the gatekeeper reports.
  for (const document of demo.documents) {
    const sections = demo.sections.filter(section => section.documentId === document.id)
    expect(pageReferences(sections)).toEqual(embeddedReferences(sections.map(section => section.body)))
  }
})

it('builds the agent text from the sections shown exactly as the gatekeeper does', () => {
  const page = { title: 'Team handbook', sections: demo.sections.filter(s => s.documentId === demo.documents[0]!.id) }
  expect(pageText(page)).toBe(documentText(page.title, page.sections.map(s => s.body)))
})

it('says what each reference names, and names nothing it cannot show', () => {
  expect(parseWikiReference('inferops://Demo.Local/project/board/DEMO?workflow="content"'))
    .toEqual({ kind: 'board', href: 'inferops://Demo.Local/project/board/DEMO?workflow="content"', boardRef: 'inferops://demo.local/project/board/DEMO', workflow: 'content' })
  expect(parseWikiReference('inferops://acme.ops/project/issue-card/ENG-12'))
    .toMatchObject({ kind: 'issue', boardRef: 'inferops://acme.ops/project/board/ENG', identifier: 'ENG-12' })
  expect(parseWikiReference('inferops://acme.kb/knowledge/document/handbook')).toMatchObject({ kind: 'page', host: 'acme.kb', slug: 'handbook' })
  for (const href of ['inferops://acme.ops/project/board-summary/ENG', 'inferops://acme.ops/project/issue-card/not-a-key',
    'inferops://acme.ops/project/board/ENG/extra', 'inferops://acme/project/board/ENG', 'https://acme.ops/project/board/ENG', 'not a url']) {
    expect(parseWikiReference(href)).toEqual({ kind: 'unsupported', href })
  }
})

const page = (section: Partial<WikiDocument['sections'][number]> | null): WikiDocument => ({ id: 'd', slug: 'd', title: 'D', body: '', version: 1, masterRole: null, references: [],
  sections: section ? [{ id: 's', tag: 't', body: 'old', version: 3, wikilinks: [], ...section }] : [] })

it('decides an awaiting edit only from the page: pending, applied, rejected or stale', () => {
  const edit: SectionEdit = { sectionId: 's', body: 'new', expectedVersion: 3, phase: 'awaiting' }
  expect(reconcileEdit(edit, page({ body: 'new', pending: 'update' })).phase).toBe('awaiting')
  expect(reconcileEdit(edit, page({ body: 'new', version: 4 })).phase).toBe('applied')
  expect(reconcileEdit(edit, page({})).phase).toBe('rejected')
  expect(reconcileEdit(edit, page({ body: 'someone else', version: 4 })).phase).toBe('stale')
  expect(reconcileEdit(edit, page(null))).toMatchObject({ phase: 'stale', message: 'The section is no longer on this page.' })
  expect(reconcileEdit({ ...edit, phase: 'proposing' }, page({})).phase).toBe('proposing')
})
