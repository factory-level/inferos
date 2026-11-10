import { useEffect, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { ActionOutcome } from '@gadgets/workshop-shared/action-outcome'
import type { RequestedRun, TriggerControl, WorkflowRunOutcome } from '@gadgets/workshop-shared/workflow-definition'
import { WorkshopButton } from '../../components/WorkshopControls'

/**
 * Where one press stands. A run the server accepted was handed to its trigger and is in flight,
 * which FAC-97's vocabulary calls `running`: never done. A refusal keeps the server's own words
 * (a rate refusal names when to try again).
 */
type Pressed =
  | { status: 'sending' }
  | { status: 'requested'; outcome: Extract<ActionOutcome, 'running'>; at: Date }
  | { status: 'refused'; message: string }

/** The words for a run that was requested and not finished. */
export const RUN_REQUESTED_TEXT = 'Run requested, not done yet'

/**
 * The words for each outcome of a run the person asked for (FAC-114, FAC-116). None says more than
 * the outcome does: a run not yet finished is only requested, and an uncertain one may have written.
 */
export const RUN_OUTCOME_TEXT: Readonly<Record<WorkflowRunOutcome, string>> = {
  queued: RUN_REQUESTED_TEXT,
  running: RUN_REQUESTED_TEXT,
  waiting: 'Waiting for approval',
  succeeded: 'Finished',
  failed: "Didn't finish",
  uncertain: 'May or may not have finished; check before running it again',
}

/** How often a run that isn't final yet is read again while this page shows it. */
const FOLLOW_MS = 5_000
const isFinal = (outcome: WorkflowRunOutcome) => outcome === 'succeeded' || outcome === 'failed' || outcome === 'uncertain'
const timeOf = (at: Date) => at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** The newest run this person asked trigger `hookId` for, or null when there's none or it can't be read. */
const newestRun = (overseer: RpcStub<Overseer>, hookId: number): Promise<RequestedRun | null> =>
  Promise.resolve().then(() => overseer.listRequestedRuns(hookId)).then(runs => runs[0] ?? null, () => null)

const errorText = (err: unknown) =>
  err instanceof Error && err.message ? err.message.replace(/^(?:\w*Error: )?/, '') : "Couldn't run this."

/**
 * The workflow runs this person may ask for (Overseer.listTriggerControls): only the controls
 * that list them, each just a label and a button (`{hookId, label}`). Nothing renders when there
 * are none, so a person who isn't listed sees nothing. Pressing asks the server to run that
 * trigger once; what it does and with whose connections is the workflow's, not theirs.
 *
 * Beside each control is what became of the newest run this person asked it for (FAC-116,
 * `listRequestedRuns`), read when the page opens, so it shows after any reconnect, and again after
 * a press; a run that isn't final yet is read again every few seconds until it is. Runs that
 * can't be read show nothing beyond the press itself.
 */
export const WorkflowRunControls = ({ overseer }: { overseer: RpcStub<Overseer> }) => {
  const [controls, setControls] = useState<Pick<TriggerControl, 'hookId' | 'label'>[]>([])
  const [pressed, setPressed] = useState<ReadonlyMap<number, Pressed>>(new Map())
  const [newest, setNewest] = useState<ReadonlyMap<number, RequestedRun>>(new Map())
  // The overseer whose answers still count: one answered after the page moved to another workspace,
  // or unmounted, is dropped.
  const live = useRef<RpcStub<Overseer> | null>(null)

  const readRuns = (asked: RpcStub<Overseer>, hookId: number) => {
    void newestRun(asked, hookId).then(run => {
      if (run && live.current === asked) setNewest(prev => new Map(prev).set(hookId, run))
    })
  }

  useEffect(() => {
    live.current = overseer
    setNewest(new Map())
    // A backend without controls, or any failure, shows none rather than breaking the page.
    Promise.resolve().then(() => overseer.listTriggerControls())
      .then(list => {
        if (live.current !== overseer) return
        setControls(list.map(({ hookId, label }) => ({ hookId, label })))
        for (const { hookId } of list) readRuns(overseer, hookId)
      })
      .catch(() => { if (live.current === overseer) setControls([]) })
    return () => { live.current = null }
  }, [overseer])

  // Follow the runs that aren't final yet, until they are; each new answer starts the next wait.
  const following = [...newest].filter(([, run]) => !isFinal(run.outcome)).map(([hookId]) => hookId).join(',')
  const answers = [...newest.values()].map(run => `${run.invocationId}:${run.outcome}`).join(',')
  useEffect(() => {
    const asked = live.current
    if (following === '' || !asked) return
    const timer = setTimeout(() => { for (const hookId of following.split(',')) readRuns(asked, Number(hookId)) }, FOLLOW_MS)
    return () => clearTimeout(timer)
  }, [following, answers])

  const press = async (hookId: number) => {
    setPressed(prev => new Map(prev).set(hookId, { status: 'sending' }))
    let next: Pressed
    try {
      await overseer.invokeTrigger(hookId)
      next = { status: 'requested', outcome: 'running', at: new Date() }
    } catch (err) {
      next = { status: 'refused', message: errorText(err) }
    }
    setPressed(prev => new Map(prev).set(hookId, next))
    if (next.status === 'requested') readRuns(overseer, hookId)
  }

  if (controls.length === 0) return null
  return (
    <section aria-label="Workflow runs" className="flex flex-shrink-0 flex-wrap items-center gap-3 border-b border-kumo-line px-4 py-2 sm:px-6">
      {controls.map(control => {
        const state = pressed.get(control.hookId)
        const last = newest.get(control.hookId)
        return (
          <div key={control.hookId} className="flex items-center gap-2">
            <WorkshopButton disabled={state?.status === 'sending'} onClick={() => press(control.hookId)}>
              {control.label}
            </WorkshopButton>
            {last ? (
              <span role="status" className="text-[12px] leading-4 text-kumo-subtle">
                Last run: {RUN_OUTCOME_TEXT[last.outcome]} (requested at {timeOf(new Date(last.requestedAt))})
              </span>
            ) : state?.status === 'requested' && (
              <span role="status" className="text-[12px] leading-4 text-kumo-subtle">
                {RUN_REQUESTED_TEXT} (requested at {timeOf(state.at)})
              </span>
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
