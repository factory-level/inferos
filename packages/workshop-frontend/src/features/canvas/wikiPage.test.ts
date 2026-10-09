import { expect, it } from 'vitest'
import type { WikiDocument, WikiDocumentNode } from '@inferos/gatekeeper-inferops/src/types'
import { authoredContent, composeDocumentText, documentText, embeddedReferences, masterStructureText, wikiPagePath } from '@inferos/gatekeeper-inferops/src/wiki'
import demo from '@inferos/gatekeeper-inferops/src/fixtures/demo-wiki.json'
import {
  agentTextShown, authoredBody, bodyEditable, editErrorText, firstNavigationPage, firstPage, pageReferences, pageText, parseWikiReference, reconcileBodyEdit,
  reconcileEdit, sectionBlocks, wikiNavigation, wikiPageSlug, wikiTree, type BodyEdit, type SectionEdit,
} from './wikiPage'
import { EMPTY_STRUCTURE, organizedWiki, wikiPages } from './wikiTestDoubles'

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

const demoPage = (slug: string): WikiDocument => {
  const document = demo.documents.find(page => page.slug === slug)!
  const sections = demo.sections.filter(s => s.documentId === document.id).map(s => ({ ...s, wikilinks: [] }))
  return { ...document, masterRole: document.masterRole as WikiDocument['masterRole'], sections, references: [] }
}

it('builds the agent text from the sections shown, for a page without a body, exactly as the gatekeeper does', () => {
  const page = demoPage('handbook')
  expect(pageText(page, null)).toBe(documentText(page.title, page.sections.map(s => s.body)))
})

