import { BookOpenIcon } from '@phosphor-icons/react'
import type { GatekeeperAppInfo } from '@gadgets/workshop-shared/api'
import SidebarItem from './SidebarItem'

/** Sidebar rows for the gatekeeper management apps (e.g. the Context Library) the user can open. */
export default function SidebarGatekeeperApps({ apps, collapsed }: { apps: GatekeeperAppInfo[]; collapsed: boolean }) {
  return apps.map((app) => {
    // Escape the icon URL for safe interpolation into a CSS url("…") string.
    const maskUrl = app.icon
      ? `url("${app.icon.url.replace(/[\\"]/g, '\\$&')}")`
      : undefined
    return (
      <SidebarItem
        key={app.id}
        to="/gatekeepers/$appId"
        params={{ appId: app.id }}
        label={app.title}
        icon={
          maskUrl ? (
            // Render the (monochrome) app icon as a CSS mask filled with the row's current
            // text color, so it tints like the Phosphor icons — subtle by default, accent
            // when active, darker on hover.
            <span
              aria-hidden
              className="h-3.5 w-3.5 bg-current"
              style={{
                maskImage: maskUrl,
                WebkitMaskImage: maskUrl,
                maskRepeat: 'no-repeat',
                WebkitMaskRepeat: 'no-repeat',
                maskPosition: 'center',
                WebkitMaskPosition: 'center',
                maskSize: 'contain',
                WebkitMaskSize: 'contain',
              }}
            />
          ) : (
            <BookOpenIcon size={14} weight="regular" />
          )
        }
        collapsed={collapsed}
      />
    )
  })
}
