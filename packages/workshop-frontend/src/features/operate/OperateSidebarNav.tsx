import { useRouterState } from '@tanstack/react-router'
import { LayoutIcon, PathIcon, PlusIcon } from '@phosphor-icons/react'
import type { GatekeeperAppInfo } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { useServerConfig } from '../../ServerConfigContext'
import SidebarItem from '../../components/AppShell/SidebarItem'
import SidebarGatekeeperApps from '../../components/AppShell/SidebarGatekeeperApps'
import { useWorkspaceScreens } from '../../pages/inferops-canvas/useWorkspaceScreens'
import { OPERATE_HOME } from './operateMode'
import { useOperateSession } from './OperateSessionContext'

const Eyebrow = ({ children }: { children: string }) =>
  <span className="px-2.5 pb-1 text-[11px] leading-4 font-medium uppercase tracking-[0.06em] text-kumo-inactive">
    {children}
  </span>

const Note = ({ children, role }: { children: string; role?: 'status' | 'alert' }) =>
  <p role={role} className="px-2.5 py-1.5 text-[12px] leading-4 tracking-[-0.2px] text-kumo-inactive">{children}</p>

/**
 * The sidebar body in Operate mode: the user's saved InferOps Canvas screens, a way to start a new
 * one (on the canvas home, where creation lives), and the gatekeeper apps. It replaces the Build
 * nav and workspace lists, since Operate is about using screens rather than making workspaces.
 */
export const OperateSidebarNav = ({ collapsed, gatekeeperApps }: {
  collapsed: boolean
  gatekeeperApps: GatekeeperAppInfo[]
}) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const durableViews = useServerConfig()?.canvasFeatures?.durableViews === true
  const screens = useWorkspaceScreens(authenticatedApi, durableViews)
  const operate = useOperateSession()
  const focus = operate?.snapshot?.state.focus ?? null
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const view = useRouterState({
    select: (s): string | null => {
      const value = (s.location.search as { view?: unknown }).view
      return typeof value === 'string' ? value : null
    },
  })

  const listed = screens.status === 'ready'
    ? screens.workspaces.flatMap(({ workspace, screens: saved }) =>
      (saved ?? []).map(screen => ({ workspaceId: workspace.id, screen })))
    : []

  const flows = screens.status === 'ready'
    ? screens.workspaces.flatMap(({ workspace, flows: authored }) =>
      authored.map(flow => ({ workspaceId: workspace.id, flow })))
    : []

  return (
    <div className="flex flex-col gap-4 px-2 pt-4">
      <div className="flex flex-col gap-0.5">
        {!collapsed && <Eyebrow>InferOps Canvas · Screens</Eyebrow>}
        <nav aria-label="Screens" className="flex flex-col gap-0.5">
          {listed.map(({ workspaceId, screen }) => operate ? (
            // In a session a screen opens into the session page, so every tab follows it.
            <SidebarItem
              key={`${workspaceId}/${screen.id}`}
              to={OPERATE_HOME}
              onClick={() => {
                operate.dispatch({ type: 'open', ref: { type: 'screen', workspaceId, screenId: screen.id } })
                  .catch(caught => console.error('Failed to open the screen in the session:', caught))
              }}
              active={pathname === OPERATE_HOME && focus?.type === 'screen' &&
                focus.workspaceId === workspaceId && focus.screenId === screen.id}
              label={screen.title}
              icon={<LayoutIcon size={14} weight="regular" />}
              collapsed={collapsed}
            />
          ) : (
            <SidebarItem
              key={`${workspaceId}/${screen.id}`}
              to="/workspace/$id/inferops-canvas"
              params={{ id: workspaceId }}
              search={{ view: screen.id }}
              active={pathname === `/workspace/${workspaceId}/inferops-canvas` && view === screen.id}
              label={screen.title}
              icon={<LayoutIcon size={14} weight="regular" />}
              collapsed={collapsed}
            />
          ))}
        </nav>
        {!collapsed && screens.status === 'loading' && <Note role="status">Loading screens…</Note>}
        {!collapsed && screens.status === 'error' && <Note role="alert">Could not load screens.</Note>}
        {!collapsed && screens.status === 'ready' && listed.length === 0 && <Note>No saved screens yet.</Note>}
        <SidebarItem
          to={OPERATE_HOME}
          label="New screen"
          icon={<PlusIcon size={14} weight="regular" />}
          collapsed={collapsed}
        />
      </div>

      {operate && flows.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {!collapsed && <Eyebrow>Flows</Eyebrow>}
          <nav aria-label="Flows" className="flex flex-col gap-0.5">
            {flows.map(({ workspaceId, flow }) => (
              <SidebarItem
                key={`${workspaceId}/${flow.id}`}
                to={OPERATE_HOME}
                onClick={() => {
                  operate.dispatch({ type: 'startFlow', workspaceId, flowId: flow.id, title: flow.title, steps: flow.steps })
                    .catch(caught => console.error('Failed to start the flow:', caught))
                }}
                active={false}
                label={flow.title}
                icon={<PathIcon size={14} weight="regular" />}
                collapsed={collapsed}
              />
            ))}
          </nav>
        </div>
      )}

      {gatekeeperApps.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {!collapsed && <Eyebrow>Gatekeeper apps</Eyebrow>}
          <SidebarGatekeeperApps apps={gatekeeperApps} collapsed={collapsed} />
        </div>
      )}
    </div>
  )
}
