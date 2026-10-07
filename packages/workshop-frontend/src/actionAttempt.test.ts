import { describe, expect, it } from 'vitest'
import type { ActionLogEntry } from '@gadgets/workshop-shared/api'
import { attemptNotice, canApproveAgain } from './actionAttempt'

const action = (over: Partial<Extract<ActionLogEntry, { type: 'action' }>>) => ({
  id: 1, type: 'action', state: 'pending', resourceTitle: 'Board', createdAt: new Date(),
  description: { title: 'Move', description: '', implementsRevert: false }, ...over,
}) as ActionLogEntry

describe('attemptNotice', () => {
  it('says nothing for an action never attempted', () => {
    expect(attemptNotice(action({}))).toBeNull()
  })

  it('warns that an unknown outcome may already have been applied', () => {
    expect(attemptNotice(action({ lastAttempt: { outcome: 'unknown', message: 'Timed out.', retryable: true, at: new Date() } })))
      .toEqual({ tone: 'warning', text: 'It may already have been applied; the outcome is unknown: Timed out.' })
  })

  it('says an unknown outcome that cannot be repeated can only be denied', () => {
    const record = action({ lastAttempt: { outcome: 'unknown', message: 'Lost.', retryable: false, at: new Date() } })
    expect(attemptNotice(record)?.text).toBe(
      'It may already have been applied; the outcome is unknown: Lost. It cannot be sent again: check it at the provider, then deny it.')
    expect(canApproveAgain(record)).toBe(false)
  })

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

  it('tells a pending refusal that cannot be retried to deny it', () => {
    expect(attemptNotice(action({ lastAttempt: { outcome: 'notApplied', message: 'Denied.', at: new Date() } }))?.text)
      .toBe('The last attempt was not applied: Denied. It cannot be approved again here: deny it.')
  })

  it('keeps the uncertainty after a denial and says local approval is closed', () => {
    const text = attemptNotice(action({
      state: 'rejected', lastAttempt: { outcome: 'unknown', message: 'Lost.', retryable: true, at: new Date() },
    }))?.text
    expect(text).toBe('It may already have been applied; the outcome is unknown: Lost. It was denied here, so local ' +
      'approval is closed; check the provider for whether it took effect.')
    expect(text).not.toContain('deny it')
  })

  it('names a refusal as not applied, for a failed action and for one still pending', () => {
    const lastAttempt = { outcome: 'notApplied' as const, message: 'Policy denies it.', retryable: true, at: new Date() }
    expect(attemptNotice(action({ state: 'failed', lastAttempt }))?.text).toBe('Not applied: Policy denies it.')
    expect(attemptNotice(action({ lastAttempt }))?.text).toBe('The last attempt was not applied: Policy denies it.')
  })
})
