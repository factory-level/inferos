import type { ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Tooltip, useKumoToastManager } from '@cloudflare/kumo'
import {
  ChatsCircleIcon, HammerIcon, LayoutIcon, SidebarSimpleIcon, SquaresFourIcon, StackIcon,
} from '@phosphor-icons/react'
import type { OperateEvent } from '@gadgets/workshop-shared/operate-session'
import { useAuthenticatedApi } from '../../AuthContext'
import { useWorkspaceScreens } from '../../pages/inferops-canvas/useWorkspaceScreens'
import { useServerConfig } from '../../ServerConfigContext'
import SidebarUtilityStrip from '../../components/AppShell/SidebarUtilityStrip'
import { findConsole } from './consoles'
import { buildReturnHref } from './operateMode'
import { useOperateSession } from './OperateSessionContext'

/**
 * Operate's one sidebar. It holds a single button back to Build, the open console with its view
 * menu, and the full chat switch when the console offers it. With no console open it only offers
 * the console mosaic. Collapsed, it is an icon rail whose buttons keep their names as accessible
 * labels and tooltips.
 */
export const OperateSidebar = ({ collapsed, onToggleCollapsed }: {
  collapsed: boolean
  onToggleCollapsed: () => void
}) => {
  const navigate = useNavigate()
  const toasts = useKumoToastManager()
  const operate = useOperateSession()
  const { authenticatedApi } = useAuthenticatedApi()
  const durableViews = useServerConfig()?.canvasFeatures?.durableViews === true
  const screens = useWorkspaceScreens(authenticatedApi, durableViews)

  const state = operate?.snapshot?.state
  const run = state?.console ?? null
  const entry = run && screens.status === 'ready' ? findConsole(screens.workspaces, run) : undefined
  // Events apply in order: each waits for the one before, so a pair never races on the sequence.
  const send = (...events: OperateEvent[]) => {
    if (!operate) return
    events.reduce((previous, event) => previous.then(() => operate.dispatch(event)), Promise.resolve()).catch(caught => {
      console.error('Operate session change failed:', caught)
      toasts.add({ title: 'That change could not be applied to your session.', variant: 'error' })
    })
  }
  const fullChat = run?.fullChat ?? 'off'
  const inChat = state?.presentation === 'chat'

  return (
    <aside aria-label="Operate"
      className={`flex h-full shrink-0 flex-col bg-kumo-elevated transition-[width] duration-200 ease-out ${collapsed ? 'w-[56px]' : 'w-[min(320px,100vw)] md:w-[240px]'}`}>
      <div className={`flex h-14 shrink-0 items-center gap-1 ${collapsed ? 'flex-col justify-center px-1.5' : 'px-2'}`}>
        <RailButton label="Back to Build" collapsed icon={<HammerIcon size={15} aria-hidden />}
          onClick={() => void navigate({ to: '.', href: buildReturnHref() })} />
        {!collapsed && <span className="min-w-0 flex-1 truncate px-1 text-[13px] font-semibold text-kumo-default">Operate</span>}
        {!collapsed && <RailButton label="Collapse sidebar" collapsed icon={<SidebarSimpleIcon size={15} aria-hidden />} onClick={onToggleCollapsed} />}
      </div>
      {collapsed && (
        <div className="flex justify-center pb-1">
          <RailButton label="Expand sidebar" collapsed icon={<SidebarSimpleIcon size={15} className="rotate-180" aria-hidden />} onClick={onToggleCollapsed} />
        </div>
      )}

      <nav aria-label="Console" className="sidebar-scroll flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pt-2">
        <MenuButton label="All consoles" icon={<SquaresFourIcon size={14} aria-hidden />} collapsed={collapsed}
          current={!run} onClick={() => run && send({ type: 'closeConsole' })} />
        {run && <>
          {!collapsed && <p className="truncate px-2.5 pb-1 pt-4 text-[11px] font-medium uppercase tracking-wide text-kumo-inactive">{run.title}</p>}
          {collapsed && <div className="my-2 h-px bg-kumo-line" />}
          {entry?.console.views.map(view => (
            <MenuButton key={view.id} label={view.title} collapsed={collapsed}
              icon={view.type === 'rollup' ? <StackIcon size={14} aria-hidden /> : <LayoutIcon size={14} aria-hidden />}
              current={!inChat && run.viewId === view.id}
              onClick={() => inChat && fullChat !== 'only'
                ? send({ type: 'setPresentation', presentation: 'canvas' }, { type: 'openView', viewId: view.id })
                : send({ type: 'openView', viewId: view.id })} />
          ))}
          {fullChat !== 'off' && (
            <MenuButton label="Full chat" icon={<ChatsCircleIcon size={14} aria-hidden />} collapsed={collapsed}
              current={inChat}
              onClick={() => fullChat !== 'only' && send({ type: 'setPresentation', presentation: inChat ? 'canvas' : 'chat' })} />
          )}
        </>}
      </nav>

      <SidebarUtilityStrip collapsed={collapsed} />
    </aside>
  )
}

const RailButton = ({ label, icon, collapsed, onClick }: {
  label: string; icon: ReactNode; collapsed: boolean; onClick: () => void
}) => {
  const button = (
    <button type="button" aria-label={label} onClick={onClick}
      className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">
      {icon}
    </button>
  )
  return collapsed ? <Tooltip side="right" content={label} render={button} /> : button
}

const MenuButton = ({ label, icon, collapsed, current, onClick }: {
  label: string; icon: ReactNode; collapsed: boolean; current: boolean; onClick: () => void
}) => {
  const button = (
    <button type="button" aria-label={collapsed ? label : undefined} aria-current={current ? 'page' : undefined} onClick={onClick}
      className={[
        'group flex h-11 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[14px] leading-5 transition-colors md:h-8 md:text-[13px] md:leading-[18px]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring',
        current ? 'bg-kumo-info-tint font-medium text-kumo-brand' : 'text-kumo-default hover:bg-kumo-tint',
      ].join(' ')}>
      <span className={`flex h-5 w-5 shrink-0 items-center justify-center ${current ? 'text-kumo-brand' : 'text-kumo-subtle group-hover:text-kumo-default'}`}>{icon}</span>
      {!collapsed && <span className="min-w-0 flex-1 truncate">{label}</span>}
    </button>
  )
  return collapsed ? <Tooltip side="right" content={label} render={button} /> : button
}
