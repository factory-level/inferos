import { useEffect, useRef, useState } from 'react'
import { getScenario } from './scenarios'

type PickerView = { id: string; title: string; kind: string; route: string }

/**
 * Demo-only overlay listing every registered view; choosing one reloads into its scenario.
 * Toggle with the corner button or Ctrl/Cmd+Shift+K.
 */
const DemoPicker = ({ views, activeId }: { views: PickerView[]; activeId: string | null }) => {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen(value => !value)
      } else if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => { if (open) input.current?.focus() }, [open])

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = views.filter(view =>
    terms.every(term => `${view.id} ${view.title} ${view.route}`.toLowerCase().includes(term)))

  const go = (id: string | null) => { window.location.href = `/?demo=${encodeURIComponent(id ?? '')}` }

  return (
    <div className="fixed bottom-3 left-3 z-[2147483647] font-sans text-sm">
      {open && (
        <div role="dialog" aria-label="Demo screens"
          className="mb-2 flex max-h-[70vh] w-[420px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-lg border border-kumo-line bg-kumo-elevated shadow-xl">
          <div className="flex items-center gap-2 border-b border-kumo-line p-2">
            <input ref={input} value={query} onChange={event => setQuery(event.target.value)}
              placeholder={`Search ${views.length} screens`} aria-label="Search screens"
              onKeyDown={event => { if (event.key === 'Enter' && shown[0]) go(shown[0].id) }}
              className="min-w-0 flex-1 rounded border border-kumo-line bg-kumo-base px-2 py-1 text-kumo-default outline-none" />
            <button type="button" onClick={() => go(null)} className="text-kumo-subtle hover:text-kumo-default">Reset</button>
          </div>
          <ul className="overflow-y-auto py-1">
            {shown.map(view => (
              <li key={view.id}>
                <button type="button" onClick={() => go(view.id)}
                  className={`flex w-full items-baseline gap-2 px-3 py-1 text-left hover:bg-kumo-tint ${view.id === activeId ? 'bg-kumo-tint' : ''}`}>
                  <span className="truncate font-mono text-xs text-kumo-default">{view.id}</span>
                  <span className="truncate text-xs text-kumo-subtle">{view.title}</span>
                  {getScenario(view.id) && <span className="ml-auto shrink-0 text-xs text-kumo-brand">●</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open}
        title="Demo screens (Ctrl/Cmd+Shift+K)"
        className="rounded-full border border-kumo-line bg-kumo-elevated px-3 py-1 text-xs text-kumo-subtle shadow hover:text-kumo-default">
        {activeId ? `Demo: ${activeId}` : 'Demo screens'}
      </button>
    </div>
  )
}

export default DemoPicker
