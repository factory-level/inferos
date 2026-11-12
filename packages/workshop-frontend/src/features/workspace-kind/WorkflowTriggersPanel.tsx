import { useEffect, useState } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { LightningIcon } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { BoundHookInfo, CollaboratorInfo, GadgetSummary, Overseer } from '@gadgets/workshop-shared/api'
import type {
  TriggerAssignment, TriggerControl, WorkflowDefinition, WorkflowDefinitionDelivery, WorkflowDefinitionHistoryRef,
  WorkflowDefinitionRef, WorkflowScheduleSummary,
} from '@gadgets/workshop-shared/workflow-definition'
import { HookToggle } from '../../components/HookToggle'
import { WorkshopButton } from '../../components/WorkshopControls'
import { reportIssue } from '../../errorReporting'
import { type AssignableConnection, TriggerAssignmentEditor } from './TriggerAssignmentEditor'
import { TriggerControlEditor } from './TriggerControlEditor'
import { WorkflowHistorySection } from './WorkflowHistorySection'
import { WorkflowDefinitionsSection } from './WorkflowDefinitionsSection'

type Props = {
  overseer: RpcStub<Overseer>
  // The workspace's gadgets, to name the one each trigger wakes when there is more than one.
  gadgets: readonly GadgetSummary[]
  // Changes whenever a hook is bound or toggled elsewhere, prompting a reload.
  refreshKey: string
  pendingActionCount: number
  onOpenActivity: () => void
}

type Loaded =
  | { status: 'loading' }
  | { status: 'error' }
  | {
      status: 'ready'
      hooks: BoundHookInfo[]
      definitions: WorkflowDefinition[]
      schedules: WorkflowScheduleSummary[]
      // Each hook's pinned definition revision, by hook id; absent when unpinned.
      pins: ReadonlyMap<number, WorkflowDefinitionRef>
      // Each pinned hook's run-on-request control, by hook id; absent when it has none.
      controls: ReadonlyMap<number, TriggerControl>
      // Who a control can list: the workspace's collaborators.
      collaborators: CollaboratorInfo[]
      // Each pinned hook's service-account assignment, by hook id; absent when it has none.
      assignments: ReadonlyMap<number, TriggerAssignment>
      // Whether this instance has assignments on, as the server reads it (off by default).
      assignmentsEnabled: boolean
      // The connections each pinned hook's gadget binds, which an assignment can choose, by hook id.
      connections: ReadonlyMap<number, AssignableConnection[] | null>
    }

// The definition revision a trigger could run: the published one for the gadget it wakes.
const publishedFor = (definitions: readonly WorkflowDefinition[], gadgetId: number) =>
  definitions.flatMap(definition => {
    const revision = definition.published &&
      definition.revisions.find(r => r.revision === definition.published!.revision)
    return revision && revision.source.gadgetId === gadgetId
      ? [{ definition, ref: { definitionId: definition.id, revision: revision.revision } }]
      : []
  })

// The connections a trigger's gadget binds, once each, for choosing who its runs act as. The server
// checks the choice. A gadget that can't be read gives null, which the editor shows as an error
// with a retry, rather than as having no connections or failing the whole panel.
const connectionsOf = async (overseer: RpcStub<Overseer>, gadgetId: number): Promise<AssignableConnection[] | null> => {
  const gadget = overseer.getGadget(gadgetId)
  try {
    const bindings = await gadget.listBindings()
    const seen = new Map<number, AssignableConnection>()
    for (const b of bindings) {
      if (b.vendorId !== undefined && !seen.has(b.target)) seen.set(b.target, { id: b.target, title: b.resourceTitle })
    }
    return [...seen.values()]
  } catch {
    return null
  } finally {
    gadget[Symbol.dispose]()
  }
}

