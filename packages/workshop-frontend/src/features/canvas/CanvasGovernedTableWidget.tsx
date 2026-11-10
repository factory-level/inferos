import { useEffect, useRef, useState } from 'react'
import { Refine, useList, useUpdate, type RefineProps } from '@refinedev/core'
import { QueryClient } from '@tanstack/react-query'
import { Button, Select } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { GovernedSessionHandle, Overseer } from '@gadgets/workshop-shared/api'
import { ACTION_OUTCOME_TEXT, type ActionOutcome } from '@gadgets/workshop-shared/action-outcome'
import type { ActionReceipt } from '@gadgets/workshop-shared/gatekeeper'
import type { CanvasGovernedTableWidget as Widget } from '@gadgets/workshop-shared/canvas'
import type { GovernedCommand, GovernedDescription, GovernedWriteSession } from '@gadgets/workshop-shared/governed-data'
import { governedDataProvider, type GovernedRecord } from './governedDataProvider'

/** Rows one page shows. */
export const GOVERNED_PAGE_SIZE = 25

/**
 * Refine's options for every governed table: no telemetry (the trusted host never reports to
 * Refine's service), and no notifications or redirects of its own.
 */
export const GOVERNED_REFINE_OPTIONS: NonNullable<RefineProps['options']> = { disableTelemetry: true, redirect: { afterEdit: false } }

/**
 * What a governed table's cached reads are scoped by (FAC-9): the widget instance, the connection
 * that serves it and its resource reference, within the Overseer stub it was opened through, which
 * is one person's in one workspace, as `BoardData` is scoped. Refine's own query keys add the
 * request (its filters, sort and page). Each scope has its own query client, discarded on a
 * revocation, so nothing read under one person, connection or reference is shown under another.
 */
export type GovernedCacheScope = { widgetInstance: string; gatekeeperId: number; ref: string }

const scopeKey = (scope: GovernedCacheScope) => JSON.stringify([scope.widgetInstance, scope.gatekeeperId, scope.ref])

// A refusal that means the reader may no longer read this resource here: the sign-in ended, the
// grant was withdrawn, or the connection is gone.
const REVOKED = /\b(UNAUTHORIZED|FORBIDDEN)\b|No such gatekeeper/

type Opened =
  | { status: 'loading' }
  | { status: 'unbound' }
  | { status: 'revoked'; message: string }
  | { status: 'error'; message: string }
  | { status: 'ready'; handle: GovernedSessionHandle }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^(?:\w*Error: )?/, '')

/**
 * One governed resource's rows on a canvas (FAC-9): a custom table or a tickets queue, read through
 * the host's Refine provider over the session `Overseer.openGovernedSession` opens, never upstream.
 * It says when it's loading, when no connection serves the reference, when the reader may no
 * longer read it, and when a read fails, in the server's words; a declared command is proposed for
 * a decision, never applied here.
 */
export const CanvasGovernedTableWidget = ({ widget, overseer }: { widget: Widget; overseer: RpcStub<Overseer> }) => {
  const [opened, setOpened] = useState<Opened>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let current = true
    let held: GovernedSessionHandle | null = null
    setOpened({ status: 'loading' })
    // The handle's session arrives as a stub, which is disposable though its typing drops that.
    Promise.resolve().then(async () => (await overseer.openGovernedSession(widget.targetRef)) as unknown as GovernedSessionHandle | null).then(
      handle => {
        if (!current) { handle?.session[Symbol.dispose](); return }
        held = handle
        setOpened(handle ? { status: 'ready', handle } : { status: 'unbound' })
      },
      (error: unknown) => {
        if (!current) return
        const message = messageOf(error)
        setOpened(REVOKED.test(message) ? { status: 'revoked', message } : { status: 'error', message })
      })
    return () => { current = false; held?.session[Symbol.dispose]() }
  }, [overseer, widget.targetRef, attempt])

  const retry = <Button size="sm" onClick={() => setAttempt(count => count + 1)}>Try again</Button>
  return <section aria-label={`Rows of ${widget.targetRef}`} className="min-w-0 space-y-2 rounded-xl border border-kumo-line bg-kumo-base p-4">
    {opened.status === 'loading' && <p aria-busy="true" className="text-sm text-kumo-subtle">Opening this resource…</p>}
    {opened.status === 'unbound' && <p className="text-sm text-kumo-subtle">Not connected: this workspace holds no connection for this resource.</p>}
    {opened.status === 'revoked' && <div role="alert" className="space-y-2 text-sm text-kumo-danger"><p>You can no longer read this resource here: {opened.message}</p>{retry}</div>}
    {opened.status === 'error' && <div role="alert" className="space-y-2 text-sm text-kumo-danger"><p>{opened.message}</p>{retry}</div>}
    {opened.status === 'ready' && <GovernedRows key={`${opened.handle.gatekeeperId}:${widget.targetRef}`} handle={opened.handle}
      scope={{ widgetInstance: widget.id, gatekeeperId: opened.handle.gatekeeperId, ref: widget.targetRef }}
      onRevoked={message => setOpened({ status: 'revoked', message })} />}
  </section>
}

