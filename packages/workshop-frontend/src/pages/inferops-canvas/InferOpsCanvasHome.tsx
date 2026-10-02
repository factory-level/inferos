import { useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { Button, Input, Select } from '@cloudflare/kumo'
import { DEFAULT_CANVAS_CATALOG, type CanvasContent, type CanvasDefinition } from '@gadgets/workshop-shared/canvas'
import { useAuthenticatedApi } from '../../AuthContext'
import { useServerConfig } from '../../ServerConfigContext'
import { useDialogSelectPortalContainer } from '../../useDialogSelectPortalContainer'
import { useDocumentTitle } from '../../useDocumentTitle'
import { MAX_SCREEN_WORKSPACES, useWorkspaceScreens, type WorkspaceScreens } from './useWorkspaceScreens'

const BLANK_TEMPLATE = ''

const widgetCount = (screen: CanvasDefinition) => screen.sections.reduce((sum, section) => sum + section.widgets.length, 0)

const ScreenLink = ({ workspaceId, screen }: { workspaceId: string; screen: CanvasDefinition }) =>
  <Link to="/workspace/$id/inferops-canvas" params={{ id: workspaceId }} search={{ view: screen.id }}
    className="flex flex-col gap-1 rounded-lg border border-kumo-line p-3 hover:bg-kumo-tint">
    <span className="font-medium text-kumo-default">{screen.title}</span>
    <span className="text-xs text-kumo-subtle">
      {screen.sections.length} {screen.sections.length === 1 ? 'section' : 'sections'} · {widgetCount(screen)} {widgetCount(screen) === 1 ? 'widget' : 'widgets'}
    </span>
  </Link>

const WorkspaceRow = ({ entry }: { entry: WorkspaceScreens }) =>
  <section className="space-y-2" aria-label={entry.workspace.title}>
    <div className="flex items-baseline justify-between gap-2">
      <h2 className="truncate text-sm font-medium text-kumo-default">{entry.workspace.title}</h2>
      <Link to="/workspace/$id/inferops-canvas" params={{ id: entry.workspace.id }} search={{}}
        className="shrink-0 text-sm text-kumo-brand">Open InferOps Canvas</Link>
    </div>
    {entry.screens === null
      ? <p className="text-xs text-kumo-subtle">Open this workspace to see its screens.</p>
      : entry.screens.length === 0
        ? <p className="text-xs text-kumo-subtle">No screens yet.</p>
        : <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {entry.screens.map(screen => <ScreenLink key={screen.id} workspaceId={entry.workspace.id} screen={screen} />)}
        </div>}
  </section>

/** Every InferOps Canvas screen the user can build, across workspaces, and a way to start one. */
export const InferOpsCanvasHome = () => {
  useDocumentTitle('InferOps Canvas')
  const navigate = useNavigate()
  const { authenticatedApi } = useAuthenticatedApi()
  const canvasFeatures = useServerConfig()?.canvasFeatures
  const catalog = canvasFeatures?.catalog ?? DEFAULT_CANVAS_CATALOG
  const durableViews = canvasFeatures?.durableViews === true
  const screens = useWorkspaceScreens(authenticatedApi, durableViews)
  const selectPortalContainer = useDialogSelectPortalContainer()
  const [workspaceId, setWorkspaceId] = useState('')
  const [template, setTemplate] = useState(BLANK_TEMPLATE)
  const [creating, setCreating] = useState(false)
  const [createFailed, setCreateFailed] = useState(false)

  if (!canvasFeatures?.composableViews) return <div className="mx-auto max-w-4xl px-6 pt-10">
    <h1 className="text-2xl font-semibold tracking-tight text-kumo-default">InferOps Canvas</h1>
    <p className="mt-2 text-sm text-kumo-subtle">Composable views are not enabled for this deployment.</p>
  </div>

  const workspaces = screens.status === 'ready' ? screens.workspaces : []
  const create = async (title: string) => {
    const screen = catalog.screens.find(item => item.id === template)
    const content: CanvasContent = screen ? { ...structuredClone(screen.content), title }
      : { title, sections: [{ id: crypto.randomUUID(), title: 'Overview', columns: 2, widgets: [] }] }
    setCreating(true); setCreateFailed(false)
    const overseer = authenticatedApi.openGadget(workspaceId)
    try {
      const created = await overseer.createCanvas(content)
      navigate({ to: '/workspace/$id/inferops-canvas', params: { id: workspaceId }, search: { view: created.id } })
    } catch {
      setCreateFailed(true)
    } finally {
      overseer[Symbol.dispose]()
      setCreating(false)
    }
  }

  return <div className="mx-auto flex h-full w-full max-w-4xl flex-col gap-6 overflow-y-auto px-6 pb-10 pt-6 sm:pt-10">
    <header>
      <h1 className="text-2xl font-semibold tracking-tight text-kumo-default">InferOps Canvas</h1>
      <p className="mt-1 text-sm text-kumo-subtle">
        Screens that compose InferOps boards and gadgets beside a chat. Ask the agent to add widgets, or arrange them yourself.
      </p>
    </header>

    {durableViews && <form className="flex flex-wrap items-end gap-2 rounded-lg border border-kumo-line p-4" aria-label="New screen"
      onSubmit={event => {
        event.preventDefault()
        const title = String(new FormData(event.currentTarget).get('title') ?? '').trim()
        if (workspaceId) void create(title)
      }}>
      <Select container={selectPortalContainer} label="Workspace" value={workspaceId} disabled={creating || workspaces.length === 0}
        placeholder={workspaces.length === 0 ? 'No workspaces yet' : 'Choose a workspace'}
        renderValue={value => workspaces.find(entry => entry.workspace.id === value)?.workspace.title ?? 'Choose a workspace'}
        onValueChange={value => setWorkspaceId(String(value ?? ''))}>
        {workspaces.map(entry => <Select.Option key={entry.workspace.id} value={entry.workspace.id}>{entry.workspace.title}</Select.Option>)}
      </Select>
      <Input label="Screen title" name="title" required maxLength={120} defaultValue="Operations" disabled={creating} />
      {catalog.screens.length > 0 && <Select container={selectPortalContainer} label="Start from" value={template} disabled={creating}
        onValueChange={value => setTemplate(String(value ?? BLANK_TEMPLATE))}
        renderValue={value => catalog.screens.find(item => item.id === value)?.content.title ?? 'Blank screen'}>
        <Select.Option value={BLANK_TEMPLATE}>Blank screen</Select.Option>
        {catalog.screens.map(screen => <Select.Option key={screen.id} value={screen.id}>{screen.content.title}</Select.Option>)}
      </Select>}
      <Button type="submit" disabled={creating || !workspaceId}>Create screen</Button>
      {createFailed && <p role="alert" className="basis-full text-sm text-kumo-danger">Could not create the screen. Check your access to the workspace and try again.</p>}
    </form>}
    {!durableViews && <p className="text-sm text-kumo-subtle">Saved screens are not enabled for this deployment; open a workspace to compose a temporary one.</p>}

    {screens.status === 'loading' && <p role="status" className="text-sm text-kumo-subtle">Loading screens…</p>}
    {screens.status === 'error' && <p role="alert" className="text-sm text-kumo-danger">Could not load your workspaces. Check your connection and reload.</p>}
    {screens.status === 'ready' && workspaces.length === 0 && <p className="text-sm text-kumo-subtle">
      You have no workspaces yet. <Link to="/" className="text-kumo-brand">Create one</Link>, then come back to add screens.
    </p>}
    {workspaces.map(entry => <WorkspaceRow key={entry.workspace.id} entry={entry} />)}
    {workspaces.length === MAX_SCREEN_WORKSPACES && <p className="text-xs text-kumo-subtle">
      Showing your {MAX_SCREEN_WORKSPACES} most recently active workspaces. <Link to="/workspaces" className="text-kumo-brand">See all workspaces</Link>.
    </p>}
  </div>
}
