import { describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { accountUrlFor, openInferOpsSession } from './inferopsConnection'

const BOARD = 'inferops://acme.operations/project/board/ENG'
const WIKI = 'inferops://acme.mind/knowledge/wiki'
const ACCOUNT = 'inferops://acme/account'

/** A fake workspace holding connections by exact URL; records lookups, opens and disposals. */
const workspace = (held: Record<string, 'board' | 'wiki' | 'account'>, refuse?: string) => {
  const lookups: string[] = []
  const disposed: string[] = []
  const opened: string[] = []
  const sessionFor = (url: string) => {
    const kind = held[url]
    if (kind !== 'account') return { kind, url, [Symbol.dispose]: () => disposed.push(`session:${url}`) }
    const open = (ref: string, opens: 'board' | 'wiki') => {
      opened.push(`${opens}:${ref}`)
      if (ref === refuse) return Promise.reject(new Error('NOT_FOUND: No such InferOps board is available to this connection.'))
      return Promise.resolve({ kind: opens, url: ref, via: url })
    }
    return {
      openBoard: (ref: string) => open(ref, 'board'),
      openWiki: (ref: string) => open(ref, 'wiki'),
      [Symbol.dispose]: () => disposed.push(`session:${url}`),
    }
  }
  const overseer = {
    getGatekeeperByResourceUrl: vi.fn<(url: string) => Promise<object | null>>(async url => {
      lookups.push(url)
      if (!held[url]) return null
      return { openSession: async () => sessionFor(url), [Symbol.dispose]: () => disposed.push(`client:${url}`) }
    }),
  } as unknown as RpcStub<Overseer>
  return { overseer, lookups, disposed, opened }
}

describe('accountUrlFor', () => {
  it('names the account connection of a reference\'s organization, and nothing for anything else', () => {
    expect(accountUrlFor(BOARD)).toBe(ACCOUNT)
    expect(accountUrlFor(WIKI)).toBe(ACCOUNT)
    expect(accountUrlFor('inferops://ACME.Operations/project/board/ENG')).toBe(ACCOUNT)
    expect(accountUrlFor('inferops://demo.local/project/board/DEMO')).toBe('inferops://demo.local/account')
    expect(accountUrlFor('inferops://operations/project/board/ENG')).toBeNull()
    expect(accountUrlFor('inferops://a.b.c/project/board/ENG')).toBeNull()
    expect(accountUrlFor('https://acme.operations/project/board/ENG')).toBeNull()
  })
})

describe('openInferOpsSession', () => {
  it('uses the exact connection when the workspace holds one, even beside an account connection', async () => {
    const ws = workspace({ [BOARD]: 'board', [ACCOUNT]: 'account' })
    expect(await openInferOpsSession(ws.overseer, BOARD, 'board')).toMatchObject({ kind: 'board', url: BOARD })
    expect(ws.lookups).toEqual([BOARD])
    expect(ws.opened).toEqual([])
    expect(ws.disposed).toEqual([`client:${BOARD}`])
  })

  it('falls back to the organization\'s account connection, opening the reference as its kind', async () => {
    const ws = workspace({ [ACCOUNT]: 'account' })
    expect(await openInferOpsSession(ws.overseer, BOARD, 'board')).toEqual({ kind: 'board', url: BOARD, via: ACCOUNT })
    expect(await openInferOpsSession(ws.overseer, WIKI, 'wiki')).toEqual({ kind: 'wiki', url: WIKI, via: ACCOUNT })
    expect(ws.lookups).toEqual([BOARD, ACCOUNT, WIKI, ACCOUNT])
    expect(ws.opened).toEqual([`board:${BOARD}`, `wiki:${WIKI}`])
    // The account session and client are disposed; only the opened session is handed back.
    expect(ws.disposed).toEqual([`session:${ACCOUNT}`, `client:${ACCOUNT}`, `session:${ACCOUNT}`, `client:${ACCOUNT}`])
  })

  it('is unbound when the workspace holds neither, and never looks up another organization', async () => {
    const ws = workspace({ 'inferops://globex/account': 'account' })
    expect(await openInferOpsSession(ws.overseer, BOARD, 'board')).toBeNull()
    expect(ws.lookups).toEqual([BOARD, ACCOUNT])
    expect(await openInferOpsSession(ws.overseer, 'inferops://operations/project/board/ENG', 'board')).toBeNull()
    expect(ws.lookups).toEqual([BOARD, ACCOUNT, 'inferops://operations/project/board/ENG'])
  })

  it('rejects with the account connection\'s refusal, so the widget shows an error, and still disposes its stubs', async () => {
    const ws = workspace({ [ACCOUNT]: 'account' }, BOARD)
    await expect(openInferOpsSession(ws.overseer, BOARD, 'board')).rejects.toThrow(/^NOT_FOUND: /)
    expect(ws.disposed).toEqual([`session:${ACCOUNT}`, `client:${ACCOUNT}`])
  })
})
