import { useEffect, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import { Banner, Button, Loader, useKumoToastManager } from '@cloudflare/kumo'
import type { AdminApi, PublicationRecord } from '@gadgets/workshop-shared/api'
import { useServerConfig } from '../../ServerConfigContext'
import { PublicationRecordSummary } from './PublicationRecordSummary'
import { WithdrawPublicationForm } from './WithdrawPublicationForm'
import { isPublicationOffered, publicationErrorMessage } from './publicationText'

type Props = { admin: RpcStub<AdminApi> }

/**
 * The deployment admin's review list: approve or refuse requests, re-confirm publications a flag
 * suspended, and withdraw active ones. The server enforces every rule (flags, self-approval, a
 * changed blueprint); this shows its answer.
 */
export const AdminPublicationsPanel = ({ admin }: Props) => {
  const config = useServerConfig()
  const toasts = useKumoToastManager()
  const [records, setRecords] = useState<PublicationRecord[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [withdrawingId, setWithdrawingId] = useState<string | null>(null)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  // Where focus returns when a withdraw form closes: the button that opened it on cancel, or the
  // row itself once the withdrawal removed that button.
  const withdrawTriggers = useRef(new Map<string, HTMLButtonElement>())
  const rows = useRef(new Map<string, HTMLLIElement>())

  useEffect(() => {
    let cancelled = false
    admin.listPublications().then(list => {
      if (!cancelled) setRecords(list)
    }, err => {
      if (!cancelled) setLoadError(publicationErrorMessage(err, 'Failed to load publications.'))
    })
    return () => { cancelled = true }
  }, [admin])

  const replace = (next: PublicationRecord) =>
    setRecords(current => current?.map(record => record.id === next.id ? next : record) ?? null)

  const decide = async (record: PublicationRecord, action: 'approve' | 'confirm') => {
    setBusyId(record.id)
    setRowErrors(({ [record.id]: _cleared, ...rest }) => rest)
    try {
      const next = action === 'approve'
        ? await admin.approvePublication(record.id)
        : await admin.confirmPublication(record.id)
      // Approval can withdraw the blueprint's earlier record for that destination, so reload.
      setRecords(await admin.listPublications())
      toasts.add({ title: next.destination === 'deployment'
        ? `"${next.artifact.title}" is listed for this deployment.`
        : `"${next.artifact.title}" can be reached by its link.`, variant: 'success' })
    } catch (err) {
      setRowErrors(errors => ({ ...errors, [record.id]: publicationErrorMessage(err, 'That did not work.') }))
    } finally {
      setBusyId(null)
    }
  }

  const closeWithdraw = (id: string) => {
    setWithdrawingId(null)
    withdrawTriggers.current.get(id)?.focus()
  }

  if (loadError) return <Banner variant="error" title="Publications" description={loadError} />
  if (records === null) return <div className="flex justify-center py-6"><Loader size="base" /></div>

  return (
    <section aria-labelledby="admin-publications-title" className="rounded-xl bg-kumo-elevated p-6">
      <h2 id="admin-publications-title" className="mb-1 text-[16px] leading-6 font-semibold text-kumo-default">
        Publications
      </h2>
      <p className="mb-5 text-[14px] leading-5 text-kumo-subtle">
        A blueprint reaches people beyond its owner only through an approved publication of one
        version. Withdrawing stops new reach; it cannot remove copies people already made.
      </p>
      {!isPublicationOffered(config) && (
        <Banner className="mb-4" title="Publishing is off on this deployment"
          description="PUBLISH_CLOUDFLAREOS_WIDGET and PUBLISH_CLOUDFLAREOS_APP are off, so nothing can be requested, approved or withdrawn, and existing publications are suspended." />
      )}
      {records.length === 0 ? (
        <p className="text-[13px] text-kumo-subtle">No publication requests yet.</p>
      ) : (
        <ul className="divide-y divide-kumo-line">
          {records.map(record => {
            const busy = busyId === record.id
            const open = record.status !== 'withdrawn'
            return (
              <li key={record.id} tabIndex={-1}
                className="py-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
                ref={element => {
                  if (element) rows.current.set(record.id, element)
                  else rows.current.delete(record.id)
                }}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <PublicationRecordSummary record={record} />
                  {open && (
                    <div className="flex shrink-0 gap-2">
                      {record.status === 'requested' && (
                        <Button size="sm" variant="primary" disabled={busy}
                          onClick={() => decide(record, 'approve')}>Approve</Button>
                      )}
                      {record.status === 'unconfirmed' && (
                        <Button size="sm" variant="primary" disabled={busy}
                          onClick={() => decide(record, 'confirm')}>Re-confirm</Button>
                      )}
                      <Button size="sm" variant="secondary" disabled={busy}
                        ref={element => {
                          if (element) withdrawTriggers.current.set(record.id, element)
                          else withdrawTriggers.current.delete(record.id)
                        }}
                        aria-expanded={withdrawingId === record.id}
                        onClick={() => setWithdrawingId(id => id === record.id ? null : record.id)}>
                        {record.status === 'requested' ? 'Refuse' : 'Withdraw'}
                      </Button>
                    </div>
                  )}
                </div>
                {rowErrors[record.id] && (
                  <p role="alert" className="mt-2 text-[12px] leading-4 text-kumo-danger">{rowErrors[record.id]}</p>
                )}
                {withdrawingId === record.id && (
                  <WithdrawPublicationForm
                    actionLabel={record.status === 'requested' ? 'Refuse' : 'Withdraw'}
                    onCancel={() => closeWithdraw(record.id)}
                    onWithdraw={async reason => {
                      replace(await admin.withdrawPublication(record.id, reason))
                      setWithdrawingId(null)
                      rows.current.get(record.id)?.focus()
                    }}
                  />
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
