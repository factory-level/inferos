import type { BaseKey, BaseRecord, CrudFilter, CrudSort, DataProvider, MetaQuery, Pagination } from '@refinedev/core'
import type { GovernedFilter, GovernedListResult, GovernedRow, GovernedWriteSession } from '@gadgets/workshop-shared/governed-data'

/** What `getApiUrl` answers: there is no API URL, since every read goes through the governed session. */
export const GOVERNED_API_URL = 'inferos:governed'

/** A governed row as Refine holds it: its id, its values by field, and its revision when it has one. */
export type GovernedRecord = BaseRecord & { id: string; values: GovernedRow['values']; revision?: string }

/** What `update` takes: one of the resource's declared commands, with exactly its fields. */
export type GovernedCommandVariables = { command: string; values: Record<string, string | number | boolean>; expectedRevision: string }

/** A request this provider refuses before anything reaches the session. */
export class GovernedProviderRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GovernedProviderRefusal'
  }
}

const refuse = (message: string): never => { throw new GovernedProviderRefusal(message) }
const WRITES_REFUSED = "Only a resource's declared commands write here."

// Refine adds its own query context to every read (`prepareQueryContext`: the query key and its
// abort signal); a caller's own options are refused.
const REFINE_CONTEXT = new Set(['queryKey', 'signal'])
const noMeta = (meta: MetaQuery | undefined) => {
  if (meta !== undefined && Object.keys(meta).some(key => !REFINE_CONTEXT.has(key))) refuse('A governed resource takes no extra request options.')
}

const toRecord = (row: GovernedRow): GovernedRecord =>
  ({ id: row.id, values: row.values, ...(row.revision === undefined ? {} : { revision: row.revision }) })

// Refine's filters, as the governed contract's: "equals" and "contains" on one field each; no
// "or"/"and" groups and no other operator.
const toFilters = (filters: CrudFilter[] | undefined): GovernedFilter[] => (filters ?? []).map(filter => {
  if (!('field' in filter) || (filter.operator !== 'eq' && filter.operator !== 'contains')) {
    return refuse('Only "equals" and "contains" filters are offered.')
  }
  return { field: filter.field, op: filter.operator, value: filter.value as GovernedFilter['value'] }
})

const toSort = (sorters: CrudSort[] | undefined) => {
  if (!sorters || sorters.length === 0) return {}
  if (sorters.length > 1) return refuse('Only one sort key is offered.')
  return { sort: { field: sorters[0]!.field, order: sorters[0]!.order } }
}

/**
 * A source-agnostic Refine DataProvider over one governed resource's session (FAC-9;
 * `Overseer.openGovernedSession`), whatever connector serves it. Reads go only through the
 * governed contract (`describe`, `list`, `get`): Refine's filters, one sort key and numbered pages
 * become a governed list request, and a numbered page is reached by walking the cursors the earlier
 * pages of the same request returned, remembered per request. Writes are only the resource's
 * declared commands (`update` with `{command, values, expectedRevision}`), proposed for a decision:
 * the answer says "proposed", never done. `create`, `deleteOne`, every `*Many` write, `custom` and
 * any `meta` are refused outright. The connector validates every request again and logs every read
 * as an observation; nothing here grants anything.
 */
export const governedDataProvider = (session: () => Promise<GovernedWriteSession>): DataProvider => {
  // Per request (its filters, sort and page size): the cursor that reads each page, page 1 first.
  const cursors = new Map<string, (string | null)[]>()

  const list = async (request: { filters: GovernedFilter[]; sort?: { field: string; order: 'asc' | 'desc' }; pageSize: number },
      page: number): Promise<GovernedListResult | null> => {
    const key = JSON.stringify(request)
    const known = cursors.get(key) ?? [null]
    cursors.set(key, known)
    const governed = await session()
    let index = Math.min(page, known.length) - 1
    for (;;) {
      const cursor = known[index]
      // The page before this one was the last.
      if (index > 0 && cursor === null) return null
      const result = await governed.list(index === 0 ? request : { ...request, cursor })
      known[index + 1] = result.nextCursor
      if (index + 1 === page) return result
      index++
    }
  }

  return {
    getApiUrl: () => GOVERNED_API_URL,

    getList: async <TData extends BaseRecord = BaseRecord>({ pagination, filters, sorters, meta }:
        { pagination?: Pagination; filters?: CrudFilter[]; sorters?: CrudSort[]; meta?: MetaQuery }) => {
      noMeta(meta)
      if (pagination?.mode !== undefined && pagination.mode !== 'server') refuse('A governed resource pages on the server only.')
      const request = { filters: toFilters(filters), ...toSort(sorters), pageSize: pagination?.pageSize ?? 25 }
      const page = Math.max(1, Math.floor(pagination?.currentPage ?? 1))
      const result = await list(request, page)
      return { data: (result?.rows.map(toRecord) ?? []) as unknown as TData[], total: result?.total ?? 0, truncated: result?.truncated ?? false }
    },

    getOne: async <TData extends BaseRecord = BaseRecord>({ id, meta }: { id: BaseKey; meta?: MetaQuery }) => {
      noMeta(meta)
      const row = await (await session()).get(String(id))
      if (!row) return refuse('This row is no longer here.')
      return { data: toRecord(row) as unknown as TData }
    },

    getMany: async <TData extends BaseRecord = BaseRecord>({ ids, meta }: { ids: BaseKey[]; meta?: MetaQuery }) => {
      noMeta(meta)
      const governed = await session()
      const rows = await Promise.all(ids.map(id => governed.get(String(id))))
      return { data: rows.flatMap(row => row ? [toRecord(row)] : []) as unknown as TData[] }
    },

    update: async <TData extends BaseRecord = BaseRecord, TVariables = {}>({ id, variables, meta }:
        { id: BaseKey; variables: TVariables; meta?: MetaQuery }) => {
      noMeta(meta)
      const given = variables as Record<string, unknown>
      if (!given || typeof given !== 'object' || Object.keys(given).some(key => !['command', 'values', 'expectedRevision'].includes(key))) {
        return refuse('A write is one declared command, with its values and the revision it was read at.')
      }
      const { command, values, expectedRevision } = given as GovernedCommandVariables
      const receipt = await (await session()).command({ command, id: String(id), values, expectedRevision })
      return { data: { id: String(id), outcome: receipt.outcome } as unknown as TData }
    },

    create: async () => refuse(WRITES_REFUSED),
    createMany: async () => refuse(WRITES_REFUSED),
    updateMany: async () => refuse(WRITES_REFUSED),
    deleteOne: async () => refuse(WRITES_REFUSED),
    deleteMany: async () => refuse(WRITES_REFUSED),
    custom: async () => refuse('A governed resource takes no other requests.'),
  }
}
