import { useEffect, useRef, useState } from 'react'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { applyCanvasOperations, parseCanvasDefinition, type CanvasContent, type CanvasDefinition, type CanvasOperation } from '@gadgets/workshop-shared/canvas'

export type CanvasStorage = { kind: 'temporary' } | {
  kind: 'durable'
  api: Pick<Overseer, 'listCanvases' | 'createCanvas' | 'editCanvas' | 'deleteCanvas'>
}

/** How often saved views are re-read so edits made elsewhere (the chat agent, another tab) appear. */
export const CANVAS_REFRESH_MS = 5000

const sameViews = (a: CanvasDefinition[], b: CanvasDefinition[]) =>
  a.length === b.length && a.every((view, index) => view.id === b[index].id && view.revision === b[index].revision)

export const useCanvasWorkspace = (storage: CanvasStorage, initialViewId: string | null = null) => {
  const api = storage.kind === 'durable' ? storage.api : null
  const [views, setViews] = useState<CanvasDefinition[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<Record<string, CanvasContent[]>>({})
  const generation = useRef(0)
  const pending = useRef(false)
  const active = views.find(view => view.id === activeId) ?? null

  useEffect(() => {
    const current = ++generation.current
    setViews([]); setActiveId(null); setHistory({}); setError(null)
    pending.current = !!api; setBusy(!!api)
    if (api) {
      api.listCanvases().then(result => {
        if (generation.current !== current) return
        const parsed = result.map(parseCanvasDefinition)
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
        const loaded = result.map(parseCanvasDefinition)
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
    } catch {
      if (generation.current === current) setError('Could not change the view. Check the fields, or reload to get the latest saved revision.')
      return false
    } finally {
      if (generation.current === current) { pending.current = false; setBusy(false) }
    }
  }

  const reload = () => run(async () => {
    if (!api) return () => {}
    const loaded = (await api.listCanvases()).map(parseCanvasDefinition)
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
      setViews(previous => previous.map(view => view.id === updated.id ? updated : view))
      setHistory(previous => ({ ...previous, [active.id]: undo ? (previous[active.id] ?? []).slice(0, -1)
        : [...(previous[active.id] ?? []), { title: active.title, sections: active.sections }].slice(-20) }))
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
  return { views, active, busy, error, create, importDefinition, edit, remove, reload,
    select: (id: string) => { if (!pending.current) { setActiveId(id); setError(null) } },
    canUndo: !!previous,
    undo: () => previous ? edit([{ type: 'restore', content: previous }], true) : Promise.resolve(false),
  }
}
