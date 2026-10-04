import type { ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Tooltip, useKumoToastManager } from '@cloudflare/kumo'
import {
  ChatsCircleIcon, GearIcon, LayoutIcon, SidebarSimpleIcon, SquaresFourIcon, StackIcon,
} from '@phosphor-icons/react'
import type { OperateEvent } from '@gadgets/workshop-shared/operate-session'
import { useAuthenticatedApi } from '../../AuthContext'
import { useWorkspaceScreens } from '../../pages/inferops-canvas/useWorkspaceScreens'
import { useServerConfig } from '../../ServerConfigContext'
import { findConsole } from './consoles'
import type { ConsoleWidgetTarget } from './ConsoleWidgetActions'
import { useOperateSession } from './OperateSessionContext'

/** A console's own page hierarchy, independent of the configuration application's sidebar. */
export const OperateSidebar = ({ collapsed, onToggleCollapsed, onOpenWidget, onNavigate }: {
  collapsed: boolean
  onToggleCollapsed: () => void
  onOpenWidget?: (target: ConsoleWidgetTarget) => void
  onNavigate?: () => void
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
    onNavigate?.()
    void navigate({ to: '/inferops-canvas', search: {} })
    events.reduce((previous, event) => previous.then(() => operate.dispatch(event)), Promise.resolve()).catch(caught => {
      console.error('Operate session change failed:', caught)
      toasts.add({ title: 'That change could not be applied to your session.', variant: 'error' })
    })
  }
  const fullChat = run?.fullChat ?? 'off'
  const inChat = state?.presentation === 'chat'

  return (
    <aside aria-label="Console workspace"
      className={`flex h-full shrink-0 flex-col bg-kumo-elevated transition-[width] duration-200 ease-out ${collapsed ? 'w-[56px]' : 'w-[min(320px,100vw)] md:w-[240px]'}`}>
      <div className={`flex h-14 shrink-0 items-center gap-1 ${collapsed ? 'flex-col justify-center px-1.5' : 'px-2'}`}>
        {!collapsed && <span className="min-w-0 flex-1 truncate px-1 text-[13px] font-semibold text-kumo-default" title={run?.title}>{run?.title ?? 'Operate'}</span>}
        {!collapsed && <RailButton label="Collapse sidebar" collapsed icon={<SidebarSimpleIcon size={15} aria-hidden />} onClick={onToggleCollapsed} />}
      </div>
      {collapsed && (
        <div className="flex justify-center pb-1">
          <RailButton label="Expand sidebar" collapsed icon={<SidebarSimpleIcon size={15} className="rotate-180" aria-hidden />} onClick={onToggleCollapsed} />
        </div>
      )}

      <nav aria-label="Console" className="sidebar-scroll flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pt-2">
        <MenuButton label="All consoles" icon={<SquaresFourIcon size={14} aria-hidden />} collapsed={collapsed}
          current={!run && !state?.focus && !state?.flow} onClick={() => { void navigate({ to: '/inferops-canvas', search: {} }); send({ type: 'showHome' }) }} />
        {run && <>
          <div className="my-3 h-px bg-kumo-line" />
          {fullChat !== 'off' && (
            <MenuButton label="Assistant" icon={<ChatsCircleIcon size={14} aria-hidden />} collapsed={collapsed}
              current={inChat}
              onClick={() => { onNavigate?.(); void navigate({ to: '/inferops-canvas', search: {} }); if (!inChat && fullChat !== 'only') send({ type: 'setPresentation', presentation: 'chat' }) }} />
          )}
          {fullChat !== 'only' && !collapsed && <p className="px-2.5 pb-1 pt-4 text-xs text-kumo-subtle">Pages</p>}
          {fullChat !== 'only' && entry?.console.views.map(view => (
            <div key={view.id}>
            <MenuButton key={view.id} label={view.title} collapsed={collapsed}
              icon={view.type === 'rollup' ? <StackIcon size={14} aria-hidden /> : <LayoutIcon size={14} aria-hidden />}
              current={!inChat && run.viewId === view.id}
              onClick={() => inChat
                ? send({ type: 'setPresentation', presentation: 'canvas' }, { type: 'openView', viewId: view.id }, { type: 'setChatOpen', open: true })
                : send({ type: 'openView', viewId: view.id })} />
            {!collapsed && run.viewId === view.id && !inChat && onOpenWidget && (view.type === 'screen' ? [view.screen] : view.screens).map(id => {
              const page = entry.screens.find(screen => screen.id === id)
              return page && <div key={id} className="ml-5 border-l border-kumo-line pl-2">
                {view.type === 'rollup' && <MenuButton label={page.title} collapsed={false} current={run.screenId === id} icon={<LayoutIcon size={13} aria-hidden />} onClick={() => send({ type: 'showScreen', screenId: id })} />}
                {page.sections.flatMap(section => section.widgets.map((widget, index) => <MenuButton key={widget.id}
                  label={`${section.title || 'Page'} ${widget.kind === 'inferops.project-board' ? 'board' : `widget ${index + 1}`}`}
                  collapsed={false} current={false} icon={<SquaresFourIcon size={12} aria-hidden />}
                  onClick={() => { onOpenWidget({ consoleId: run.consoleId, screenId: id, widgetId: widget.id, presentation: 'page' }); onNavigate?.() }} />))}
              </div>
            })}
            </div>
          ))}
        </>}
      </nav>

      {run && <div className="border-t border-kumo-line p-2">
        <MenuButton label="Settings" icon={<GearIcon size={15} aria-hidden />} collapsed={collapsed} current={false}
          onClick={() => { void navigate({ to: '/inferops-canvas', search: { settings: run.consoleId, workspace: run.workspaceId } }); onNavigate?.() }} />
      </div>}
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
        current ? 'bg-kumo-control font-medium text-kumo-default' : 'text-kumo-default hover:bg-kumo-tint',
      ].join(' ')}>
      <span className={`flex h-5 w-5 shrink-0 items-center justify-center ${current ? 'text-kumo-default' : 'text-kumo-subtle group-hover:text-kumo-default'}`}>{icon}</span>
      {!collapsed && <span className="min-w-0 flex-1 truncate">{label}</span>}
    </button>
  )
  return collapsed ? <Tooltip side="right" content={label} render={button} /> : button
}
