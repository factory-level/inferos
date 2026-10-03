// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { OperateEvent, OperatePageState } from '@gadgets/workshop-shared/operate-session'

const auth = vi.hoisted(() => {
  const holder = { openGadget: (() => { throw new Error('unset') }) as (id: string) => unknown, context: {} }
  // Stable, as the real context is: the screen workspace reopens when the API changes.
  holder.context = { authenticatedApi: { openGadget: (id: string) => holder.openGadget(id) } }
  return holder
})
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => auth.context }))

import { entry, flushFrames, makeOverseer, makeTestRoot } from '../../action-test-harness'
import { SessionApprovals } from './SessionApprovals'

const view = makeTestRoot()

afterEach(() => {
  view.cleanup()
  vi.restoreAllMocks()
})

const MOVE = entry(4, {
  resourceTitle: 'DEMO board',
  requestedBy: 'agent',
  description: { title: 'Move DEMO-1 to Done', description: 'Moves DEMO-1 from Doing to Done.', implementsRevert: false },
})

const REF = { workspaceId: 'ops', actionId: 4 }

/** Renders the session's approvals over a session workspace with MOVE pending. */
async function renderPending(page: Partial<Pick<OperatePageState, 'reviewing' | 'lastApprovalOutcome'>> = {}) {
  const server = makeOverseer()
  const approveAction = vi.fn<(id: number) => Promise<void>>(async () => {})
  const rejectAction = vi.fn<(id: number) => Promise<void>>(async () => {})
  Object.assign(server.overseer as object, { approveAction, rejectAction })
  const onEvent = vi.fn<(event: OperateEvent) => Promise<void>>(async () => {})
  await view.render(
    <SessionApprovals session={{ stub: server.overseer, id: 'ops', restricted: false }} screenWorkspaceId={null}
      reviewing={page.reviewing ?? null} lastOutcome={page.lastApprovalOutcome ?? null} onEvent={onEvent} />,
  )
  await server.resolveSubscription()
  await server.resolvePendingQuery({ entries: [MOVE] })
  flushFrames()
  return { server, approveAction, rejectAction, onEvent }
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
  })

  it('reports a rejection', async () => {
    const { server, rejectAction, onEvent } = await renderPending()
    await act(async () => button('Deny').click())
    await server.resolvePage({ entries: [entry(4, { state: 'rejected' })] })

    expect(rejectAction).toHaveBeenCalledWith(4)
    expect(onEvent).toHaveBeenLastCalledWith({ type: 'approvalResolved', approval: REF, outcome: 'rejected' })
    expect(status()).toContain('was rejected')
  })

  it('reports nothing resolved when a rejection is refused', async () => {
    const { server, rejectAction, onEvent } = await renderPending()
    rejectAction.mockRejectedValueOnce(new Error('Unauthorized'))
    await act(async () => button('Deny').click())
    await server.resolvePage({ entries: [MOVE] })

    expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual(['reviewApproval'])
    expect(status()).toContain('was not resolved: Unauthorized')
  })

  it('shows the last outcome the session recorded', async () => {
    await renderPending({ lastApprovalOutcome: { workspaceId: 'ops', actionId: 2, outcome: 'rejected' } })
    expect(status()).toBe('“Action 2” was rejected.')
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
