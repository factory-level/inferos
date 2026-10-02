import { useNavigate } from '@tanstack/react-router'
import { Tooltip } from '@cloudflare/kumo'
import { HammerIcon, PulseIcon } from '@phosphor-icons/react'
import { buildReturnHref, OPERATE_HOME, type AppMode } from './operateMode'

const MODES = [
  { mode: 'build', label: 'Build', icon: HammerIcon },
  { mode: 'operate', label: 'Operate', icon: PulseIcon },
] as const

/**
 * The Build | Operate segmented control at the top of the sidebar. It navigates rather than holding
 * state: Operate opens the InferOps Canvas, Build returns to the last Build page of this session.
 * Collapsed, it stacks icon-only buttons that keep their names as accessible labels and tooltips.
 */
export const ModeToggle = ({ mode, collapsed }: { mode: AppMode; collapsed: boolean }) => {
  const navigate = useNavigate()
  const select = (next: AppMode) => {
    if (next === mode) return
    if (next === 'operate') void navigate({ to: OPERATE_HOME })
    // The remembered location is a full href (path, search, hash), which takes precedence over
    // `to`; the typed options still require one.
    else void navigate({ to: '.', href: buildReturnHref() })
  }

  return (
    <div
      role="group"
      aria-label="Mode"
      className={[
        'flex shrink-0 gap-0.5 rounded-lg bg-kumo-base p-[3px]',
        collapsed ? 'mx-auto mt-2 flex-col' : 'mx-2 mt-1',
      ].join(' ')}
    >
      {MODES.map(({ mode: option, label, icon: Icon }) => {
        const pressed = option === mode
        const button = (
          <button
            key={option}
            type="button"
            aria-pressed={pressed}
            aria-label={collapsed ? label : undefined}
            onClick={() => select(option)}
            className={[
              'flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded-md text-[13px] leading-[18px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring',
              collapsed ? 'w-7' : 'flex-1',
              pressed
                ? 'bg-kumo-control font-medium text-kumo-default'
                : 'text-kumo-subtle hover:text-kumo-default',
            ].join(' ')}
          >
            <Icon size={13} aria-hidden />
            {!collapsed && label}
          </button>
        )
        return collapsed ? <Tooltip key={option} side="right" content={label} render={button} /> : button
      })}
    </div>
  )
}
