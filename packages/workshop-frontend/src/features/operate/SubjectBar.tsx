import { useState } from 'react'
import { Button, Dialog, Input, InputArea } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import {
  getOperateSessionErrorCode, OPERATE_SESSION_ERROR_CODES, type OperateSession, type OperateSubjectParticipant,
} from '@gadgets/workshop-shared/api'
import type { OperateBoardView } from '@gadgets/workshop-shared/operate-session'
import { useAuthenticatedApi } from '../../AuthContext'
import { SubjectAudit } from './SubjectAudit'
import { useSubjectPresence } from './useSubjectPresence'

const whereLabel = (participant: OperateSubjectParticipant, board: OperateBoardView) =>
  participant.issueId === null ? 'on the board'
    : participant.issueId === board.issueId ? 'on this issue' : 'on another issue'

const handoverError = (caught: unknown) => {
  switch (getOperateSessionErrorCode(caught)) {
    case OPERATE_SESSION_ERROR_CODES.recipientUnavailable: return 'There is no other person with that id here.'
    case OPERATE_SESSION_ERROR_CODES.boardUnavailable: return 'You can no longer reach this board, so it can\'t be handed over.'
    case OPERATE_SESSION_ERROR_CODES.invalidEvent: return 'The note is too long, or no board is shown.'
    default: return 'Could not hand this board over. Try again.'
  }
}

/** Hands the shown board, its open issue and a note to another person, who opens it with their own access. */
const HandoverDialog = ({ session }: { session: RpcStub<OperateSession> }) => {
  const [open, setOpen] = useState(false)
  const [recipient, setRecipient] = useState('')
  const [note, setNote] = useState('')
  const [status, setStatus] = useState<{ sending: true } | { sent: string } | { error: string } | null>(null)

  const changeOpen = (next: boolean) => {
    setOpen(next)
    if (next) { setRecipient(''); setNote(''); setStatus(null) }
  }
  const submit = async () => {
    setStatus({ sending: true })
    try {
      const handover = await session.handOver(recipient.trim(), note)
      setStatus({ sent: handover.to.name })
    } catch (caught) {
      setStatus({ error: handoverError(caught) })
    }
  }

  return <Dialog.Root open={open} onOpenChange={changeOpen}>
    <Dialog.Trigger render={<Button size="sm" variant="ghost">Hand over</Button>} />
    <Dialog className="space-y-4 p-6">
      <Dialog.Title>Hand over this board</Dialog.Title>
      <Dialog.Description className="text-sm text-kumo-subtle">
        Sends the board, the issue you have open and your note to another person. They open it with their own access: a handover grants nothing.
      </Dialog.Description>
      {status && 'sent' in status
        ? <p role="status" className="text-sm text-kumo-default">Handed over to {status.sent}.</p>
        : <form className="space-y-3" onSubmit={event => { event.preventDefault(); void submit() }}>
            <Input label="Person (their user id)" value={recipient} required onChange={event => setRecipient(event.target.value)} />
            <InputArea label="Note" value={note} maxLength={2000} rows={3} onChange={event => setNote(event.target.value)} />
            {status && 'error' in status && <p role="alert" className="text-sm text-kumo-danger">{status.error}</p>}
            <Button type="submit" variant="primary" disabled={recipient.trim() === '' || (status !== null && 'sending' in status)}>Hand over</Button>
          </form>}
      <div className="flex justify-end"><Dialog.Close render={<Button type="button" variant="secondary">Close</Button>} /></div>
    </Dialog>
  </Dialog.Root>
}

const SubjectBarForBoard = ({ board, session }: { board: OperateBoardView; session: { stub: RpcStub<OperateSession> } }) => {
  const { currentUser } = useAuthenticatedApi()
  const participants = useSubjectPresence(session, board)
  const [showAudit, setShowAudit] = useState(false)
  // Hide the roster until we know who we are, so this person never briefly shows as someone else.
  const others = currentUser ? participants.filter(participant => participant.user.id !== currentUser.id) : []

  return <div className="space-y-2">
    <div className="flex flex-wrap items-center gap-2">
      <p role="status" aria-live="polite" className="m-0 min-w-0 flex-1 truncate text-xs text-kumo-subtle">
        {others.length === 0 ? 'No one else has this board open.'
          : `Also here: ${others.map(participant => `${participant.user.name} (${whereLabel(participant, board)})`).join(', ')}`}
      </p>
      <HandoverDialog session={session.stub} />
      <Button size="sm" variant="ghost" aria-pressed={showAudit} onClick={() => setShowAudit(shown => !shown)}>Audit</Button>
    </div>
    {showAudit && <SubjectAudit session={session.stub} board={board} />}
  </div>
}

/**
 * The session's subject, around its board: who else has it open, a handover, and its audit. Keyed
 * by the board here, rather than by each caller, so switching subject always starts from nothing:
 * no roster, audit or handover of the previous board can show against the new one.
 */
export const SubjectBar = ({ board, session }: { board: OperateBoardView; session: { stub: RpcStub<OperateSession> } }) =>
  <SubjectBarForBoard key={`${board.workspaceId} ${board.boardRef}`} board={board} session={session} />
