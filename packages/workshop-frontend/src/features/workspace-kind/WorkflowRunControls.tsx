import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { ActionOutcome } from '@gadgets/workshop-shared/action-outcome'
import type { TriggerControl } from '@gadgets/workshop-shared/workflow-definition'
import { WorkshopButton } from '../../components/WorkshopControls'

/**
 * Where one press stands. A run the server accepted was handed to its trigger and is in flight,
 * which FAC-97's vocabulary calls `running`: never done. A refusal keeps the server's own words
 * (a rate refusal names when to try again).
 */
type Pressed =
  | { status: 'sending' }
  | { status: 'requested'; outcome: Extract<ActionOutcome, 'running'> }
  | { status: 'refused'; message: string }

/** The words for a run that was requested and not finished. */
export const RUN_REQUESTED_TEXT = 'Run requested, not done yet'

const errorText = (err: unknown) =>
  err instanceof Error && err.message ? err.message.replace(/^(?:\w*Error: )?/, '') : "Couldn't run this."

/**
 * The workflow runs this person may ask for (Overseer.listTriggerControls): only the controls
 * that list them, each just a label and a button (`{hookId, label}`). Nothing renders when there
 * are none, so a person who isn't listed sees nothing. Pressing asks the server to run that
 * trigger once; what it does and with whose connections is the workflow's, not theirs.
 */
export const WorkflowRunControls = ({ overseer }: { overseer: RpcStub<Overseer> }) => {
  const [controls, setControls] = useState<Pick<TriggerControl, 'hookId' | 'label'>[]>([])
  const [pressed, setPressed] = useState<ReadonlyMap<number, Pressed>>(new Map())

  useEffect(() => {
    let cancelled = false
    // A backend without controls, or any failure, shows none rather than breaking the page.
    Promise.resolve().then(() => overseer.listTriggerControls())
      .then(list => { if (!cancelled) setControls(list.map(({ hookId, label }) => ({ hookId, label }))) })
      .catch(() => { if (!cancelled) setControls([]) })
    return () => { cancelled = true }
  }, [overseer])

  const press = async (hookId: number) => {
    setPressed(prev => new Map(prev).set(hookId, { status: 'sending' }))
    let next: Pressed
    try {
      await overseer.invokeTrigger(hookId)
      next = { status: 'requested', outcome: 'running' }
    } catch (err) {
      next = { status: 'refused', message: errorText(err) }
    }
    setPressed(prev => new Map(prev).set(hookId, next))
  }

  if (controls.length === 0) return null
  return (
    <section aria-label="Workflow runs" className="flex flex-shrink-0 flex-wrap items-center gap-3 border-b border-kumo-line px-4 py-2 sm:px-6">
      {controls.map(control => {
        const state = pressed.get(control.hookId)
        return (
          <div key={control.hookId} className="flex items-center gap-2">
            <WorkshopButton disabled={state?.status === 'sending'} onClick={() => press(control.hookId)}>
              {control.label}
            </WorkshopButton>
            {state?.status === 'requested' && (
              <span role="status" className="text-[12px] leading-4 text-kumo-subtle">{RUN_REQUESTED_TEXT}</span>
            )}
            {state?.status === 'refused' && (
              <span role="alert" className="text-[12px] leading-4 text-kumo-danger">{state.message}</span>
            )}
          </div>
        )
      })}
    </section>
  )
}
