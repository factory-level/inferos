import { useEffect, useState } from 'react'
import { Button } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import {
  actionChangeTime, getOperateSessionErrorCode, OPERATE_SESSION_ERROR_CODES,
  type ActionLogEntry, type OperateSession, type OperateSubjectAuditCursor,
} from '@gadgets/workshop-shared/api'
import type { OperateBoardRef, OperateEventRecord } from '@gadgets/workshop-shared/operate-session'
import { formatRelativeTime } from '../../Activity'
import { ACTOR_LABELS } from '../canvas/boardActivity'
import { describeAgentEvent } from './AgentActivityNote'

type AuditItem = { key: string; at: Date; text: string; note?: string }

const STATE_LABELS: Record<ActionLogEntry['state'], string> = {
  pending: 'awaiting approval', approved: 'approved', rejected: 'rejected',
}

const eventItem = (record: OperateEventRecord): AuditItem => {
  const { event } = record
  const who = record.actor === 'agent' ? 'Agent' : 'You'
  const text = event.type === 'handoverReceived'
    ? `${event.handover.from.name} handed this board to you`
    : `${who} ${describeAgentEvent(event, ref => ref.type === 'screen' ? 'a screen' : 'a workspace')}`
  const note = event.type === 'handoverReceived' || event.type === 'handoverSent' ? event.handover.note : undefined
  return { key: `event ${record.seq}`, at: record.at, text, ...note ? { note } : {} }
}

const actionItem = (entry: ActionLogEntry): AuditItem => {
  const who = entry.requestedBy ? ACTOR_LABELS[entry.requestedBy] : 'Someone'
  const what = entry.type === 'observation' ? `read: ${entry.description.title}`
    : `${entry.description.title} (${entry.type === 'action' ? STATE_LABELS[entry.state] : 'hook'})`
  return { key: `action ${entry.id}`, at: actionChangeTime(entry), text: `${who} ${what}` }
}

type Audit = { items: AuditItem[]; next: OperateSubjectAuditCursor | undefined; loading: boolean; error: string | null }

/**
 * The audit of one subject, newest first: this session's events about the board and the reads and
 * actions its workspace's log records for it. The kernel serves it only through the reader's own
 * access to the board. Mounted per board (keyed by the caller), so nothing of another subject's
 * audit is ever shown here.
 */
export const SubjectAudit = ({ session, board }: { session: RpcStub<OperateSession>; board: OperateBoardRef }) => {
  const [audit, setAudit] = useState<Audit>({ items: [], next: undefined, loading: true, error: null })

  const load = (cursor: OperateSubjectAuditCursor | undefined, isCurrent: () => boolean) => {
    setAudit(previous => ({ ...previous, loading: true, error: null }))
    session.listSubjectAudit({ workspaceId: board.workspaceId, boardRef: board.boardRef }, cursor).then(page => {
      if (!isCurrent()) return
      const items = [...page.events.map(eventItem), ...page.actions.map(actionItem)]
      setAudit(previous => ({
        items: [...previous.items, ...items].toSorted((a, b) => b.at.getTime() - a.at.getTime()),
        next: page.next, loading: false, error: null,
      }))
    }).catch(caught => {
      if (!isCurrent()) return
      setAudit(previous => ({
        ...previous, loading: false,
        error: getOperateSessionErrorCode(caught) === OPERATE_SESSION_ERROR_CODES.boardUnavailable
          ? 'You can no longer reach this board, so its audit is not available to you.'
          : 'Could not read the audit. Try again.',
      }))
    })
  }

  useEffect(() => {
    let current = true
    load(undefined, () => current)
    return () => { current = false }
  // The component is keyed by board, so the session and board never change while it is mounted.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <section aria-label="Board audit" className="space-y-2 rounded-lg border border-kumo-line p-3 text-sm">
    <h2 className="text-xs font-medium text-kumo-subtle">Audit</h2>
    {audit.error && <p role="alert" className="text-kumo-danger">{audit.error}</p>}
    {audit.items.length > 0
      ? <ol className="max-h-64 space-y-1 overflow-auto">
          {audit.items.map(item => <li key={item.key} className="flex gap-2">
            <span className="min-w-0 flex-1">{item.text}{item.note && <span className="text-kumo-subtle">: “{item.note}”</span>}</span>
            <span className="shrink-0 text-kumo-inactive">{formatRelativeTime(item.at)}</span>
          </li>)}
        </ol>
      : !audit.loading && !audit.error && <p className="text-kumo-subtle">{audit.next ? 'Nothing in this stretch of the log.' : 'Nothing recorded for this board yet.'}</p>}
    {audit.loading && <p role="status" className="text-kumo-subtle">Loading…</p>}
    {audit.next && !audit.loading && <Button size="sm" variant="ghost" onClick={() => load(audit.next, () => true)}>Load older</Button>}
  </section>
}
