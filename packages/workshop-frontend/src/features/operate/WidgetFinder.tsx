import { useEffect, useState, type FormEvent } from 'react'
import { Button, Input, Loader } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import type { WidgetSearchAnswer, WidgetSearchUnavailableReason } from '@gadgets/workshop-shared/gatekeeper'
import type { ConsoleWidgetInstance } from '@gadgets/workshop-shared/operate-console'
import type { WidgetPlacementRef } from '@gadgets/workshop-shared/widget-placements'
import { canonicalBoardRef } from '../canvas/boardData'
import type { WorkspaceScreensState } from '../../pages/inferops-canvas/useWorkspaceScreens'
import { placeableBuiltin } from './personalCanvas'

/** Why a search asked nothing, in a person's words: never "no widgets". */
export const SEARCH_UNAVAILABLE: Record<WidgetSearchUnavailableReason, string> = {
  'not-configured': "Widget search isn't set up for this deployment.",
  'not-connected': 'Connect your InferOps account to search for widgets.',
  reconnect: 'Your InferOps sign-in has expired. Reconnect your account to search for widgets.',
  'no-workspace': 'Your InferOps account has no workspace to search.',
}

type Search =
  | { status: 'idle' }
  | { status: 'searching'; query: string }
  | { status: 'error'; query: string }
  | { status: 'done'; query: string; answer: WidgetSearchAnswer }

type Instances =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; instances: (ConsoleWidgetInstance & { workspaceId: string; workspaceTitle: string })[] }

const BOARD_REF = /^inferops:\/\/[^/\s]+\/project\/board\/[^/\s]+$/

/** Whether a workspace's published consoles offer this definition, from what Operate already loaded. */
const offers = (workspace: { consoles: { published: { content: { widgets?: { blueprintId: string; version: number }[] } } | null }[] },
    blueprintId: string, version: number) =>
  workspace.consoles.some(console => console.published?.content.widgets?.some(widget =>
    widget.blueprintId === blueprintId && widget.version === version) === true)

/**
 * Find a widget by what the person wants it for, and choose what to place (FAC-13): one of the
 * widgets InferOps' search says they may use, asked with their own accounts, then a console that
 * offers it (each workspace's `listWidgetInstances`, which only answers what the person may open)
 * or, for a board, the board to show. A search that asked nothing says why, a partial one says
 * what it couldn't search, and an empty one says nothing matched: the three are never alike.
 */
