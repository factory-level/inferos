import { useEffect, useRef, useState } from 'react'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { applyCanvasOperations, parseCanvasDefinition, type CanvasContent, type CanvasDefinition, type CanvasOperation } from '@gadgets/workshop-shared/canvas'
import { applyCanvasPageOperations, canvasDefinitionProjection, canvasPageFromDefinition, parseCanvasPage, type CanvasPage, type CanvasPageOperation } from '@gadgets/workshop-shared/canvas-model'
import { withServerWords } from './serverWords'

export type CanvasStorage = { kind: 'temporary' } | {
  kind: 'durable'
  api: Pick<Overseer, 'listCanvases' | 'createCanvas' | 'editCanvas' | 'deleteCanvas' | 'getCanvasPage' | 'editCanvasPage'>
}

/** How often saved views are re-read so edits made elsewhere (the chat agent, another tab) appear. */
export const CANVAS_REFRESH_MS = 5000

/** The server's own words for a conflict, so a person knows newer work exists and nothing was overwritten. */
const CONFLICT = /^Canvas changed/

const sameViews = (a: CanvasDefinition[], b: CanvasDefinition[]) =>
  a.length === b.length && a.every((view, index) => view.id === b[index].id && view.revision === b[index].revision)

/**
 * `readPage` reads the active view's nested page (FAC-83) only while it's wanted: edit mode. Viewing
 * needs only the version 1 definitions, and a use-role session is refused the page read.
 */
