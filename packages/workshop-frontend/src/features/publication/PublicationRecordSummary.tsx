import { Badge } from '@cloudflare/kumo'
import type { PublicationRecord } from '@gadgets/workshop-shared/api'
import { DESTINATION_TEXT, STATUS_TEXT } from './publicationText'

const date = (value: Date) => new Date(value).toLocaleDateString()

/** One publication record as both the owner and the reviewer read it: what, where, and its history. */
export const PublicationRecordSummary = ({ record }: { record: PublicationRecord }) => {
  const status = STATUS_TEXT[record.status]
  const lastConfirmation = record.confirmations?.at(-1)
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[14px] leading-5 font-semibold text-kumo-default">
          {record.artifact.title}
        </span>
        <span className="text-[12px] leading-4 text-kumo-subtle">
          v{record.artifact.version} · {record.artifact.kind} · {DESTINATION_TEXT[record.destination].label}
        </span>
        <Badge variant={status.variant}>{status.label}</Badge>
      </div>
      <p className="text-[12px] leading-4 text-kumo-subtle">{record.audience}</p>
      <p className="text-[12px] leading-4 text-kumo-subtle">
        Requested by {record.publishedBy} on {date(record.requestedAt)}
        {record.approvedBy && record.at && (
          <>; approved by {record.approvedBy}{record.selfApproved ? ' (self-approved)' : ''} on {date(record.at)}</>
        )}
        {lastConfirmation && <>; re-confirmed by {lastConfirmation.by} on {date(lastConfirmation.at)}</>}
        {record.withdrawnBy && record.withdrawnAt && (
          <>; withdrawn by {record.withdrawnBy} on {date(record.withdrawnAt)}{record.reason ? `: ${record.reason}` : ''}</>
        )}
      </p>
      {record.artifact.digest && (
        <p className="truncate font-mono text-[11px] leading-4 text-kumo-inactive" title={record.artifact.digest}>
          {record.artifact.digest}
        </p>
      )}
    </div>
  )
}
