import { Button, Checkbox, Input, Select } from '@cloudflare/kumo'
import { ArrowDownIcon, ArrowUpIcon, XIcon } from '@phosphor-icons/react'
import type { CanvasDefinition } from '@gadgets/workshop-shared/canvas'
import { MAX_CONSOLE_VIEWS, MAX_ROLLUP_SCREENS, type ConsoleView } from '@gadgets/workshop-shared/operate-console'

/** The console's navigation, with references to existing screens rather than copied definitions. */
export const ConsoleViewEditor = ({ views, screens, onChange }: {
  views: ConsoleView[]
  screens: readonly CanvasDefinition[]
  onChange: (views: ConsoleView[]) => void
}) => {
  const update = (view: ConsoleView) => onChange(views.map(item => item.id === view.id ? view : item))
  const move = (index: number, offset: number) => {
    const next = [...views]
    const [view] = next.splice(index, 1)
    next.splice(index + offset, 0, view)
    onChange(next)
  }
  return <div className="space-y-4">
    {views.length === 0 && <p className="text-sm text-kumo-subtle">Add a screen or an Overview to start your console’s navigation.</p>}
    <ol className="space-y-3">
      {views.map((view, index) => <li key={view.id} className="space-y-3 rounded-xl border border-kumo-line bg-kumo-base p-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1"><Input label={`View ${index + 1} name`} value={view.title} required maxLength={120}
            onChange={event => update({ ...view, title: event.target.value })} /></div>
          <Button size="sm" aria-label={`Move ${view.title} up`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUpIcon aria-hidden /></Button>
          <Button size="sm" aria-label={`Move ${view.title} down`} disabled={index === views.length - 1} onClick={() => move(index, 1)}><ArrowDownIcon aria-hidden /></Button>
          <Button size="sm" aria-label={`Remove ${view.title}`} onClick={() => onChange(views.filter(item => item.id !== view.id))}><XIcon aria-hidden /></Button>
        </div>
        {view.type === 'screen'
          ? <Select label={`Screen for ${view.title}`} value={view.screen}
              renderValue={value => screens.find(screen => screen.id === value)?.title ?? 'Unavailable screen'}
              onValueChange={value => update({ ...view, screen: String(value) })}>
              {screens.map(screen => <Select.Option key={screen.id} value={screen.id}>{screen.title}</Select.Option>)}
            </Select>
          : <fieldset className="space-y-2">
              <legend className="mb-2 text-sm text-kumo-subtle">Screens in this Overview</legend>
              {screens.map(screen => <Checkbox key={screen.id} label={screen.title} checked={view.screens.includes(screen.id)}
                disabled={!view.screens.includes(screen.id) && view.screens.length >= MAX_ROLLUP_SCREENS}
                onCheckedChange={checked => update({ ...view, screens: checked ? [...view.screens, screen.id] : view.screens.filter(id => id !== screen.id) })} />)}
              {view.screens.some(id => !screens.some(screen => screen.id === id)) && <p role="alert" className="text-sm text-kumo-danger">An included screen is unavailable. Remove it before saving.</p>}
              {view.screens.filter(id => !screens.some(screen => screen.id === id)).map(id => <Button key={id} size="sm"
                onClick={() => update({ ...view, screens: view.screens.filter(candidate => candidate !== id) })}>Remove unavailable screen</Button>)}
            </fieldset>}
      </li>)}
    </ol>
    <div className="flex flex-wrap gap-2">
      <Select label="Add an existing screen" value="" placeholder="Choose a screen"
        disabled={screens.length === 0 || views.length >= MAX_CONSOLE_VIEWS}
        onValueChange={value => {
          const screen = screens.find(item => item.id === value)
          if (screen) onChange([...views, { id: crypto.randomUUID(), title: screen.title, type: 'screen', screen: screen.id }])
        }}>
        {screens.map(screen => <Select.Option key={screen.id} value={screen.id}>{screen.title}</Select.Option>)}
      </Select>
      <Button disabled={screens.length === 0 || views.length >= MAX_CONSOLE_VIEWS} onClick={() => onChange([...views, {
        id: crypto.randomUUID(), title: 'Overview', type: 'rollup', screens: screens.slice(0, MAX_ROLLUP_SCREENS).map(screen => screen.id),
      }])}>Add Overview</Button>
    </div>
  </div>
}
