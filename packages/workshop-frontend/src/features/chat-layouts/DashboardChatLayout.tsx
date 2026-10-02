import type { ReactNode } from 'react'
import { MetricSlot } from './MetricSlot'

/** The pieces every Home layout places: the real composer and the task suggestions. */
export type ChatLayoutSlots = { composer: ReactNode; suggestions: ReactNode }

/** Layout A: a full metrics grid with the composer floating over its bottom edge. */
export const DashboardChatLayout = ({ composer }: ChatLayoutSlots) => (
  <div className="relative flex h-full min-h-0 flex-col">
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-64 pt-6 sm:px-8">
      <header className="mb-5">
        <h1 className="m-0 text-lg font-semibold text-kumo-default">Overview</h1>
        <p className="m-0 text-xs text-kumo-subtle">Widgets fill in as data sources are connected.</p>
      </header>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricSlot title="Agent runs" kind="stat" />
        <MetricSlot title="Tool-call success" kind="stat" />
        <MetricSlot title="Awaiting approval" kind="stat" />
        <MetricSlot title="Model spend" kind="stat" />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2"><MetricSlot title="Runs per day" kind="chart" /></div>
        <MetricSlot title="Approval queue" kind="list" />
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <MetricSlot title="Spend by model" kind="chart" />
        <MetricSlot title="p95 latency" kind="chart" />
        <MetricSlot title="Gatekeepers" kind="list" />
      </div>
    </div>
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center px-4 pb-4">
      <div className="themed-floating-shadow-lg pointer-events-auto w-full max-w-3xl rounded-2xl bg-kumo-overlay p-2">
        {composer}
      </div>
    </div>
  </div>
)
