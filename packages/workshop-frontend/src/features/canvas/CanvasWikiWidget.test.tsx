// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { ActionLogEntry, ActionsSubscriber, Overseer } from '@gadgets/workshop-shared/api'
import type { CanvasDefinition, CanvasWikiWidget } from '@gadgets/workshop-shared/canvas'
import type { Board, Issue } from '@inferos/gatekeeper-inferops/src/types'
import { documentText } from '@inferos/gatekeeper-inferops/src/wiki'
import { CanvasView } from './CanvasView'
import { setFieldValue } from './kumoPopupDoubles'
import { WIKI, fakeWiki, wikiSections } from './wikiTestDoubles'

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
const wikiArticle = () => container.querySelector<HTMLElement>(`[aria-label="InferMind Wiki ${WIKI}"]`)!
const section = (tag: string) => [...container.querySelectorAll<HTMLElement>('section[aria-labelledby^="wiki-section-"]')]
  .find(element => element.querySelector('h4')?.textContent === `#${tag}`)!
const button = (scope: ParentNode, text: string) => [...scope.querySelectorAll<HTMLButtonElement>('button')]
  .find(element => element.textContent === text || element.getAttribute('aria-label') === text)!
const click = async (element: HTMLElement) => { await act(async () => element.click()); await settle() }
const decided = (id: number, state: ActionLogEntry['state']) => act(async () => {
  actions?.entry({ id, type: 'action', state, resourceUrl: WIKI, resourceTitle: 'InferMind Wiki acme.kb', createdAt: new Date(), requestedBy: 'person',
    description: { title: 'Edit Wiki section purpose of Team handbook', description: '' } } as ActionLogEntry)
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

it('shows what an agent reads, equal to the sections rendered, through the same connection', async () => {
  await render(widget())
  await click(button(wikiArticle(), 'Agent view'))
  const panel = wikiArticle().querySelector<HTMLElement>('[aria-label="Agent view"]')!
  const shown = wikiSections().filter(s => s.documentId === 'd1')
  expect(panel.querySelector('pre')?.textContent).toBe(documentText('Team handbook', shown.map(s => s.body)))
  expect(panel.textContent).toContain('Same as this page')
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
