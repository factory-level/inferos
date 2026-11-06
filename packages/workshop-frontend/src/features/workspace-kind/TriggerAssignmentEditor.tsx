import { useState } from 'react'
import { Select } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { TriggerAssignment } from '@gadgets/workshop-shared/workflow-definition'
import { WorkshopButton, WorkshopInput } from '../../components/WorkshopControls'

/** A connection the trigger's gadget binds, which its runs can act through. */
export type AssignableConnection = { id: number; title: string }

const errorText = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback

/**
 * Who one pinned trigger's runs on request act as (FAC-102): a service account in one of the
 * gadget's connections (Overseer.setTriggerAssignment), never the person who asks for a run. Once
 * assigned, an Admin gives that connection the service account's key (provisionTriggerCredential).
 * The key lives only in this field's local state while it is typed: it is never put in props, the
 * URL or anything kept, and the field is emptied as soon as it is sent, whether or not the key was
 * accepted. The editor shows who gave the key and when, never the key. Refusals show in the
 * server's words.
 */
export const TriggerAssignmentEditor = ({ overseer, hookId, assignment, connections, onChanged }: {
  overseer: RpcStub<Overseer>
  hookId: number
  assignment: TriggerAssignment | null
  connections: readonly AssignableConnection[]
  onChanged: () => void
}) => {
  const [choice, setChoice] = useState<number | null>(connections[0]?.id ?? null)
  const [key, setKey] = useState('')
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
    const typed = key
    // Emptied before the call returns, so the key isn't left on screen whatever happens.
    setKey('')
    await run(() => overseer.provisionTriggerCredential(hookId, typed), "The key wasn't accepted.")
  }

  const assigned = assignment
    ? connections.find(c => c.id === assignment.gatekeeperId)?.title ?? 'A connection no longer bound'
    : null

  return (
    <section aria-label="Runs act as" className="mt-2 grid gap-2 rounded-lg border border-kumo-line px-3 py-2.5">
      <p className="m-0 text-[12px] leading-4 font-medium text-kumo-default">Runs act as</p>
      {assignment ? (
        <>
          <p className="m-0 text-[12px] leading-4 text-kumo-default">
            A service account in <span className="font-medium">{assigned}</span>
          </p>
          <p className="m-0 text-[12px] leading-4 text-kumo-subtle">
            {assignment.provisionedBy && assignment.provisionedAt
              ? `Key given by ${assignment.provisionedBy.name} on ${new Date(assignment.provisionedAt).toLocaleString()}.`
              : 'No key yet: runs are refused until an Admin gives one.'}
          </p>
          <form
            className="flex gap-2"
            onSubmit={e => {
              e.preventDefault()
              if (key) void giveKey()
            }}
          >
            <WorkshopInput
              aria-label="Service account key"
              type="password"
              autoComplete="off"
              placeholder={assignment.provisionedAt ? 'Replace the key' : 'Paste the key'}
              value={key}
              onChange={e => setKey(e.target.value)}
              className="w-full"
            />
            <WorkshopButton type="submit" disabled={busy || !key}>Give key</WorkshopButton>
          </form>
          <div className="flex justify-end">
            <WorkshopButton disabled={busy} onClick={() => run(() => overseer.setTriggerAssignment(hookId, null),
              "Couldn't remove the assignment.")}>Remove</WorkshopButton>
          </div>
        </>
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
