import type { GadgetMetadata, WorkspaceKind } from '@gadgets/workshop-shared/api'
import { useUiFeatureFlags } from '../../FeatureFlagsContext'
import { WorkspaceKindSwitch } from './WorkspaceKindSwitch'
import { hasAppViewToggle, kindOf } from './workspaceKinds'

type Props = {
  metadata: Pick<GadgetMetadata, 'kind' | 'role'>
  onSetKind: (kind: WorkspaceKind) => Promise<void>
  // Whether the app is shown on its own instead of the chat + output editor.
  appView: boolean
  onAppViewChange: (appView: boolean) => void
}

const SEGMENT =
  'flex h-6 cursor-pointer items-center rounded-md px-2 text-[12px] font-medium tracking-[-0.15px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring'

/**
 * The editor header's workspace-kind controls (behind the `operate-mode` flag): the kind switch,
 * and for an app the Chat ↔ App toggle. Only the build role may change the kind, so a "use" viewer
 * sees none of it.
 */
export const WorkspaceKindHeader = ({ metadata, onSetKind, appView, onAppViewChange }: Props) => {
  const operateMode = useUiFeatureFlags().flags['operate-mode']
  if (!operateMode || metadata.role === 'use') return null

  const kind = kindOf(metadata)
  return (
    <div className="flex flex-shrink-0 items-center gap-2">
      <WorkspaceKindSwitch kind={kind} onSetKind={onSetKind} />
      {hasAppViewToggle(kind) && (
        <div
          role="group"
          aria-label="Workspace view"
          className="flex items-center rounded-lg border border-kumo-line p-0.5"
        >
          <button
            type="button"
            aria-pressed={!appView}
            onClick={() => onAppViewChange(false)}
            className={`${SEGMENT} ${!appView ? 'bg-kumo-tint text-kumo-default' : 'text-kumo-subtle hover:text-kumo-default'}`}
          >
            Chat
          </button>
          <button
            type="button"
            aria-pressed={appView}
            onClick={() => onAppViewChange(true)}
            className={`${SEGMENT} ${appView ? 'bg-kumo-tint text-kumo-default' : 'text-kumo-subtle hover:text-kumo-default'}`}
          >
            App
          </button>
        </div>
      )}
    </div>
  )
}