it('reads a page as its body when it has one, never with its sections, keeping a heading other than the title', () => {
  // Every fixture page: what the page renders as its body is exactly the gatekeeper's authored content.
  for (const { slug } of demo.documents) {
    const page = demoPage(slug)
    expect(authoredBody(page)).toBe(page.body.trim() ? authoredContent(page.title, { body: page.body, visibleSections: [] })[0] : null)
  }
  expect(authoredBody(demoPage('incident-response'))).toMatch(/^1\. Page the on-call engineer\./)
  expect(authoredBody(demoPage('dispatch/dispatch-a-crew'))).toMatch(/^# Before you start/)
  // Onboarding has a body and a section: it reads as its body alone.
  const onboarding = demoPage('onboarding')
  expect(onboarding.sections).toHaveLength(1)
  expect(pageText(onboarding, null)).toBe(`# Onboarding\n\n${onboarding.body}`)
})

it('composes a Master\'s text with the gatekeeper\'s generated block, and none without the structure', () => {
  const { structure } = organizedWiki()
  const root = { id: 'r1', slug: 'company', title: 'Acme', body: 'Acme builds **bridges**.', version: 2, masterRole: 'root' as const, sections: [], references: [] }
  expect(pageText(root, structure)).toBe(composeDocumentText('Acme', { body: root.body, visibleSections: [], generated: masterStructureText(root, structure) }))
  expect(pageText(root, structure)).toContain(`- [Engineering](${wikiPagePath('engineering')})`)
  expect(pageText(root, null)).toBeNull()
})

it('navigates an organized Wiki by root, Masters in pillar order with their pages, then unfiled pages', () => {
  const { pages, structure } = organizedWiki()
  const reversed = { ...structure, pillars: structure.pillars.toReversed() }
  const navigation = wikiNavigation(pages, reversed)
  if (navigation.kind !== 'structure') throw new Error('expected the structure')
  expect(navigation.root?.slug).toBe('company')
  expect(navigation.pillars.map(pillar => [pillar.master?.slug, pillar.members.map(m => [m.page.slug, m.shared])])).toEqual([
    ['engineering', [['ops/incident-response', true], ['release-process', false]]],
    ['operations', [['ops/incident-response', true]]],
  ])
  expect(navigation.unfiled.map(page => page.slug)).toEqual(['handbook', 'onboarding', 'drafts'])
  expect(firstNavigationPage(navigation)).toBe('company')
})

it('keeps navigation to the pages listed: a structure page not listed is left out, a listed page it does not place is unfiled', () => {
  const { pages, structure } = organizedWiki()
  const listed = [...pages.filter(page => page.id !== 'p1' && page.id !== 'r1'), { id: 'n1', slug: 'new', title: 'New page', parentId: null, siblingOrder: 9 }]
  const navigation = wikiNavigation(listed, structure)
  if (navigation.kind !== 'structure') throw new Error('expected the structure')
  expect(navigation.root).toBeNull()
  expect(navigation.pillars.map(pillar => pillar.members.map(m => [m.page.slug, m.shared]))).toEqual([[['release-process', false]], []])
  expect(navigation.unfiled.map(page => page.slug)).toEqual(['handbook', 'onboarding', 'drafts', 'new'])
  expect(firstNavigationPage(navigation)).toBe('engineering')
})

it('navigates a Wiki with no root and no pillars, or no structure read, by its tree', () => {
  expect(wikiNavigation(wikiPages(), EMPTY_STRUCTURE)).toEqual({ kind: 'tree', tree: wikiTree(wikiPages()) })
  expect(wikiNavigation(wikiPages(), { ...EMPTY_STRUCTURE, unfiled: [{ id: 'd1', slug: 'handbook', title: 'Team handbook', parentId: null }] }).kind).toBe('tree')
  expect(wikiNavigation(wikiPages(), null).kind).toBe('tree')
  expect(firstNavigationPage(wikiNavigation(wikiPages(), null))).toBe('handbook')
})

it('reads a Wiki route back to its slug, a slash slug as one page, and nothing else as one', () => {
  for (const slug of ['handbook', 'dispatch/dispatch-a-crew', 'ops/incident-response']) expect(wikiPageSlug(wikiPagePath(slug))).toBe(slug)
  for (const href of [undefined, '/wiki/', '/wiki/a/b', '/other/handbook', 'https://example.com/wiki/handbook', '/wiki/%E0%A4%A']) expect(wikiPageSlug(href)).toBeNull()
})

it('offers a body edit on any page that is not a Master, and on a Master only when it has a body', () => {
  expect(bodyEditable({ masterRole: null, body: '' })).toBe(true)
  expect(bodyEditable({ masterRole: 'pillar', body: '' })).toBe(false)
  expect(bodyEditable({ masterRole: 'root', body: 'Acme.' })).toBe(true)
})

it('says what each reference names, and names nothing it cannot show', () => {
  expect(parseWikiReference('inferops://Demo.Local/project/board/DEMO?workflow="content"'))
    .toEqual({ kind: 'board', href: 'inferops://Demo.Local/project/board/DEMO?workflow="content"', boardRef: 'inferops://demo.local/project/board/DEMO', workflow: 'content' })
  expect(parseWikiReference('inferops://acme.ops/project/issue-card/ENG-12'))
    .toMatchObject({ kind: 'issue', boardRef: 'inferops://acme.ops/project/board/ENG', identifier: 'ENG-12' })
  expect(parseWikiReference('inferops://acme.kb/knowledge/document/handbook')).toMatchObject({ kind: 'page', host: 'acme.kb', slug: 'handbook' })
  expect(parseWikiReference('inferops://acme.kb/knowledge/document/dispatch%2Fdispatch-a-crew')).toMatchObject({ kind: 'page', host: 'acme.kb', slug: 'dispatch/dispatch-a-crew' })
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

const at = (changes: Partial<WikiDocument>): WikiDocument => ({ ...page(null), version: 3, body: 'old', ...changes })

it('decides an awaiting body edit only from the page: pending, applied, rejected or stale', () => {
  const edit: BodyEdit = { documentId: 'd', body: 'new', expectedVersion: 3, phase: 'awaiting' }
  expect(reconcileBodyEdit(edit, at({ body: 'new', pendingBody: true })).phase).toBe('awaiting')
  // A new version with the proposed text is only `matched`: another writer may have made it.
  expect(reconcileBodyEdit(edit, at({ body: 'new', version: 4 })).phase).toBe('matched')
  expect(reconcileBodyEdit(edit, at({})).phase).toBe('rejected')
  expect(reconcileBodyEdit(edit, at({ body: 'someone else', version: 4 })).phase).toBe('stale')
  expect(reconcileBodyEdit(edit, at({ id: 'other' }))).toMatchObject({ phase: 'stale', message: 'The page is no longer in this Wiki.' })
  expect(editErrorText({ ...edit, phase: 'refused', code: 'STALE_REVISION' }, 'page')).toBe('Not sent: the page changed since the page was read. The page was read again; edit the current text.')
  expect(editErrorText({ ...edit, phase: 'stale' }, 'page')).toContain('the page changed in InferMind')
})

it('leaves a Master\'s documentation coverage block out of the agent text it compares, and nothing else', () => {
  const page = '# Engineering\n\n<!-- generated: wiki structure -->\n## Pages in Engineering\n- [Release](/wiki/release)'
  const coverage = '<!-- generated: documentation coverage -->\n## Documentation coverage\nCoverage unavailable: No coverage source is set for this wiki.'
  expect(agentTextShown(`${page}\n\n${coverage}`)).toBe(page)
  expect(agentTextShown(page)).toBe(page)
  // The marker counts only as a block of its own, not quoted inside a paragraph.
  const quoted = '# Notes\n\nWe mark it with <!-- generated: documentation coverage --> today.'
  expect(agentTextShown(quoted)).toBe(quoted)
})
