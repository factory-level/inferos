import type { ChatLayoutSlots } from './DashboardChatLayout'
import { MetricSlot } from './MetricSlot'

/** Layout B: the conversation leads, with the user's pinned metrics in a column beside it. */
export const ThreadChatLayout = ({ composer, suggestions }: ChatLayoutSlots) => (
  <div className="grid h-full min-h-0 lg:grid-cols-[minmax(0,1fr)_360px]">
    <div className="flex min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-10 sm:px-8">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
          <header>
            <h1 className="m-0 text-2xl font-semibold tracking-tight text-kumo-default">What are we working on?</h1>
            <p className="m-0 mt-2 text-sm text-kumo-subtle">
              Ask about your agents and data. Pin any answer to keep it beside the chat.
            </p>
          </header>
          {suggestions}
        </div>
      </div>
      <div className="px-4 pb-4 pt-2 sm:px-8">
        <div className="mx-auto w-full max-w-3xl">{composer}</div>
      </div>
    </div>
    <aside aria-label="Pinned metrics" className="hidden min-h-0 flex-col gap-3 overflow-y-auto bg-kumo-elevated p-4 lg:flex">
      <h2 className="m-0 text-sm font-semibold text-kumo-default">Pinned</h2>
      <div className="grid grid-cols-2 gap-3">
        <MetricSlot title="Agent runs" kind="stat" />
        <MetricSlot title="Model spend" kind="stat" />
      </div>
      <MetricSlot title="Runs by agent" kind="chart" />
      <MetricSlot title="Deploys" kind="list" />
    </aside>
  </div>
)
