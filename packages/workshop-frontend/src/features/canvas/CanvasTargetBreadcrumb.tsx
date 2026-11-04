import type { GadgetSummary, WorkpieceId } from '@gadgets/workshop-shared/api'
import { formatCanvasTarget, type CanvasTarget, type CanvasTargetStep } from '@gadgets/workshop-shared/canvas-model'
import { widgetLabel } from './canvasLayout'

const stepLabel = (step: CanvasTargetStep, gadgets: ReadonlyMap<WorkpieceId, GadgetSummary>) => {
  switch (step.kind) {
    case 'workspace': return 'Workspace'
    case 'page': return step.page.title
    case 'object': return step.node.title
    case 'widget': return widgetLabel(step.node, gadgets)
    case 'attachment': return `Attachment ${step.attachment.id}`
  }
}

/**
 * Where the selected target sits, from the workspace down, and its exact written target, so the
 * builder can always tell what the inspector's controls (and a request handed to the agent) edit.
 * Each step above the target selects that step.
 */
export const CanvasTargetBreadcrumb = ({ path, gadgets, onSelect }: {
  /** `canvasTargetPath` of the selected target. */
  path: CanvasTargetStep[]
  gadgets: ReadonlyMap<WorkpieceId, GadgetSummary>
  onSelect: (target: CanvasTarget) => void
}) => {
  const last = path.at(-1)!
  return <nav aria-label="Editing" className="space-y-1">
    <ol className="flex flex-wrap items-center gap-1 text-sm">
      {path.map((step, index) => <li key={formatCanvasTarget(step.target)} className="flex items-center gap-1">
        {index > 0 && <span aria-hidden="true" className="text-kumo-subtle">›</span>}
        {step === last || step.kind === 'workspace'
          ? <span aria-current={step === last ? 'location' : undefined} className={step === last ? 'font-medium text-kumo-default' : 'text-kumo-subtle'}>{stepLabel(step, gadgets)}</span>
          : <button type="button" className="rounded-md text-kumo-subtle underline focus-visible:ring-2 focus-visible:ring-kumo-ring"
            onClick={() => onSelect(step.target)}>{stepLabel(step, gadgets)}</button>}
      </li>)}
    </ol>
    <p className="text-xs text-kumo-subtle">Target <code className="break-all">{formatCanvasTarget(last.target)}</code></p>
  </nav>
}
