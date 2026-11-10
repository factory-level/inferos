// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('@cloudflare/kumo')
  const toasts = { add: vi.fn<(options: unknown) => void>() }
  return { ...actual, useKumoToastManager: () => toasts }
})
// The signed-in person, null unless a test says who: a run they asked for says so (FAC-119).
const viewer = vi.hoisted(() => ({ currentUser: null as { id: string; name: string } | null }))
vi.mock('./AuthContext', () => {
  const api = { listGatekeeperVendors: async () => [], getAvatar: async () => null }
  return {
    useAuthenticatedApi: () => ({ authenticatedApi: api, currentUser: viewer.currentUser }),
    useOptionalAuthenticatedApi: () => null,
  }
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

  it('says a run the viewer asked for is theirs, here as in Needs your approval (FAC-119)', async () => {
    viewer.currentUser = { id: 'viewer-profile', name: 'Vi' }
    const server = makeOverseer()
    await view.render(<Activity overseer={server.overseer} restricted={false} view="review" onViewChange={() => {}} />)
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [entry(1, {
      context: { kind: 'workflow-run', hookId: 7, assigned: false, requestedBy: 'viewer-profile', triggerLabel: 'Refund' },
    } as never)] })
    flushFrames()
    expect(document.body.textContent).toContain('From a run of the workflow trigger “Refund”, which you asked for')
    expect(document.body.textContent).not.toContain('another person asked for')
    viewer.currentUser = null
  })

  it('shows an unknown outcome that cannot be repeated, and offers only Deny', async () => {
    await renderAttempted({ outcome: 'unknown', message: 'Lost after sending.', retryable: false, at: new Date(1700000200000) })
    expect(document.body.textContent).toContain('It cannot be sent again: check it at the service, then deny it.')
    expect(document.body.textContent).not.toContain('Lost after sending.')
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
    // Its reason in the decision's words (FAC-119), never the provider's own.
    expect(document.body.textContent).toContain('It may or may not have been applied. Check before making it again.')
    expect(document.body.textContent).not.toContain('Briefly unreachable.')
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

// FAC-97: one vocabulary for where an action stands. Queued is waiting, an apply in flight is
// applying, and only an applied action says Applied, with what the provider reported.
describe('outcomes', () => {
  async function renderHistory(entries: Parameters<typeof entry>[]) {
    const server = makeOverseer()
    await view.render(<Activity overseer={server.overseer} restricted={false} view="history" onViewChange={() => {}} />)
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [] })
    await server.resolvePage({ entries: entries.map(([id, more]) => entry(id, more)) })
    flushFrames()
    return document.body.textContent ?? ''
  }

  it('never reads a queued or applying action as applied', async () => {
    const text = await renderHistory([[2, { applying: true }], [1, {}]])
    expect(text).toContain('Applying, not done yet')
    expect(text).toContain('Waiting for approval')
    expect(text).not.toContain('Applied')
    expect(text).not.toContain('Approved')
  })

  it('says Applied for an applied action, with the result the provider reported', async () => {
    const text = await renderHistory([[1, { state: 'approved', appliedAt: new Date(1700000300000),
      resolvedBy: { type: 'user', id: 'u', name: 'U' }, result: { createdIdentifier: 'ENG-7', appliedRevision: '2' } }]])
    expect(text).toContain('Applied')
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!.click() })
    flushFrames()
    const expanded = document.querySelector('[aria-label="What the provider reported"]')?.textContent ?? ''
    expect(expanded).toContain('createdIdentifier:ENG-7')
    expect(expanded).toContain('appliedRevision:2')
  })
})
