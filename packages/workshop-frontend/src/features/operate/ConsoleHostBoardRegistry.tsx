import { useState } from 'react'
import { Button, Input } from '@cloudflare/kumo'
import { canonicalHostBoardTarget, HOST_BOARD_RESOURCE, MAX_CONSOLE_WIDGETS, type HostBoardEntry } from '@gadgets/workshop-shared/operate-console'

/** The first `board-<n>` requirement name no entry uses yet. */
const freshName = (entries: readonly HostBoardEntry[]) => {
  const used = new Set(entries.map(entry => entry.requirement.name))
  let n = entries.length + 1
  while (used.has(`board-${n}`)) n++
  return `board-${n}`
}

/**
 * The host boards a console offers, edited in its draft: read-only InferOps boards that trusted host
 * code renders, each operator reading it with a connection of their own. A board's target only
 * names it; it grants no access. A saved entry's target is fixed, so changing it means removing the
 * entry and adding a new one. Widgets and host boards share one registry limit.
 */
export const ConsoleHostBoardRegistry = ({ hostBoards, published, widgetCount, disabled, onChange }: {
  hostBoards: HostBoardEntry[]
  /** The host boards operators use now, or undefined if the console was never published. */
  published: HostBoardEntry[] | undefined
  /** Registered widgets, which count toward the same limit. */
  widgetCount: number
  disabled: boolean
  onChange: (hostBoards: HostBoardEntry[]) => void
}) => {
  const [label, setLabel] = useState('')
  const [target, setTarget] = useState('')
  const canonical = canonicalHostBoardTarget(target)
  const full = hostBoards.length + widgetCount >= MAX_CONSOLE_WIDGETS
  const add = () => {
    if (!canonical || !label.trim() || full) return
    onChange([...hostBoards, { kind: 'host-board', label: label.trim(),
      requirement: { name: freshName(hostBoards), resource: HOST_BOARD_RESOURCE, target: canonical } }])
    setLabel(''); setTarget('')
  }
  const isPublished = (entry: HostBoardEntry) => entry.id !== undefined && !!published?.some(item =>
    item.id === entry.id && item.label === entry.label)

  return <section aria-labelledby="console-host-boards-heading" className="space-y-4">
    <div><h2 id="console-host-boards-heading" className="text-sm font-medium text-kumo-default">Boards</h2>
      <p className="mt-1 text-sm text-kumo-subtle">Read-only InferOps boards this console offers. Each operator reads a board with their own InferOps access; the board named here grants none.</p></div>
    {hostBoards.length === 0 ? <p className="text-sm text-kumo-subtle">No boards are registered.</p>
      : <ul aria-label="Registered boards" className="divide-y divide-kumo-line rounded-xl border border-kumo-line">
        {hostBoards.map((entry, index) => <li key={entry.id ?? `new-${index}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-kumo-default">{entry.label}</p>
            <p className="truncate text-xs text-kumo-subtle">{entry.requirement.target} · {isPublished(entry) ? 'Published' : 'Not yet published'}</p>
          </div>
          <Button size="sm" variant="ghost" disabled={disabled} aria-label={`Remove ${entry.label}`}
            onClick={() => onChange(hostBoards.filter(item => item !== entry))}>Remove</Button>
        </li>)}
      </ul>}
    {!disabled && <div className="space-y-3 rounded-xl border border-kumo-line p-4">
      <Input label="Board" value={target} placeholder="inferops://tenant.workspace/project/board/KEY" disabled={full}
        onChange={event => setTarget(event.target.value)} />
      {target.trim() !== '' && !canonical && <p className="text-sm text-kumo-danger">Use inferops://&lt;tenant&gt;.&lt;workspace&gt;/project/board/&lt;KEY&gt;, with an uppercase key of at most 10 letters and digits.</p>}
      <Input label="Name operators see" value={label} maxLength={120} disabled={full} onChange={event => setLabel(event.target.value)} />
      <Button disabled={!canonical || !label.trim() || full} onClick={add}>Register board</Button>
      {full && <p className="text-sm text-kumo-subtle">A console offers at most {MAX_CONSOLE_WIDGETS} widgets and boards.</p>}
    </div>}
  </section>
}