/**
 * A workflow's output pane: what wakes it, in place of an app preview. Lists the workspace's bound
 * hooks, which is where both event hooks and scheduled tasks land (the scheduler binds each
 * schedule as a hook), with the same enable toggle as Connections, and the workflow's saved
 * definitions (WorkflowDefinitionsSection). Readable schedules are shown with their safe cadence,
 * status, and next fire time. The server filters these to definitions this viewer can read. A
 * trigger pinned to a definition revision says so, and can be pinned to a published revision for
 * its gadget or unpinned; the server decides whether it may. Retained run history is discovered
 * separately through the server's authorized ID list, including when a temporary definition
 * record was swept.
 */
export const WorkflowTriggersPanel = ({
  overseer,
  gadgets,
  refreshKey,
  pendingActionCount,
  onOpenActivity,
}: Props) => {
  const toasts = useKumoToastManager()
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [reloadTick, setReloadTick] = useState(0)
  const [toggling, setToggling] = useState<ReadonlySet<number>>(new Set())
  const [workflowView, setWorkflowView] = useState<'scheduled' | 'shared' | 'saved' | 'recent'>('saved')
  const [recentRuns, setRecentRuns] = useState<WorkflowDefinitionDelivery[] | null>(null)
  const [recentRunsError, setRecentRunsError] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const [hooks, definitions, controlList, collaborators, schedules] = await Promise.all([
        overseer.listHooks(), overseer.listWorkflowDefinitions(), overseer.listTriggerControls(),
        overseer.listCollaborators().catch(() => [] as CollaboratorInfo[]),
        overseer.listReadableWorkflowSchedules(),
      ])
      const refs = await Promise.all(hooks.map(h => overseer.getTriggerDefinition(h.id)))
      const pins = new Map<number, WorkflowDefinitionRef>()
      refs.forEach((ref, i) => { if (ref) pins.set(hooks[i]!.id, ref) })
      const controls = new Map(controlList.map(control => [control.hookId, control]))
      const pinned = hooks.filter(h => pins.has(h.id))
      const [assignmentList, connectionList] = await Promise.all([
        Promise.all(pinned.map(h => overseer.getTriggerAssignment(h.id))),
        Promise.all(pinned.map(h => connectionsOf(overseer, h.gadgetId))),
      ])
      const assignments = new Map<number, TriggerAssignment>()
      assignmentList.forEach((state, i) => { if (state.assignment) assignments.set(pinned[i]!.id, state.assignment) })
      // One instance-wide switch; every read reports the same.
      const assignmentsEnabled = assignmentList.some(state => state.enabled)
      const connections = new Map(pinned.map((h, i) => [h.id, connectionList[i]!]))
      return { hooks, definitions, schedules, pins, controls, collaborators, assignments, assignmentsEnabled, connections }
    }
    load()
      .then(ready => {
        if (!cancelled) setLoaded({ status: 'ready', ...ready })
      })
      .catch(err => {
        reportIssue('workflow-triggers.load', err)
        if (!cancelled) setLoaded({ status: 'error' })
      })
    return () => { cancelled = true }
  }, [overseer, refreshKey, reloadTick])

  useEffect(() => {
    if (workflowView !== 'recent' || loaded.status !== 'ready') return
    let cancelled = false
    setRecentRuns(null)
    setRecentRunsError(false)
    const loadRecentRuns = async () => {
      const histories = await overseer.listReadableWorkflowHistories()
      const deliveries: WorkflowDefinitionDelivery[] = []
      // Keep RPC fan-out bounded while preserving the definition store's authorized ID list.
      for (let index = 0; index < histories.length; index += 4) {
        if (cancelled) break
        const batch = histories.slice(index, index + 4)
        const results = await Promise.all(batch.map((history: WorkflowDefinitionHistoryRef) =>
          overseer.listWorkflowDeliveries(history.definitionId)))
        deliveries.push(...results.flat())
      }
      return deliveries.toSorted((left, right) => right.at.getTime() - left.at.getTime())
    }
    loadRecentRuns().then(runs => {
      if (!cancelled) setRecentRuns(runs)
    }).catch(() => {
      if (!cancelled) setRecentRunsError(true)
    })
    return () => { cancelled = true }
  }, [loaded.status, overseer, workflowView])

  const setHookEnabled = (id: number, enabled: boolean) => {
    setLoaded(prev => prev.status === 'ready'
      ? { ...prev, hooks: prev.hooks.map(h => (h.id === id ? { ...h, enabled } : h)) }
      : prev)
  }

  const handleToggle = async (id: number, enabled: boolean) => {
    setHookEnabled(id, enabled)
    setToggling(prev => new Set(prev).add(id))
    try {
      await (enabled ? overseer.enableHook(id) : overseer.disableHook(id))
    } catch {
      setHookEnabled(id, !enabled)
      toasts.add({ title: `Failed to ${enabled ? 'enable' : 'disable'} trigger`, variant: 'error' })
    } finally {
      setToggling(prev => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  // Pin a trigger to a definition revision, or clear its pin; the server checks it may see that
  // revision and that it is for the gadget the trigger wakes.
  const handlePin = async (hookId: number, ref: WorkflowDefinitionRef | null) => {
    try {
      await overseer.pinTriggerDefinition(hookId, ref)
      setReloadTick(t => t + 1)
    } catch (err) {
      toasts.add({
        title: err instanceof Error && err.message ? err.message : "Couldn't change what this trigger runs.",
        variant: 'error',
      })
    }
  }

  const gadgetTitle = (id: number) =>
    gadgets.length > 1 ? gadgets.find(g => g.id === id)?.title : undefined

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[720px] px-4 py-6">
        {pendingActionCount > 0 && (
          <div className="mb-6 flex items-center gap-3 rounded-xl bg-kumo-warning-tint px-3 py-2.5">
            <p className="m-0 min-w-0 flex-1 text-[13px] leading-[18px] text-kumo-default">
              {pendingActionCount === 1
                ? '1 action is waiting on you.'
                : `${pendingActionCount} actions are waiting on you.`}
            </p>
            <WorkshopButton onClick={onOpenActivity}>Review</WorkshopButton>
          </div>
        )}

        <section aria-labelledby="workflow-triggers-heading">
          <h2
            id="workflow-triggers-heading"
            className="m-0 text-[17px] leading-6 font-medium tracking-[-0.35px] text-kumo-default"
          >
            Triggers
          </h2>
          <p className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
            This workflow has no UI. It runs when one of these hooks fires: an event from a
            connected resource, or a scheduled task.
          </p>

          <div className="mt-3">
            {loaded.status === 'loading' && (
              <p className="text-[13px] text-kumo-subtle">Loading triggers…</p>
            )}
            {loaded.status === 'error' && (
              <div className="flex items-center gap-3">
                <p role="alert" className="m-0 text-[13px] text-kumo-danger">
                  Couldn&apos;t load triggers.
                </p>
                <WorkshopButton onClick={() => setReloadTick(t => t + 1)}>Try again</WorkshopButton>
              </div>
            )}
            {loaded.status === 'ready' && loaded.hooks.length === 0 && (
              <div className="rounded-xl border border-dashed border-kumo-line px-4 py-6 text-center">
                <p className="m-0 text-[13px] font-medium text-kumo-default">No triggers yet</p>
                <p className="mt-1 mb-0 text-[12px] leading-4 text-kumo-subtle">
                  Ask the agent in chat to run this on a schedule or when an event arrives.
                </p>
              </div>
            )}
            {loaded.status === 'ready' && loaded.hooks.length > 0 && (
              <ul className="m-0 list-none overflow-hidden rounded-xl border border-kumo-line bg-kumo-base p-0">
                {loaded.hooks.map((hook, index) => {
                  const wakes = gadgetTitle(hook.gadgetId)
                  const pin = loaded.pins.get(hook.id)
                  const pinned = pin && loaded.definitions.find(d => d.id === pin.definitionId)
                  const candidates = publishedFor(loaded.definitions, hook.gadgetId)
                    .filter(c => c.ref.definitionId !== pin?.definitionId || c.ref.revision !== pin?.revision)
                  return (
                    <li key={hook.id} className={`px-3 py-3 ${index > 0 ? 'border-t border-kumo-line' : ''}`}>
                    <div className="flex items-center gap-3">
                      <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-kumo-fill text-kumo-subtle">
                        <LightningIcon size={15} aria-hidden="true" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="m-0 truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                          {hook.description.title}
                        </p>
                        {hook.description.description && (
                          <p className="mt-0.5 mb-0 truncate text-[12px] leading-4 text-kumo-subtle">
                            {hook.description.description}
                          </p>
                        )}
                        {(hook.resourceTitle || wakes) && (
                          <p className="mt-0.5 mb-0 truncate text-[11px] leading-4 text-kumo-inactive">
                            {[hook.resourceTitle, wakes && `Wakes ${wakes}`].filter(Boolean).join(' · ')}
                          </p>
                        )}
                        {pin && (
                          <p className="mt-0.5 mb-0 truncate text-[11px] leading-4 text-kumo-subtle">
                            Runs {pinned ? `“${pinned.title}”` : 'a definition'}, revision {pin.revision}
                          </p>
                        )}
                      </div>
                      {candidates[0] && (
                        <WorkshopButton onClick={() => handlePin(hook.id, candidates[0]!.ref)}>
                          Run “{candidates[0].definition.title}” revision {candidates[0].ref.revision}
                        </WorkshopButton>
                      )}
                      {pin && (
                        <WorkshopButton onClick={() => handlePin(hook.id, null)}>Unpin</WorkshopButton>
                      )}
                      <HookToggle
                        enabled={hook.enabled}
                        disabled={toggling.has(hook.id)}
                        onToggle={enabled => handleToggle(hook.id, enabled)}
                      />
                    </div>
                    {pin && (
                      <TriggerControlEditor
                        // A saved or removed control remounts the editor with what the server kept.
                        key={`${hook.id}:${JSON.stringify(loaded.controls.get(hook.id) ?? null)}`}
                        overseer={overseer}
                        hookId={hook.id}
                        pin={pin}
                        control={loaded.controls.get(hook.id) ?? null}
                        collaborators={loaded.collaborators}
                        onChanged={() => setReloadTick(t => t + 1)}
                      />
                    )}
                    {pin && (
                      <TriggerAssignmentEditor
                        // An assigned, given or removed key remounts the editor with what the server kept.
                        key={`${hook.id}:${JSON.stringify(loaded.assignments.get(hook.id) ?? null)}`}
                        overseer={overseer}
                        hookId={hook.id}
                        enabled={loaded.assignmentsEnabled}
                        assignment={loaded.assignments.get(hook.id) ?? null}
                        connections={loaded.connections.get(hook.id) ?? null}
                        onChanged={() => setReloadTick(t => t + 1)}
                      />
                    )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </section>

        {loaded.status === 'ready' && <WorkflowHistorySection overseer={overseer} />}

        {loaded.status === 'ready' && (
          <section aria-label="Workflow views" className="mt-8">
            <div role="group" aria-label="Workflow views" className="flex flex-wrap gap-2 border-b border-kumo-line">
              {([
                ['scheduled', 'Scheduled'], ['shared', 'Shared with me'], ['saved', 'Saved'], ['recent', 'Recent'],
              ] as const).map(([view, label]) => (
                <button
                  key={view}
                  type="button"
                  aria-pressed={workflowView === view}
                  className={`border-b-2 px-2 py-2 text-[13px] ${workflowView === view
                    ? 'border-kumo-default font-medium text-kumo-default'
                    : 'border-transparent text-kumo-subtle'}`}
                  onClick={() => setWorkflowView(view)}
                >
                  {label}
                </button>
              ))}
            </div>
          </section>
        )}

        {loaded.status === 'ready' && workflowView === 'scheduled' && (
          <section id="workflow-schedules-panel" aria-labelledby="workflow-schedules-heading" className="mt-5">
            <h2
              id="workflow-schedules-heading"
              className="m-0 text-[17px] leading-6 font-medium tracking-[-0.35px] text-kumo-default"
            >
              Scheduled
            </h2>
            <p className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
              Schedules for workflows you can read. Only workspace schedule details are shown.
            </p>
            {loaded.schedules.length === 0 ? (
              <p className="mt-3 mb-0 text-[13px] text-kumo-subtle">No readable schedules.</p>
            ) : (
              <ul className="mt-3 mb-0 list-none overflow-hidden rounded-xl border border-kumo-line bg-kumo-base p-0">
                {loaded.schedules.map((schedule, index) => (
                  <li key={`${schedule.hookId}:${schedule.scheduleId}`}
                    className={`px-3 py-3 ${index > 0 ? 'border-t border-kumo-line' : ''}`}>
                    <p className="m-0 text-[13px] leading-[18px] font-medium text-kumo-default">
                      {schedule.title}
                    </p>
                    {schedule.description && (
                      <p className="mt-0.5 mb-0 text-[12px] leading-4 text-kumo-subtle">{schedule.description}</p>
                    )}
                    <p className="mt-1 mb-0 text-[12px] leading-4 text-kumo-subtle">
                      {formatScheduleCadence(schedule)} · {schedule.status[0]?.toUpperCase()}{schedule.status.slice(1)}
                      {schedule.nextFire !== undefined && schedule.status === 'active' && (
                        <>
                          {' '}· Next run{' '}
                          <time dateTime={new Date(schedule.nextFire).toISOString()}>
                            {new Date(schedule.nextFire).toLocaleString([], schedule.cadence.kind === 'interval'
                              ? undefined
                              : { timeZone: schedule.cadence.timeZone })}
                          </time>
                          {schedule.cadence.kind !== 'interval' && ` (${schedule.cadence.timeZone})`}
                        </>
                      )}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {loaded.status === 'ready' && workflowView !== 'scheduled' && (
          <WorkflowDefinitionsSection
            overseer={overseer}
            gadgets={gadgets}
            definitions={loaded.definitions}
            collaborators={loaded.collaborators}
            view={workflowView}
            recentRuns={workflowView === 'recent' ? recentRuns : undefined}
            recentRunsError={workflowView === 'recent' && recentRunsError}
            onChanged={() => setReloadTick(t => t + 1)}
          />
        )}
      </div>
    </div>
  )
}

const formatScheduleCadence = (schedule: WorkflowScheduleSummary) => {
  const { cadence } = schedule
  if (cadence.kind === 'interval') {
    const units = [
      [86_400_000, 'day'], [3_600_000, 'hour'], [60_000, 'minute'], [1_000, 'second'],
    ] as const
    const unit = units.find(([size]) => cadence.everyMs >= size && cadence.everyMs % size === 0)
    if (unit) {
      const amount = cadence.everyMs / unit[0]
      return `Every ${amount} ${unit[1]}${amount === 1 ? '' : 's'}`
    }
    return `Every ${cadence.everyMs} milliseconds`
  }
  if (cadence.kind === 'once') {
    return `Once · ${new Date(cadence.fireAt).toLocaleString([], { timeZone: cadence.timeZone })} (${cadence.timeZone})`
  }
  const { rule } = cadence
  if (rule.freq === 'hourly') return `Every ${rule.interval} hour${rule.interval === 1 ? '' : 's'} at minute ${rule.minute} (${cadence.timeZone})`
  const time = `${String(rule.hour).padStart(2, '0')}:${String(rule.minute).padStart(2, '0')}`
  if (rule.freq === 'daily') {
    return `Every ${rule.interval} day${rule.interval === 1 ? '' : 's'} at ${time} (${cadence.timeZone})`
  }
  const weekdays: Record<string, string> = { SU: 'Sun', MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat' }
  const days = rule.byDay.map(day => weekdays[day] ?? day).join(', ')
  return `Every ${rule.interval} week${rule.interval === 1 ? '' : 's'} on ${days} at ${time} (${cadence.timeZone})`
}