/** The rows of one opened resource, under its own scoped query client. */
const GovernedRows = ({ handle, scope, onRevoked }: { handle: GovernedSessionHandle; scope: GovernedCacheScope; onRevoked: (message: string) => void }) => {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }))
  const [provider] = useState(() => {
    // Every call goes through the governed session; a revocation discards everything cached.
    const guarded = <T,>(call: (session: GovernedWriteSession) => Promise<T>) => call(handle.session).catch((error: unknown) => {
      const message = messageOf(error)
      if (REVOKED.test(message)) { client.clear(); onRevoked(message) }
      throw error
    })
    const session: GovernedWriteSession = {
      describe: () => guarded(s => s.describe()),
      list: request => guarded(s => s.list(request)),
      get: id => guarded(s => s.get(id)),
      command: request => guarded(s => s.command(request)),
    }
    return { session, dataProvider: governedDataProvider(async () => session) }
  })
  useEffect(() => () => client.clear(), [client])

  return <Refine dataProvider={provider.dataProvider} options={{ ...GOVERNED_REFINE_OPTIONS, reactQuery: { clientConfig: client } }}>
    <GovernedTable resource={scopeKey(scope)} session={provider.session} />
  </Refine>
}

const GovernedTable = ({ resource, session }: { resource: string; session: GovernedWriteSession }) => {
  const [description, setDescription] = useState<GovernedDescription | null>(null)
  const [described, setDescribed] = useState<string | null>(null)
  const [page, setPage] = useState(1)

  useEffect(() => {
    let current = true
    session.describe().then(next => { if (current) setDescription(next) }, (error: unknown) => { if (current) setDescribed(messageOf(error)) })
    return () => { current = false }
  }, [session])

  const { query, result } = useList<GovernedRecord>({ resource, pagination: { currentPage: page, pageSize: GOVERNED_PAGE_SIZE } })

  if (described !== null) return <p role="alert" className="text-sm text-kumo-danger">{described}</p>
  if (!description || query.isLoading) return <p aria-busy="true" className="text-sm text-kumo-subtle">Loading rows…</p>
  if (query.isError) return <div role="alert" className="space-y-2 text-sm text-kumo-danger"><p>{messageOf(query.error)}</p>
    <Button size="sm" onClick={() => void query.refetch()}>Try again</Button></div>
  const rows = result.data
  const total = result.total ?? 0
  if (rows.length === 0) return <p className="text-sm text-kumo-subtle">No rows.</p>
  const fields = description.fields
  return <div className="min-w-0 space-y-2">
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm text-kumo-default">
        <thead><tr>{fields.map(field => <th key={field.name} scope="col" className="px-2 py-1 font-medium">{field.label}</th>)}
          {description.commands.length > 0 && <th scope="col" className="px-2 py-1 font-medium">Propose</th>}</tr></thead>
        <tbody>{rows.map(row => <tr key={row.id} className="border-t border-kumo-line">
          {fields.map(field => <td key={field.name} className="px-2 py-1"><bdi>{String(row.values[field.name] ?? '')}</bdi></td>)}
          {description.commands.length > 0 && <td className="px-2 py-1">
            {description.commands.map(command => <CommandForm key={command.name} resource={resource} row={row} command={command} description={description} refresh={query.refetch} />)}
          </td>}
        </tr>)}</tbody>
      </table>
    </div>
    <div className="flex items-center gap-2 text-sm text-kumo-subtle">
      <Button size="sm" disabled={page === 1} onClick={() => setPage(current => current - 1)}>Previous</Button>
      <span>Page {page} of {Math.max(1, Math.ceil(total / GOVERNED_PAGE_SIZE))}{result.truncated ? ', of the rows read so far' : ''}</span>
      <Button size="sm" disabled={page * GOVERNED_PAGE_SIZE >= total} onClick={() => setPage(current => current + 1)}>Next</Button>
    </div>
  </div>
}

