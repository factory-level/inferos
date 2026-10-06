import { useState, type ReactNode } from 'react'
import { Badge, Button } from '@cloudflare/kumo'
import type { WikiDocument } from '@inferos/gatekeeper-inferops/src/types'
import type { ProposalResult } from './boardData'
import { WikiEditForm } from './WikiEditForm'
import { WikiMarkdown } from './WikiMarkdown'
import { authoredBody, editErrorText, editStatus, isOpenEdit, sectionBlocks, type BodyEdit } from './wikiPage'

const MAX_BODY = 200_000

/**
 * A page's authored body as the page contract reads it (without a leading heading repeating the
 * title), with references that stand alone as a paragraph rendered by `renderEmbed`, and, when
 * `onPropose` is given, an editor whose save proposes a new body through the approval path. A page
 * without a body shows only the offer to add one; the caller shows its sections instead.
 */
export const WikiPageBody = ({ document, edit, renderEmbed, onOpenPage, onPropose, onDismissEdit }: {
  document: WikiDocument
  /** The body edit proposed here for this page, if any. */
  edit: BodyEdit | undefined
  renderEmbed: (href: string, label: string) => ReactNode
  /** Open a page of this Wiki that a `/wiki/<slug>` link names. */
  onOpenPage: (slug: string) => void
  /** Propose a new body; absent where the Wiki is shown read-only or the page's body is not edited here. */
  onPropose?: (body: string) => Promise<ProposalResult>
  onDismissEdit: () => void
}) => {
  const [editing, setEditing] = useState(false)
  const text = authoredBody(document)
  const status = editStatus(edit)
  const errorText = edit && (edit.phase === 'refused' || edit.phase === 'stale') ? editErrorText(edit, 'page') : null
  if (text === null && !onPropose && !edit) return null
  const hint = 'Saving proposes this text for approval. It is saved only once approved, and only if the page has not changed meanwhile.' +
    (text === null && document.sections.length > 0
      ? ' Once the page has a body it reads as its body: its sections are kept as separate index text and are no longer shown here.' : '')
  return <section aria-label="Page body" className="space-y-2">
    <div className="flex flex-wrap items-center gap-2">
      {document.pendingBody && edit?.phase !== 'awaiting' && <Badge variant="warning">Body edit waiting for approval</Badge>}
      {status && <Badge variant={status.variant}>{status.label}</Badge>}
      <span role="status" className="sr-only">{status ? `Page body: ${status.label}` : errorText ?? ''}</span>
      {onPropose && !editing && <Button size="sm" variant="ghost" className="ml-auto" disabled={document.pendingBody === true || isOpenEdit(edit)}
        onClick={() => { onDismissEdit(); setEditing(true) }}>{text === null ? 'Add page body' : 'Edit page body'}</Button>}
    </div>
    {errorText && <div className="flex flex-wrap items-center gap-2">
      <p role="alert" className="text-sm text-kumo-danger">{errorText}</p>
      <Button size="sm" variant="ghost" onClick={onDismissEdit}>Dismiss</Button>
    </div>}
    {editing && onPropose
      ? <WikiEditForm label={`Markdown of page ${document.title}`} initial={document.body} maxLength={MAX_BODY} hint={hint}
        onPropose={onPropose} onClose={() => setEditing(false)} />
      : text !== null && sectionBlocks(text).map((block, index) => block.type === 'markdown'
        ? <WikiMarkdown key={index} text={block.text} onOpenPage={onOpenPage} />
        : <div key={index}>{renderEmbed(block.href, block.label)}</div>)}
  </section>
}
