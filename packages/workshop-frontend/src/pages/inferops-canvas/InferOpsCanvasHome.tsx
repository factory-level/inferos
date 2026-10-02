import { useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { Select } from '@cloudflare/kumo'
import { DEFAULT_CANVAS_CATALOG, type CanvasContent, type CanvasDefinition } from '@gadgets/workshop-shared/canvas'
import { useAuthenticatedApi } from '../../AuthContext'
import { WorkshopButton, WorkshopInput } from '../../components/WorkshopControls'
import { useServerConfig } from '../../ServerConfigContext'
import { useDialogSelectPortalContainer } from '../../useDialogSelectPortalContainer'
import { useDocumentTitle } from '../../useDocumentTitle'
import { MAX_SCREEN_WORKSPACES, invalidateWorkspaceScreens, useWorkspaceScreens, type WorkspaceScreens } from './useWorkspaceScreens'
import { useOperateSession } from '../../features/operate/OperateSessionContext'

// Kumo's Select treats an empty value as unselected and shows nothing; ':' never starts a template ID.
const BLANK_TEMPLATE = ':blank'

// Kumo's Select trigger in the shell's filled-control treatment, matching WorkshopInput.
const FILLED_SELECT = '!h-9 rounded-md border-0 bg-kumo-control text-[13px] text-kumo-default shadow-none ring-0'

const Eyebrow = ({ children, as: Tag = 'p' }: { children: string; as?: 'p' | 'h2' }) =>
  <Tag className="m-0 truncate text-[11px] leading-4 font-medium uppercase tracking-[0.06em] text-kumo-inactive">{children}</Tag>

const PageHeading = ({ subtitle }: { subtitle: string }) =>
  <header className="px-1">
    <h1 className="m-0 text-[18px] leading-[26px] font-semibold tracking-[-0.25px] text-kumo-default">InferOps Canvas</h1>
    <p className="mt-1 text-[13px] leading-[18px] text-kumo-subtle">{subtitle}</p>
  </header>

const widgetCount = (screen: CanvasDefinition) => screen.sections.reduce((sum, section) => sum + section.widgets.length, 0)

const ScreenLink = ({ workspaceId, screen }: { workspaceId: string; screen: CanvasDefinition }) =>
  <Link to="/workspace/$id/inferops-canvas" params={{ id: workspaceId }} search={{ view: screen.id }}
    className="flex flex-col gap-1 rounded-xl bg-kumo-elevated p-4 transition-colors hover:bg-kumo-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">
    <span className="truncate text-[14px] leading-5 font-medium text-kumo-default">{screen.title}</span>
    <span className="text-[12px] leading-4 text-kumo-subtle">
      {screen.sections.length} {screen.sections.length === 1 ? 'section' : 'sections'} · {widgetCount(screen)} {widgetCount(screen) === 1 ? 'widget' : 'widgets'}
    </span>
  </Link>

const WorkspaceRow = ({ entry }: { entry: WorkspaceScreens }) =>
  <section className="space-y-2" aria-label={entry.workspace.title}>
    <div className="flex items-baseline justify-between gap-2 px-1">
      <Eyebrow as="h2">{entry.workspace.title}</Eyebrow>
      <Link to="/workspace/$id/inferops-canvas" params={{ id: entry.workspace.id }} search={{}}
        className="shrink-0 text-[12px] leading-4 font-medium text-kumo-brand hover:underline">Open InferOps Canvas</Link>
    </div>
    {entry.screens === null
      ? <p className="px-1 text-[12px] leading-4 text-kumo-subtle">Open this workspace to see its screens.</p>
      : entry.screens.length === 0
        ? <p className="px-1 text-[12px] leading-4 text-kumo-subtle">No screens yet.</p>
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
  const operate = useOperateSession()
  const selectPortalContainer = useDialogSelectPortalContainer()
  const [workspaceId, setWorkspaceId] = useState('')
  const [template, setTemplate] = useState(BLANK_TEMPLATE)
  const [creating, setCreating] = useState(false)
  const [createFailed, setCreateFailed] = useState(false)

  if (!canvasFeatures?.composableViews) return <div className="mx-auto max-w-4xl px-6 pt-6 sm:pt-10">
    <PageHeading subtitle="Composable views are not enabled for this deployment." />
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
      invalidateWorkspaceScreens()
      // In Operate the new screen opens into the person's session; otherwise on its workspace page.
      if (operate) await operate.dispatch({ type: 'open', ref: { type: 'screen', workspaceId, screenId: created.id } })
      else navigate({ to: '/workspace/$id/inferops-canvas', params: { id: workspaceId }, search: { view: created.id } })
    } catch {
      setCreateFailed(true)
    } finally {
      overseer[Symbol.dispose]()
      setCreating(false)
    }
  }

  return <div className="mx-auto flex h-full w-full max-w-4xl flex-col gap-8 overflow-y-auto px-6 pb-10 pt-6 sm:pt-10">
    <PageHeading subtitle="Screens that compose InferOps boards and gadgets beside a chat. Ask the agent to add widgets, or arrange them yourself." />

    {durableViews && <form className="flex flex-wrap items-end gap-3 rounded-xl bg-kumo-elevated p-4" aria-label="New screen"
      onSubmit={event => {
        event.preventDefault()
        const title = String(new FormData(event.currentTarget).get('title') ?? '').trim()
        if (workspaceId) void create(title)
      }}>
      <div className="basis-full"><Eyebrow>New screen</Eyebrow></div>
      <Select container={selectPortalContainer} className={FILLED_SELECT} label="Workspace" value={workspaceId} disabled={creating || workspaces.length === 0}
        placeholder={workspaces.length === 0 ? 'No workspaces yet' : 'Choose a workspace'}
        renderValue={value => workspaces.find(entry => entry.workspace.id === value)?.workspace.title ?? 'Choose a workspace'}
        onValueChange={value => setWorkspaceId(String(value ?? ''))}>
        {workspaces.map(entry => <Select.Option key={entry.workspace.id} value={entry.workspace.id}>{entry.workspace.title}</Select.Option>)}
      </Select>
      <WorkshopInput label="Screen title" name="title" required maxLength={120} defaultValue="Operations" disabled={creating} />
      {catalog.screens.length > 0 && <Select container={selectPortalContainer} className={FILLED_SELECT} label="Start from" value={template} disabled={creating}
        onValueChange={value => setTemplate(String(value ?? BLANK_TEMPLATE))}
        renderValue={value => catalog.screens.find(item => item.id === value)?.content.title ?? 'Blank screen'}>
        <Select.Option value={BLANK_TEMPLATE}>Blank screen</Select.Option>
        {catalog.screens.map(screen => <Select.Option key={screen.id} value={screen.id}>{screen.content.title}</Select.Option>)}
      </Select>}
      <WorkshopButton tone="primary" type="submit" disabled={creating || !workspaceId}>Create screen</WorkshopButton>
      {createFailed && <p role="alert" className="basis-full text-[13px] leading-[18px] text-kumo-danger">Could not create the screen. Check your access to the workspace and try again.</p>}
    </form>}
    {!durableViews && <p className="px-1 text-[13px] leading-[18px] text-kumo-subtle">Saved screens are not enabled for this deployment; open a workspace to compose a temporary one.</p>}

    {screens.status === 'loading' && <p role="status" className="px-1 text-[13px] leading-[18px] text-kumo-subtle">Loading screens…</p>}
    {screens.status === 'error' && <p role="alert" className="px-1 text-[13px] leading-[18px] text-kumo-danger">Could not load your workspaces. Check your connection and reload.</p>}
    {screens.status === 'ready' && workspaces.length === 0 && <p className="px-1 text-[13px] leading-[18px] text-kumo-subtle">
      You have no workspaces yet. <Link to="/" className="text-kumo-brand">Create one</Link>, then come back to add screens.
    </p>}
    {workspaces.map(entry => <WorkspaceRow key={entry.workspace.id} entry={entry} />)}
    {workspaces.length === MAX_SCREEN_WORKSPACES && <p className="px-1 text-[12px] leading-4 text-kumo-subtle">
      Showing your {MAX_SCREEN_WORKSPACES} most recently active workspaces. <Link to="/workspaces" className="text-kumo-brand">See all workspaces</Link>.
    </p>}
  </div>
}
