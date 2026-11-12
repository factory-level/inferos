import { useEffect, useState } from 'react'
import { Checkbox } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { CollaboratorInfo, Overseer } from '@gadgets/workshop-shared/api'
import type {
  TriggerControl, WorkflowDefinitionDelivery, WorkflowDefinitionRef,
} from '@gadgets/workshop-shared/workflow-definition'
import { isLiveWorkflowDelivery } from '@gadgets/workshop-shared/workflow-definition'
import { WorkshopButton, WorkshopInput } from '../../components/WorkshopControls'

/** How many of a trigger's runs on request the editor lists. */
const RECENT_RUNS = 5

type History = { status: 'loading' } | { status: 'error' } | { status: 'ready'; runs: WorkflowDefinitionDelivery[] }

const runState = (run: WorkflowDefinitionDelivery) => {
  if (run.result) {
    return ({ queued: 'Queued', running: 'Running', waiting: 'Waiting for approval', succeeded: 'Finished', failed: "Didn't finish", uncertain: 'Outcome uncertain' } as const)[run.result.outcome]
  }
  if (run.execution?.state === 'queued') return 'Queued'
  if (run.execution?.state === 'running') return 'Running'
  if (run.execution?.state === 'finished') return 'Finished'
  if (run.execution?.state === 'failed') return "Didn't finish"
  return 'Run recorded'
}

const errorText = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback

/**
 * Who may run one pinned trigger on request (Overseer.setTriggerControl): a label for its button
 * and the people listed, chosen from the workspace's collaborators. Being listed lets a person run
 * the trigger and nothing else. Below it, this trigger's latest run history and server-computed
 * retention. A requester is shown as a record, not the run's authority. Refusals show in the
 * server's words.
 */
