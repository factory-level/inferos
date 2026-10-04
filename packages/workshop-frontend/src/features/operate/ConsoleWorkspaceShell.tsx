import { useState, type ReactNode } from 'react'
import { Button, Dialog } from '@cloudflare/kumo'
import { ListIcon, XIcon } from '@phosphor-icons/react'
import { OperateSidebar } from './OperateSidebar'
import type { ConsoleWidgetTarget } from './ConsoleWidgetActions'

/** The operator's shell does not mount the configuration application's navigation or shortcuts. */
export const ConsoleWorkspaceShell = ({ children, onOpenWidget, onNavigate }: {
  children: ReactNode
  onOpenWidget: (target: ConsoleWidgetTarget) => void
  onNavigate: () => void
}) => {
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const navigated = () => { setMobileOpen(false); onNavigate() }
  return <div className="flex h-full min-h-0 flex-1 overflow-hidden bg-kumo-base">
    <div className="hidden h-full md:block"><OperateSidebar collapsed={collapsed} onToggleCollapsed={() => setCollapsed(!collapsed)} onOpenWidget={onOpenWidget} onNavigate={navigated} /></div>
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center px-3 md:hidden">
        <Dialog.Root open={mobileOpen} onOpenChange={setMobileOpen}>
          <Dialog.Trigger render={<Button variant="ghost" aria-label="Open console navigation"><ListIcon size={18} aria-hidden /></Button>} />
          <Dialog className="!fixed !inset-y-0 !left-0 !m-0 !h-dvh !max-h-dvh !w-80 !translate-x-0 !translate-y-0 rounded-none p-0">
            <Dialog.Title className="sr-only">Console navigation</Dialog.Title>
            <Dialog.Description className="sr-only">Pages and settings for this console.</Dialog.Description>
            <Dialog.Close className="absolute right-2 top-2" render={<Button variant="ghost" aria-label="Close console navigation"><XIcon size={16} aria-hidden /></Button>} />
            <OperateSidebar collapsed={false} onToggleCollapsed={() => setMobileOpen(false)} onOpenWidget={onOpenWidget} onNavigate={navigated} />
          </Dialog>
        </Dialog.Root>
      </div>
      {children}
    </div>
  </div>
}
