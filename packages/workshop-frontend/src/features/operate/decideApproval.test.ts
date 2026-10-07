import { describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { ActionLogEntry, ActionState, Overseer } from '@gadgets/workshop-shared/api'
import { decideApproval } from './decideApproval'

const logged = (state: ActionState) =>
  ({ id: 4, state, type: 'action', resourceTitle: 'Board', createdAt: new Date() }) as ActionLogEntry

type Page = { entries: ActionLogEntry[] }

const overseer = (over: { approve?: () => Promise<void>; list?: () => Promise<Page> }) => ({
  approveAction: vi.fn<() => Promise<void>>(over.approve ?? (async () => {})),
  rejectAction: vi.fn<() => Promise<void>>(async () => {}),
  listActions: vi.fn<() => Promise<Page>>(over.list ?? (async () => ({ entries: [] }))),
}) as unknown as RpcStub<Overseer>

describe('decideApproval', () => {
  it('never reports applied when the result cannot be read back', async () => {
    const result = await decideApproval(overseer({ list: async () => { throw new Error('connection lost') } }), 4, 'approve')
    expect(result).toEqual({ outcome: null, error: 'The decision was sent, but its result could not be read: connection lost' })
  })

  it('never reports applied while the log still shows the action pending', async () => {
    const result = await decideApproval(overseer({ list: async () => ({ entries: [logged('pending')] }) }), 4, 'approve')
    expect(result.outcome).toBeNull()
  })

  it('reports a provider refusal as failed, with the reason the log kept', async () => {
    const result = await decideApproval(overseer({
      approve: async () => { throw new Error('refused') },
      list: async () => ({ entries: [{ ...logged('failed'),
        lastAttempt: { outcome: 'notApplied', message: 'Policy denies it.', at: new Date() } } as ActionLogEntry] }),
    }), 4, 'approve')
    expect(result).toEqual({ outcome: 'failed', error: 'Policy denies it.' })
  })

  it('reports an unknown outcome as neither applied nor failed, only as a warning', async () => {
    const result = await decideApproval(overseer({
      approve: async () => { throw new Error('timed out') },
      list: async () => ({ entries: [{ ...logged('pending'),
        lastAttempt: { outcome: 'unknown', message: 'Timed out after sending.', at: new Date() } } as ActionLogEntry] }),
    }), 4, 'approve')
    expect(result).toEqual({ outcome: null, error: 'It may already have been applied; the outcome is unknown: Timed out after sending.' })
  })

  it('reports what the log says when someone else decided first', async () => {
    const result = await decideApproval(overseer({
      approve: async () => { throw new Error('Action is not pending: 4') },
      list: async () => ({ entries: [logged('rejected')] }),
    }), 4, 'approve')
    expect(result).toEqual({ outcome: 'rejected' })
  })
})
