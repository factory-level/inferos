// FAC-9: the host's source-agnostic Refine DataProvider over one governed resource's session
// (Overseer.openGovernedSession). It reads through the governed contract only: Refine's filters,
// one sort key and numbered pages become a governed list request, walked by its cursors; writes are
// only the resource's declared commands, pessimistic, and everything else is refused outright.
import { describe, expect, it, vi } from 'vitest'
import type { GovernedListResult, GovernedRow, GovernedWriteSession } from '@gadgets/workshop-shared/governed-data'
import { GOVERNED_API_URL, governedDataProvider } from './governedDataProvider'

const row = (n: number): GovernedRow => ({ id: `r${n}`, values: { title: `Row ${n}`, status: n % 2 ? 'open' : 'closed' }, revision: String(n) })

/** A session over `total` rows, paging by an opaque cursor as the connector does. */
function session(total = 5) {
  const calls: unknown[] = []
  const rows = Array.from({ length: total }, (_, i) => row(i + 1))
  const impl: GovernedWriteSession = {
    describe: async () => ({ resource: 'tickets/queue', fields: [], commands: [{ name: 'setStatus', label: 'Change status', fields: ['status'] }] }),
    list: vi.fn<GovernedWriteSession['list']>(async (request: unknown): Promise<GovernedListResult> => {
      calls.push(request)
      const { pageSize = 25, cursor } = request as { pageSize?: number; cursor?: string }
      const offset = cursor === undefined ? 0 : Number(cursor.slice(1))
      const next = offset + pageSize
      return { rows: rows.slice(offset, next), nextCursor: next < rows.length ? `c${next}` : null, total: rows.length, truncated: false }
    }),
    get: vi.fn<GovernedWriteSession['get']>(async (id: string) => rows.find(item => item.id === id) ?? null),
    command: vi.fn<GovernedWriteSession['command']>(async () => ({
      outcome: 'proposed' as const, actionId: 'test-action', status: async () => ({ outcome: 'waiting' as const }),
    })),
  }
  return { impl, calls, provider: governedDataProvider(async () => impl) }
}

