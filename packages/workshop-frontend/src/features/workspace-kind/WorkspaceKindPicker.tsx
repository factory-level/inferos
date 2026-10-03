import { Radio } from '@cloudflare/kumo'
import { WORKSPACE_KINDS, type WorkspaceKind } from '@gadgets/workshop-shared/api'
import { WORKSPACE_KIND_PRESENTATION } from './workspaceKinds'

type Props = {
  kind: WorkspaceKind
  onKindChange: (kind: WorkspaceKind) => void
}

/**
 * Chooses what a new workspace builds, before its first message. The kind is fixed by this choice,
 * not inferred from the request, so the workspace builds an app, a widget or a workflow on purpose.
 *
 * Kumo's radio group supplies the keyboard pattern: one tab stop on the chosen kind, and arrow keys
 * move to and select a neighbour.
 */
export const WorkspaceKindPicker = ({ kind, onKindChange }: Props) => (
  // Kumo stacks card radios; from `sm` the three kinds sit side by side as before.
  <Radio.Group
    value={kind}
    onValueChange={value => onKindChange(value as WorkspaceKind)}
    appearance="card"
    className="sm:[&>div]:grid sm:[&>div]:grid-cols-3"
  >
    <Radio.Legend className="sr-only">What this workspace builds</Radio.Legend>
    {WORKSPACE_KINDS.map(option => {
      const { label, icon: Icon, description } = WORKSPACE_KIND_PRESENTATION[option]
      return (
        <Radio.Item
          key={option}
          value={option}
          label={
            <span className="inline-flex items-center gap-1.5 text-[13px]">
              <Icon size={15} aria-hidden="true" />
              {label}
            </span>
          }
          description={<span className="text-[12px] leading-4">{description}</span>}
        />
      )
    })}
  </Radio.Group>
)
