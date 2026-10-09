// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { ActionLogEntry, ActionsSubscriber, Overseer } from '@gadgets/workshop-shared/api'
import type { CanvasDefinition, CanvasWikiWidget } from '@gadgets/workshop-shared/canvas'
import type { Board, Issue } from '@inferos/gatekeeper-inferops/src/types'
import { composeDocumentText, documentText, masterStructureText } from '@inferos/gatekeeper-inferops/src/wiki'
import { CanvasView } from './CanvasView'
import { setFieldValue } from './kumoPopupDoubles'
import { wikiDocumentUrl } from '@inferos/gatekeeper-inferops/src/resources'
import { WIKI, fakeWiki, organizedWiki, wikiSections } from './wikiTestDoubles'

vi.mock('@cloudflare/kumo', async importOriginal =>
  (await import('./kumoPopupDoubles')).withKumoPopupDoubles(await importOriginal<typeof import('@cloudflare/kumo')>()))

const ENG = 'inferops://acme.ops/project/board/ENG'
const OPS = 'inferops://other.ops/project/board/OPS'
const issue = (id: string, identifier: string, stateId: string, revision: string): Issue => ({
  id, identifier, title: `Issue ${identifier}`, priority: 'high', stateId, targetDate: null, workflow: 'software', revision, assigneeId: null, blockedReason: null,
})
const engBoard = (issues: Issue[]): Board => ({
  project: { id: 'p', identifier: 'ENG', name: 'Engineering' },
  columns: [
    { state: { id: 'todo', name: 'Todo', group: 'unstarted', position: 0, workflow: 'software' }, issues: issues.filter(i => i.stateId === 'todo') },
    { state: { id: 'doing', name: 'Doing', group: 'started', position: 1, workflow: 'software' }, issues: issues.filter(i => i.stateId === 'doing') },
  ],
})

let root: Root
let container: HTMLDivElement
let wiki: ReturnType<typeof fakeWiki>
let board: Board
const readBoard = vi.fn<() => Promise<Board>>()
const boardDispose = vi.fn<() => void>()
const bindings = new Map<string, object>()
const lookup = vi.fn<(url: string) => Promise<object | null>>(async url => bindings.get(url) ?? null)
let overseer: RpcStub<Overseer>
let actions: ActionsSubscriber | undefined

const connection = (session: object) => ({ openSession: async () => session, [Symbol.dispose]: () => {} })
const widget = (page: string | null = null): CanvasWikiWidget => ({ id: 'wiki', kind: 'inferops.wiki', version: 1, targetRef: WIKI, size: 'full', params: { page } })
const view = (w: CanvasWikiWidget): CanvasDefinition => ({ schemaVersion: 1, id: 'v', revision: '0', title: 'Knowledge', sections: [{ id: 's', title: 'SOPs', columns: 1, widgets: [w] }] })
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)) })
const render = async (w: CanvasWikiWidget, editable = true) => {
  await act(async () => root.render(<CanvasView definition={view(w)} gadgets={new Map()} overseer={overseer} wikiEditable={editable} />))
  await settle()
}
const organize = () => {
  const organized = organizedWiki()
  wiki = fakeWiki(organized)
  bindings.set(WIKI, connection(wiki.session))
  return organized
}
const pageNav = () => wikiArticle().querySelector<HTMLElement>('nav[aria-label="Wiki pages"]')!
const pageBody = () => wikiArticle().querySelector<HTMLElement>('section[aria-label="Page body"]')!
const generated = () => wikiArticle().querySelector<HTMLElement>('[aria-label="Generated page list"]')
const current = () => [...pageNav().querySelectorAll('[aria-current="page"]')].map(element => element.getAttribute('aria-label') ?? element.textContent)
const wikiArticle = () => container.querySelector<HTMLElement>(`[aria-label="InferMind Wiki ${WIKI}"]`)!
const section = (tag: string) => [...container.querySelectorAll<HTMLElement>('section[aria-labelledby^="wiki-section-"]')]
  .find(element => element.querySelector('h4')?.textContent === `#${tag}`)!
const button = (scope: ParentNode, text: string) => [...scope.querySelectorAll<HTMLButtonElement>('button')]
  .find(element => element.textContent === text || element.getAttribute('aria-label') === text)!
