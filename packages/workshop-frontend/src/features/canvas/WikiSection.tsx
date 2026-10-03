import { useState, type ReactNode } from 'react'
import { Badge, Button, InputArea } from '@cloudflare/kumo'
import type { WikiSection as Section } from '@inferos/gatekeeper-inferops/src/types'
import type { ProposalResult } from './boardData'
import { WikiMarkdown } from './WikiMarkdown'
import { editErrorText, isOpenEdit, sectionBlocks, type SectionEdit } from './wikiPage'

const MAX_BODY = 100_000

// What a section's edit means for the person, in words that never call it saved before it was applied.
const EDIT_STATUS: Record<Exclude<SectionEdit['phase'], 'refused' | 'stale'>, { label: string; variant: 'warning' | 'success' | 'neutral' }> = {
  proposing: { label: 'Sending for approval…', variant: 'neutral' },
  awaiting: { label: 'Waiting for approval, not saved yet', variant: 'warning' },
  applied: { label: 'Saved', variant: 'success' },
  rejected: { label: 'Rejected, not saved', variant: 'neutral' },
}

/**
 * One section of a Wiki page: its Markdown, with the references that stand alone as a paragraph
 * rendered by `renderEmbed`, and, when `onPropose` is given, an inline editor whose save is a
 * proposal through the approval path. The section shows what the Wiki returns; an edit's outcome
 * comes from the page read after it was decided.
 */
export const WikiSection = ({ section, edit, renderEmbed, onPropose, onDismissEdit }: {
  section: Section
  /** The edit proposed here for this section, if any. */
  edit: SectionEdit | undefined
  renderEmbed: (href: string, label: string) => ReactNode
  /** Propose new Markdown; absent where the Wiki is shown read-only. */
  onPropose?: (body: string) => Promise<ProposalResult>
  onDismissEdit: () => void
}) => {
  const [draft, setDraft] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const blocked = section.pending === 'update' || isOpenEdit(edit)
  const status = edit && edit.phase !== 'refused' && edit.phase !== 'stale' ? EDIT_STATUS[edit.phase] : null
  const errorText = edit && (edit.phase === 'refused' || edit.phase === 'stale') ? editErrorText(edit) : null
  const headingId = `wiki-section-${section.id}`
  return <section aria-labelledby={headingId} className="space-y-2 border-t border-kumo-line pt-3 first:border-t-0 first:pt-0">
    <div className="flex flex-wrap items-center gap-2">
      <h4 id={headingId} className="font-mono text-xs text-kumo-subtle">#{section.tag}</h4>
      {section.pending === 'update' && edit?.phase !== 'awaiting' && <Badge variant="warning">Edit waiting for approval</Badge>}
      {status && <Badge variant={status.variant}>{status.label}</Badge>}
      <span role="status" className="sr-only">{status ? `Section ${section.tag}: ${status.label}` : errorText ?? ''}</span>
      {onPropose && draft === null && <Button size="sm" variant="ghost" className="ml-auto" disabled={blocked}
        aria-label={`Edit section ${section.tag}`} onClick={() => { onDismissEdit(); setDraft(section.body) }}>Edit</Button>}
    </div>
    {errorText && <div className="flex flex-wrap items-center gap-2">
      <p role="alert" className="text-sm text-kumo-danger">{errorText}</p>
      <Button size="sm" variant="ghost" onClick={onDismissEdit}>Dismiss</Button>
    </div>}
    {draft !== null && onPropose
      ? <form className="space-y-2" onSubmit={async event => {
        event.preventDefault()
        setSending(true)
        const result = await onPropose(draft)
        setSending(false)
        // A refusal keeps the draft so nothing typed is lost; the alert above says why.
        if (result.ok) setDraft(null)
      }}>
        <InputArea label={`Markdown of section ${section.tag}`} rows={8} maxLength={MAX_BODY} value={draft} disabled={sending}
          onChange={event => setDraft(event.target.value)} />
        <p className="text-xs text-kumo-subtle">Saving proposes this text for approval. It is saved only once approved, and only if the section has not changed meanwhile.</p>
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={sending || draft === section.body}>{sending ? 'Proposing…' : 'Propose edit'}</Button>
          <Button disabled={sending} onClick={() => setDraft(null)}>Cancel</Button>
        </div>
      </form>
      : sectionBlocks(section.body).map((block, index) => block.type === 'markdown'
        ? <WikiMarkdown key={index} text={block.text} />
        : <div key={index}>{renderEmbed(block.href, block.label)}</div>)}
  </section>
}