describe('governedDataProvider (FAC-9)', () => {
  it('lists through the governed contract: filters, one sort key and a page size', async () => {
    const { provider, calls } = session()
    const page = await provider.getList({
      resource: 'queue',
      filters: [{ field: 'status', operator: 'eq', value: 'open' }, { field: 'title', operator: 'contains', value: 'row' }],
      sorters: [{ field: 'title', order: 'desc' }],
      pagination: { currentPage: 1, pageSize: 2 },
    })
    expect(calls).toEqual([{ filters: [{ field: 'status', op: 'eq', value: 'open' }, { field: 'title', op: 'contains', value: 'row' }],
      sort: { field: 'title', order: 'desc' }, pageSize: 2 }])
    expect(page).toEqual({ data: [{ id: 'r1', values: row(1).values, revision: '1' }, { id: 'r2', values: row(2).values, revision: '2' }],
      total: 5, truncated: false })
  })

  it('reaches a numbered page by walking the cursors the earlier pages returned, and remembers them', async () => {
    const { provider, calls } = session(5)
    const third = await provider.getList({ resource: 'queue', pagination: { currentPage: 3, pageSize: 2 } })
    expect(third.data.map(item => item.id)).toEqual(['r5'])
    expect(calls).toEqual([{ filters: [], pageSize: 2 }, { filters: [], pageSize: 2, cursor: 'c2' }, { filters: [], pageSize: 2, cursor: 'c4' }])
    // Page 2 again reads only that page, from the cursor already known.
    calls.length = 0
    expect((await provider.getList({ resource: 'queue', pagination: { currentPage: 2, pageSize: 2 } })).data.map(item => item.id)).toEqual(['r3', 'r4'])
    expect(calls).toEqual([{ filters: [], pageSize: 2, cursor: 'c2' }])
    // Past the last page there's nothing, without another read.
    calls.length = 0
    expect((await provider.getList({ resource: 'queue', pagination: { currentPage: 9, pageSize: 2 } })).data).toEqual([])
    expect(calls).toEqual([])
  })

  it("accepts Refine's own query context, and refuses any option a caller adds", async () => {
    const { provider, calls } = session()
    await provider.getList({ resource: 'queue', meta: { queryKey: ['queue'], signal: undefined } })
    expect(calls).toHaveLength(1)
    await expect(provider.getList({ resource: 'queue', meta: { queryKey: ['queue'], headers: { x: '1' } } })).rejects.toThrow('A governed resource takes no extra request options.')
    expect(calls).toHaveLength(1)
  })

  it('refuses a filter, sort or paging the contract doesn\'t offer, and any meta, before reading', async () => {
    const { provider, calls } = session()
    for (const [params, message] of [
      [{ filters: [{ field: 'title', operator: 'startswith', value: 'R' }] }, 'Only "equals" and "contains" filters are offered.'],
      [{ filters: [{ operator: 'or', value: [{ field: 'title', operator: 'eq', value: 'x' }] }] }, 'Only "equals" and "contains" filters are offered.'],
      [{ sorters: [{ field: 'title', order: 'asc' }, { field: 'status', order: 'asc' }] }, 'Only one sort key is offered.'],
      [{ pagination: { mode: 'client' } }, 'A governed resource pages on the server only.'],
      [{ meta: { url: 'https://example.com' } }, 'A governed resource takes no extra request options.'],
    ] as const) {
      await expect(provider.getList({ resource: 'queue', ...params } as never)).rejects.toThrow(message)
    }
    expect(calls).toEqual([])
  })

  it('reads one row or several by id, and says when a row is gone', async () => {
    const { provider } = session()
    expect(await provider.getOne({ resource: 'queue', id: 'r2' })).toEqual({ data: { id: 'r2', values: row(2).values, revision: '2' } })
    expect((await provider.getMany!({ resource: 'queue', ids: ['r1', 'gone', 'r3'] })).data.map(item => item.id)).toEqual(['r1', 'r3'])
    await expect(provider.getOne({ resource: 'queue', id: 'gone' })).rejects.toThrow('This row is no longer here.')
  })

  it('writes only a declared command, proposed for a decision, with exactly its fields', async () => {
    const { provider, impl } = session()
    expect(await provider.update({ resource: 'queue', id: 'r1', variables: { command: 'setStatus', values: { status: 'closed' }, expectedRevision: '1' } }))
      .toEqual({ data: { id: 'r1', outcome: 'proposed' } })
    expect(impl.command).toHaveBeenCalledWith({ command: 'setStatus', id: 'r1', values: { status: 'closed' }, expectedRevision: '1' })
    await expect(provider.update({ resource: 'queue', id: 'r1', variables: { command: 'setStatus', values: {}, expectedRevision: '1', url: 'x' } }))
      .rejects.toThrow('A write is one declared command, with its values and the revision it was read at.')
    await expect(provider.update({ resource: 'queue', id: 'r1', variables: { command: 'setStatus', values: {}, expectedRevision: '1' }, meta: { x: 1 } }))
      .rejects.toThrow('A governed resource takes no extra request options.')
    expect(impl.command).toHaveBeenCalledTimes(1)
  })

  it('refuses every other write and request outright', async () => {
    const { provider, impl } = session()
    await expect(provider.create({ resource: 'queue', variables: {} })).rejects.toThrow("Only a resource's declared commands write here.")
    await expect(provider.deleteOne({ resource: 'queue', id: 'r1' })).rejects.toThrow("Only a resource's declared commands write here.")
    await expect(provider.createMany!({ resource: 'queue', variables: [{}] })).rejects.toThrow("Only a resource's declared commands write here.")
    await expect(provider.updateMany!({ resource: 'queue', ids: ['r1'], variables: {} })).rejects.toThrow("Only a resource's declared commands write here.")
    await expect(provider.deleteMany!({ resource: 'queue', ids: ['r1'] })).rejects.toThrow("Only a resource's declared commands write here.")
    await expect(provider.custom!({ url: 'https://example.com', method: 'get' })).rejects.toThrow('A governed resource takes no other requests.')
    expect(provider.getApiUrl()).toBe(GOVERNED_API_URL)
    expect(impl.command).not.toHaveBeenCalled()
  })
})
