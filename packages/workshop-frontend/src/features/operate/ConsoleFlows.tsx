import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { PlayIcon } from '@phosphor-icons/react'
import type { OperateFlow } from '@gadgets/workshop-shared/operate-flow'
import { WorkshopButton } from '../../components/WorkshopControls'
import { useOperateSession } from './OperateSessionContext'

/**
 * The flows an open published console offers, as frozen when it was published: anyone who can open
 * the console, a use-role operator included, starts one in their own session. A start sends the
 * frozen title and steps exactly, which the kernel checks against that copy; on success the page
 * shows the running flow, and a refusal stays here and says so.
 */
export const ConsoleFlows = ({ workspaceId, flows }: { workspaceId: string; flows: readonly OperateFlow[] }) => {
  const operate = useOperateSession()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)

  const start = (flow: OperateFlow) => {
    setError(null)
    operate?.dispatch({ type: 'startFlow', workspaceId, flowId: flow.id, title: flow.title, steps: flow.steps })
      .then(() => void navigate({ to: '/inferops-canvas', search: {} }),
        caught => { console.error('Failed to start the flow:', caught); setError(`Could not start ${flow.title}.`) })
  }

  if (!operate || flows.length === 0) return null
  return (
    <section aria-label="Flows" className="space-y-2">
      {flows.map(flow => <div key={flow.id} className="flex flex-wrap items-center gap-2 rounded-xl bg-kumo-elevated px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="m-0 truncate text-[14px] leading-5 font-medium text-kumo-default">{flow.title}</p>
          <p className="m-0 text-[12px] leading-4 text-kumo-subtle">Flow · {flow.steps.length} {flow.steps.length === 1 ? 'step' : 'steps'}</p>
        </div>
        <WorkshopButton tone="primary" aria-label={`Start ${flow.title}`} onClick={() => start(flow)}>
          <PlayIcon size={12} aria-hidden className="mr-1" />Start
        </WorkshopButton>
      </div>)}
      {error && <p role="alert" className="m-0 px-1 text-[13px] leading-[18px] text-kumo-danger">{error}</p>}
    </section>
  )
}
