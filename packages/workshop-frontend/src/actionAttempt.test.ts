import { describe, expect, it } from 'vitest'
import type { ActionLogEntry } from '@gadgets/workshop-shared/api'
import { attemptNotice } from './actionAttempt'

const action = (over: Partial<Extract<ActionLogEntry, { type: 'action' }>>) => ({
  id: 1, type: 'action', state: 'pending', resourceTitle: 'Board', createdAt: new Date(),
  description: { title: 'Move', description: '', implementsRevert: false }, ...over,
}) as ActionLogEntry

describe('attemptNotice', () => {
  it('says nothing for an action never attempted', () => {
    expect(attemptNotice(action({}))).toBeNull()
  })

  it('warns that an unknown outcome may already have been applied', () => {
    expect(attemptNotice(action({ lastAttempt: { outcome: 'unknown', message: 'Timed out.', at: new Date() } })))
      .toEqual({ tone: 'warning', text: 'It may already have been applied; the outcome is unknown: Timed out.' })
  })

  it('names a refusal as not applied, for a failed action and for one still pending', () => {
    const lastAttempt = { outcome: 'notApplied' as const, message: 'Policy denies it.', at: new Date() }
    expect(attemptNotice(action({ state: 'failed', lastAttempt }))?.text).toBe('Not applied: Policy denies it.')
    expect(attemptNotice(action({ lastAttempt }))?.text).toBe('The last attempt was not applied: Policy denies it.')
  })
})
