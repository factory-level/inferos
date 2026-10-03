import { useState } from 'react'
import { ArrowDownIcon, ArrowUpIcon, XIcon } from '@phosphor-icons/react'
import type { CanvasDefinition } from '@gadgets/workshop-shared/canvas'
import type { OperateFlowContent } from '@gadgets/workshop-shared/operate-flow'
import { MAX_OPERATE_FLOW_STEPS, MAX_OPERATE_FLOW_TITLE_LENGTH } from '@gadgets/workshop-shared/operate-session'
import { WorkshopButton, WorkshopIconButton, WorkshopInput } from '../../components/WorkshopControls'

/**
 * Authors one flow: its title and the workspace's screens in the order people are taken through
 * them. Order is explicit (move up, move down) and a screen may appear more than once. It only
 * edits a draft; saving is the caller's.
 */
export const FlowEditor = ({ screens, initial, saving, error, onSave, onCancel }: {
  /** The workspace's screens, which are the only possible steps. */
  screens: readonly CanvasDefinition[]
  initial: OperateFlowContent
  saving: boolean
  error: string | null
  onSave: (content: OperateFlowContent) => void
  onCancel: () => void
}) => {
  const [title, setTitle] = useState(initial.title)
  const [steps, setSteps] = useState<string[]>(initial.steps)
  const titleOf = (id: string) => screens.find(screen => screen.id === id)?.title ?? 'Removed screen'
  const move = (index: number, by: -1 | 1) => setSteps(current => {
    const next = [...current]
    const [step] = next.splice(index, 1)
    next.splice(index + by, 0, step!)
    return next
  })
  const full = steps.length >= MAX_OPERATE_FLOW_STEPS

  return (
    <form aria-label="Flow" className="space-y-3 rounded-xl bg-kumo-elevated p-4"
      onSubmit={event => { event.preventDefault(); onSave({ title: title.trim(), steps }) }}>
      <WorkshopInput label="Flow title" required maxLength={MAX_OPERATE_FLOW_TITLE_LENGTH} value={title}
        disabled={saving} onChange={event => setTitle(event.target.value)} />
      <div className="space-y-1">
        <p className="m-0 text-[12px] leading-4 font-medium text-kumo-subtle">Steps, in order</p>
        {steps.length === 0 && <p className="m-0 text-[12px] leading-4 text-kumo-inactive">Add the first screen below.</p>}
        <ol aria-label="Steps" className="m-0 list-none space-y-1 p-0">
          {steps.map((step, index) => (
            <li key={`${index}/${step}`} className="flex items-center gap-2 rounded-lg bg-kumo-control px-2.5 py-1.5">
              <span className="w-5 text-[12px] tabular-nums text-kumo-inactive">{index + 1}</span>
              <span className="min-w-0 flex-1 truncate text-[13px] text-kumo-default">{titleOf(step)}</span>
              <WorkshopIconButton aria-label={`Move step ${index + 1} up`} disabled={saving || index === 0} onClick={() => move(index, -1)}>
                <ArrowUpIcon size={12} aria-hidden />
              </WorkshopIconButton>
              <WorkshopIconButton aria-label={`Move step ${index + 1} down`} disabled={saving || index === steps.length - 1} onClick={() => move(index, 1)}>
                <ArrowDownIcon size={12} aria-hidden />
              </WorkshopIconButton>
              <WorkshopIconButton danger aria-label={`Remove step ${index + 1}`} disabled={saving}
                onClick={() => setSteps(current => current.filter((_, at) => at !== index))}>
                <XIcon size={12} aria-hidden />
              </WorkshopIconButton>
            </li>
          ))}
        </ol>
      </div>
      <div role="group" aria-label="Add a step" className="flex flex-wrap gap-1.5">
        {screens.map(screen => (
          <WorkshopButton key={screen.id} type="button" disabled={saving || full}
            onClick={() => setSteps(current => [...current, screen.id])}>
            + {screen.title}
          </WorkshopButton>
        ))}
      </div>
      {full && <p className="m-0 text-[12px] leading-4 text-kumo-subtle">A flow holds at most {MAX_OPERATE_FLOW_STEPS} steps.</p>}
      {error && <p role="alert" className="m-0 text-[13px] leading-[18px] text-kumo-danger">{error}</p>}
      <div className="flex gap-2">
        <WorkshopButton tone="primary" type="submit" disabled={saving || steps.length === 0 || title.trim() === ''}>Save flow</WorkshopButton>
        <WorkshopButton type="button" disabled={saving} onClick={onCancel}>Cancel</WorkshopButton>
      </div>
    </form>
  )
}
