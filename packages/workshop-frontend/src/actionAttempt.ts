import type { ActionLogEntry } from '@gadgets/workshop-shared/api'

/**
 * Whether approving again is allowed: false once the gatekeeper said the last attempt cannot be
 * safely repeated, which the overseer enforces too. Such an action can only be denied.
 */
export const canApproveAgain = (record: ActionLogEntry): boolean =>
  record.type !== 'action' || record.lastAttempt?.retryable !== false

/**
 * What a person should know about an action's last unsuccessful apply, or null when there was none.
 * An unknown outcome is never presented as safely undone: the provider may have applied it.
 */
export const attemptNotice = (record: ActionLogEntry): { text: string; tone: 'danger' | 'warning' } | null => {
  if (record.type !== 'action' || !record.lastAttempt) return null
  const { outcome, message } = record.lastAttempt
  if (outcome === 'unknown') {
    const next = canApproveAgain(record) ? '' : ' It cannot be sent again: check it at the provider, then deny it.'
    return { tone: 'warning', text: `It may already have been applied; the outcome is unknown: ${message}${next}` }
  }
  return { tone: 'danger', text: record.state === 'failed' ? `Not applied: ${message}` : `The last attempt was not applied: ${message}` }
}
