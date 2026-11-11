import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { WorkflowDefinitionDelivery, WorkflowDefinitionHistoryRef } from '@gadgets/workshop-shared/workflow-definition'
import { WorkshopButton } from '../../components/WorkshopControls'

type Load<T> = { status: 'loading' } | { status: 'error' } | { status: 'ready'; value: T }

const outcome = (delivery: WorkflowDefinitionDelivery) => {
  if (delivery.result) return ({
    queued: 'Queued', running: 'Running', waiting: 'Waiting for approval', succeeded: 'Finished',
    failed: "Didn't finish", uncertain: 'Outcome uncertain',
  } as const)[delivery.result.outcome]
  if (delivery.execution?.state === 'queued') return 'Queued'
  if (delivery.execution?.state === 'running') return 'Running'
  if (delivery.execution?.state === 'finished') return 'Finished'
  if (delivery.execution?.state === 'failed') return "Didn't finish"
  return 'Run recorded'
}

const DefinitionHistory = ({ overseer, definitionId }: {
  overseer: RpcStub<Overseer>
  definitionId: string
}) => {
  const [retry, setRetry] = useState(0)
  const [history, setHistory] = useState<Load<WorkflowDefinitionDelivery[]>>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    setHistory({ status: 'loading' })
    overseer.listWorkflowDeliveries(definitionId).then(value => {
      if (!cancelled) setHistory({ status: 'ready', value: [...value].toReversed() })
    }).catch(() => { if (!cancelled) setHistory({ status: 'error' }) })
    return () => { cancelled = true }
  }, [overseer, definitionId, retry])

  return (
    <li className="border-t border-kumo-line px-3 py-2">
      <h3 className="m-0 break-all text-[12px] leading-4 font-medium text-kumo-default">Workflow {definitionId}</h3>
      {history.status === 'loading' && <p role="status" className="m-0 text-[12px] text-kumo-subtle">Loading run history…</p>}
      {history.status === 'error' && (
        <div>
          <p role="alert" className="m-0 text-[12px] text-kumo-danger">Couldn't load this run history.</p>
          <WorkshopButton onClick={() => setRetry(n => n + 1)}>Retry history</WorkshopButton>
        </div>
      )}
      {history.status === 'ready' && history.value.length === 0 && (
        <p className="m-0 text-[12px] text-kumo-subtle">No run history yet.</p>
      )}
      {history.status === 'ready' && history.value.length > 0 && (
        <ul aria-label={`Run history for ${definitionId}`} className="m-0 list-none p-0">
          {history.value.map((item, index) => (
            <li key={item.run?.runId ?? item.invocation?.id ?? `${item.at.getTime()}:${index}`}
              className="text-[12px] leading-4 text-kumo-subtle">
              {outcome(item)} · {new Date(item.at).toLocaleString()} · revision {item.revision}
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

/** Server-authorized discovery also finds retained history after a temporary definition is swept. */
export const WorkflowHistorySection = ({ overseer }: { overseer: RpcStub<Overseer> }) => {
  const [retry, setRetry] = useState(0)
  const [definitions, setDefinitions] = useState<Load<WorkflowDefinitionHistoryRef[]>>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    setDefinitions({ status: 'loading' })
    overseer.listReadableWorkflowHistories().then(value => {
      if (!cancelled) setDefinitions({ status: 'ready', value })
    }).catch(() => { if (!cancelled) setDefinitions({ status: 'error' }) })
    return () => { cancelled = true }
  }, [overseer, retry])

  return (
    <section aria-labelledby="workflow-history-heading" className="mt-8">
      <h2 id="workflow-history-heading" className="m-0 text-[17px] leading-6 font-medium text-kumo-default">Run history</h2>
      {definitions.status === 'loading' && <p role="status" className="mt-2 text-[13px] text-kumo-subtle">Loading available run histories…</p>}
      {definitions.status === 'error' && (
        <div className="mt-2">
          <p role="alert" className="m-0 text-[13px] text-kumo-danger">Couldn't load available run histories.</p>
          <WorkshopButton onClick={() => setRetry(n => n + 1)}>Retry histories</WorkshopButton>
        </div>
      )}
      {definitions.status === 'ready' && definitions.value.length === 0 && (
        <p className="mt-2 text-[13px] text-kumo-subtle">No run history available.</p>
      )}
      {definitions.status === 'ready' && definitions.value.length > 0 && (
        <ul aria-label="Available workflow histories" className="mt-2 list-none overflow-hidden rounded-xl border border-kumo-line bg-kumo-base p-0">
          {definitions.value.map(({ definitionId }) => (
            <DefinitionHistory key={definitionId} overseer={overseer} definitionId={definitionId} />
          ))}
        </ul>
      )}
    </section>
  )
}
