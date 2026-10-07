import { useState, type ReactNode } from 'react'
import { Badge, Button } from '@cloudflare/kumo'
import type { WikiSection as Section } from '@inferos/gatekeeper-inferops/src/types'
import type { ProposalResult } from './boardData'
import { WikiEditForm } from './WikiEditForm'
import { WikiMarkdown } from './WikiMarkdown'
import { editErrorText, editStatus, isOpenEdit, sectionBlocks, type SectionEdit } from './wikiPage'

const MAX_BODY = 100_000

/**
 * One section of a Wiki page: its Markdown, with the references that stand alone as a paragraph
 * rendered by `renderEmbed`, and, when `onPropose` is given, an inline editor whose save is a
 * proposal through the approval path. The section shows what the Wiki returns; an edit's outcome
 * comes from the page read after it was decided.
 */
export const WikiSection = ({ section, edit, renderEmbed, onOpenPage, onPropose, onDismissEdit }: {
  section: Section
  /** The edit proposed here for this section, if any. */
  edit: SectionEdit | undefined
  renderEmbed: (href: string, label: string) => ReactNode
  /** Open a page of this Wiki that a `/wiki/<slug>` link names. */
  onOpenPage: (slug: string) => void
  /** Propose new Markdown; absent where the Wiki is shown read-only. */
  onPropose?: (body: string) => Promise<ProposalResult>
  onDismissEdit: () => void
}) => {
  const [editing, setEditing] = useState(false)
  const blocked = section.pending === 'update' || isOpenEdit(edit)
  const status = editStatus(edit)
  const errorText = edit && (edit.phase === 'refused' || edit.phase === 'stale') ? editErrorText(edit) : null
  const headingId = `wiki-section-${section.id}`
  return <section aria-labelledby={headingId} className="space-y-2 border-t border-kumo-line pt-3 first:border-t-0 first:pt-0">
    <div className="flex flex-wrap items-center gap-2">
      <h4 id={headingId} className="font-mono text-xs text-kumo-subtle">#{section.tag}</h4>
      {section.pending === 'update' && edit?.phase !== 'awaiting' && <Badge variant="warning">Edit waiting for approval</Badge>}
      {status && <Badge variant={status.variant}>{status.label}</Badge>}
      <span role="status" className="sr-only">{status ? `Section ${section.tag}: ${status.label}` : errorText ?? ''}</span>
      {onPropose && !editing && <Button size="sm" variant="ghost" className="ml-auto" disabled={blocked}
        aria-label={`Edit section ${section.tag}`} onClick={() => { onDismissEdit(); setEditing(true) }}>Edit</Button>}
    </div>
    {errorText && <div className="flex flex-wrap items-center gap-2">
      <p role="alert" className="text-sm text-kumo-danger">{errorText}</p>
      <Button size="sm" variant="ghost" onClick={onDismissEdit}>Dismiss</Button>
    </div>}
    {editing && onPropose
      ? <WikiEditForm label={`Markdown of section ${section.tag}`} initial={section.body} maxLength={MAX_BODY} onPropose={onPropose}
        onClose={() => setEditing(false)}
        hint="Saving proposes this text for approval. It is saved only once approved, and only if the section has not changed meanwhile." />
      : sectionBlocks(section.body).map((block, index) => block.type === 'markdown'
        ? <WikiMarkdown key={index} text={block.text} onOpenPage={onOpenPage} />
        : <div key={index}>{renderEmbed(block.href, block.label)}</div>)}
  </section>
}
