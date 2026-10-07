// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('@cloudflare/kumo')
  const toasts = { add: vi.fn<(options: unknown) => void>() }
  return { ...actual, useKumoToastManager: () => toasts }
})
vi.mock('./AuthContext', () => {
  const context = {
    authenticatedApi: { listGatekeeperVendors: async () => [], getAvatar: async () => null },
    currentUser: null,
  }
  return { useAuthenticatedApi: () => context, useOptionalAuthenticatedApi: () => null }
})
vi.mock('./useAlwaysApproveTag', () => ({
  useAlwaysApproveTag: () => ({ alwaysApproveTag: vi.fn<() => Promise<void>>(), isTagAutoApproved: () => false }),
}))

import { entry, flushFrames, makeOverseer, makeTestRoot } from './action-test-harness'
import Activity from './Activity'

const view = makeTestRoot()

afterEach(() => {
  view.cleanup()
  vi.restoreAllMocks()
})

const fields = [
  { label: 'To', kind: 'list', items: ['a@example.com'] },
  { label: 'Body', kind: 'text', value: 'Full body text' },
]

// Renders the review view with one complete pending request carrying `fields`.
async function renderReview(restricted: boolean) {
  const server = makeOverseer()
  await view.render(
    <Activity overseer={server.overseer} restricted={restricted} view="review" onViewChange={() => {}} />,
  )
  await server.resolveSubscription()
  await server.resolvePendingQuery({
    entries: [entry(1, {
      description: {
        title: 'Send email', description: 'Send an email.', implementsRevert: false,
        descriptionIsComplete: true, fields,
      },
    })],
  })
  flushFrames()
}

// The box holding the Body field's value.
const bodyBox = () =>
  [...document.querySelectorAll('pre')].find(pre => pre.textContent === 'Full body text')

// The text a screen reader announces as the Approve button's description.
function approveDescribedBy(): string | null {
  const approve = [...document.querySelectorAll('button')].find(b => b.textContent === 'Approve')
  if (!approve) throw new Error('No Approve button rendered')
  const ids = approve.getAttribute('aria-describedby')
  if (ids === null) return null
  return ids.split(' ').map(id => {
    const el = document.getElementById(id)
    if (!el) throw new Error(`aria-describedby names a missing element: ${id}`)
    return el.textContent ?? ''
  }).join('\n')
}

describe('Activity review request fields', () => {
  it('shows the fields in full, named by the approve button, while restricted', async () => {
    await renderReview(true)
    expect(document.body.textContent).toContain('Full body text')
    expect(document.body.textContent).not.toContain('2 fields')
    const described = approveDescribedBy()
    expect(described).toContain('a@example.com')
    expect(described).toContain('Full body text')
  })

  it('offers no disclosure while restricted, since everything it would reveal is shown', async () => {
    await renderReview(true)
    expect(document.querySelector('[aria-expanded]')).toBeNull()
    expect(bodyBox()?.className).not.toContain('max-h-56')
  })

  it('collapses the fields to a count until expanded when not restricted', async () => {
    await renderReview(false)
    expect(document.body.textContent).toContain('2 fields')
    expect(document.body.textContent).not.toContain('Full body text')
    expect(document.querySelector('[aria-expanded="false"]')).not.toBeNull()
  })
})

describe('Activity review request after an unsuccessful attempt', () => {
  const approveButton = () => [...document.querySelectorAll('button')].find(b => b.textContent === 'Approve')

  async function renderAttempted(lastAttempt: NonNullable<Parameters<typeof entry>[1]>['lastAttempt']) {
    const server = makeOverseer()
    await view.render(<Activity overseer={server.overseer} restricted={false} view="review" onViewChange={() => {}} />)
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [entry(1, { lastAttempt })] })
    flushFrames()
  }

  it('shows an unknown outcome that cannot be repeated, and offers only Deny', async () => {
    await renderAttempted({ outcome: 'unknown', message: 'Lost after sending.', retryable: false, at: new Date(1700000200000) })
    expect(document.body.textContent).toContain('It cannot be sent again: check it at the provider, then deny it.')
    expect(approveButton()?.disabled).toBe(true)
    expect([...document.querySelectorAll('button')].find(b => b.textContent === 'Deny')?.disabled).toBe(false)
  })

  it('offers neither Approve nor Always approve for a refusal without an explicit retry', async () => {
    const server = makeOverseer()
    await view.render(<Activity overseer={server.overseer} restricted={false} view="review" onViewChange={() => {}} />)
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [entry(1, {
      gatekeeperId: 7,
      description: { title: 'Move', description: '', implementsRevert: false, autoApprovable: true,
        actionKind: { tag: 'move', label: 'Move' } },
      lastAttempt: { outcome: 'notApplied', message: 'Denied.', at: new Date(1700000200000) },
    })] })
    flushFrames()
    expect(approveButton()?.disabled).toBe(true)
    expect(document.body.textContent).not.toContain('Always approve')
    expect(document.body.textContent).toContain('It cannot be approved again here: deny it.')
  })

  it('keeps Approve for an attempt that may be repeated, with its reason shown', async () => {
    await renderAttempted({ outcome: 'unknown', message: 'Briefly unreachable.', retryable: true, at: new Date(1700000200000) })
    expect(document.body.textContent).toContain('Briefly unreachable.')
    expect(approveButton()?.disabled).toBe(false)
  })
})

describe('history', () => {
  it('shows a failed action as failed, and one whose outcome is unknown as unknown, never as approved', async () => {
    const server = makeOverseer()
    await view.render(<Activity overseer={server.overseer} restricted={false} view="history" onViewChange={() => {}} />)
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [] })
    await server.resolvePage({
      entries: [
        entry(2, { state: 'failed', resolvedBy: { type: 'user', id: 'u', name: 'U' },
          lastAttempt: { outcome: 'notApplied', message: 'Policy denies it.', at: new Date(1700000300000) } }),
        entry(1, { lastAttempt: { outcome: 'unknown', message: 'Timed out after sending.', at: new Date(1700000200000) } }),
      ],
    })
    flushFrames()
    const text = document.body.textContent ?? ''
    expect(text).toContain('Failed')
    expect(text).toContain('Outcome unknown')
    expect(text).not.toContain('Approved')
  })

  it('keeps a denied action\'s uncertainty in restored history, with approval closed', async () => {
    const server = makeOverseer()
    await view.render(<Activity overseer={server.overseer} restricted={false} view="history" onViewChange={() => {}} />)
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [] })
    await server.resolvePage({ entries: [entry(3, {
      state: 'rejected', resolvedBy: { type: 'user', id: 'u', name: 'U' },
      lastAttempt: { outcome: 'unknown', message: 'Timed out after sending.', retryable: false, at: new Date(1700000300000) },
    })] })
    flushFrames()
    expect(document.body.textContent).toContain('Denied, may have applied')
    // The notice shows once the row is opened.
    const row = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('Action 3'))
    act(() => row!.click())
    flushFrames()
    const text = document.body.textContent ?? ''
    expect(text).toContain('local approval is closed')
    expect(text).not.toContain('deny it')
  })
})
