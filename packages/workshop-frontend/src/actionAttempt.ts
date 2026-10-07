import type { ActionLogEntry } from '@gadgets/workshop-shared/api'

/**
 * What a person should know about an action's last unsuccessful apply, or null when there was none.
 * An unknown outcome is never presented as safely undone: the provider may have applied it.
 */
export const attemptNotice = (record: ActionLogEntry): { text: string; tone: 'danger' | 'warning' } | null => {
  if (record.type !== 'action' || !record.lastAttempt) return null
  const { outcome, message } = record.lastAttempt
  if (outcome === 'unknown') {
    return { tone: 'warning', text: `It may already have been applied; the outcome is unknown: ${message}` }
  }
  return { tone: 'danger', text: record.state === 'failed' ? `Not applied: ${message}` : `The last attempt was not applied: ${message}` }
}