/** One declared command on one row: its one field's allowed values, proposed for a decision. */
const RECEIPT_POLL_MS = 1_000
type CommandState = { kind: 'receipt'; outcome: ActionOutcome; reason?: string } | { kind: 'status-error' } | { kind: 'stale' } | { kind: 'error'; message: string } | null

const CommandForm = ({ resource, row, command, description, refresh }: { resource: string; row: GovernedRecord; command: GovernedCommand; description: GovernedDescription; refresh: () => Promise<unknown> }) => {
  const field = description.fields.find(item => item.name === command.fields[0])
  const [value, setValue] = useState('')
  const update = useUpdate()
  const [state, setState] = useState<CommandState>(null)
  const [receipt, setReceipt] = useState<ActionReceipt | null>(null)
  const [pending, setPending] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const checkReceipt = async (current: ActionReceipt) => {
    for (;;) {
      let status
      try { status = await current.status() }
      catch {
        if (mounted.current) setState({ kind: 'status-error' })
        return
      }
      if (status.outcome === 'waiting' || status.outcome === 'running') {
        if (mounted.current) setState({ kind: 'receipt', outcome: status.outcome, ...(status.reason ? { reason: status.reason } : {}) })
        await new Promise(resolve => setTimeout(resolve, RECEIPT_POLL_MS))
        if (!mounted.current) return
        continue
      }
      if (mounted.current) setState({ kind: 'receipt', outcome: status.outcome, ...(status.reason ? { reason: status.reason } : {}) })
      await refresh()
      if (mounted.current && status.code === 'STALE_REVISION') {
        setState({ kind: 'receipt', outcome: status.outcome, reason: `${status.reason ?? 'The row changed since it was read.'} The row was refreshed; review it before proposing again.` })
      }
      if (mounted.current) setPending(false)
      return
    }
  }

  useEffect(() => {
    if (receipt) void checkReceipt(receipt)
    // A new attempt only retries the receipt capability; it never resubmits the write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt])

  // Only a command with one field that has a fixed set of values is offered here.
  if (command.fields.length !== 1 || !field?.options || row.revision === undefined) return null
  const propose = async () => {
    if (!value || pending) return
    setPending(true); setState({ kind: 'receipt', outcome: 'waiting' })
    try {
      const result = await update.mutateAsync({ resource, id: row.id, mutationMode: 'pessimistic', invalidates: [], successNotification: false, errorNotification: false,
        values: { command: command.name, values: { [field.name]: value }, expectedRevision: row.revision } })
      const submitted = (result.data as GovernedRecord).receipt
      if (!submitted) throw new Error('The command response did not include its operation receipt.')
      setReceipt(submitted)
      await checkReceipt(submitted)
    } catch (error) {
      const message = messageOf(error)
      await refresh()
      if (/STALE_REVISION/.test(message)) setState({ kind: 'stale' })
      else setState({ kind: 'error', message })
      setPending(false)
    }
  }
  return <div className="flex flex-wrap items-end gap-2">
    <Select label={command.label} value={value} onValueChange={next => setValue(String(next ?? ''))} renderValue={next => next ? String(next) : `Choose ${field.label.toLowerCase()}`}>
      {field.options.filter(option => option !== row.values[field.name]).map(option => <Select.Option key={option} value={option}>{option}</Select.Option>)}
    </Select>
    <Button size="sm" disabled={!value || pending} onClick={() => void propose()}>Propose</Button>
    {state?.kind === 'receipt' && <span role="status" className="text-xs text-kumo-subtle">{ACTION_OUTCOME_TEXT[state.outcome]}{state.reason ? `: ${state.reason}` : ''}</span>}
    {state?.kind === 'status-error' && <span role="status" className="text-xs text-kumo-danger">Could not check this operation's status. It has not been resubmitted.</span>}
    {state?.kind === 'status-error' && <Button size="sm" onClick={() => setAttempt(count => count + 1)}>Retry status</Button>}
    {state?.kind === 'stale' && <span role="status" className="text-xs text-kumo-danger">This row changed since it was read. It has been refreshed; review it and try again.</span>}
    {state?.kind === 'error' && <span role="status" className="text-xs text-kumo-danger">{state.message}</span>}
  </div>
}
