import { useEffect, useRef, useState } from 'react'
import { ArrowLeft } from '@phosphor-icons/react'
import { Banner, Button, Loader, Radio, useKumoToastManager } from '@cloudflare/kumo'
import {
  DEFAULT_WORKSPACE_KIND, PUBLICATION_DESTINATIONS,
  type BlueprintPublicInfo, type PublicationDestination, type PublicationRecord,
} from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { useServerConfig } from '../../ServerConfigContext'
import { PublicationRecordSummary } from './PublicationRecordSummary'
import { WithdrawPublicationForm } from './WithdrawPublicationForm'
import { canPublishKind, DESTINATION_TEXT, publicationErrorMessage } from './publicationText'

type Props = {
  blueprintId: string
  onBack: () => void
}

type Loaded = { blueprint: BlueprintPublicInfo; records: PublicationRecord[] }

/**
 * Build's publication step for one of the author's blueprints: shows exactly what would go out,
 * requests a publication to a chosen destination, and lists this blueprint's publications with a
 * way to withdraw each one. A deployment admin approves; nothing here publishes on its own.
 */
export const PublicationReview = ({ blueprintId, onBack }: Props) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const config = useServerConfig()
  const toasts = useKumoToastManager()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [destination, setDestination] = useState<PublicationDestination>('deployment')
  const [requesting, setRequesting] = useState(false)
  const [requestError, setRequestError] = useState<string | null>(null)
  const [withdrawingId, setWithdrawingId] = useState<string | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const withdrawTriggers = useRef(new Map<string, HTMLButtonElement>())

  useEffect(() => { headingRef.current?.focus() }, [])

  useEffect(() => {
    let cancelled = false
    Promise.all([authenticatedApi.getBlueprintInfo(blueprintId), authenticatedApi.listOwnPublications()])
      .then(([blueprint, records]) => {
        if (cancelled) return
        if (!blueprint) setLoadError('This blueprint no longer exists.')
        else setLoaded({ blueprint, records: records.filter(r => r.artifact.blueprintId === blueprintId) })
      }, err => {
        if (!cancelled) setLoadError(publicationErrorMessage(err, 'Failed to load this blueprint.'))
      })
    return () => { cancelled = true }
  }, [authenticatedApi, blueprintId])

  const upsert = (record: PublicationRecord) => setLoaded(current => current && {
    ...current,
    records: [record, ...current.records.filter(r => r.id !== record.id)],
  })

  const request = async () => {
    setRequesting(true)
    setRequestError(null)
    try {
      upsert(await authenticatedApi.requestPublication(blueprintId, destination))
      toasts.add({ title: 'Sent to a deployment admin for approval.', variant: 'success' })
    } catch (err) {
      setRequestError(publicationErrorMessage(err, 'The request failed.'))
    } finally {
      setRequesting(false)
    }
  }

  const metadata = loaded?.blueprint.metadata
  const kind = metadata?.kind ?? DEFAULT_WORKSPACE_KIND
  const bindings = metadata ? Object.entries(metadata.bindings) : []

  return (
    <div className="space-y-5 px-6 py-5">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" shape="square" aria-label="Back to blueprints" onClick={onBack}>
          <ArrowLeft size={14} />
        </Button>
        <h3 ref={headingRef} tabIndex={-1}
          className="text-[15px] leading-5 font-semibold text-kumo-default focus-visible:outline-none">
          Publish {metadata ? `"${metadata.title}"` : 'blueprint'}
        </h3>
      </div>

      {loadError ? (
        <Banner variant="error" title="Can't publish" description={loadError} />
      ) : !loaded || !metadata ? (
        <div className="flex justify-center py-6"><Loader size="base" /></div>
      ) : (
        <>
          <section aria-labelledby="publication-artifact" className="rounded-xl border border-kumo-line p-4">
            <h4 id="publication-artifact" className="text-[13px] leading-[18px] font-medium text-kumo-default">
              What goes out
            </h4>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px] leading-[18px]">
              <dt className="text-kumo-subtle">Version</dt><dd className="text-kumo-default">v{metadata.version}, as published now</dd>
              <dt className="text-kumo-subtle">Kind</dt><dd className="text-kumo-default">{kind}</dd>
              <dt className="text-kumo-subtle">Description</dt>
              <dd className="text-kumo-default whitespace-pre-wrap">{metadata.description || 'None'}</dd>
              <dt className="text-kumo-subtle">Installers connect</dt>
              <dd className="text-kumo-default">
                {bindings.length === 0 ? 'Nothing' : bindings.map(([name, binding]) => binding.title || name).join(', ')}
              </dd>
            </dl>
            <p className="mt-2 text-[12px] leading-4 text-kumo-subtle">
              Only this version's code and binding descriptions. Never your chats, workspace data,
              credentials or connected accounts. A newer version needs a new request.
            </p>
          </section>

          {!canPublishKind(config, kind) ? (
            <Banner title={`Publishing ${kind}s is off on this deployment`}
              description="A deployer can turn it on. Until then nothing of this kind can be requested or withdrawn." />
          ) : (
            <section className="space-y-3">
              <Radio.Group value={destination} disabled={requesting}
                onValueChange={value => setDestination(value as PublicationDestination)}>
                <Radio.Legend className="text-[13px] leading-[18px] font-medium text-kumo-default">Where</Radio.Legend>
                {PUBLICATION_DESTINATIONS.map(value => (
                  <Radio.Item key={value} value={value}
                    label={`${DESTINATION_TEXT[value].label}: ${DESTINATION_TEXT[value].reach}`} />
                ))}
              </Radio.Group>
              {requestError && <p role="alert" className="text-[12px] leading-4 text-kumo-danger">{requestError}</p>}
              <Button variant="primary" size="sm" onClick={request} disabled={requesting}>
                {requesting ? 'Requesting…' : 'Request publication'}
              </Button>
            </section>
          )}

          <section aria-labelledby="publication-history">
            <h4 id="publication-history" className="mb-2 text-[13px] leading-[18px] font-medium text-kumo-default">
              Publications of this blueprint
            </h4>
            {loaded.records.length === 0 ? (
              <p className="text-[13px] text-kumo-subtle">None yet.</p>
            ) : (
              <ul className="divide-y divide-kumo-line rounded-xl border border-kumo-line px-4">
                {loaded.records.map(record => (
                  <li key={record.id} className="py-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <PublicationRecordSummary record={record} />
                      {record.status !== 'withdrawn' && canPublishKind(config, record.artifact.kind) && (
                        <Button size="sm" variant="secondary"
                          aria-expanded={withdrawingId === record.id}
                          ref={element => {
                            if (element) withdrawTriggers.current.set(record.id, element)
                            else withdrawTriggers.current.delete(record.id)
                          }}
                          onClick={() => setWithdrawingId(id => id === record.id ? null : record.id)}>
                          {record.status === 'requested' ? 'Cancel request' : 'Withdraw'}
                        </Button>
                      )}
                    </div>
                    {withdrawingId === record.id && (
                      <WithdrawPublicationForm
                        actionLabel={record.status === 'requested' ? 'Cancel request' : 'Withdraw'}
                        onCancel={() => {
                          setWithdrawingId(null)
                          withdrawTriggers.current.get(record.id)?.focus()
                        }}
                        onWithdraw={async reason => {
                          upsert(await authenticatedApi.withdrawPublication(record.id, reason))
                          setWithdrawingId(null)
                          headingRef.current?.focus()
                        }}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  )
}
