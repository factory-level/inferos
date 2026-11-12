import { Badge } from '@cloudflare/kumo'
import type { ActionContext } from '@gadgets/workshop-shared/api'

/** What every approval surface says above a declared run's reference (FAC-120), in the kernel's words. */
export const DECLARED_RUN_TEXT = 'Workflow run this approval starts'

/** The provenance mark beside it: the kernel wrote this line, not the connection that asked. */
export const DECLARED_RUN_PROVENANCE = 'Shown by InferOS'

/**
 * The workflow run approving an action starts (FAC-120), read only from the kernel's own marker,
 * `ActionContext.declaredRun`, never from a field the connection supplied, so a look-alike field
 * label can't stand in for it. Marked as InferOS's, apart from the gatekeeper's text. Nothing when
 * the action declared no run.
 */
export const DeclaredRunNotice = ({ context, id, className = '' }: {
  context: ActionContext | undefined
  /** For an Approve or Deny button's `aria-describedby`. */
  id?: string
  className?: string
}) => {
  const reference = context?.declaredRun?.reference
  if (!reference) return null
  return (
    <span id={id} className={`flex flex-wrap items-center gap-1.5 text-[11.5px] leading-4 text-kumo-default ${className}`}>
      <Badge variant="secondary">{DECLARED_RUN_PROVENANCE}</Badge>
      <span>{DECLARED_RUN_TEXT}:</span>
      <span className="break-all font-mono text-kumo-subtle">{reference}</span>
    </span>
  )
}
