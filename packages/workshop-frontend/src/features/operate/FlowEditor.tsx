import { useState } from 'react'
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from '@phosphor-icons/react'
import { Checkbox, Select } from '@cloudflare/kumo'
import type { CanvasDefinition } from '@gadgets/workshop-shared/canvas'
import { MAX_OPERATE_FLOW_ROUTES, parseOperateFlowContent, type OperateFlowContent } from '@gadgets/workshop-shared/operate-flow'
import {
  MAX_OPERATE_FLOW_ROUTE_LABEL_LENGTH, MAX_OPERATE_FLOW_STEPS, MAX_OPERATE_FLOW_TITLE_LENGTH, type OperateFlowPage,
} from '@gadgets/workshop-shared/operate-session'
import { WorkshopButton, WorkshopIconButton, WorkshopInput } from '../../components/WorkshopControls'

// A route names its destination by the editor's own key for that page, not by its name, so renaming
// a page keeps the routes that lead to it. `to` is null once the page it led to is removed.
type RouteDraft = { key: string; label: string; to: string | null }
type PageDraft = { key: string; screen: string; name: string; states: string; routes: RouteDraft[] }

let lastKey = 0
const newKey = () => `draft-${++lastKey}`

const NAME_LENGTH = 40

// A default page name from its screen's title, in the form a page name takes (see
// OPERATE_FLOW_NAME), and not taken by another page or by any of the workspace's screen ids.
const defaultName = (title: string, taken: ReadonlySet<string>) => {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '')
  const base = (slug || 'page').slice(0, NAME_LENGTH - 3).replace(/-+$/, '')
  if (!taken.has(base)) return base
  for (let suffix = 2; ; suffix++) if (!taken.has(`${base}-${suffix}`)) return `${base}-${suffix}`
}

const statesOf = (text: string) => text.split(',').map(state => state.trim()).filter(state => state !== '')

const draftsOf = (initial: OperateFlowContent, screens: readonly CanvasDefinition[]): PageDraft[] => {
  const keys = initial.steps.map(() => newKey())
  const taken = new Set([...screens.map(screen => screen.id), ...(initial.pages ?? []).map(page => page.name)])
  return initial.steps.map((screen, index) => {
    const page = initial.pages?.[index]
    const keyOf = (name: string) => {
      const at = initial.pages?.findIndex(candidate => candidate.name === name) ?? -1
      return at >= 0 ? keys[at]! : null
    }
    const name = page?.name ?? defaultName(screens.find(item => item.id === screen)?.title ?? 'page', taken)
    taken.add(name)
    return {
      key: keys[index]!, screen, name, states: (page?.states ?? []).join(', '),
      routes: (page?.routes ?? []).map(route => ({ key: newKey(), label: route.label, to: keyOf(route.to) })),
    }
  })
}

