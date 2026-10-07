import type { ActionLogEntry } from '@gadgets/workshop-shared/api'

/**
 * Whether approving again is allowed, by the overseer's rule: an action already attempted is sent
 * again only when the gatekeeper explicitly said another attempt is safe. Otherwise it can only be
 * denied, and no "always approve" rule is offered for it either.
 */
export const canApproveAgain = (record: ActionLogEntry): boolean =>
  record.type !== 'action' || !record.lastAttempt || record.lastAttempt.retryable === true

/**
 * What a person should know about an action's last unsuccessful apply, or null when there was none.
 * An unknown outcome is never presented as safely undone: the provider may have applied it, also
 * after the action was denied here.
 */
export const attemptNotice = (record: ActionLogEntry): { text: string; tone: 'danger' | 'warning' } | null => {
  if (record.type !== 'action' || !record.lastAttempt) return null
  const { outcome, message } = record.lastAttempt
  const blocked = record.state === 'pending' && !canApproveAgain(record)
  if (outcome === 'unknown') {
    const next = record.state === 'rejected'
      ? ' It was denied here, so local approval is closed; check the provider for whether it took effect.'
      : blocked ? ' It cannot be sent again: check it at the provider, then deny it.' : ''
    return { tone: 'warning', text: `It may already have been applied; the outcome is unknown: ${message}${next}` }
  }
  if (record.state === 'failed') return { tone: 'danger', text: `Not applied: ${message}` }
  const next = blocked ? ' It cannot be approved again here: deny it.' : ''
  return { tone: 'danger', text: `The last attempt was not applied: ${message}${next}` }
}
