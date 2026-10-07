// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { ActionLogEntry, Overseer } from '@gadgets/workshop-shared/api'
import type { OperateEvent, OperatePageState } from '@gadgets/workshop-shared/operate-session'

const auth = vi.hoisted(() => {
  const holder = { openGadget: (() => { throw new Error('unset') }) as (id: string) => unknown, context: {} }
  // Stable, as the real context is: the screen workspace reopens when the API changes.
  holder.context = { authenticatedApi: { openGadget: (id: string) => holder.openGadget(id) } }
  return holder
})
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => auth.context }))
const boards = vi.hoisted(() => ({ invalidated: [] as string[] }))
vi.mock('../canvas/useBoardData', () => ({
  useDecidedActionInvalidationInEveryScope: () => {},
  invalidateBoardInEveryScope: (targetRef: string) => { boards.invalidated.push(targetRef) },
}))

import { entry, flushFrames, makeOverseer, makeTestRoot } from '../../action-test-harness'
import { SessionApprovals } from './SessionApprovals'

const view = makeTestRoot()

afterEach(() => {
  view.cleanup()
  vi.restoreAllMocks()
  boards.invalidated = []
})

const MOVE = entry(4, {
  resourceTitle: 'DEMO board',
  resourceUrl: 'inferops://demo.local/project/board/DEMO',
  requestedBy: 'agent',
  description: { title: 'Move DEMO-1 to Done', description: 'Moves DEMO-1 from Doing to Done.', implementsRevert: false },
})

const REF = { workspaceId: 'ops', actionId: 4 }

/** Renders the session's approvals over a session workspace with MOVE pending. */
async function renderPending(page: Partial<Pick<OperatePageState, 'reviewing' | 'lastApprovalOutcome'>> = {},
                             pendingEntry: ActionLogEntry = MOVE) {
  const server = makeOverseer()
  const approveAction = vi.fn<(id: number) => Promise<void>>(async () => {})
  const rejectAction = vi.fn<(id: number) => Promise<void>>(async () => {})
  Object.assign(server.overseer as object, { approveAction, rejectAction })
  const onEvent = vi.fn<(event: OperateEvent) => Promise<void>>(async () => {})
  const show = (next: Partial<Pick<OperatePageState, 'reviewing' | 'lastApprovalOutcome'>>) => view.render(
    <SessionApprovals session={{ stub: server.overseer, id: 'ops', restricted: false }} screenWorkspaceId={null}
      reviewing={next.reviewing ?? null} lastOutcome={next.lastApprovalOutcome ?? null} onEvent={onEvent} />,
  )
  await show(page)
  await server.resolveSubscription()
  await server.resolvePendingQuery({ entries: [pendingEntry] })
  flushFrames()
  return { server, approveAction, rejectAction, onEvent, show }
}

const button = (label: string) => {
  const found = [...document.querySelectorAll('button')].find(b => b.textContent === label)
  if (!found) throw new Error(`No ${label} button`)
  return found
}

const status = () => document.querySelector('[role="status"]')?.textContent ?? ''

