import { PlugsConnected, type Icon } from '@phosphor-icons/react'
import { WorkshopButton } from './WorkshopControls'

export function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
  icon: EmptyIcon = PlugsConnected,
}: {
  title: string
  description: string
  actionLabel?: string
  onAction?: () => void
  icon?: Icon
}) {
  return (
    <div className="rounded-xl bg-kumo-elevated px-6 py-9 text-center">
      <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-kumo-control text-kumo-subtle">
        <EmptyIcon size={18} />
      </div>
      <div>
        <p className="m-0 text-[14px] leading-5 font-medium tracking-[-0.3px] text-kumo-default">
          {title}
        </p>
        <p className="mx-auto mt-1 max-w-sm text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
          {description}
        </p>
      </div>
      {actionLabel && onAction && (
        <WorkshopButton
          className="mx-auto mt-4"
          onClick={onAction}
        >
          {actionLabel}
        </WorkshopButton>
      )}
    </div>
  )
}
