import { beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { ActionLogEntry, Overseer } from '@gadgets/workshop-shared/api'
import { WikiData } from './wikiData'
import { WIKI, fakeWiki, organizedWiki } from './wikiTestDoubles'

let wiki: ReturnType<typeof fakeWiki>
const clientDispose = vi.fn<() => void>()
const lookup = vi.fn<(url: string) => Promise<object | null>>()
const overseer = { getGatekeeperByResourceUrl: lookup } as unknown as RpcStub<Overseer>
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const pageOf = (data: WikiData, slug: string) => {
  const page = data.snapshot.pages.get(slug)
  if (page?.status !== 'ready') throw new Error(`page ${slug} is ${page?.status}`)
  return page.document
}
const sectionOf = (data: WikiData, slug: string, id: string) => {
  const page = data.snapshot.pages.get(slug)
  if (page?.status !== 'ready') throw new Error(`page ${slug} is ${page?.status}`)
  return page.document.sections.find(section => section.id === id)!
}

beforeEach(() => {
  wiki = fakeWiki()
  clientDispose.mockClear()
  lookup.mockReset().mockImplementation(async url => url === WIKI ? { openSession: async () => wiki.session, [Symbol.dispose]: clientDispose } : null)
})

it('resolves the Wiki only through the workspace connection for its canonical reference, and is unbound without one', async () => {
  const data = new WikiData(overseer, 'inferops://ACME.kb/knowledge/wiki')
  await flush()
  expect(lookup).toHaveBeenCalledWith(WIKI)
  expect(data.snapshot.list).toMatchObject({ status: 'ready', refreshing: false })
  expect(clientDispose).toHaveBeenCalledTimes(1)
  data.dispose()
  const other = new WikiData(overseer, 'inferops://other.kb/knowledge/wiki')
  await flush()
  expect(other.snapshot.list).toEqual({ status: 'unbound' })
  other.openPage('handbook')
  other.dispose()
})

it('reads a page once, reports a missing one, and drops everything read when access is lost', async () => {
  const data = new WikiData(overseer, WIKI)
  data.openPage('handbook'); data.openPage('handbook'); data.openPage('gone')
  await flush()
  expect(wiki.session.readDocument).toHaveBeenCalledTimes(2)
  expect(data.snapshot.pages.get('handbook')).toMatchObject({ status: 'ready', document: { title: 'Team handbook' } })
  expect(data.snapshot.pages.get('gone')).toEqual({ status: 'missing', message: 'No such page in this Wiki.' })
  wiki.session.readDocument.mockRejectedValueOnce(new Error('Error: INTERNAL: boom'))
  data.refresh()
  await flush()
  expect(data.snapshot.pages.get('handbook')).toMatchObject({ status: 'ready', error: 'boom', document: { title: 'Team handbook' } })
  wiki.session.listDocuments.mockRejectedValueOnce(new Error('Error: FORBIDDEN: Your InferOps access lacks knowledge permission.'))
  data.refresh()
  await flush()
  expect(data.snapshot.list).toEqual({ status: 'error', code: 'FORBIDDEN', message: 'Your InferOps access lacks knowledge permission.' })
  expect(data.snapshot.pages.size).toBe(0)
  expect(wiki.session.dispose).toHaveBeenCalled()
  data.dispose()
})

it('keeps InferOps being turned off apart from lost access, and a removed connection as unbound', async () => {
  const data = new WikiData(overseer, WIKI)
  await flush()
  wiki.session.listDocuments.mockRejectedValueOnce(new Error('Error: DISABLED: InferOps is turned off for this deployment.'))
  data.refresh()
  await flush()
  expect(data.snapshot.list).toEqual({ status: 'disabled', message: 'InferOps is turned off for this deployment.' })
  wiki.session.listDocuments.mockRejectedValueOnce(new Error('No such gatekeeper: 4'))
  data.refresh()
  await flush()
  expect(data.snapshot.list).toEqual({ status: 'unbound' })
  data.dispose()
})

it('lands only the newest read of a page', async () => {
  const data = new WikiData(overseer, WIKI)
  let release!: () => void
  wiki.session.readDocument.mockImplementationOnce(async () => {
    await new Promise<void>(resolve => { release = resolve })
    return { id: 'd1', slug: 'handbook', title: 'Old title', body: '', version: 1, masterRole: null, sections: [], references: [] }
  })
  data.openPage('handbook')
  await flush()
  data.refresh()
  await flush()
  release()
  await flush()
  expect(data.snapshot.pages.get('handbook')).toMatchObject({ status: 'ready', document: { title: 'Team handbook' } })
  data.dispose()
})

it('takes an edit from proposing to awaiting, and only a page read made after it was queued says it was applied', async () => {
  const data = new WikiData(overseer, WIKI)
  data.openPage('handbook')
  await flush()
  const section = sectionOf(data, 'handbook', 's1')
  let release!: () => void
  wiki.session.updateSection.mockImplementationOnce(async (...args) => {
    await new Promise<void>(resolve => { release = resolve })
    return wiki.session.updateSection.getMockImplementation()!(...args)
  })
  const proposal = data.proposeEdit('handbook', section, 'New purpose.')
  await flush()
  expect(data.snapshot.edits.get('s1')).toMatchObject({ phase: 'proposing', expectedVersion: 1 })
  expect(await data.proposeEdit('handbook', section, 'Again')).toMatchObject({ ok: false, code: 'CONFLICT' })
  release()
  expect(await proposal).toEqual({ ok: true })
  await flush()
  expect(data.snapshot.edits.get('s1')?.phase).toBe('awaiting')
  expect(sectionOf(data, 'handbook', 's1')).toMatchObject({ body: 'New purpose.', version: 1, pending: 'update' })
  wiki.approve('s1')
  data.refresh()
  await flush()
  expect(data.snapshot.edits.get('s1')?.phase).toBe('applied')
  expect(sectionOf(data, 'handbook', 's1')).toMatchObject({ body: 'New purpose.', version: 2 })
  data.dismissEdit('s1')
  expect(data.snapshot.edits.has('s1')).toBe(false)
  data.dispose()
})

it('says an edit was rejected, or stale when the section changed first, and never reconciles from a read older than the edit', async () => {
  const data = new WikiData(overseer, WIKI)
  data.openPage('handbook')
  await flush()
  // A read started before the edit was queued lands after it, showing no pending edit: that must not read as a rejection.
  let release!: () => void
  const original = wiki.session.readDocument.getMockImplementation()!
  wiki.session.readDocument.mockImplementationOnce(async slug => { const page = await original(slug); await new Promise<void>(resolve => { release = resolve }); return page })
  data.refresh()
  await flush()
  await data.proposeEdit('handbook', sectionOf(data, 'handbook', 's1'), 'Rejected text')
  release()
  await flush()
  expect(data.snapshot.edits.get('s1')?.phase).toBe('awaiting')
  wiki.reject('s1')
  data.refresh()
  await flush()
  expect(data.snapshot.edits.get('s1')?.phase).toBe('rejected')
  expect(sectionOf(data, 'handbook', 's1').pending).toBeUndefined()

  await data.proposeEdit('handbook', sectionOf(data, 'handbook', 's2'), 'Mine')
  wiki.writeElsewhere('s2', 'Theirs')
  data.refresh()
  await flush()
  expect(data.snapshot.edits.get('s2')?.phase).toBe('stale')
  expect(sectionOf(data, 'handbook', 's2')).toMatchObject({ body: 'Theirs', version: 4 })
  data.dispose()
})

it('refuses an edit at an old version with the gatekeeper\'s code, and re-reads the page', async () => {
  const data = new WikiData(overseer, WIKI)
  data.openPage('handbook')
  await flush()
  const section = sectionOf(data, 'handbook', 's1')
  wiki.writeElsewhere('s1', 'Changed in InferMind')
  const reads = wiki.session.readDocument.mock.calls.length
  expect(await data.proposeEdit('handbook', section, 'Mine')).toMatchObject({ ok: false, code: 'STALE_REVISION' })
  await flush()
  expect(data.snapshot.edits.get('s1')).toMatchObject({ phase: 'refused', code: 'STALE_REVISION' })
  expect(wiki.session.readDocument.mock.calls.length).toBe(reads + 1)
  expect(sectionOf(data, 'handbook', 's1').body).toBe('Changed in InferMind')
  expect(await data.proposeEdit('handbook', sectionOf(data, 'handbook', 's1'), 'Changed in InferMind')).toMatchObject({ ok: false, code: 'UNCHANGED' })
  data.dispose()
})

it('reads the agent text through the same connection, and disposes the session with the instance', async () => {
  const data = new WikiData(overseer, WIKI)
  data.openPage('handbook')
  await flush()
  const result = await data.readAgentText('handbook')
  expect(result).toMatchObject({ ok: true })
  expect(await data.readAgentText('drafts')).toEqual({ ok: false, code: 'NOT_FOUND', message: 'Nothing on this page is readable.' })
  data.dispose()
  await flush()
  expect(wiki.session.dispose).toHaveBeenCalledTimes(1)
  expect(await data.readAgentText('handbook')).toMatchObject({ ok: false, code: 'NOT_CONNECTED' })
})

it('reads the structure beside the page list, states its failure apart from the list, and re-reads it on refresh', async () => {
  const organized = organizedWiki()
  wiki = fakeWiki(organized)
  wiki.session.readStructure.mockRejectedValueOnce(new Error('Error: UNAVAILABLE: InferOps did not answer.'))
  const data = new WikiData(overseer, WIKI)
  await flush()
  expect(data.snapshot.list).toMatchObject({ status: 'ready', refreshing: false })
  expect(data.snapshot.structure).toEqual({ status: 'error', code: 'UNAVAILABLE', message: 'InferOps did not answer.' })
  data.refresh()
  await flush()
  expect(data.snapshot.structure).toEqual({ status: 'ready', structure: organized.structure, refreshing: false })
  // A failed refresh keeps the structure read, with its error.
  wiki.session.readStructure.mockRejectedValueOnce(new Error('Error: UNAVAILABLE: Still down.'))
  data.refresh()
  await flush()
  expect(data.snapshot.structure).toMatchObject({ status: 'ready', structure: organized.structure, error: 'Still down.' })
  data.dispose()
})

it('drops the structure with everything else when access to the Wiki is lost, and keeps it when only a page read fails', async () => {
  wiki = fakeWiki(organizedWiki())
  const data = new WikiData(overseer, WIKI)
  wiki.session.readDocument.mockRejectedValueOnce(new Error('Error: INTERNAL: boom'))
  data.openPage('company')
  await flush()
  expect(data.snapshot.pages.get('company')).toEqual({ status: 'error', message: 'boom' })
  expect(data.snapshot.structure.status).toBe('ready')
  wiki.session.readStructure.mockRejectedValueOnce(new Error('Error: FORBIDDEN: Your InferOps access lacks knowledge permission.'))
  data.refresh()
  await flush()
  expect(data.snapshot.list).toMatchObject({ status: 'error', code: 'FORBIDDEN' })
  expect(data.snapshot.structure).toEqual({ status: 'loading' })
  expect(data.snapshot.pages.size).toBe(0)
  data.dispose()
})

it('lands only the newest structure read', async () => {
  const organized = organizedWiki()
  wiki = fakeWiki(organized)
  let release!: () => void
  wiki.session.readStructure.mockImplementationOnce(async () => {
    await new Promise<void>(resolve => { release = resolve })
    return { root: null, pillars: [], unfiled: [] }
  })
  const data = new WikiData(overseer, WIKI)
  await flush()
  data.refresh()
  await flush()
  release()
  await flush()
  expect(data.snapshot.structure).toMatchObject({ status: 'ready', structure: organized.structure })
  data.dispose()
})

it('takes a body edit from proposing to awaiting under the page\'s pendingBody, and applied only from a later read with its own approval', async () => {
  wiki = fakeWiki(organizedWiki())
  const data = new WikiData(overseer, WIKI)
  data.openPage('ops/incident-response')
  await flush()
  const page = pageOf(data, 'ops/incident-response')
  let release!: () => void
  wiki.session.updateDocumentBody.mockImplementationOnce(async (...args) => {
    await new Promise<void>(resolve => { release = resolve })
    return wiki.session.updateDocumentBody.getMockImplementation()!(...args)
  })
  const proposal = data.proposeBodyEdit(page, '# Incident response\n\nCall the on-call engineer.')
  await flush()
  expect(data.snapshot.bodyEdits.get('p1')).toMatchObject({ phase: 'proposing', expectedVersion: 4 })
  expect(await data.proposeBodyEdit(page, 'Again')).toMatchObject({ ok: false, code: 'CONFLICT' })
  // The approval it raised can be logged before the proposal returns.
  const record = (id: number, state: ActionLogEntry['state'], title = 'Edit Wiki page Incident response') =>
    ({ id, type: 'action', state, resourceUrl: WIKI, resourceTitle: 'InferMind Wiki', createdAt: new Date(), description: { title, description: '' } }) as ActionLogEntry
  data.noteAction(record(21, 'pending'))
  release()
  expect(await proposal).toEqual({ ok: true })
  expect(wiki.session.updateDocumentBody).toHaveBeenCalledWith('p1', '# Incident response\n\nCall the on-call engineer.', 4)
  await flush()
  expect(data.snapshot.bodyEdits.get('p1')?.phase).toBe('awaiting')
  expect(pageOf(data, 'ops/incident-response')).toMatchObject({ version: 4, pendingBody: true, body: '# Incident response\n\nCall the on-call engineer.' })
  // The page's own overlay blocks a second edit, even from another instance.
  expect(await data.proposeBodyEdit(pageOf(data, 'ops/incident-response'), 'Third')).toMatchObject({ ok: false, code: 'CONFLICT' })
  wiki.approveBody('p1')
  // A read landing before the approval record only matches: the page alone cannot say who wrote it.
  data.refresh()
  await flush()
  expect(data.snapshot.bodyEdits.get('p1')?.phase).toBe('matched')
  data.noteAction(record(22, 'approved'))
  data.noteAction(record(21, 'approved', 'Edit Wiki page Operations'))
  expect(data.snapshot.bodyEdits.get('p1')?.phase).toBe('matched')
  data.noteAction(record(21, 'approved'))
  expect(data.snapshot.bodyEdits.get('p1')?.phase).toBe('applied')
  expect(pageOf(data, 'ops/incident-response')).toMatchObject({ version: 5, body: '# Incident response\n\nCall the on-call engineer.' })
  expect(pageOf(data, 'ops/incident-response').pendingBody).toBeUndefined()
  data.dismissBodyEdit('p1')
  expect(data.snapshot.bodyEdits.has('p1')).toBe(false)
  data.dispose()
})

it('says a body edit was rejected, stale when the page changed first, or refused at an old version, re-reading the page', async () => {
  wiki = fakeWiki(organizedWiki())
  const data = new WikiData(overseer, WIKI)
  data.openPage('operations')
  await flush()
  await data.proposeBodyEdit(pageOf(data, 'operations'), 'Rejected text')
  await flush()
  wiki.rejectBody('m2')
  data.refresh()
  await flush()
  expect(data.snapshot.bodyEdits.get('m2')?.phase).toBe('rejected')
  expect(pageOf(data, 'operations').body).toBe('How the team runs day to day.')

  await data.proposeBodyEdit(pageOf(data, 'operations'), 'Mine')
  wiki.writeBodyElsewhere('m2', 'Theirs')
  data.refresh()
  await flush()
  expect(data.snapshot.bodyEdits.get('m2')?.phase).toBe('stale')

  const read = pageOf(data, 'operations')
  wiki.writeBodyElsewhere('m2', 'Changed again')
  const reads = wiki.session.readDocument.mock.calls.length
  expect(await data.proposeBodyEdit(read, 'Mine')).toMatchObject({ ok: false, code: 'STALE_REVISION' })
  await flush()
  expect(data.snapshot.bodyEdits.get('m2')).toMatchObject({ phase: 'refused', code: 'STALE_REVISION' })
  expect(wiki.session.readDocument.mock.calls.length).toBe(reads + 1)
  expect(pageOf(data, 'operations').body).toBe('Changed again')
  expect(await data.proposeBodyEdit(pageOf(data, 'operations'), 'Changed again')).toMatchObject({ ok: false, code: 'UNCHANGED' })
  wiki.session.updateDocumentBody.mockRejectedValueOnce(new Error('Error: FORBIDDEN: You cannot edit this Wiki.'))
  expect(await data.proposeBodyEdit(pageOf(data, 'operations'), 'Mine')).toMatchObject({ ok: false, code: 'FORBIDDEN', message: 'You cannot edit this Wiki.' })
  data.dispose()
})

it('never lets a page list read started before access was lost land after it', async () => {
  wiki = fakeWiki(organizedWiki())
  const data = new WikiData(overseer, WIKI)
  await flush()
  let release!: () => void
  const original = wiki.session.listDocuments.getMockImplementation()!
  wiki.session.listDocuments.mockImplementationOnce(async () => { const pages = await original(); await new Promise<void>(resolve => { release = resolve }); return pages })
  wiki.session.readStructure.mockRejectedValueOnce(new Error('Error: UNAUTHORIZED: Sign in to InferOps again.'))
  data.refresh()
  await flush()
  expect(data.snapshot.list).toMatchObject({ status: 'error', code: 'UNAUTHORIZED' })
  release()
  await flush()
  expect(data.snapshot.list).toMatchObject({ status: 'error', code: 'UNAUTHORIZED' })
  data.dispose()
})
