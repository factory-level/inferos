import { useState, type ReactElement } from 'react'
import { Button, Dialog, Input, InputArea, Select } from '@cloudflare/kumo'
import type { Issue, IssueChanges, NewIssue, Priority, State } from '@inferos/gatekeeper-inferops/src/types'
import { useDialogSelectPortalContainer } from '../../useDialogSelectPortalContainer'
import type { ProposalResult } from './boardData'
import { PRIORITY_LABELS, changedFields, proposalErrorText, type IssueFields } from './kanbanBoard'

const PRIORITIES: readonly Priority[] = ['none', 'urgent', 'high', 'medium', 'low']

// The gatekeeper's own bounds; the inputs stop at them rather than have the proposal refused.
const TITLE_MAX = 500
const DESCRIPTION_MAX = 20000

type Mode =
  | { kind: 'create'; state: State; onCreate: (issue: NewIssue) => Promise<ProposalResult> }
  | { kind: 'edit'; issue: Issue; onUpdate: (changes: IssueChanges) => Promise<ProposalResult> }

export type KanbanIssueDialogProps = {
  /** The control that opens the dialog. Focus returns to it when the dialog closes. */
  trigger: ReactElement
} & Mode

/**
 * The form for a new issue in a column, or for editing an issue's title, description and
 * priority. Submitting proposes the change through the approval path: the dialog stays open while
 * the proposal is sent and shows a refusal with the gatekeeper's reason, and closes once the
 * change is queued, which the board then shows as waiting for approval.
 */
export const KanbanIssueDialog = ({ trigger, ...mode }: KanbanIssueDialogProps) => {
  const [open, setOpen] = useState(false)
  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Trigger render={trigger} />
    <Dialog className="responsive-dialog space-y-4 p-6" size="lg">
      {/* Mounted only while open, so every opening starts from the issue as the board shows it. */}
      <IssueForm mode={mode} onDone={() => setOpen(false)} />
    </Dialog>
  </Dialog.Root>
}

const IssueForm = ({ mode, onDone }: { mode: Mode; onDone: () => void }) => {
  const selectPortalContainer = useDialogSelectPortalContainer()
  const [fields, setFields] = useState<IssueFields>(mode.kind === 'edit'
    ? { title: mode.issue.title, description: '', priority: mode.issue.priority }
    : { title: '', description: '', priority: 'none' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const changes = mode.kind === 'edit' ? changedFields(mode.issue, fields) : null
  const title = fields.title.trim()
  const unchanged = changes !== null && Object.keys(changes).length === 0

  const submit = async () => {
    if (title === '' || unchanged || busy) return
    setBusy(true)
    setError(null)
    const result = mode.kind === 'create'
      ? await mode.onCreate({ title, priority: fields.priority, stateId: mode.state.id,
        ...fields.description.trim() !== '' ? { description: fields.description } : {} })
      : await mode.onUpdate(changes!)
    setBusy(false)
    if (result.ok) onDone()
    else setError(proposalErrorText(result))
  }

  const set = (patch: Partial<IssueFields>) => setFields(previous => ({ ...previous, ...patch }))
  return <form className="space-y-4" onSubmit={event => { event.preventDefault(); void submit() }}>
    <Dialog.Title>{mode.kind === 'create' ? `New issue in ${mode.state.name}` : `Edit ${mode.issue.identifier}`}</Dialog.Title>
    <Dialog.Description className="text-sm text-kumo-subtle">
      {mode.kind === 'create' ? 'The issue is created in InferOps once the request is approved.' : 'The change is applied in InferOps once it is approved.'}
    </Dialog.Description>
    <Input label="Title" required maxLength={TITLE_MAX} value={fields.title} disabled={busy}
      onChange={event => set({ title: event.target.value })} />
    <InputArea label="Description" rows={4} maxLength={DESCRIPTION_MAX} value={fields.description} disabled={busy}
      description={mode.kind === 'edit' ? 'Leave empty to keep the current description.' : undefined}
      onValueChange={description => set({ description })} />
    <Select container={selectPortalContainer} label="Priority" value={fields.priority} disabled={busy}
      renderValue={value => PRIORITY_LABELS[value as Priority]}
      onValueChange={value => { if (value) set({ priority: value as Priority }) }}>
      {PRIORITIES.map(priority => <Select.Option key={priority} value={priority}>{PRIORITY_LABELS[priority]}</Select.Option>)}
    </Select>
    {error && <p role="alert" className="text-sm text-kumo-danger">{error}</p>}
    {busy && <p role="status" className="text-sm text-kumo-subtle">Proposing…</p>}
    <div className="flex items-center justify-end gap-2">
      {unchanged && <p className="mr-auto text-xs text-kumo-subtle">Nothing changed yet.</p>}
      <Dialog.Close render={<Button type="button" variant="secondary" disabled={busy}>Cancel</Button>} />
      <Button type="submit" variant="primary" disabled={busy || title === '' || unchanged}>
        {mode.kind === 'create' ? 'Propose issue' : 'Propose changes'}
      </Button>
    </div>
  </form>
}