/**
 * Authors one flow: its title and the workspace's screens in the order people are taken through
 * them. Order is explicit (move up, move down) and a screen may appear more than once. A flow may
 * also name its pages, so that it branches, retries and returns instead of running in order: each
 * page then has a name, optional page-local states and the routes that lead from it to other pages
 * of the same flow. Routes are page navigation only; a widget's own transitions are authored with
 * the widget, never here. It only edits a draft, checked as the kernel will check it before
 * `onSave`; saving is the caller's.
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
  const [pages, setPages] = useState<PageDraft[]>(() => draftsOf(initial, screens))
  const [branching, setBranching] = useState(initial.pages !== undefined)
  const [problem, setProblem] = useState<string | null>(null)
  const titleOf = (id: string) => screens.find(screen => screen.id === id)?.title ?? 'Removed screen'
  const full = pages.length >= MAX_OPERATE_FLOW_STEPS

  const edit = (apply: (current: PageDraft[]) => PageDraft[]) => { setProblem(null); setPages(apply) }
  const editPage = (key: string, change: (page: PageDraft) => PageDraft) =>
    edit(current => current.map(page => page.key === key ? change(page) : page))
  const move = (index: number, by: -1 | 1) => edit(current => {
    const next = [...current]
    const [page] = next.splice(index, 1)
    next.splice(index + by, 0, page!)
    return next
  })
  const add = (screen: CanvasDefinition) => edit(current => {
    const taken = new Set([...screens.map(item => item.id), ...current.map(page => page.name)])
    return [...current, { key: newKey(), screen: screen.id, name: defaultName(screen.title, taken), states: '', routes: [] }]
  })
  // A route to the removed page is kept, leading nowhere, so the author sees it and chooses again.
  const remove = (key: string) => edit(current => current.filter(page => page.key !== key)
    .map(page => ({ ...page, routes: page.routes.map(route => route.to === key ? { ...route, to: null } : route) })))
  const setBranchingOn = (on: boolean) => {
    setProblem(null)
    setBranching(on)
    // Starting from a list, each page leads on to the next, so the flow runs as it did until edited.
    if (on && pages.every(page => page.routes.length === 0)) {
      setPages(current => current.map((page, index) => index === current.length - 1 ? page
        : { ...page, routes: [{ key: newKey(), label: 'Next', to: current[index + 1]!.key }] }))
    }
  }

  const content = (): OperateFlowContent => {
    const steps = pages.map(page => page.screen)
    if (!branching) return { title: title.trim(), steps }
    const nameOf = (key: string | null) => pages.find(page => page.key === key)?.name.trim() ?? ''
    return {
      title: title.trim(), steps,
      pages: pages.map((page): OperateFlowPage => {
        const states = statesOf(page.states)
        return {
          name: page.name.trim(),
          ...(states.length > 0 ? { states } : {}),
          ...(page.routes.length > 0 ? { routes: page.routes.map(route => ({ label: route.label.trim(), to: nameOf(route.to) })) } : {}),
        }
      }),
    }
  }
  const submit = () => {
    const draft = content()
    try {
      parseOperateFlowContent(draft)
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : 'This flow cannot be saved as it is.')
      return
    }
    onSave(draft)
  }
  const shownError = problem ?? error

  return (
    <form aria-label="Flow" className="space-y-3 rounded-xl bg-kumo-elevated p-4"
      onSubmit={event => { event.preventDefault(); submit() }}>
      <WorkshopInput label="Flow title" required maxLength={MAX_OPERATE_FLOW_TITLE_LENGTH} value={title}
        disabled={saving} onChange={event => setTitle(event.target.value)} />
      <Checkbox label="Let pages branch, retry and return" checked={branching} disabled={saving}
        onCheckedChange={value => setBranchingOn(value === true)} />
      {branching && <p className="m-0 text-[12px] leading-4 text-kumo-subtle">
        Name each page and choose where it leads. People move by these routes and can go back the way they came. A page with no routes is where the flow can finish.
      </p>}
      <div className="space-y-1">
        <p className="m-0 text-[12px] leading-4 font-medium text-kumo-subtle">{branching ? 'Pages' : 'Steps, in order'}</p>
        {pages.length === 0 && <p className="m-0 text-[12px] leading-4 text-kumo-inactive">Add the first screen below.</p>}
        <ol aria-label="Steps" className="m-0 list-none space-y-1 p-0">
          {pages.map((page, index) => (
            <li key={page.key} aria-label={`Step ${index + 1}`} className="rounded-lg bg-kumo-control px-2.5 py-1.5">
              <div className="flex items-center gap-2">
                <span className="w-5 text-[12px] tabular-nums text-kumo-inactive">{index + 1}</span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-kumo-default">{titleOf(page.screen)}</span>
                <WorkshopIconButton aria-label={`Move step ${index + 1} up`} disabled={saving || index === 0} onClick={() => move(index, -1)}>
                  <ArrowUpIcon size={12} aria-hidden />
                </WorkshopIconButton>
                <WorkshopIconButton aria-label={`Move step ${index + 1} down`} disabled={saving || index === pages.length - 1} onClick={() => move(index, 1)}>
                  <ArrowDownIcon size={12} aria-hidden />
                </WorkshopIconButton>
                <WorkshopIconButton danger aria-label={`Remove step ${index + 1}`} disabled={saving} onClick={() => remove(page.key)}>
                  <XIcon size={12} aria-hidden />
                </WorkshopIconButton>
              </div>
              {branching && <PageFields page={page} index={index} pages={pages} titleOf={titleOf} disabled={saving}
                onChange={change => editPage(page.key, change)} />}
            </li>
          ))}
        </ol>
      </div>
      <div role="group" aria-label="Add a step" className="flex flex-wrap gap-1.5">
        {screens.map(screen => (
          <WorkshopButton key={screen.id} type="button" disabled={saving || full} onClick={() => add(screen)}>
            + {screen.title}
          </WorkshopButton>
        ))}
      </div>
      {full && <p className="m-0 text-[12px] leading-4 text-kumo-subtle">A flow holds at most {MAX_OPERATE_FLOW_STEPS} steps.</p>}
      {shownError && <p role="alert" className="m-0 text-[13px] leading-[18px] text-kumo-danger">{shownError}</p>}
      <div className="flex gap-2">
        <WorkshopButton tone="primary" type="submit" disabled={saving || pages.length === 0 || title.trim() === ''}>Save flow</WorkshopButton>
        <WorkshopButton type="button" disabled={saving} onClick={onCancel}>Cancel</WorkshopButton>
      </div>
    </form>
  )
}

// One page's name, states and routes. Kept in the editor's file: it has no state of its own and
// changes only with the flow's page model.
const PageFields = ({ page, index, pages, titleOf, disabled, onChange }: {
  page: PageDraft
  index: number
  pages: readonly PageDraft[]
  titleOf: (screen: string) => string
  disabled: boolean
  onChange: (change: (page: PageDraft) => PageDraft) => void
}) => {
  const position = index + 1
  const setRoute = (key: string, change: Partial<RouteDraft>) =>
    onChange(current => ({ ...current, routes: current.routes.map(route => route.key === key ? { ...route, ...change } : route) }))
  const destination = (key: string | null) => {
    const target = pages.find(candidate => candidate.key === key)
    return target ? `${target.name || 'Unnamed page'} · ${titleOf(target.screen)}` : 'Choose a page'
  }
  return (
    <div className="mt-2 space-y-2 pl-7">
      <div className="grid gap-2 sm:grid-cols-2">
        <WorkshopInput label="Page name" maxLength={NAME_LENGTH} value={page.name}
          disabled={disabled} onChange={event => { const name = event.target.value; onChange(current => ({ ...current, name })) }} />
        <WorkshopInput label="Page states (optional)" value={page.states}
          placeholder="e.g. editing, checked" disabled={disabled}
          onChange={event => { const states = event.target.value; onChange(current => ({ ...current, states })) }} />
      </div>
      <p className="m-0 text-[12px] leading-4 text-kumo-inactive">
        Names are lowercase, a letter first. Separate states with commas; the page starts in the first each time it is reached.
      </p>
      <ul aria-label={`Routes from page ${position}`} className="m-0 list-none space-y-1.5 p-0">
        {page.routes.length === 0 && <li className="text-[12px] leading-4 text-kumo-subtle">No routes: the flow can finish here.</li>}
        {page.routes.map((route, at) => (
          <li key={route.key} className="flex flex-wrap items-end gap-2">
            <WorkshopInput label="Route label" className="min-w-40 flex-1"
              maxLength={MAX_OPERATE_FLOW_ROUTE_LABEL_LENGTH} value={route.label} disabled={disabled}
              onChange={event => setRoute(route.key, { label: event.target.value })} />
            <Select label="Leads to" value={route.to ?? ''} disabled={disabled}
              placeholder="Choose a page" renderValue={value => destination(typeof value === 'string' ? value : null)}
              onValueChange={value => setRoute(route.key, { to: typeof value === 'string' && value !== '' ? value : null })}>
              {pages.map(target => <Select.Option key={target.key} value={target.key}>
                {target.key === page.key ? `${destination(target.key)} (again)` : destination(target.key)}
              </Select.Option>)}
            </Select>
            <WorkshopIconButton danger aria-label={`Remove route ${at + 1} from page ${position}`} disabled={disabled}
              onClick={() => onChange(current => ({ ...current, routes: current.routes.filter(item => item.key !== route.key) }))}>
              <XIcon size={12} aria-hidden />
            </WorkshopIconButton>
          </li>
        ))}
      </ul>
      <WorkshopButton type="button" aria-label={`Add a route from page ${position}`}
        disabled={disabled || page.routes.length >= MAX_OPERATE_FLOW_ROUTES}
        onClick={() => onChange(current => ({ ...current, routes: [...current.routes, { key: newKey(), label: '', to: null }] }))}>
        <PlusIcon size={12} aria-hidden className="mr-1" />Add a route
      </WorkshopButton>
      {page.routes.length >= MAX_OPERATE_FLOW_ROUTES && <p className="m-0 text-[12px] leading-4 text-kumo-subtle">A page offers at most {MAX_OPERATE_FLOW_ROUTES} routes.</p>}
    </div>
  )
}
