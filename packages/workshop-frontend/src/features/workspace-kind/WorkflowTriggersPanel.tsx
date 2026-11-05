import { useEffect, useState } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { LightningIcon } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { BoundHookInfo, CollaboratorInfo, GadgetSummary, Overseer } from '@gadgets/workshop-shared/api'
import type { TriggerControl, WorkflowDefinition, WorkflowDefinitionRef } from '@gadgets/workshop-shared/workflow-definition'
import { HookToggle } from '../../components/HookToggle'
import { WorkshopButton } from '../../components/WorkshopControls'
import { reportIssue } from '../../errorReporting'
import { TriggerControlEditor } from './TriggerControlEditor'
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
      // Each hook's pinned definition revision, by hook id; absent when unpinned.
      pins: ReadonlyMap<number, WorkflowDefinitionRef>
      // Each pinned hook's run-on-request control, by hook id; absent when it has none.
      controls: ReadonlyMap<number, TriggerControl>
      // Who a control can list: the workspace's collaborators.
      collaborators: CollaboratorInfo[]
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

/**
 * A workflow's output pane: what wakes it, in place of an app preview. Lists the workspace's bound
 * hooks, which is where both event hooks and scheduled tasks land (the scheduler binds each
 * schedule as a hook), with the same enable toggle as Connections, and the workflow's saved
 * definitions (WorkflowDefinitionsSection). A trigger pinned to a definition revision says so, and
 * can be pinned to a published revision for its gadget or unpinned; the server decides whether it
 * may. Next-run times and run history are not exposed to the Workshop, so they are not shown.
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

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const [hooks, definitions, controlList, collaborators] = await Promise.all([
        overseer.listHooks(), overseer.listWorkflowDefinitions(), overseer.listTriggerControls(),
        overseer.listCollaborators().catch(() => [] as CollaboratorInfo[]),
      ])
      const refs = await Promise.all(hooks.map(h => overseer.getTriggerDefinition(h.id)))
      const pins = new Map<number, WorkflowDefinitionRef>()
      refs.forEach((ref, i) => { if (ref) pins.set(hooks[i]!.id, ref) })
      const controls = new Map(controlList.map(control => [control.hookId, control]))
      return { hooks, definitions, pins, controls, collaborators }
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
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </section>

        {loaded.status === 'ready' && (
          <WorkflowDefinitionsSection
            overseer={overseer}
            gadgets={gadgets}
            definitions={loaded.definitions}
            onChanged={() => setReloadTick(t => t + 1)}
          />
        )}
      </div>
    </div>
  )
}
