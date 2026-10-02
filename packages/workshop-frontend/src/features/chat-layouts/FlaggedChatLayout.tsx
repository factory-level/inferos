import type { ChatLayout } from './chatLayout'
import { CopilotChatLayout } from './CopilotChatLayout'
import { DashboardChatLayout, type ChatLayoutSlots } from './DashboardChatLayout'
import { ThreadChatLayout } from './ThreadChatLayout'

const LAYOUTS = {
  dashboard: DashboardChatLayout,
  thread: ThreadChatLayout,
  copilot: CopilotChatLayout,
} as const

/** Renders one of the flag-gated Home layouts around the page's composer and suggestions. */
export const FlaggedChatLayout = ({ layout, ...slots }: ChatLayoutSlots & {
  layout: Exclude<ChatLayout, 'default'>
}) => {
  const Layout = LAYOUTS[layout]
  return <Layout {...slots} />
}
