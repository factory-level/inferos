import { beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { WikiData } from './wikiData'
import { WIKI, fakeWiki } from './wikiTestDoubles'

let wiki: ReturnType<typeof fakeWiki>
const clientDispose = vi.fn<() => void>()
const lookup = vi.fn<(url: string) => Promise<object | null>>()
const overseer = { getGatekeeperByResourceUrl: lookup } as unknown as RpcStub<Overseer>
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
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
  expect(await data.readAgentText('drafts')).toEqual({ ok: false, code: 'NOT_FOUND', message: 'No section of this page is readable.' })
  data.dispose()
  await flush()
  expect(wiki.session.dispose).toHaveBeenCalledTimes(1)
  expect(await data.readAgentText('handbook')).toMatchObject({ ok: false, code: 'NOT_CONNECTED' })
})
