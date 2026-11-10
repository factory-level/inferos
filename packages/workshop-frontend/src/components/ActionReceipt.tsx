import { ACTION_OUTCOME_TEXT, type ActionOutcome, type ActionResult } from '@gadgets/workshop-shared/action-outcome'

/**
 * What the provider reported for an applied action (its `result`), as plain pairs. Nothing is
 * rendered as markup or a link: the values are the provider's, shown as text.
 */
export const ActionResultList = ({ result, className = '' }: { result: ActionResult; className?: string }) => (
  <dl aria-label="What the provider reported" className={`m-0 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-kumo-subtle ${className}`}>
    {Object.entries(result).map(([key, value]) => (
      <div key={key} className="flex gap-1"><dt className="text-kumo-inactive">{key}:</dt><dd className="m-0 break-all">{String(value)}</dd></div>
    ))}
  </dl>
)

/**
 * A write receipt (FAC-97, first drawn by FAC-10's governed table): where the write stands, in
 * FAC-97's words, the receipt's fixed reason when it has one, and, once applied, what the provider
 * reported. Only `succeeded` says it was applied.
 */
export const ActionReceiptLine = ({ outcome, reason, result }: { outcome: ActionOutcome; reason?: string; result?: ActionResult }) => (
  <span role="status" className="inline-flex flex-col gap-1 text-xs text-kumo-subtle">
    <span>{ACTION_OUTCOME_TEXT[outcome]}{reason ? `: ${reason}` : ''}</span>
    {outcome === 'succeeded' && result && Object.keys(result).length > 0 && <ActionResultList result={result} />}
  </span>
)