describe('SessionApprovals', () => {
  it('lists a pending action with its resource and who asked for it', async () => {
    await renderPending()
    const text = document.body.textContent ?? ''
    expect(text).toContain('Move DEMO-1 to Done')
    expect(text).toContain('DEMO board')
    expect(text).toContain('Requested by the agent')
  })

  it('opens an action for review through the session', async () => {
    const { approveAction, onEvent } = await renderPending()
    const open = document.querySelector<HTMLButtonElement>('button[aria-expanded]')!
    expect(open.getAttribute('aria-expanded')).toBe('false')
    await act(async () => open.click())
    expect(onEvent).toHaveBeenCalledWith({ type: 'reviewApproval', approval: REF })
    expect(approveAction).not.toHaveBeenCalled()
  })

  it('shows the full request of the action under review', async () => {
    await renderPending({ reviewing: REF })
    expect(document.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('true')
    expect(document.body.textContent).toContain('Moves DEMO-1 from Doing to Done.')
  })

  it('reports applied only once the log shows the action approved', async () => {
    const { server, approveAction, onEvent } = await renderPending()
    await act(async () => button('Approve').click())

    expect(approveAction).toHaveBeenCalledWith(4)
    // Approval returned, but its result has not been read back yet: nothing is reported resolved.
    expect(onEvent.mock.calls.map(([event]) => event)).toEqual([{ type: 'reviewApproval', approval: REF }])
    expect(status()).toBe('')

    await server.resolvePage({ entries: [entry(4, { state: 'approved' })] })
    expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: 'reviewApproval', approval: REF },
      { type: 'approvalResolved', approval: REF, outcome: 'applied' },
    ])
    expect(server.listCalls).toEqual([{ beforeId: 5 }])
    expect(status()).toContain('approved and applied')
  })

  it('reports a refused apply as failed, with the gatekeeper’s message', async () => {
    const { server, approveAction, onEvent } = await renderPending({ reviewing: REF })
    approveAction.mockRejectedValueOnce(new Error('STALE_REVISION: the board changed since this move was proposed'))
    await act(async () => button('Approve').click())
    await server.resolvePage({ entries: [MOVE] })

    // Already under review, so only the outcome is reported.
    expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: 'approvalResolved', approval: REF, outcome: 'failed' },
    ])
    expect(status()).toContain('STALE_REVISION: the board changed since this move was proposed')
    expect(status()).not.toContain('approved and applied')
    // The action stays pending, so no decided entry re-reads its board: it is re-read here.
    expect(boards.invalidated).toEqual(['inferops://demo.local/project/board/DEMO'])
  })

  it('reports a rejection', async () => {
    const { server, rejectAction, onEvent } = await renderPending()
    await act(async () => button('Deny').click())
    await server.resolvePage({ entries: [entry(4, { state: 'rejected' })] })

    expect(rejectAction).toHaveBeenCalledWith(4)
    expect(onEvent).toHaveBeenLastCalledWith({ type: 'approvalResolved', approval: REF, outcome: 'rejected' })
    expect(status()).toContain('was rejected')
  })

  it('offers only Deny for an attempt that was not explicitly retryable, and Approve for one that was', async () => {
    const attempted = (retryable?: boolean) => ({ ...MOVE, lastAttempt: {
      outcome: 'notApplied', message: 'Denied.', at: new Date(), ...(retryable === undefined ? {} : { retryable }),
    } }) as ActionLogEntry
    await renderPending({}, attempted())
    expect((button('Approve') as HTMLButtonElement).disabled).toBe(true)
    expect((button('Deny') as HTMLButtonElement).disabled).toBe(false)
    view.cleanup()
    await renderPending({}, attempted(true))
    expect((button('Approve') as HTMLButtonElement).disabled).toBe(false)
  })

  it('keeps the uncertainty of a rejection after an unknown attempt, here and when restored', async () => {
    const uncertain = { ...MOVE, lastAttempt: { outcome: 'unknown', message: 'Lost.', retryable: false, at: new Date() } } as ActionLogEntry
    const { server } = await renderPending({}, uncertain)
    await act(async () => button('Deny').click())
    await server.resolvePage({ entries: [{ ...uncertain, state: 'rejected' } as ActionLogEntry] })
    expect(status()).toContain('was rejected. It may already have been applied')
    expect(status()).toContain('local approval is closed')
    view.cleanup()

    const restored = await renderPending({ lastApprovalOutcome: { workspaceId: 'ops', actionId: 2, outcome: 'rejected' } })
    await restored.server.resolvePage({ entries: [entry(2, {
      state: 'rejected', appliedAt: new Date(Date.now() - 30_000),
      lastAttempt: { outcome: 'unknown', message: 'Lost.', retryable: false, at: new Date(Date.now() - 30_000) },
      description: { title: 'Update DEMO-1: priority', description: '', implementsRevert: false },
    })] })
    expect(document.body.textContent).toContain('“Update DEMO-1: priority” was rejected. It may already have been applied')
    expect(document.body.textContent).toContain('local approval is closed')
  })

  it('shows the newer rejection elsewhere with its uncertainty, after a refusal and an unknown retry here', async () => {
    const attempted = (outcome: 'notApplied' | 'unknown', message: string, state = 'pending') => ({
      ...MOVE, state, lastAttempt: { outcome, message, retryable: true, at: new Date() },
    }) as ActionLogEntry
    const { server, approveAction, show } = await renderPending({ reviewing: REF })

    // The first attempt is refused for now (it may pass), so Operate reads and keeps that entry.
    approveAction.mockRejectedValueOnce(new Error('Not yet.'))
    await act(async () => button('Approve').click())
    await server.resolvePage({ entries: [attempted('notApplied', 'Not yet.')] })
    await show({ reviewing: REF, lastApprovalOutcome: { ...REF, outcome: 'failed' } })
    await server.resolvePage({ entries: [attempted('notApplied', 'Not yet.')] })

    // The retry's outcome is unknown.
    approveAction.mockRejectedValueOnce(new Error('Lost after sending.'))
    await act(async () => button('Approve').click())
    await server.resolvePage({ entries: [attempted('unknown', 'Lost after sending.')] })
    await show({ reviewing: REF, lastApprovalOutcome: { ...REF, outcome: 'failed' } })
    expect(status()).toContain('Lost after sending.')

    // Another tab rejects it: the newer outcome wins over this tab's notice, read afresh.
    await show({ reviewing: REF, lastApprovalOutcome: { ...REF, outcome: 'rejected' } })
    await server.resolvePage({ entries: [attempted('unknown', 'Lost after sending.', 'rejected')] })
    expect(status()).toContain('“Move DEMO-1 to Done” was rejected.')
    expect(status()).toContain('It may already have been applied')
    expect(status()).toContain('local approval is closed')
    expect(status()).not.toContain('Not yet.')
  })

  it('reports nothing resolved when a rejection is refused', async () => {
    const { server, rejectAction, onEvent } = await renderPending()
    rejectAction.mockRejectedValueOnce(new Error('Unauthorized'))
    await act(async () => button('Deny').click())
    await server.resolvePage({ entries: [MOVE] })

    expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual(['reviewApproval'])
    expect(status()).toContain('was not resolved: Unauthorized')
  })

  it('shows the outcome restored on load with the action\'s title and age, without announcing it', async () => {
    const { server } = await renderPending({ lastApprovalOutcome: { workspaceId: 'ops', actionId: 2, outcome: 'rejected' } })
    await server.resolvePage({ entries: [entry(2, {
      state: 'rejected', appliedAt: new Date(Date.now() - 30_000),
      description: { title: 'Update DEMO-1: priority', description: '', implementsRevert: false },
    })] })
    expect(server.listCalls).toEqual([{ beforeId: 3 }])
    expect(document.body.textContent).toContain('“Update DEMO-1: priority” was rejected. · just now')
    expect(document.body.textContent).not.toContain('Action 2')
    expect(status()).toBe('')
  })

  it('drops a restored outcome that is no longer recent', async () => {
    const { server } = await renderPending({ lastApprovalOutcome: { workspaceId: 'ops', actionId: 2, outcome: 'applied' } })
    await server.resolvePage({ entries: [entry(2, { state: 'approved', appliedAt: new Date(Date.now() - 10 * 60_000) })] })
    expect(document.body.textContent).not.toContain('was approved and applied')
    expect(status()).toBe('')
  })

  it('announces an outcome reported after load under the action\'s title', async () => {
    const { server, show } = await renderPending()
    await show({ lastApprovalOutcome: { workspaceId: 'ops', actionId: 4, outcome: 'applied' } })
    expect(status()).toBe('')
    await server.resolvePage({ entries: [{ ...MOVE, state: 'approved', appliedAt: new Date() } as ActionLogEntry] })
    expect(status()).toBe('“Move DEMO-1 to Done” was approved and applied.')
  })

  it('renders nothing for a workspace the viewer may only use', async () => {
    const stub = { getMetadata: async () => ({ id: 'ws1', title: 'Board', role: 'use' }), [Symbol.dispose]: () => {} }
    const openGadget = vi.fn<(id: string) => unknown>(() => stub)
    auth.openGadget = openGadget
    await view.render(
      <SessionApprovals session={null} screenWorkspaceId="ws1" reviewing={null} lastOutcome={null} onEvent={async () => {}} />,
    )
    await act(async () => {})
    expect(openGadget).toHaveBeenCalledWith('ws1')
    expect(document.body.querySelector('section')).toBeNull()
    expect(document.body.querySelectorAll('button')).toHaveLength(0)
  })

  it('lists the focused screen workspace’s pending actions beside the session’s', async () => {
    const screen = makeOverseer()
    Object.assign(screen.overseer as object, {
      getMetadata: async () => ({ id: 'ws1', title: 'Shift board', role: 'build' }),
    })
    auth.openGadget = () => screen.overseer as RpcStub<Overseer>
    const session = makeOverseer()
    await view.render(
      <SessionApprovals session={{ stub: session.overseer, id: 'ops', restricted: false }} screenWorkspaceId="ws1"
        reviewing={null} lastOutcome={null} onEvent={async () => {}} />,
    )
    await act(async () => {})
    await session.resolveSubscription()
    await session.resolvePendingQuery({ entries: [] })
    await screen.resolveSubscription()
    await screen.resolvePendingQuery({ entries: [entry(9, { requestedBy: 'person', resourceTitle: 'DEMO board' })] })
    flushFrames()
    const text = document.body.textContent ?? ''
    expect(text).toContain('Action 9')
    expect(text).toContain('Requested by a person')
    expect(text).toContain('in Shift board')
  })
})
