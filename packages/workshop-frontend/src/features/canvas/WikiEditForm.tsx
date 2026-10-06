import { useState } from 'react'
import { Button, InputArea } from '@cloudflare/kumo'
import type { ProposalResult } from './boardData'

/**
 * An inline Markdown editor whose save is a proposal through the approval path. A refusal keeps
 * the draft so nothing typed is lost (the caller shows why); an accepted proposal closes it.
 */
export const WikiEditForm = ({ label, initial, maxLength, hint, onPropose, onClose }: {
  /** The text area's accessible name. */
  label: string
  /** The text being edited, as read. */
  initial: string
  maxLength: number
  /** What proposing means, shown under the text area. */
  hint: string
  onPropose: (body: string) => Promise<ProposalResult>
  onClose: () => void
}) => {
  const [draft, setDraft] = useState(initial)
  const [sending, setSending] = useState(false)
  return <form className="space-y-2" onSubmit={async event => {
    event.preventDefault()
    setSending(true)
    const result = await onPropose(draft)
    setSending(false)
    if (result.ok) onClose()
  }}>
    <InputArea label={label} rows={8} maxLength={maxLength} value={draft} disabled={sending}
      onChange={event => setDraft(event.target.value)} />
    <p className="text-xs text-kumo-subtle">{hint}</p>
    <div className="flex gap-2">
      <Button type="submit" variant="primary" disabled={sending || draft === initial}>{sending ? 'Proposing…' : 'Propose edit'}</Button>
      <Button disabled={sending} onClick={onClose}>Cancel</Button>
    </div>
  </form>
}
