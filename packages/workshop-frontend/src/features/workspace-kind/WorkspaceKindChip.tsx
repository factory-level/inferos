import type { WorkspaceKind } from '@gadgets/workshop-shared/api'
import { kindOf, WORKSPACE_KIND_PRESENTATION } from './workspaceKinds'

/** A small, read-only label naming a workspace's kind. An absent kind reads as App. */
export const WorkspaceKindChip = ({ kind }: { kind: WorkspaceKind | undefined }) => {
  const { label, icon: KindIcon } = WORKSPACE_KIND_PRESENTATION[kindOf({ kind })]
  return (
    <span className="inline-flex flex-shrink-0 items-center gap-1 rounded-md bg-kumo-fill px-1.5 py-0.5 text-[11px] font-medium leading-4 text-kumo-subtle">
      <KindIcon size={12} aria-hidden="true" />
      {label}
    </span>
  )
}
