/** A section heading in the InferOS style: a small uppercase eyebrow with an optional count. */
export function SectionEyebrow({ label, count }: { label: string; count?: number }) {
  return (
    <div className="mb-2.5 flex items-center gap-2 px-1">
      <h2 className="m-0 text-[12px] leading-4 font-medium uppercase tracking-[0.08em] text-kumo-inactive">
        {label}
      </h2>
      {typeof count === 'number' && (
        <span className="text-[12px] leading-4 font-medium text-kumo-inactive">{count}</span>
      )}
    </div>
  )
}
