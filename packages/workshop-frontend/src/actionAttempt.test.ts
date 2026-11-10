import { describe, expect, it } from 'vitest'
import type { ActionLogEntry } from '@gadgets/workshop-shared/api'
import { canApproveAgain } from './actionAttempt'

const action = (over: Partial<Extract<ActionLogEntry, { type: 'action' }>>) => ({
  id: 1, type: 'action', state: 'pending', resourceTitle: 'Board', createdAt: new Date(),
  description: { title: 'Move', description: '', implementsRevert: false }, ...over,
}) as ActionLogEntry

// What an attempt says is ActionDecision's (FAC-119); this is whether it may be approved again.
describe('canApproveAgain', () => {
  it('approves an attempted action again only when the gatekeeper explicitly said so, for either outcome', () => {
    expect(canApproveAgain(action({}))).toBe(true)
    for (const outcome of ['unknown', 'notApplied'] as const) {
      const attempted = (retryable?: boolean) => action({
        lastAttempt: { outcome, message: 'x', at: new Date(), ...(retryable === undefined ? {} : { retryable }) },
      })
      expect(canApproveAgain(attempted())).toBe(false)
      expect(canApproveAgain(attempted(false))).toBe(false)
      expect(canApproveAgain(attempted(true))).toBe(true)
    }
  })
})