export const TriggerControlEditor = ({ overseer, hookId, pin, control, collaborators, onChanged }: {
  overseer: RpcStub<Overseer>
  hookId: number
  pin: WorkflowDefinitionRef
  control: TriggerControl | null
  collaborators: readonly CollaboratorInfo[]
  onChanged: () => void
}) => {
  const [label, setLabel] = useState(control?.label ?? '')
  const [invokers, setInvokers] = useState<ReadonlySet<string>>(new Set(control?.invokers ?? []))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<History>({ status: 'loading' })
  const [historyRetry, setHistoryRetry] = useState(0)

  useEffect(() => {
    let cancelled = false
    setHistory({ status: 'loading' })
    overseer.listWorkflowDeliveries(pin.definitionId)
      .then(all => {
        if (!cancelled) setHistory({
          status: 'ready',
          runs: all.filter(d => d.hookId === hookId).slice(-RECENT_RUNS).toReversed(),
        })
      })
      .catch(() => { if (!cancelled) setHistory({ status: 'error' }) })
    return () => { cancelled = true }
  }, [overseer, hookId, pin.definitionId, historyRetry])

  const nameOf = (profileId: string) =>
    collaborators.find(c => c.profile.id === profileId)?.profile.name ?? 'Someone no longer here'
  // Everyone the control lists is shown, a person who has left the workspace included, so the
  // builder sees and can untick them; Save needs a current collaborator ticked.
  const current = new Set(collaborators.map(c => c.profile.id))
  const departed = (control?.invokers ?? []).filter(id => !current.has(id))
  const tickedCurrent = [...invokers].some(id => current.has(id))

  const save = async (settings: { label: string; invokers: string[] } | null) => {
    setBusy(true)
    setError(null)
    try {
      await overseer.setTriggerControl(hookId, settings)
      onChanged()
    } catch (err) {
      setError(errorText(err, "Couldn't change who may run this trigger."))
    } finally {
      setBusy(false)
    }
  }

  const toggle = (profileId: string, on: boolean) => {
    setInvokers(prev => {
      const next = new Set(prev)
      if (on) next.add(profileId)
      else next.delete(profileId)
      return next
    })
  }

  return (
    <section aria-label="Run on request" className="mt-2 grid gap-2 rounded-lg border border-kumo-line px-3 py-2.5">
      <p className="m-0 text-[12px] leading-4 font-medium text-kumo-default">Run on request</p>
      <p className="m-0 text-[12px] leading-4 text-kumo-subtle">
        People you list here get a button that runs this trigger now, and nothing else: they can't
        see or change the workflow, its trigger or its connections.
      </p>
      <WorkshopInput
        aria-label="Button label"
        placeholder="e.g. Issue refunds now"
        value={label}
        maxLength={80}
        onChange={e => setLabel(e.target.value)}
        className="w-full"
      />
      {collaborators.length === 0 && departed.length === 0 ? (
        <p className="m-0 text-[12px] leading-4 text-kumo-subtle">Share this workspace to list who may run it.</p>
      ) : (
        <ul aria-label="Who may run it" className="m-0 grid list-none gap-1 p-0">
          {collaborators.map(c => (
            <li key={c.profile.id} className="flex items-center gap-2 text-[12px] text-kumo-default">
              <Checkbox
                aria-label={`Let ${c.profile.name} run it`}
                checked={invokers.has(c.profile.id)}
                onCheckedChange={checked => toggle(c.profile.id, checked === true)}
              />
              <span className="truncate">{c.profile.name}</span>
            </li>
          ))}
          {departed.map((id, index) => (
            <li key={id} className="flex items-center gap-2 text-[12px] text-kumo-subtle">
              <Checkbox
                aria-label={`Let a former collaborator (${index + 1}) run it`}
                checked={invokers.has(id)}
                onCheckedChange={checked => toggle(id, checked === true)}
              />
              <span className="truncate">No longer a collaborator: they can't run it unless re-added, untick to remove them</span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-end gap-2">
        {control && (
          <WorkshopButton disabled={busy} onClick={() => save(null)}>Remove</WorkshopButton>
        )}
        <WorkshopButton
          tone="primary"
          disabled={busy || !label.trim() || !tickedCurrent}
          onClick={() => save({ label: label.trim(), invokers: [...invokers] })}
        >
          {busy ? 'Saving…' : control ? 'Save' : 'Add button'}
        </WorkshopButton>
      </div>
      {error && <p role="alert" className="m-0 text-[12px] leading-4 text-kumo-danger">{error}</p>}
      <p className="m-0 text-[12px] leading-4 font-medium text-kumo-default">Recent run history</p>
      {history.status === 'loading' && (
        <p role="status" className="m-0 text-[11px] leading-4 text-kumo-subtle">Loading run history…</p>
      )}
      {history.status === 'error' && (
        <div>
          <p role="alert" className="m-0 text-[11px] leading-4 text-kumo-danger">Couldn't load run history.</p>
          <WorkshopButton onClick={() => setHistoryRetry(n => n + 1)}>Retry history</WorkshopButton>
        </div>
      )}
      {history.status === 'ready' && history.runs.length === 0 && (
        <p className="m-0 text-[11px] leading-4 text-kumo-inactive">No run history yet.</p>
      )}
      {history.status === 'ready' && history.runs.length > 0 && (
        <ul aria-label="Recent workflow run history" className="m-0 grid list-none gap-0.5 p-0">
          {history.runs.map((run, index) => {
            const live = isLiveWorkflowDelivery(run)
            return (
              <li key={run.run?.runId ?? run.invocation?.id ?? `${run.hookId}:${run.at.getTime()}:${index}`}
                className="text-[11px] leading-4 text-kumo-subtle">
                <span>{runState(run)} · {new Date(run.at).toLocaleString()} · revision {run.revision}</span>
                {run.invocation && <span> · Requested by {nameOf(run.invocation.requestedBy)}</span>}
                {live ? (
                  <span> · Kept while it&apos;s live, uncertain or waiting</span>
                ) : run.historyExpiresAt ? (
                  <span> · Kept until <time dateTime={run.historyExpiresAt.toISOString()}>{run.historyExpiresAt.toLocaleString()}</time></span>
                ) : (
                  <span> · Retention date unavailable</span>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
