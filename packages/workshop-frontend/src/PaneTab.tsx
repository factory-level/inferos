import { CountBadge } from './components/CountBadge'

export const PaneTab = ({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean
  label: string
  count?: number
  onClick: () => void
}) => (
  <button
    type="button"
    onClick={onClick}
    className={`relative flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] font-medium tracking-[-0.15px] transition-colors duration-150 ${
      active ? 'bg-kumo-tint text-kumo-default' : 'text-kumo-subtle hover:text-kumo-default'
    }`}
  >
    {label}
    <CountBadge count={count ?? 0} />
  </button>
)
