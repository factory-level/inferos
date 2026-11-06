import { useRef, useState } from 'react'
import { Select } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { TriggerAssignment } from '@gadgets/workshop-shared/workflow-definition'
import { WorkshopButton } from '../../components/WorkshopControls'

/** A connection the trigger's gadget binds, which its runs can act through. */
export type AssignableConnection = { id: number; title: string }

const errorText = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback

/**
 * Who one pinned trigger's runs on request act as (FAC-102): a service account in one of the
 * gadget's connections (Overseer.setTriggerAssignment), never the person who asks for a run. Once
 * assigned, an Admin gives that connection the service account's key (provisionTriggerCredential).
 *
 * The key field is uncontrolled: the key is only ever the DOM input's own value while it is typed,
 * read through a ref when it is sent, never React state, a prop or anything kept, and never the
 * URL. The field is emptied as it is sent, whether or not the key is accepted. As defence in depth
 * against password managers saving it, the field asks for a new password, carries the managers'
 * opt-outs, and sits in no `<form>`, so nothing is ever submitted natively; Enter and the button
 * send it. The editor shows who gave the key and when, never the key. Refusals show in the
 * server's words. `connections` is null when the gadget's connections couldn't be read.
 *
 * When the instance has assignments off (`enabled` false, as the server reads it; off by default
 * until the fail-closed follow-up), the editor says so and offers neither assigning nor a key field,
 * only Remove for an assignment made before. The server refuses the rest regardless.
 */
export const TriggerAssignmentEditor = ({ overseer, hookId, enabled, assignment, connections, onChanged }: {
  overseer: RpcStub<Overseer>
  hookId: number
  enabled: boolean
  assignment: TriggerAssignment | null
  connections: readonly AssignableConnection[] | null
  onChanged: () => void
}) => {
  const [choice, setChoice] = useState<number | null>(connections?.[0]?.id ?? null)
  const keyField = useRef<HTMLInputElement>(null)
  // Whether the field holds anything, for the button; never the key itself.
  const [hasKey, setHasKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (action: () => Promise<unknown>, fallback: string) => {
    setBusy(true)
    setError(null)
    try {
      await action()
      onChanged()
    } catch (err) {
      setError(errorText(err, fallback))
    } finally {
      setBusy(false)
    }
  }

  const giveKey = async () => {
    const field = keyField.current
    if (!field?.value || busy) return
    const typed = field.value
    // Emptied before the call returns, so the key isn't left on screen whatever happens.
    field.value = ''
    setHasKey(false)
    await run(() => overseer.provisionTriggerCredential(hookId, typed), "The key wasn't accepted.")
  }

  const assigned = assignment
    ? connections?.find(c => c.id === assignment.gatekeeperId)?.title ?? 'A connection no longer bound'
    : null

  return (
    <section aria-label="Runs act as" className="mt-2 grid gap-2 rounded-lg border border-kumo-line px-3 py-2.5">
      <p className="m-0 text-[12px] leading-4 font-medium text-kumo-default">Runs act as</p>
      {!enabled ? (
        <>
          <p className="m-0 text-[12px] leading-4 text-kumo-subtle">
            Not enabled on this instance. Runs on request can't act as a service account here.
          </p>
          {assignment && (
            <div className="flex items-center justify-between gap-2">
              <p className="m-0 text-[12px] leading-4 text-kumo-default">
                Assigned before: a service account in <span className="font-medium">{assigned}</span>
              </p>
              <WorkshopButton disabled={busy} onClick={() => run(() => overseer.setTriggerAssignment(hookId, null),
                "Couldn't remove the assignment.")}>Remove</WorkshopButton>
            </div>
          )}
        </>
      ) : assignment ? (
        <>
          <p className="m-0 text-[12px] leading-4 text-kumo-default">
            A service account in <span className="font-medium">{assigned}</span>
          </p>
          <p className="m-0 text-[12px] leading-4 text-kumo-subtle">
            {assignment.provisionedBy && assignment.provisionedAt
              ? `Key given by ${assignment.provisionedBy.name} on ${new Date(assignment.provisionedAt).toLocaleString()}.`
              : 'No key yet: runs are refused until an Admin gives one.'}
          </p>
          <div className="flex gap-2">
            {/* A plain input, so the key never travels as a prop; styled as WorkshopInput. */}
            <input
              ref={keyField}
              aria-label="Service account key"
              type="password"
              name="trigger-service-account-key"
              autoComplete="new-password"
              spellCheck={false}
              data-1p-ignore="true"
              data-lpignore="true"
              data-bwignore="true"
              data-keeper-ignore="true"
              placeholder={assignment.provisionedAt ? 'Replace the key' : 'Paste the key'}
              onChange={e => setHasKey(e.currentTarget.value !== '')}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void giveKey()
                }
              }}
              className="!h-9 w-full rounded-md border-0 bg-kumo-control px-3 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-default placeholder:text-kumo-inactive shadow-none ring-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
            />
            <WorkshopButton disabled={busy || !hasKey} onClick={() => void giveKey()}>Give key</WorkshopButton>
          </div>
          <div className="flex justify-end">
            <WorkshopButton disabled={busy} onClick={() => run(() => overseer.setTriggerAssignment(hookId, null),
              "Couldn't remove the assignment.")}>Remove</WorkshopButton>
          </div>
        </>
      ) : connections === null ? (
        <div className="flex items-center justify-between gap-2">
          <p role="alert" className="m-0 text-[12px] leading-4 text-kumo-danger">
            Couldn't read this trigger's connections.
          </p>
          <WorkshopButton onClick={onChanged}>Retry</WorkshopButton>
        </div>
      ) : connections.length === 0 ? (
        <p className="m-0 text-[12px] leading-4 text-kumo-subtle">
          Bind this trigger's gadget to a connection to run it as a service account.
        </p>
      ) : (
        <>
          <p className="m-0 text-[12px] leading-4 text-kumo-subtle">
            Runs on request act as a service account in one connection, never as the person who asks.
          </p>
          <Select label="Connection" value={choice === null ? '' : String(choice)}
            renderValue={value => connections.find(c => String(c.id) === value)?.title ?? ''}
            onValueChange={value => { if (value) setChoice(Number(value)) }}>
            {connections.map(c => <Select.Option key={c.id} value={String(c.id)}>{c.title}</Select.Option>)}
          </Select>
          <div className="flex justify-end">
            <WorkshopButton disabled={busy || choice === null} onClick={() => run(
              () => overseer.setTriggerAssignment(hookId, { gatekeeperId: choice! }),
              "Couldn't assign the trigger.")}>Assign</WorkshopButton>
          </div>
        </>
      )}
      {error && <p role="alert" className="m-0 text-[12px] leading-4 text-kumo-danger">{error}</p>}
    </section>
  )
}
