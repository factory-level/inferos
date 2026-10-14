import { Button, Checkbox } from '@cloudflare/kumo'
import type { CanvasDefinition } from '@gadgets/workshop-shared/canvas'
import type { OperateFlow } from '@gadgets/workshop-shared/operate-flow'
import { orderConsoleFlows, unshownSteps } from './consoles'

/**
 * Which of the workspace's flows a console offers its employees, as a builder chooses them. A flow
 * can run only over screens the console shows, which the kernel checks again at save and publish;
 * a flow the console listed that the workspace has since deleted must be removed, since a save
 * naming it is refused. Publishing freezes each chosen flow, so a later edit reaches employees
 * only when the console is published again.
 */
export const ConsoleFlowRegistry = ({ flows, selected, published, shownScreens, screens, disabled, onChange }: {
  /** The workspace's flows, in its order. */
  flows: readonly OperateFlow[]
  /** The ids the console lists. */
  selected: readonly string[]
  /** The flows the console's current publication froze, or undefined if it was never published. */
  published: readonly OperateFlow[] | undefined
  /** The screens the console's views show. */
  shownScreens: readonly string[]
  /** The workspace's screens, for naming a flow's steps. */
  screens: readonly CanvasDefinition[]
  disabled: boolean
  onChange: (selected: string[]) => void
}) => {
  const deleted = selected.filter(id => !flows.some(flow => flow.id === id))
  const toggle = (id: string, checked: boolean) =>
    onChange(orderConsoleFlows(checked ? [...selected, id] : selected.filter(item => item !== id), flows))
  const titleOf = (id: string) => screens.find(screen => screen.id === id)?.title ?? 'a removed screen'
  const publishedNote = (flow: OperateFlow) => {
    if (!published) return null
    const frozen = published.find(item => item.id === flow.id)
    if (!frozen) return 'Not published yet. Publish again to give employees this flow.'
    return frozen.revision === flow.revision ? null : 'Edited since published. Publish again to give employees this version.'
  }

  return <section aria-labelledby="console-flows-heading" className="space-y-4">
    <div><h2 id="console-flows-heading" className="text-sm font-medium text-kumo-default">Flows</h2>
      <p className="mt-1 text-sm text-kumo-subtle">Employees can start these from the console. A flow can use only screens this console shows.</p></div>
    {flows.length === 0 && deleted.length === 0
      ? <p className="text-sm text-kumo-subtle">This workspace has no flows yet. Create one in Screens and flows, then come back to add it.</p>
      : <ul aria-label="Console flows" className="divide-y divide-kumo-line rounded-xl border border-kumo-line">
        {flows.map(flow => {
          const checked = selected.includes(flow.id)
          const unshown = [...new Set(unshownSteps(flow, shownScreens))]
          const note = checked ? publishedNote(flow) : null
          return <li key={flow.id} className="space-y-1 px-4 py-3">
            <Checkbox label={`${flow.title} · ${flow.steps.length} ${flow.steps.length === 1 ? 'step' : 'steps'}`}
              checked={checked} disabled={disabled} onCheckedChange={value => toggle(flow.id, value === true)} />
            {unshown.length > 0 && <p className="text-xs text-kumo-subtle">
              Uses {unshown.map(titleOf).join(', ')}, which this console doesn't show. Add it to a view, or leave this flow out.
            </p>}
            {note && <p className="text-xs text-kumo-subtle">{note}</p>}
          </li>
        })}
        {deleted.map(id => <li key={id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <p className="text-sm text-kumo-default">A flow this console listed was deleted</p>
          <Button size="sm" variant="ghost" disabled={disabled} aria-label={`Remove deleted flow ${id}`}
            onClick={() => onChange(selected.filter(item => item !== id))}>Remove</Button>
        </li>)}
      </ul>}
  </section>
}
