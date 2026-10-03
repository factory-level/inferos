import { useEffect, useState } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { LightningIcon } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { BoundHookInfo, GadgetSummary, Overseer } from '@gadgets/workshop-shared/api'
import { HookToggle } from '../../components/HookToggle'
import { WorkshopButton } from '../../components/WorkshopControls'
import { reportIssue } from '../../errorReporting'

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
  | { status: 'ready'; hooks: BoundHookInfo[] }

/**
 * A workflow's output pane: what wakes it, in place of an app preview. Lists the workspace's bound
 * hooks, which is where both event hooks and scheduled tasks land (the scheduler binds each
 * schedule as a hook), with the same enable toggle as Connections. Next-run times and run history
 * are not exposed to the Workshop, so they are not shown.
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
    overseer.listHooks()
      .then(hooks => { if (!cancelled) setLoaded({ status: 'ready', hooks }) })
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
                  return (
                    <li
                      key={hook.id}
                      className={`flex items-center gap-3 px-3 py-3 ${index > 0 ? 'border-t border-kumo-line' : ''}`}
                    >
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
                      </div>
                      <HookToggle
                        enabled={hook.enabled}
                        disabled={toggling.has(hook.id)}
                        onToggle={enabled => handleToggle(hook.id, enabled)}
                      />
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
