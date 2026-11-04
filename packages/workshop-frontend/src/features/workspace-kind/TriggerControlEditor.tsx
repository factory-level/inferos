import { useEffect, useState } from 'react'
import { Checkbox } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { CollaboratorInfo, Overseer } from '@gadgets/workshop-shared/api'
import type {
  TriggerControl, WorkflowDefinitionDelivery, WorkflowDefinitionRef,
} from '@gadgets/workshop-shared/workflow-definition'
import { WorkshopButton, WorkshopInput } from '../../components/WorkshopControls'

/** How many of a trigger's runs on request the editor lists. */
const RECENT_RUNS = 5

const errorText = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback

/**
 * Who may run one pinned trigger on request (Overseer.setTriggerControl): a label for its button
 * and the people listed, chosen from the workspace's collaborators. Being listed lets a person run
 * the trigger and nothing else. Below it, the trigger's recent runs on request and who asked; the
 * person who asked is a record, not the run's authority. Refusals show in the server's words.
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
  const [runs, setRuns] = useState<WorkflowDefinitionDelivery[]>([])

  useEffect(() => {
    if (!control) return
    let cancelled = false
    overseer.listWorkflowDeliveries(pin.definitionId)
      .then(all => {
        if (!cancelled) setRuns(all.filter(d => d.hookId === hookId && d.invocation).slice(-RECENT_RUNS).toReversed())
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [overseer, hookId, pin.definitionId, control])

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
      {control && (
        runs.length === 0 ? (
          <p className="m-0 text-[11px] leading-4 text-kumo-inactive">No runs on request yet.</p>
        ) : (
          <ul aria-label="Recent runs on request" className="m-0 grid list-none gap-0.5 p-0">
            {runs.map(run => (
              <li key={run.invocation!.id} className="text-[11px] leading-4 text-kumo-subtle">
                Requested by {nameOf(run.invocation!.requestedBy)}, {new Date(run.at).toLocaleString()}, revision {run.revision}
              </li>
            ))}
          </ul>
        )
      )}
    </section>
  )
}