const click = async (element: HTMLElement) => { await act(async () => element.click()); await settle() }
const decided = (id: number, state: ActionLogEntry['state'], title = 'Edit Wiki section purpose of Team handbook') => act(async () => {
  actions?.entry({ id, type: 'action', state, resourceUrl: WIKI, resourceTitle: 'InferMind Wiki acme.kb', createdAt: new Date(), requestedBy: 'person',
    description: { title, description: '' } } as ActionLogEntry)
})

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  wiki = fakeWiki()
  board = engBoard([issue('i1', 'ENG-1', 'doing', '7')])
  readBoard.mockReset().mockImplementation(async () => board)
  boardDispose.mockClear()
  bindings.clear()
  bindings.set(WIKI, connection(wiki.session))
  bindings.set(ENG, connection({ readBoard, openIssue: () => ({}), createIssue: async () => {}, [Symbol.dispose]: boardDispose }))
  lookup.mockClear()
  actions = undefined
  overseer = {
    getGatekeeperByResourceUrl: lookup,
    subscribeToActions: async (subscriber: ActionsSubscriber) => { actions = subscriber; return { [Symbol.dispose]: () => {} } },
    listActions: async () => ({ entries: [] }),
  } as unknown as RpcStub<Overseer>
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

it('shows the page tree and the first page as Markdown, never rendering raw HTML from a section', async () => {
  await render(widget())
  const nav = wikiArticle().querySelector('nav[aria-label="Wiki pages"]')!
  expect([...nav.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Team handbook', 'Onboarding', 'Release process', 'Drafts'])
  expect(button(nav, 'Team handbook').getAttribute('aria-current')).toBe('page')
  const purpose = section('purpose')
  expect(purpose.querySelector('h2')?.textContent).toBe('Purpose')
  expect(purpose.querySelector('strong')?.textContent).toBe('works')
  expect(purpose.querySelector('script, b')).toBeNull()
  // Untrusted links: only http(s) becomes an anchor; javascript: and data: never reach an href or title.
  expect([...purpose.querySelectorAll('a')].map(a => a.getAttribute('href'))).toEqual(['https://example.com/docs'])
  expect(purpose.innerHTML).not.toMatch(/javascript:|data:text/)
  expect(purpose.textContent).toContain('See x, y and the docs.')
  await click(button(nav, 'Onboarding'))
  expect(section('first-week').textContent).toContain('Pair on one small issue.')
  await click(button(nav, 'Drafts'))
  expect(wikiArticle().textContent).toContain('This page has no sections.')
})

it('opens the configured page, and says when it is not in the Wiki', async () => {
  await render(widget('onboarding'))
  expect(section('first-week')).toBeDefined()
  await act(async () => root.unmount())
  root = createRoot(container)
  await render(widget('retired-page'))
  expect(wikiArticle().textContent).toContain('The page retired-page is not in this Wiki, or you cannot open it.')
  expect(wiki.session.readDocument).not.toHaveBeenCalledWith('retired-page')
})

it('embeds the live Kanban and the issue the Kanban shows, resolved only through the workspace connection to that board', async () => {
  await render(widget())
  const work = section('current-work')
  const kanban = work.querySelector<HTMLElement>(`[aria-label="Project board ${ENG}"]`)!
  expect(kanban.querySelector('h4')?.textContent).toBe('Engineering (ENG)')
  const card = kanban.querySelector<HTMLElement>('[data-issue-id="i1"]')!
  expect(card.textContent).toContain('ENG-1')
  const embedded = work.querySelector<HTMLElement>('[aria-label="Issue ENG-1"]')!
  expect(embedded.textContent).toContain('Issue ENG-1')
  expect(embedded.textContent).toContain('Doing')
  expect(embedded.textContent).toContain('Revision 7')
  // One read serves the Kanban and the issue: the same board, not a copy.
  expect(readBoard).toHaveBeenCalledTimes(1)
  expect(lookup.mock.calls.map(([url]) => url)).toEqual(expect.arrayContaining([WIKI, ENG, OPS]))
  // Another tenant's board: the workspace holds no connection, so nothing of it is shown.
  const other = work.querySelector<HTMLElement>('[aria-label="Issue OPS-2"]')!
  expect(other.textContent).toContain('Not connected. This workspace has no connection to the board of OPS-2')
  expect(other.textContent).toContain('inferops://other.ops/project/issue-card/OPS-2')
  // A page reference of the same Wiki opens that page.
  await click(button(work, 'Open page: Onboarding'))
  expect(section('first-week')).toBeDefined()
})

it('shows the Kanban\'s new state and revision in the embed once the board is re-read, and a deleted issue as missing', async () => {
  await render(widget())
  board = engBoard([issue('i1', 'ENG-1', 'todo', '8')])
  await click(button(section('current-work'), 'Refresh board'))
  const embedded = section('current-work').querySelector<HTMLElement>('[aria-label="Issue ENG-1"]')!
  expect(embedded.textContent).toContain('Todo')
  expect(embedded.textContent).toContain('Revision 8')
  board = engBoard([])
  await click(button(section('current-work'), 'Refresh board'))
  expect(section('current-work').querySelector('[aria-label="Issue ENG-1"]')?.textContent)
    .toContain('ENG-1 is not on the ENG board. It may have been deleted or moved.')
})

it('renders the other embeds when one fails, and the last page with a failed refresh', async () => {
  const opsRead = vi.fn<() => Promise<Board>>(async () => { throw new Error('Error: FORBIDDEN: The connection was refused.') })
  bindings.set(OPS, connection({ readBoard: opsRead, [Symbol.dispose]: () => {} }))
  await render(widget())
  const work = section('current-work')
  expect(work.querySelector('[aria-label="Issue OPS-2"] [role="alert"]')?.textContent).toBe('Could not read OPS-2: The connection was refused.')
  expect(work.querySelector('[aria-label="Issue ENG-1"]')?.textContent).toContain('Revision 7')
  expect(work.querySelector(`[aria-label="Project board ${ENG}"] [data-issue-id="i1"]`)).not.toBeNull()
  wiki.session.readDocument.mockRejectedValueOnce(new Error('Error: UNAVAILABLE: InferOps did not answer.'))
  await click(button(wikiArticle(), 'Refresh Wiki'))
  expect(wikiArticle().textContent).toContain('Refresh failed')
  expect(wikiArticle().textContent).toContain('Showing the last read; refresh failed: InferOps did not answer.')
  expect(section('purpose')).toBeDefined()
})

it('says the Wiki is not connected without a connection, and has no access once it is refused', async () => {
  bindings.delete(WIKI)
  await render(widget())
  expect(wikiArticle().textContent).toContain('Not connected. This workspace has no connection to this Wiki.')
  expect(wikiArticle().querySelector('section')).toBeNull()
  bindings.set(WIKI, connection(wiki.session))
  await click(button(wikiArticle(), 'Refresh Wiki'))
  expect(section('purpose')).toBeDefined()
  wiki.session.listDocuments.mockRejectedValueOnce(new Error('Error: FORBIDDEN: No InferMind access.'))
  await click(button(wikiArticle(), 'Refresh Wiki'))
  expect(wikiArticle().querySelector('[role="alert"]')?.textContent).toBe('No access to this Wiki: No InferMind access.')
  expect(wikiArticle().querySelector('section')).toBeNull()
})

it('proposes a section edit, shows it waiting for approval and not saved, and saved only once the decided action re-reads the page', async () => {
  await render(widget())
  await click(button(section('purpose'), 'Edit section purpose'))
  const field = section('purpose').querySelector('textarea')!
  expect(field.value).toBe(wikiSections()[0]!.body)
  await act(async () => setFieldValue(field, 'Updated purpose.'))
  await act(async () => section('purpose').querySelector('form')!.requestSubmit())
  await settle()
  expect(wiki.session.updateSection).toHaveBeenCalledWith('s1', 'Updated purpose.', 1)
  expect(section('purpose').textContent).toContain('Waiting for approval, not saved yet')
  expect(section('purpose').textContent).not.toContain('Saved')
  expect(button(section('purpose'), 'Edit section purpose').disabled).toBe(true)
  wiki.approve('s1')
  await decided(5, 'approved')
  await settle()
  expect(section('purpose').textContent).toContain('Saved')
  expect(section('purpose').textContent).toContain('Updated purpose.')
  expect(section('purpose').querySelector('[role="status"]')?.textContent).toBe('Section purpose: Saved')
})

it('says a rejected edit was not saved, and why a stale one was not sent, keeping the draft', async () => {
  await render(widget())
  await click(button(section('purpose'), 'Edit section purpose'))
  await act(async () => setFieldValue(section('purpose').querySelector('textarea')!, 'Rejected text'))
  await act(async () => section('purpose').querySelector('form')!.requestSubmit())
  await settle()
  wiki.reject('s1')
  await decided(6, 'rejected')
  await settle()
  expect(section('purpose').textContent).toContain('Rejected, not saved')
  expect(section('purpose').textContent).toContain('How the team')

  await click(button(section('purpose'), 'Edit section purpose'))
  wiki.writeElsewhere('s1', 'Changed in InferMind meanwhile.')
  await act(async () => setFieldValue(section('purpose').querySelector('textarea')!, 'Mine'))
  await act(async () => section('purpose').querySelector('form')!.requestSubmit())
  await settle()
  expect(section('purpose').querySelector('[role="alert"]')?.textContent).toContain('Not sent: the section changed since the page was read.')
  expect(section('purpose').querySelector('textarea')?.value).toBe('Mine')
})

it('shows the Wiki read-only where edits are not offered', async () => {
  await render(widget(), false)
  expect(section('purpose')).toBeDefined()
  expect(wikiArticle().querySelector('[aria-label^="Edit section"]')).toBeNull()
})

it('shows what an agent reads through the same connection, and does not compare a page whose widgets it reads as text', async () => {
  await render(widget())
  await click(button(wikiArticle(), 'Agent view'))
  const panel = wikiArticle().querySelector<HTMLElement>('[aria-label="Agent view"]')!
  const shown = wikiSections().filter(s => s.documentId === 'd1')
  expect(panel.querySelector('pre')?.textContent).toBe(documentText('Team handbook', shown.map(s => s.body)))
  // The handbook embeds the DEMO board.
  expect(panel.textContent).toContain('Not compared: an agent reads each embedded widget as its live text.')
  expect(wiki.session.readDocumentText).toHaveBeenCalledWith('handbook')
})

it('disposes the Wiki and board sessions with the view', async () => {
  await render(widget())
  await act(async () => root.unmount())
  await settle()
  expect(wiki.session.dispose).toHaveBeenCalledTimes(1)
  expect(boardDispose).toHaveBeenCalledTimes(1)
  root = createRoot(container)
})

it('navigates an organized Wiki by its root, each Master in pillar order with its pages, then the unfiled pages, opening the root first', async () => {
  organize()
  await render(widget())
  const top = [...pageNav().querySelectorAll(':scope > ul > li')].map(item => item.querySelector('button, p')?.textContent)
  expect(top).toEqual(['Acme', 'Engineering', 'Operations', 'Unfiled pages'])
  const filed = (pillar: string) => [...pageNav().querySelectorAll(`ul[aria-label="Pages in ${pillar}"] button`)].map(b => b.getAttribute('aria-label') ?? b.textContent)
  expect(filed('Engineering')).toEqual(['Incident response, filed in several pillars', 'Release process'])
  expect(filed('Operations')).toEqual(['Incident response, filed in several pillars'])
  expect([...pageNav().querySelectorAll('ul[aria-label="Unfiled pages"] button')].map(b => b.textContent)).toEqual(['Team handbook', 'Onboarding', 'Drafts'])
  expect(current()).toEqual(['Acme'])
  expect(pageBody().textContent).toContain('Acme builds bridges.')
  // A shared page opens the same page from either pillar, and both entries mark it current.
  const [fromEngineering, fromOperations] = [...pageNav().querySelectorAll<HTMLButtonElement>('button[aria-label="Incident response, filed in several pillars"]')]
  await click(fromEngineering!)
  expect(current()).toEqual(['Incident response, filed in several pillars', 'Incident response, filed in several pillars'])
  expect(pageBody().textContent).toContain('Page the on-call engineer.')
  await click(fromOperations!)
  expect(wiki.session.readDocument.mock.calls.filter(([slug]) => slug === 'ops/incident-response')).toHaveLength(1)
  expect(pageBody().textContent).toContain('Page the on-call engineer.')
})

it('renders a page with a body as its body alone, embeds included, and shows the agent text without comparing its widgets', async () => {
  organize()
  await render(widget('ops/incident-response'))
  const body = pageBody()
  expect(body.querySelector('h1')).toBeNull()
  expect([...body.querySelectorAll('ol > li')].map(item => item.textContent)).toEqual(['Page the on-call engineer.', 'Write the timeline.'])
  expect(body.querySelector(`[aria-label="Project board ${ENG}"] h4`)?.textContent).toBe('Engineering (ENG)')
  // Its section is index text, not part of the page.
  expect(wikiArticle().textContent).not.toContain('Section text that is never part of the page.')
  expect(wikiArticle().querySelector('section[aria-labelledby^="wiki-section-"]')).toBeNull()
  expect(generated()).toBeNull()
  await click(button(wikiArticle(), 'Agent view'))
  const panel = wikiArticle().querySelector<HTMLElement>('[aria-label="Agent view"]')!
  const { pages } = organizedWiki()
  const stored = pages.find(page => page.id === 'p1')!
  expect(panel.querySelector('pre')?.textContent).toBe(composeDocumentText(stored.title, { body: stored.body, visibleSections: ['Section text that is never part of the page.'], generated: null }))
  expect(panel.querySelector('pre')?.textContent).toContain('1. Page the on-call engineer.')
  // InferOps reads each embedded widget as its live text, which this page draws as the widget.
  expect(panel.textContent).toContain('Not compared: an agent reads each embedded widget as its live text.')
  expect(panel.textContent).not.toContain('Same as this page')
})

it('shows a Master\'s documentation coverage in what an agent reads, and compares the page without it', async () => {
  const { structure } = organize()
  const page = { id: 'm1', masterRole: 'pillar' as const }
  const coverage = '<!-- generated: documentation coverage -->\n## Documentation coverage\nDocumented 1 · Stale 0 · Partial 0 · Missing 1'
  wiki.session.readDocumentText.mockResolvedValueOnce(`# Engineering\n\n${masterStructureText(page, structure)}\n\n${coverage}`)
  await render(widget('engineering'))
  await click(button(wikiArticle(), 'Agent view'))
  const panel = wikiArticle().querySelector<HTMLElement>('[aria-label="Agent view"]')!
  expect(panel.querySelector('pre')?.textContent).toContain('Documented 1 · Stale 0 · Partial 0 · Missing 1')
  expect(panel.textContent).toContain('Same as this page')
})

it('shows a Master\'s generated page list as generated, not editable, whose links select the page in the widget', async () => {
  const { structure } = organize()
  await render(widget('engineering'))
  const block = generated()!
  expect(block.textContent).toContain('Generated from the Wiki structure, not editable')
  expect(block.querySelector('h2')?.textContent).toBe('Pages in Engineering')
  expect(block.querySelector('a')).toBeNull()
  // A Master without a body reads only as its generated list: no body to edit, no "no sections" note.
  expect(wikiArticle().querySelector('section[aria-label="Page body"]')).toBeNull()
  expect(wikiArticle().textContent).not.toContain('This page has no sections.')
  await click(button(wikiArticle(), 'Agent view'))
  const page = { id: 'm1', masterRole: 'pillar' as const }
  expect(wikiArticle().querySelector('[aria-label="Agent view"] pre')?.textContent).toBe(`# Engineering\n\n${masterStructureText(page, structure)}`)
  expect(wikiArticle().querySelector('[aria-label="Agent view"]')?.textContent).toContain('Same as this page')
  await click(button(block, 'Release process'))
  expect(current()).toEqual(['Release process'])
  expect(section('steps')).toBeUndefined()
  expect(wiki.session.readDocument).toHaveBeenLastCalledWith('release-process')
  // The root lists the pillars, its body editable above them.
  await click(button(pageNav(), 'Acme'))
  expect(generated()?.querySelector('h2')?.textContent).toBe('Pillars')
  expect(button(pageBody(), 'Edit page body')).toBeDefined()
  await click(button(generated()!, 'Operations'))
  expect(current()).toEqual(['Operations'])
})

it('states a failed structure read, shows the page tree meanwhile, and a Master\'s list as unread', async () => {
  organize()
  wiki.session.readStructure.mockRejectedValueOnce(new Error('Error: UNAVAILABLE: InferOps did not answer.'))
  await render(widget('engineering'))
  expect(wikiArticle().querySelector('[role="alert"]')?.textContent).toBe('Could not read how this Wiki is organized, so its pages are shown as a tree: InferOps did not answer.')
  expect(pageNav().querySelector('ul[aria-label^="Pages in"]')).toBeNull()
  expect(button(pageNav(), 'Team handbook')).toBeDefined()
  expect(wikiArticle().textContent).toContain('Could not read the pages this page lists: InferOps did not answer.')
  await click(button(wikiArticle(), 'Agent view'))
  expect(wikiArticle().querySelector('[aria-label="Agent view"]')?.textContent).toContain('Not compared')
  await click(button(wikiArticle(), 'Refresh Wiki'))
  expect(pageNav().querySelector('ul[aria-label="Pages in Engineering"]')).not.toBeNull()
  expect(generated()?.textContent).toContain('Pages in Engineering')
})

it('shows the structure when a page read fails, and the page when it is read again', async () => {
  organize()
  wiki.session.readDocument.mockRejectedValueOnce(new Error('Error: INTERNAL: boom'))
  await render(widget())
  expect(pageNav().querySelector('ul[aria-label="Pages in Engineering"]')).not.toBeNull()
  expect(wikiArticle().textContent).toContain('Could not read the page: boom')
  await click(button(wikiArticle(), 'Try again'))
  expect(pageBody().textContent).toContain('Acme builds bridges.')
})

const proposeBody = async (text: string) => {
  await click(button(pageBody(), 'Edit page body'))
  await act(async () => setFieldValue(pageBody().querySelector('textarea')!, text))
  await act(async () => pageBody().querySelector('form')!.requestSubmit())
  await settle()
}

it('proposes a body edit, shows it waiting for approval, saved only once the decided action re-reads the page, and pending after a reload', async () => {
  organize()
  await render(widget('ops/incident-response'))
  await click(button(pageBody(), 'Edit page body'))
  expect(pageBody().querySelector('textarea')?.value).toBe(organizedWiki().pages.find(page => page.id === 'p1')!.body)
  await act(async () => setFieldValue(pageBody().querySelector('textarea')!, '# Incident response\n\nCall the on-call engineer.'))
  await act(async () => pageBody().querySelector('form')!.requestSubmit())
  await settle()
  expect(wiki.session.updateDocumentBody).toHaveBeenCalledWith('p1', '# Incident response\n\nCall the on-call engineer.', 4)
  expect(pageBody().textContent).toContain('Waiting for approval, not saved yet')
  expect(pageBody().textContent).not.toContain('Saved')
  expect(button(pageBody(), 'Edit page body').disabled).toBe(true)
  expect(pageBody().querySelector('[role="status"]')?.textContent).toBe('Page body: Waiting for approval, not saved yet')

  // A reload starts from nothing: the pending state comes from the page's own overlay.
  await act(async () => root.unmount())
  root = createRoot(container)
  await render(widget('ops/incident-response'))
  expect(pageBody().textContent).toContain('Body edit waiting for approval')
  expect(button(pageBody(), 'Edit page body').disabled).toBe(true)
  wiki.approveBody('p1')
  await decided(7, 'approved')
  await settle()
  expect(pageBody().textContent).not.toContain('waiting for approval')
  expect(pageBody().textContent).toContain('Call the on-call engineer.')
  expect(button(pageBody(), 'Edit page body').disabled).toBe(false)
})

it('says a decided body edit was saved or rejected in the same session', async () => {
  organize()
  await render(widget('operations'))
  await proposeBody('Operations run on the board.')
  await decided(8, 'pending', 'Edit Wiki page Operations')
  wiki.approveBody('m2')
  await decided(8, 'approved', 'Edit Wiki page Operations')
  await settle()
  expect(pageBody().querySelector('[role="status"]')?.textContent).toBe('Page body: Saved')
  expect(pageBody().textContent).toContain('Operations run on the board.')
  await proposeBody('Rejected text')
  wiki.rejectBody('m2')
  await decided(9, 'rejected')
  await settle()
  expect(pageBody().textContent).toContain('Rejected, not saved')
  expect(pageBody().textContent).toContain('Operations run on the board.')
})

it('never calls a body edit saved when another writer set the same text, or on an approval it did not raise', async () => {
  organize()
  await render(widget('operations'))
  await proposeBody('Operations run on the board.')
  await decided(10, 'pending', 'Edit Wiki page Operations')
  // InferMind gets the same text first; this approval then fails its compare-and-swap.
  wiki.rejectBody('m2')
  wiki.writeBodyElsewhere('m2', 'Operations run on the board.')
  await decided(10, 'rejected', 'Edit Wiki page Operations')
  await settle()
  expect(pageBody().querySelector('[role="status"]')?.textContent).toBe('Page body: The page now has this text')
  expect(pageBody().textContent).not.toContain('Saved')

  // An approval of another page's edit, or of one never seen raised here, is not this edit's.
  await proposeBody('Operations run on the Kanban board.')
  await decided(11, 'pending', 'Edit Wiki page Incident response')
  wiki.approveBody('m2')
  await decided(11, 'approved', 'Edit Wiki page Incident response')
  await decided(12, 'approved', 'Edit Wiki page Operations')
  await settle()
  expect(pageBody().querySelector('[role="status"]')?.textContent).toBe('Page body: The page now has this text')
})

it('keeps a pending body deletion visible after a reload, read-only too', async () => {
  organize()
  await render(widget('operations'))
  await proposeBody('')
  expect(wiki.session.updateDocumentBody).toHaveBeenCalledWith('m2', '', 3)
  expect(pageBody().querySelector('[role="status"]')?.textContent).toBe('Page body: Waiting for approval, not saved yet')

  await act(async () => root.unmount())
  root = createRoot(container)
  await render(widget('operations'), false)
  expect(pageBody().textContent).toContain('Body edit waiting for approval')
  expect(pageBody().textContent).toContain("The proposed body is empty: approving it removes this page's body.")
})

it('says why a body edit was not sent, stale, conflicting or denied, keeping the draft', async () => {
  organize()
  await render(widget('operations'))
  await click(button(pageBody(), 'Edit page body'))
  wiki.writeBodyElsewhere('m2', 'Changed in InferMind meanwhile.')
  await act(async () => setFieldValue(pageBody().querySelector('textarea')!, 'Mine'))
  await act(async () => pageBody().querySelector('form')!.requestSubmit())
  await settle()
  expect(pageBody().querySelector('[role="alert"]')?.textContent).toBe('Not sent: the page changed since the page was read. The page was read again; edit the current text.')
  expect(pageBody().querySelector('textarea')?.value).toBe('Mine')
  await click(button(pageBody(), 'Cancel'))
  expect(pageBody().textContent).toContain('Changed in InferMind meanwhile.')

  wiki.session.updateDocumentBody.mockRejectedValueOnce(new Error('Error: CONFLICT: Page operations already has a body edit that has not taken effect yet.'))
  await proposeBody('Second try')
  expect(pageBody().querySelector('[role="alert"]')?.textContent).toBe('Not sent: Page operations already has a body edit that has not taken effect yet.')
  await click(button(pageBody(), 'Cancel'))
  wiki.session.updateDocumentBody.mockRejectedValueOnce(new Error('Error: FORBIDDEN: Your InferOps access cannot edit this Wiki.'))
  await proposeBody('Third try')
  expect(pageBody().querySelector('[role="alert"]')?.textContent).toBe('Not sent: Your InferOps access cannot edit this Wiki.')
  expect(pageBody().querySelector('textarea')?.value).toBe('Third try')
})

it('offers to add a body to a page that reads as its sections, keeping section edits, and no body edit read-only', async () => {
  await render(widget())
  expect(button(pageBody(), 'Add page body')).toBeDefined()
  expect(button(section('purpose'), 'Edit section purpose')).toBeDefined()
  await click(button(pageBody(), 'Add page body'))
  expect(pageBody().textContent).toContain('its sections are kept as separate index text and are no longer shown here')
  await act(async () => root.unmount())
  root = createRoot(container)
  organize()
  await render(widget('ops/incident-response'), false)
  expect(pageBody().textContent).toContain('Page the on-call engineer.')
  expect([...pageBody().querySelectorAll('button')].filter(b => /page body/.test(b.textContent ?? ''))).toEqual([])
})

it('opens a slash-slug page from a page reference of the same Wiki', async () => {
  const organized = organizedWiki()
  const href = wikiDocumentUrl({ host: 'acme.kb', slug: 'ops/incident-response' })
  expect(href).toBe('inferops://acme.kb/knowledge/document/ops%2Fincident-response')
  wiki = fakeWiki({ ...organized, sections: [...organized.sections, { id: 's8', documentId: 'd3', tag: 'see-also', body: `[Incident response](${href})`, version: 1 }] })
  bindings.set(WIKI, connection(wiki.session))
  await render(widget('onboarding'))
  await click(button(section('see-also'), 'Open page: Incident response'))
  expect(current()).toEqual(['Incident response, filed in several pillars', 'Incident response, filed in several pillars'])
  expect(pageBody().textContent).toContain('Page the on-call engineer.')
  expect(wiki.session.readDocument).toHaveBeenLastCalledWith('ops/incident-response')
})
