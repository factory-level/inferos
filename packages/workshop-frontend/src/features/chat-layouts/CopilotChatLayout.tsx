import type { ChatLayoutSlots } from './DashboardChatLayout'
import { MetricSlot } from './MetricSlot'

/** Layout C: a board of widgets with an agent panel docked on the right. */
export const CopilotChatLayout = ({ composer, suggestions }: ChatLayoutSlots) => (
  <div className="flex h-full min-h-0 flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_400px]">
    <div className="min-h-0 overflow-y-auto px-4 pb-8 pt-6 sm:px-8 lg:pb-6">
      <header className="mb-5">
        <h1 className="m-0 text-lg font-semibold text-kumo-default">Board</h1>
        <p className="m-0 text-xs text-kumo-subtle">Ask the agent about any widget, or to add one.</p>
      </header>
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <div className="col-span-2 xl:col-span-3"><MetricSlot title="Agent runs" kind="chart" /></div>
        <div className="col-span-2 xl:col-span-1"><MetricSlot title="Approvals" kind="list" /></div>
        <MetricSlot title="Tool-call success" kind="stat" />
        <MetricSlot title="p95 latency" kind="stat" />
        <MetricSlot title="Model spend" kind="stat" />
        <MetricSlot title="Active gadgets" kind="stat" />
        <div className="col-span-2"><MetricSlot title="Runs by agent" kind="chart" /></div>
        <div className="col-span-2"><MetricSlot title="Gatekeeper health" kind="list" /></div>
      </div>
    </div>
    <aside aria-label="Agent" className="flex min-h-0 flex-col gap-3 bg-kumo-elevated p-4">
      <h2 className="m-0 text-sm font-semibold text-kumo-default">Agent</h2>
      <div className="min-h-0 flex-1 overflow-y-auto">{suggestions}</div>
      {composer}
    </aside>
  </div>
)
