import { useState } from 'react'
import { PlayIcon } from '@phosphor-icons/react'
import type { CanvasDefinition } from '@gadgets/workshop-shared/canvas'
import type { OperateFlow, OperateFlowContent } from '@gadgets/workshop-shared/operate-flow'
import { useAuthenticatedApi } from '../../AuthContext'
import { WorkshopButton } from '../../components/WorkshopControls'
import { invalidateWorkspaceScreens } from '../../pages/inferops-canvas/useWorkspaceScreens'
import { FlowEditor } from './FlowEditor'
import { useOperateSession } from './OperateSessionContext'

const SAVE_FAILED = 'Could not save the flow. It may have changed elsewhere; reload and try again.'

/**
 * A workspace's flows on the Operate home: start one in your session, or author them. A flow is
 * started with the steps it has now, and a run keeps those steps even if the flow is edited later.
 */
export const WorkspaceFlows = ({ workspaceId, screens, flows }: {
  workspaceId: string
  screens: readonly CanvasDefinition[]
  flows: readonly OperateFlow[]
}) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const operate = useOperateSession()
  // 'new', a flow id being edited, or null.
  const [editing, setEditing] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const change = async (apply: (overseer: ReturnType<typeof authenticatedApi.openGadget>) => PromiseLike<unknown>) => {
    setSaving(true); setError(null)
    const overseer = authenticatedApi.openGadget(workspaceId)
    try {
      await apply(overseer)
      invalidateWorkspaceScreens()
      setEditing(null)
    } catch (caught) {
      console.error('Flow change failed:', caught)
      setError(SAVE_FAILED)
    } finally {
      overseer[Symbol.dispose]()
      setSaving(false)
    }
  }
  const start = (flow: OperateFlow) => {
    operate?.dispatch({ type: 'startFlow', workspaceId, flowId: flow.id, title: flow.title, steps: flow.steps })
      .catch(caught => { console.error('Failed to start the flow:', caught); setError('Could not start the flow.') })
  }
  const cancel = () => { setEditing(null); setError(null) }

  if (screens.length === 0) return null
  return (
    <div className="space-y-2">
      {flows.map(flow => editing === flow.id
        ? <FlowEditor key={flow.id} screens={screens} initial={flow} saving={saving} error={error} onCancel={cancel}
            onSave={(content: OperateFlowContent) => void change(overseer => overseer.replaceFlow(flow.id, flow.revision, content))} />
        : <div key={flow.id} className="flex flex-wrap items-center gap-2 rounded-xl bg-kumo-elevated px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="m-0 truncate text-[14px] leading-5 font-medium text-kumo-default">{flow.title}</p>
              <p className="m-0 text-[12px] leading-4 text-kumo-subtle">Flow · {flow.steps.length} {flow.steps.length === 1 ? 'step' : 'steps'}</p>
            </div>
            {operate && <WorkshopButton tone="primary" aria-label={`Start ${flow.title}`} onClick={() => start(flow)}>
              <PlayIcon size={12} aria-hidden className="mr-1" />Start
            </WorkshopButton>}
            <WorkshopButton aria-label={`Edit ${flow.title}`} disabled={saving} onClick={() => { setEditing(flow.id); setError(null) }}>Edit</WorkshopButton>
            <WorkshopButton aria-label={`Delete ${flow.title}`} disabled={saving}
              onClick={() => void change(overseer => overseer.deleteFlow(flow.id, flow.revision))}>Delete</WorkshopButton>
          </div>)}
      {editing === 'new'
        ? <FlowEditor screens={screens} initial={{ title: '', steps: [] }} saving={saving} error={error} onCancel={cancel}
            onSave={content => void change(overseer => overseer.createFlow(content))} />
        : <WorkshopButton onClick={() => { setEditing('new'); setError(null) }}>New flow</WorkshopButton>}
      {error && editing === null && <p role="alert" className="m-0 px-1 text-[13px] leading-[18px] text-kumo-danger">{error}</p>}
    </div>
  )
}
