import { WORKSPACE_KINDS, type WorkspaceKind } from '@gadgets/workshop-shared/api'
import { WORKSPACE_KIND_PRESENTATION } from './workspaceKinds'

type Props = {
  kind: WorkspaceKind
  onKindChange: (kind: WorkspaceKind) => void
}

/**
 * Chooses what a new workspace builds, before its first message. The kind is fixed by this choice,
 * not inferred from the request, so the workspace builds an app, a widget or a workflow on purpose.
 */
export const WorkspaceKindPicker = ({ kind, onKindChange }: Props) => (
  <div role="radiogroup" aria-label="What this workspace builds" className="grid gap-2 sm:grid-cols-3">
    {WORKSPACE_KINDS.map(option => {
      const { label, icon: Icon, description } = WORKSPACE_KIND_PRESENTATION[option]
      const selected = option === kind
      return (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={selected}
          onClick={() => onKindChange(option)}
          className={`flex cursor-pointer flex-col gap-1 rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring ${selected ? 'border-kumo-brand bg-kumo-control' : 'border-kumo-line bg-kumo-elevated hover:bg-kumo-control'}`}
        >
          <span className={`flex items-center gap-1.5 text-[13px] font-medium ${selected ? 'text-kumo-brand' : 'text-kumo-default'}`}>
            <Icon size={15} aria-hidden="true" />
            {label}
          </span>
          <span className="text-[12px] leading-4 text-kumo-subtle">{description}</span>
        </button>
      )
    })}
  </div>
)
