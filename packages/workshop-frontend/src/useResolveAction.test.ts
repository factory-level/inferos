// FAC-119: a failed decision's toast. A failed approve never shows what it threw, which can be the
// provider's own words (the kernel rethrows a failed apply's message): the action's card says why.
// The kernel's refusal that the person may not decide is shown as is, as is a failed rejection's.
import { describe, expect, it } from 'vitest'
import { SHARED_CONFIGURATION_REFUSED } from '@gadgets/workshop-shared/api'
import { APPROVE_FAILED_TEXT, resolveFailureText } from './useResolveAction'

describe("a failed decision's toast", () => {
  it("never shows a failed approve's provider text", () => {
    const text = resolveFailureText('approve', new Error('Error: InferOps said: token expired for acme-bot'))
    expect(text).toBe(APPROVE_FAILED_TEXT)
    expect(text).not.toContain('acme-bot')
  })

  it("keeps the kernel's own refusal, and a rejection's words", () => {
    expect(resolveFailureText('approve', new Error(`Error: ${SHARED_CONFIGURATION_REFUSED}`))).toBe(SHARED_CONFIGURATION_REFUSED)
    expect(resolveFailureText('deny', new Error('This action was already approved.'))).toBe('This action was already approved.')
  })
})
