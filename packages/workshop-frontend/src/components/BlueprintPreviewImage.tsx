import { Hexagon } from '@phosphor-icons/react'

export function BlueprintPreviewImage({
  title,
  screenshotUrl,
  className,
}: {
  /** Accepted for callers that identify the blueprint; the placeholder is no longer tinted per id. */
  blueprintId: string
  title: string
  screenshotUrl?: string
  className?: string
}) {
  return (
    <div className={`overflow-hidden rounded-xl bg-kumo-overlay ${className ?? ''}`}>
      {screenshotUrl ? (
        <img
          src={screenshotUrl}
          alt={`Screenshot of ${title}`}
          className="aspect-[16/9] w-full object-cover"
          loading="lazy"
        />
      ) : (
        <BlueprintPreviewPlaceholder />
      )}
    </div>
  )
}

/** A neutral wireframe standing in for a blueprint that has no screenshot. */
export function BlueprintPreviewPlaceholder() {
  return (
    <div className="relative aspect-[16/9] overflow-hidden bg-kumo-overlay">
      <svg
        viewBox="0 0 640 360"
        aria-hidden="true"
        className="absolute inset-0 h-full w-full"
      >
        <rect x="52" y="54" width="536" height="252" rx="18" className="fill-kumo-elevated stroke-kumo-line" />
        <rect x="84" y="86" width="132" height="12" rx="6" className="fill-kumo-fill-hover" />
        <rect x="84" y="116" width="312" height="10" rx="5" className="fill-kumo-control" />
        <rect x="84" y="142" width="472" height="1" className="fill-kumo-control" />
        {[0, 1, 2].map(row => (
          <g key={row} className="fill-kumo-control">
            <rect x="84" y={166 + row * 28} width="64" height="7" rx="3.5" />
            <rect x="196" y={166 + row * 28} width="108" height="7" rx="3.5" />
            <rect x="360" y={166 + row * 28} width="76" height="7" rx="3.5" />
            <rect x="486" y={166 + row * 28} width="52" height="7" rx="3.5" />
          </g>
        ))}
      </svg>
      <div className="absolute left-3 top-3 grid h-7 w-7 place-items-center rounded-lg bg-kumo-control text-kumo-brand">
        <Hexagon size={14} weight="bold" />
      </div>
    </div>
  )
}
