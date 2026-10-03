import { ChartLine, ListChecks, NumberSquareOne } from '@phosphor-icons/react'

type MetricSlotKind = 'stat' | 'chart' | 'list'

const KIND_STYLE: Record<MetricSlotKind, { minHeight: string; Icon: typeof ChartLine }> = {
  stat: { minHeight: 'min-h-24', Icon: NumberSquareOne },
  chart: { minHeight: 'min-h-56', Icon: ChartLine },
  list: { minHeight: 'min-h-56', Icon: ListChecks },
}

/**
 * A reserved place for a metric widget in a Home layout. No metrics source exists yet, so the slot
 * says so plainly instead of showing invented numbers or an empty card that reads as "zero".
 */
export const MetricSlot = ({ title, kind }: { title: string; kind: MetricSlotKind }) => {
  const { minHeight, Icon } = KIND_STYLE[kind]
  return (
    <section
      aria-label={title}
      className={`flex h-full flex-col gap-3 rounded-xl bg-kumo-elevated p-4 ${minHeight}`}
    >
      <h2 className="m-0 text-sm font-semibold text-kumo-default">{title}</h2>
      <div className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-dashed border-kumo-line px-3 py-4 text-xs text-kumo-subtle">
        <Icon aria-hidden="true" size={16} className="shrink-0 text-kumo-inactive" />
        <span>No data source connected yet</span>
      </div>
    </section>
  )
}