export const useCanvasWorkspace = (storage: CanvasStorage, initialViewId: string | null = null, readPage = false) => {
  const api = storage.kind === 'durable' ? storage.api : null
  const [views, setViews] = useState<CanvasDefinition[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Each entry is the content before one of this page's own edits and the revision that edit
  // produced: undo applies only while the view is still at that revision, so it never reverts an
  // edit someone else (the chat agent, another tab) made since.
  const [history, setHistory] = useState<Record<string, { content: CanvasContent; revision: string }[]>>({})
  const generation = useRef(0)
  const pending = useRef(false)
  const active = views.find(view => view.id === activeId) ?? null
  // The nested page of the view on screen, read from the store (FAC-83). Views list as their version 1
  // projection, so the page is read again whenever the active view's revision moves.
  const [loadedPage, setLoadedPage] = useState<CanvasPage | null>(null)
  const page = active && loadedPage?.id === active.id && loadedPage.revision === active.revision ? loadedPage
    : active && !api ? canvasPageFromDefinition(active) : null

  useEffect(() => {
    const current = ++generation.current
    setViews([]); setActiveId(null); setHistory({}); setError(null)
    pending.current = !!api; setBusy(!!api)
    if (api) {
      api.listCanvases().then(result => {
        if (generation.current !== current) return
        const parsed = result.map(value => parseCanvasDefinition(value))
        setViews(parsed); setActiveId((parsed.find(view => view.id === initialViewId) ?? parsed[0])?.id ?? null)
      }).catch(() => {
        if (generation.current === current) setError('Could not load views. Check your connection and access, then reload.')
      }).finally(() => {
        if (generation.current === current) { pending.current = false; setBusy(false) }
      })
    }
    return () => { generation.current++ }
    // The initial view only seeds the first load; later selections are this hook's own state.
  }, [api])

  const activeRevision = active?.revision
  useEffect(() => {
    if (!api || !activeId || !readPage) return
    let stopped = false
    api.getCanvasPage(activeId).then(result => {
      if (stopped || !result) return
      const read = parseCanvasPage(result)
      // A read that started before this page's own edit landed is older than what that edit returned.
      setLoadedPage(previous => previous?.id === read.id && BigInt(previous.revision) > BigInt(read.revision) ? previous : read)
    }).catch(() => {
      if (!stopped) setError('Could not read this view. Reload to try again.')
    })
    return () => { stopped = true }
  }, [api, activeId, activeRevision, readPage])

  // Saved views can change outside this page: the chat agent edits them while the user watches.
  // A quiet re-read between the user's own operations picks those edits up; it never interrupts an
  // operation in flight. It pauses while the page is hidden and catches up as soon as it is shown.
  useEffect(() => {
    if (!api) return
    let stopped = false
    const refresh = () => {
      if (pending.current || document.visibilityState !== 'visible') return
      const current = generation.current
      api.listCanvases().then(result => {
        if (stopped || generation.current !== current || pending.current) return
        const loaded = result.map(value => parseCanvasDefinition(value))
        setViews(previous => sameViews(previous, loaded) ? previous : loaded)
        setActiveId(id => loaded.some(view => view.id === id) ? id : loaded[0]?.id ?? null)
      }).catch(() => {})
    }
    const timer = setInterval(refresh, CANVAS_REFRESH_MS)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      stopped = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [api])

  const run = async (task: () => Promise<() => void>) => {
    if (pending.current) return false
    pending.current = true; setBusy(true); setError(null)
    const current = generation.current
    try {
      const commit = await task()
      if (generation.current !== current) return false
      commit()
      return true
    } catch (thrown) {
      if (generation.current === current) {
        // A conflict says plainly that newer work exists and nothing was overwritten (FAC-83); every
        // refusal keeps the server's own words (FAC-97).
        const message = thrown instanceof Error ? thrown.message : undefined
        setError(withServerWords(message && CONFLICT.test(message)
          ? 'Nothing was overwritten: reload to see the newer version, then make your change again.'
          : 'Could not change the view. Check the fields, or reload to get the latest saved revision.', message))
      }
      return false
    } finally {
      if (generation.current === current) { pending.current = false; setBusy(false) }
    }
  }

  const reload = () => run(async () => {
    if (!api) return () => {}
    const loaded = (await api.listCanvases()).map(value => parseCanvasDefinition(value))
    return () => {
      setViews(loaded); setHistory({})
      setActiveId(id => loaded.some(view => view.id === id) ? id : loaded[0]?.id ?? null)
    }
  })

  const prepareCreate = async (content: CanvasContent) => {
    const preview = parseCanvasDefinition({ ...content, schemaVersion: 1, id: crypto.randomUUID(), revision: '0' })
    if (views.length >= 64) throw new Error('View limit reached')
    const created = api ? parseCanvasDefinition(await api.createCanvas(content)) : preview
    return () => { setViews(previous => [...previous, created]); setActiveId(created.id) }
  }
  const create = (content: CanvasContent) => run(() => prepareCreate(content))
  const importDefinition = (file: File) => run(async () => {
    if (file.size > 128 * 1024) throw new Error("Definition too large")
    const current = generation.current
    const definition = parseCanvasDefinition(JSON.parse(await file.text()))
    if (generation.current !== current) throw new Error("Workspace changed")
    return prepareCreate({ title: definition.title, sections: definition.sections })
  })

  const edit = (operations: CanvasOperation[], undo = false) => run(async () => {
    if (!active) throw new Error('No view selected')
    const preview = applyCanvasOperations(active, active.revision, operations)
    const updated = api ? parseCanvasDefinition(await api.editCanvas(active.id, active.revision, operations)) : preview
    return () => {
      // A version 1 edit's result is exactly its page, the conversion the store reads it by.
      setLoadedPage(canvasPageFromDefinition(updated))
      setViews(previous => previous.map(view => view.id === updated.id ? updated : view))
      setHistory(previous => {
        const entries = previous[active.id] ?? []
        if (!undo) return { ...previous, [active.id]: [...entries, { content: { title: active.title, sections: active.sections }, revision: updated.revision }].slice(-20) }
        // The restore leaves the view as the edit before it left it, at a new revision.
        const rest = entries.slice(0, -1)
        return { ...previous, [active.id]: rest.length === 0 ? rest : [...rest.slice(0, -1), { ...rest.at(-1)!, revision: updated.revision }] }
      })
    }
  })

  // A nested edit (FAC-83): typed page operations at the page's revision. It isn't recorded for undo,
  // which restores version 1 content and so can't hold what these edits make.
  const editPage = (operations: CanvasPageOperation[]) => run(async () => {
    if (!active || !page) throw new Error('No view selected')
    const preview = applyCanvasPageOperations(page, operations)
    const updated = api ? parseCanvasPage(await api.editCanvasPage(page.id, page.revision, operations))
      : { ...preview, revision: (BigInt(page.revision) + 1n).toString() }
    const shown = canvasDefinitionProjection(updated)
    return () => {
      setLoadedPage(updated)
      setViews(previous => previous.map(view => view.id === shown.id ? shown : view))
      setHistory(previous => { const next = { ...previous }; delete next[active.id]; return next })
    }
  })

  const remove = () => run(async () => {
    if (!active) throw new Error('No view selected')
    if (api) await api.deleteCanvas(active.id, active.revision)
    return () => {
      setViews(previous => previous.filter(view => view.id !== active.id)); setActiveId(null)
      setHistory(previous => { const next = { ...previous }; delete next[active.id]; return next })
    }
  })
  const previous = active ? history[active.id]?.at(-1) : undefined
  const canUndo = !!previous && previous.revision === active?.revision
  return { views, active, page, busy, error, create, importDefinition, edit, editPage, remove, reload,
    select: (id: string) => { if (!pending.current) { setActiveId(id); setError(null) } },
    canUndo,
    /** True when this page has an edit to undo but the view has changed since, so undo is refused. */
    undoBlocked: !!previous && !canUndo,
    undo: () => previous && canUndo ? edit([{ type: 'restore', content: previous.content }], true) : Promise.resolve(false),
  }
}