export const WidgetFinder = ({ api, screens, currentBoard, onPlace }: {
  api: RpcStub<AuthenticatedApi>
  screens: WorkspaceScreensState
  /** The board open in the session now, offered as a board's target. */
  currentBoard: string | null
  /** Places a widget; resolves to the refusal's words, or null once placed. */
  onPlace: (ref: WidgetPlacementRef) => Promise<string | null>
}) => {
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState<Search>({ status: 'idle' })
  const [chosen, setChosen] = useState<{ blueprintId: string; version: number; title: string; attempt: number } | null>(null)
  const [instances, setInstances] = useState<Instances>({ status: 'loading' })
  const [boardKind, setBoardKind] = useState<string | null>(null)
  const [boardRef, setBoardRef] = useState('')
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)

  const run = async (text: string) => {
    setChosen(null)
    setBoardKind(null)
    setSearch({ status: 'searching', query: text })
    try {
      setSearch({ status: 'done', query: text, answer: await api.searchWidgets(text) })
    } catch {
      setSearch({ status: 'error', query: text })
    }
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const text = query.trim()
    if (text) void run(text)
  }

  const chooseDefinition = (definition: { sourceId: string; sourceVersion: number; title: string }) => {
    setBoardKind(null)
    setChosen({ blueprintId: definition.sourceId, version: definition.sourceVersion, title: definition.title, attempt: Date.now() })
  }

  // The consoles that offer the chosen definition: only workspaces whose published consoles list
  // it are asked, each through its own `listWidgetInstances`, which answers only what the person
  // may open. Read again when Operate's workspace list arrives or changes.
  useEffect(() => {
    if (!chosen) return
    if (screens.status !== 'ready') { setInstances({ status: screens.status === 'error' ? 'error' : 'loading' }); return }
    let current = true
    setInstances({ status: 'loading' })
    const asked = screens.workspaces.filter(workspace => offers(workspace, chosen.blueprintId, chosen.version))
    Promise.all(asked.map(async ({ workspace }) => {
      const overseer = api.openGadget(workspace.id)
      try {
        const list = await overseer.listWidgetInstances(chosen.blueprintId, chosen.version)
        return list.map(instance => ({ ...instance, workspaceId: workspace.id, workspaceTitle: workspace.title }))
      } finally {
        overseer[Symbol.dispose]()
      }
    })).then(
      found => { if (current) setInstances({ status: 'ready', instances: found.flat() }) },
      () => { if (current) setInstances({ status: 'error' }) })
    return () => { current = false }
  }, [api, chosen, screens])

  const place = async (ref: WidgetPlacementRef) => {
    setBusy(true)
    setRefusal(null)
    try {
      setRefusal(await onPlace(ref))
    } finally {
      setBusy(false)
    }
  }

  const typedBoard = canonicalBoardRef(boardRef.trim())
  const answer = search.status === 'done' ? search.answer : null
  const searched = answer?.status === 'searched' ? answer : null

  return (
    <section aria-label="Add a widget" className="space-y-3 rounded-xl border border-kumo-line bg-kumo-base p-4">
      <form className="flex flex-wrap items-center gap-2" onSubmit={submit}>
        <Input aria-label="What do you want a widget for?" className="min-w-0 flex-1" value={query} maxLength={500}
          placeholder="What do you want to see or do? e.g. open refunds this week" onChange={(e) => setQuery(e.target.value)} />
        <Button type="submit" variant="primary" disabled={!query.trim() || search.status === 'searching'}>Search</Button>
      </form>

      {search.status === 'searching' && <p role="status" className="flex items-center gap-2 text-sm text-kumo-subtle"><Loader size="sm" /> Searching…</p>}
      {search.status === 'error' && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-kumo-danger">
          Couldn't search for widgets just now.
          <Button size="sm" onClick={() => void run(search.query)}>Try again</Button>
        </div>
      )}
      {answer?.status === 'unavailable' && <p role="status" className="text-sm text-kumo-subtle">{SEARCH_UNAVAILABLE[answer.reason]}</p>}
      {searched && (searched.unsearched > 0 || searched.denied > 0) && (
        <p role="status" className="text-[12px] text-kumo-subtle">
          {[searched.unsearched > 0 && `${searched.unsearched} ${searched.unsearched === 1 ? 'place' : 'places'} couldn't be searched just now, so this may be incomplete.`,
            searched.denied > 0 && `You may not search ${searched.denied} ${searched.denied === 1 ? 'place' : 'places'}.`]
            .filter(Boolean).join(' ')}
        </p>
      )}
      {searched && searched.hits.length === 0 && searched.definitions.length === 0 && (
        <p className="text-sm text-kumo-subtle">No widgets you may use match “{search.status === 'done' ? search.query : ''}”.</p>
      )}
      {searched && (searched.hits.length > 0 || searched.definitions.length > 0) && (
        <ul aria-label="Matching widgets" className="m-0 list-none space-y-1 p-0">
          {searched.definitions.map(definition => (
            <li key={`${definition.sourceId}@${definition.sourceVersion}`} className="flex items-center gap-3 rounded-lg px-2 py-1.5">
              <div className="min-w-0 flex-1">
                <p className="m-0 truncate text-sm font-medium text-kumo-default">{definition.title}</p>
                <p className="m-0 truncate text-[12px] text-kumo-subtle">{definition.purpose}</p>
              </div>
              <Button size="sm" onClick={() => chooseDefinition(definition)}>Choose</Button>
            </li>
          ))}
          {searched.hits.map(hit => (
            <li key={hit.kind} className="flex items-center gap-3 rounded-lg px-2 py-1.5">
              <div className="min-w-0 flex-1">
                <p className="m-0 truncate text-sm font-medium text-kumo-default">{hit.kind}</p>
                <p className="m-0 truncate text-[12px] text-kumo-subtle">{hit.description}</p>
              </div>
              {placeableBuiltin(hit.kind)
                ? <Button size="sm" onClick={() => { setChosen(null); setBoardKind(hit.kind) }}>Choose</Button>
                : <span className="text-[12px] text-kumo-subtle">Can't be placed here yet</span>}
            </li>
          ))}
        </ul>
      )}

      {chosen && (
        <div aria-label={`Where “${chosen.title}” is offered`} role="group" className="space-y-2 border-t border-kumo-line pt-3">
          <p className="m-0 text-sm font-medium text-kumo-default">Consoles that offer “{chosen.title}”</p>
          {instances.status === 'loading' && <p role="status" className="flex items-center gap-2 text-sm text-kumo-subtle"><Loader size="sm" /> Looking in your consoles…</p>}
          {instances.status === 'error' && (
            <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-kumo-danger">
              Couldn't look in your consoles just now.
              <Button size="sm" onClick={() => chooseDefinition({ sourceId: chosen.blueprintId, sourceVersion: chosen.version, title: chosen.title })}>Try again</Button>
            </div>
          )}
          {instances.status === 'ready' && instances.instances.length === 0 && (
            <p className="m-0 text-sm text-kumo-subtle">
              No published console you can open offers it. Only the workspaces you used most recently are looked in.
            </p>
          )}
          {instances.status === 'ready' && instances.instances.length > 0 && (
            <ul aria-label="Consoles that offer it" className="m-0 list-none space-y-1 p-0">
              {instances.instances.map(instance => (
                <li key={`${instance.workspaceId}/${instance.consoleId}/${instance.sourceGadgetId}`} className="flex items-center gap-3 px-2 py-1">
                  <p className="m-0 min-w-0 flex-1 truncate text-sm text-kumo-default">
                    {instance.label} <span className="text-kumo-subtle">· {instance.consoleTitle} · {instance.workspaceTitle}</span>
                  </p>
                  <Button size="sm" disabled={busy} onClick={() => void place({
                    type: 'console-widget', workspaceId: instance.workspaceId, consoleId: instance.consoleId,
                    sourceGadgetId: instance.sourceGadgetId, blueprintId: chosen.blueprintId, version: chosen.version,
                  })}>Place</Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {boardKind && (
        <div role="group" aria-label="Which board to show" className="space-y-2 border-t border-kumo-line pt-3">
          <p className="m-0 text-sm font-medium text-kumo-default">Which board?</p>
          {currentBoard && (
            <Button size="sm" disabled={busy} onClick={() => void place({ type: 'builtin', kind: boardKind, target: currentBoard })}>
              The board you have open ({currentBoard.split('/').pop()})
            </Button>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Input aria-label="Board reference" className="min-w-0 flex-1" value={boardRef}
              placeholder="inferops://tenant.workspace/project/board/KEY" onChange={(e) => setBoardRef(e.target.value)} />
            <Button size="sm" disabled={busy || !BOARD_REF.test(typedBoard)}
              onClick={() => void place({ type: 'builtin', kind: boardKind, target: typedBoard })}>Place</Button>
          </div>
          <p className="m-0 text-[12px] text-kumo-subtle">A board is read with your own InferOps access each time it's shown; placing it grants nothing.</p>
        </div>
      )}

      {refusal && <p role="alert" className="m-0 text-sm text-kumo-danger">{refusal}</p>}
    </section>
  )
}
