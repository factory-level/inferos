import type { ActionLogEntry } from '@gadgets/workshop-shared/api'

/**
 * Whether approving again is allowed, by the overseer's rule: an action already attempted is sent
 * again only when the gatekeeper explicitly said another attempt is safe. Otherwise it can only be
 * denied, and no "always approve" rule is offered for it either.
 */
export const canApproveAgain = (record: ActionLogEntry): boolean =>
  record.type !== 'action' || !record.lastAttempt || record.lastAttempt.retryable === true
