// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// FAC-9: a governed table on a canvas, read through the host's Refine provider over the session
// Overseer.openGovernedSession opens. It names each state (opening, not connected, no longer
// allowed, a failure in the server's words, no rows), pages on the server, proposes a declared
// command for a decision and says so, and never reports to Refine's telemetry service.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { GovernedSessionHandle, Overseer } from '@gadgets/workshop-shared/api'
import type { CanvasGovernedTableWidget as Widget } from '@gadgets/workshop-shared/canvas'
import type { GovernedDescription, GovernedListResult, GovernedRow, GovernedWriteSession } from '@gadgets/workshop-shared/governed-data'
import { CanvasGovernedTableWidget, GOVERNED_PAGE_SIZE, GOVERNED_REFINE_OPTIONS } from './CanvasGovernedTableWidget'

const REF = 'tickets://support/queue/billing'
const WIDGET: Widget = { id: 'q', kind: 'inferos.governed-table', version: 1, targetRef: REF, size: 'wide', params: {},
  dataBinding: { resource: 'tickets/queue', ref: REF, schemaVersion: 1 } }
const QUEUE: GovernedDescription = {
  resource: 'tickets/queue',
  fields: [
    { name: 'title', label: 'Title', type: 'text', filterable: true, sortable: true },
    { name: 'status', label: 'Status', type: 'text', filterable: true, sortable: true, options: ['open', 'pending', 'closed'] },
  ],
  commands: [{ name: 'setStatus', label: 'Change status', fields: ['status'] }],
}
const ticket = (n: number): GovernedRow => ({ id: `T-${n}`, values: { title: `Ticket ${n}`, status: 'open' }, revision: '1' })

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
const button = (name: string) => [...container.querySelectorAll('button')].find(item => item.textContent === name)

/** A queue session over `rows`, recording what it's asked. */
function queue(rows: GovernedRow[], overrides: Partial<GovernedSessionHandle['session']> = {}) {
  const calls: unknown[] = []
  const session = {
    describe: async () => QUEUE,
    list: vi.fn<GovernedWriteSession['list']>(async (request: unknown): Promise<GovernedListResult> => {
      calls.push(request)
      const { pageSize = 25, cursor } = request as { pageSize?: number; cursor?: string }
      const offset = cursor === undefined ? 0 : Number(cursor)
      return { rows: rows.slice(offset, offset + pageSize), nextCursor: offset + pageSize < rows.length ? String(offset + pageSize) : null, total: rows.length, truncated: false }
    }),
    get: async () => null,
    command: vi.fn<GovernedWriteSession['command']>(async () => ({
      outcome: 'proposed' as const, actionId: 'test-action', status: async () => ({ outcome: 'waiting' as const }),
    })),
    [Symbol.dispose]: vi.fn<() => void>(),
    ...overrides,
  }
  return { session, calls }
}

async function render(openGovernedSession: Overseer['openGovernedSession']) {
  const overseer = { openGovernedSession } as unknown as RpcStub<Overseer>
  await act(async () => root.render(<CanvasGovernedTableWidget widget={WIDGET} overseer={overseer} />))
  await settle()
}

it('shows the rows through the governed session, and pages on the server', async () => {
  const fetchSpy = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetchSpy)
  const { session, calls } = queue(Array.from({ length: GOVERNED_PAGE_SIZE + 2 }, (_, i) => ticket(i + 1)))
  const open = vi.fn<Overseer['openGovernedSession']>(async () => ({ gatekeeperId: 4, resource: 'tickets/queue' as const, session }))
  await render(open)
  expect(open).toHaveBeenCalledWith(REF)
  expect([...container.querySelectorAll('th')].map(cell => cell.textContent)).toEqual(['Title', 'Status', 'Propose'])
  expect(container.querySelectorAll('tbody tr')).toHaveLength(GOVERNED_PAGE_SIZE)
  expect(container.textContent).toContain('Page 1 of 2')
  await act(async () => { button('Next')!.click() }); await settle()
  expect([...container.querySelectorAll('tbody tr td:first-child')].map(cell => cell.textContent)).toEqual(['Ticket 26', 'Ticket 27'])
  expect(calls).toEqual([{ filters: [], pageSize: GOVERNED_PAGE_SIZE }, { filters: [], pageSize: GOVERNED_PAGE_SIZE, cursor: String(GOVERNED_PAGE_SIZE) }])
  // The trusted host never reports to Refine's telemetry service.
  expect(GOVERNED_REFINE_OPTIONS.disableTelemetry).toBe(true)
  expect(fetchSpy).not.toHaveBeenCalled()
})

it('proposes a declared command for a decision, and says it is waiting, not done', async () => {
  const { session } = queue([ticket(1)])
  await render(async () => ({ gatekeeperId: 4, resource: 'tickets/queue' as const, session }))
  const field = container.querySelector<HTMLElement>('[role="combobox"]')!
  await act(async () => field.click()); await settle()
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent === 'closed')!
  // The current status isn't offered.
  expect([...document.querySelectorAll('[role="option"]')].map(item => item.textContent)).toEqual(['pending', 'closed'])
  if (!('PointerEvent' in window)) Object.defineProperty(window, 'PointerEvent', { value: class extends MouseEvent {} })
  await act(async () => {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      option.dispatchEvent(new (type.startsWith('pointer') ? window.PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true }))
    }
  })
  await settle()
  await act(async () => { button('Propose')!.click() }); await settle()
  expect(session.command).toHaveBeenCalledWith({ command: 'setStatus', id: 'T-1', values: { status: 'closed' }, expectedRevision: '1' })
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Waiting for approval, not applied yet')
  expect(button('Propose')?.disabled).toBe(true)
})

it.each([
  ['succeeded', 'Applied'],
  ['rejected', 'Rejected, not applied'],
  ['failed', 'Failed, not applied'],
  ['unknown', 'Outcome unknown: it may or may not have applied'],
] as const)('renders the terminal %s receipt and rereads the canonical row', async (outcome, message) => {
  const list = vi.fn<GovernedWriteSession['list']>(async () => ({ rows: [ticket(1)], nextCursor: null, total: 1, truncated: false }))
  const { session } = queue([ticket(1)], {
    list,
    command: vi.fn<GovernedWriteSession['command']>(async () => ({ outcome: 'proposed', actionId: 'receipt-1', status: async () => ({ outcome }) })),
  })
  await render(async () => ({ gatekeeperId: 4, resource: 'tickets/queue' as const, session }))
  await chooseClosed()
  await act(async () => { button('Propose')!.click() }); await settle()
  expect(container.querySelector('[role="status"]')?.textContent).toBe(message)
  expect(list).toHaveBeenCalledTimes(2)
  expect(button('Propose')?.disabled).toBe(false)
})

it('keeps a waiting receipt pending, then refreshes after it resolves', async () => {
  const status = vi.fn<() => Promise<{ outcome: 'waiting' | 'succeeded' }>>()
    .mockResolvedValueOnce({ outcome: 'waiting' }).mockResolvedValueOnce({ outcome: 'succeeded' })
  const list = vi.fn<GovernedWriteSession['list']>(async () => ({ rows: [ticket(1)], nextCursor: null, total: 1, truncated: false }))
  const { session } = queue([ticket(1)], { list, command: vi.fn<GovernedWriteSession['command']>(async () => ({ outcome: 'proposed', actionId: 'receipt-1', status })) })
  await render(async () => ({ gatekeeperId: 4, resource: 'tickets/queue' as const, session }))
  await chooseClosed()
  await act(async () => { button('Propose')!.click() }); await settle()
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Waiting for approval, not applied yet')
  expect(button('Propose')?.disabled).toBe(true)
  expect(list).toHaveBeenCalledTimes(1)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1_050)) }); await settle()
  expect(status).toHaveBeenCalledTimes(2)
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Applied')
  expect(list).toHaveBeenCalledTimes(2)
  expect(button('Propose')?.disabled).toBe(false)
})

it('stops polling a waiting receipt after the total attempt limit and offers status retry', async () => {
  const status = vi.fn<() => Promise<{ outcome: 'waiting' }>>().mockResolvedValue({ outcome: 'waiting' })
  const command = vi.fn<GovernedWriteSession['command']>(async () => ({ outcome: 'proposed', actionId: 'receipt-1', status }))
  const { session } = queue([ticket(1)], { command })
  await render(async () => ({ gatekeeperId: 4, resource: 'tickets/queue' as const, session }))
  await chooseClosed()
  vi.useFakeTimers()
  await act(async () => { button('Propose')!.click() })
  await act(async () => { await vi.advanceTimersByTimeAsync(100_000) })
  expect(status).toHaveBeenCalledTimes(8)
  expect(container.textContent).toContain("Could not check this operation's status. It has not been resubmitted.")
  expect(button('Retry status')).toBeTruthy()
  expect(button('Propose')?.disabled).toBe(true)
  expect(command).toHaveBeenCalledTimes(1)
  vi.useRealTimers()
})

it('retries a disconnected receipt check without resubmitting the command', async () => {
  const status = vi.fn<() => Promise<{ outcome: 'succeeded' }>>()
    .mockRejectedValueOnce(new Error('connection lost')).mockResolvedValueOnce({ outcome: 'succeeded' })
  const command = vi.fn<GovernedWriteSession['command']>(async () => ({ outcome: 'proposed', actionId: 'receipt-1', status }))
  const { session } = queue([ticket(1)], { command })
  await render(async () => ({ gatekeeperId: 4, resource: 'tickets/queue' as const, session }))
  await chooseClosed()
  await act(async () => { button('Propose')!.click() }); await settle()
  expect(container.textContent).toContain("Could not check this operation's status. It has not been resubmitted.")
  expect(container.textContent).toContain('Reload to check it in approvals.')
  await act(async () => { button('Retry status')!.click() }); await settle()
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Applied')
  expect(command).toHaveBeenCalledTimes(1)
})

it('refreshes after a stale-revision refusal and asks the person to review the row again', async () => {
  const list = vi.fn<GovernedWriteSession['list']>(async () => ({ rows: [ticket(1)], nextCursor: null, total: 1, truncated: false }))
  const command = vi.fn<GovernedWriteSession['command']>(async () => { throw new Error('STALE_REVISION: changed') })
  const { session } = queue([ticket(1)], { list, command })
  await render(async () => ({ gatekeeperId: 4, resource: 'tickets/queue' as const, session }))
  await chooseClosed()
  await act(async () => { button('Propose')!.click() }); await settle()
  expect(container.querySelector('[role="status"]')?.textContent).toContain('This row changed since it was read.')
  expect(list).toHaveBeenCalledTimes(2)
  expect(button('Propose')?.disabled).toBe(true)
})

it('keeps a known terminal receipt and clears pending when refreshing the row fails', async () => {
  const list = vi.fn<GovernedWriteSession['list']>()
    .mockResolvedValueOnce({ rows: [ticket(1)], nextCursor: null, total: 1, truncated: false })
    .mockRejectedValueOnce(new Error('connection lost'))
  const command = vi.fn<GovernedWriteSession['command']>(async () => ({ outcome: 'proposed', actionId: 'receipt-1', status: async () => ({ outcome: 'succeeded' }) }))
  const { session } = queue([ticket(1)], { list, command })
  await render(async () => ({ gatekeeperId: 4, resource: 'tickets/queue' as const, session }))
  await chooseClosed()
  await act(async () => { button('Propose')!.click() }); await settle()
  expect(container.textContent).toContain('Applied: The outcome is known, but the row could not be refreshed.')
  expect(button('Propose')?.disabled).toBe(false)
  expect(command).toHaveBeenCalledTimes(1)
})

it('keeps a stale refusal visible and disables proposing when refreshing the row fails', async () => {
  const list = vi.fn<GovernedWriteSession['list']>()
    .mockResolvedValueOnce({ rows: [ticket(1)], nextCursor: null, total: 1, truncated: false })
    .mockRejectedValueOnce(new Error('connection lost'))
  const command = vi.fn<GovernedWriteSession['command']>(async () => { throw new Error('STALE_REVISION: changed') })
  const { session } = queue([ticket(1)], { list, command })
  await render(async () => ({ gatekeeperId: 4, resource: 'tickets/queue' as const, session }))
  await chooseClosed()
  await act(async () => { button('Propose')!.click() }); await settle()
  expect(container.textContent).toContain('The row could not be refreshed; reload to read it before proposing again.')
  expect(button('Propose')?.disabled).toBe(true)
  expect(command).toHaveBeenCalledTimes(1)
})

it('preserves a stale-revision failure receipt and refreshes its row', async () => {
  const list = vi.fn<GovernedWriteSession['list']>(async () => ({ rows: [ticket(1)], nextCursor: null, total: 1, truncated: false }))
  const { session } = queue([ticket(1)], {
    list,
    command: vi.fn<GovernedWriteSession['command']>(async () => ({ outcome: 'proposed', actionId: 'receipt-1', status: async () => ({
      outcome: 'failed', code: 'STALE_REVISION', reason: 'It changed since it was read. Read it again before changing it.',
    }) })),
  })
  await render(async () => ({ gatekeeperId: 4, resource: 'tickets/queue' as const, session }))
  await chooseClosed()
  await act(async () => { button('Propose')!.click() }); await settle()
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Failed, not applied: It changed since it was read.')
  expect(container.querySelector('[role="status"]')?.textContent).toContain('The row was refreshed; review it before proposing again.')
  expect(list).toHaveBeenCalledTimes(2)
})

async function chooseClosed() {
  const field = container.querySelector<HTMLElement>('[role="combobox"]')!
  await act(async () => field.click()); await settle()
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent === 'closed')!
  if (!('PointerEvent' in window)) Object.defineProperty(window, 'PointerEvent', { value: class extends MouseEvent {} })
  await act(async () => {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      option.dispatchEvent(new (type.startsWith('pointer') ? window.PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true }))
    }
  })
  await settle()
}

it('says when no connection serves the reference', async () => {
  await render(async () => null)
  expect(container.textContent).toContain('Not connected: this workspace holds no connection for this resource.')
})

it('says when the reader may no longer read it, and discards what it read, then tries again on request', async () => {
  const { session } = queue([ticket(1)], { list: vi.fn<GovernedWriteSession['list']>(async () => { throw new Error('UNAUTHORIZED: Your InferOps sign-in has ended.') }) })
  const open = vi.fn<Overseer['openGovernedSession']>(async () => ({ gatekeeperId: 4, resource: 'tickets/queue' as const, session }))
  await render(open)
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('You can no longer read this resource here: UNAUTHORIZED: Your InferOps sign-in has ended.')
  expect(container.querySelector('table')).toBeNull()
  await act(async () => { button('Try again')!.click() }); await settle()
  expect(open).toHaveBeenCalledTimes(2)
})

it("shows a read's refusal in the server's words, and says when there are no rows", async () => {
  const { session } = queue([], { list: vi.fn<GovernedWriteSession['list']>(async () => { throw new Error('INVALID_REQUEST: That field can\'t be filtered on.') }) })
  await render(async () => ({ gatekeeperId: 4, resource: 'tickets/queue' as const, session }))
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("INVALID_REQUEST: That field can't be filtered on.")
  await act(async () => root.render(<></>))
  const empty = queue([])
  await render(async () => ({ gatekeeperId: 4, resource: 'tickets/queue' as const, session: empty.session }))
  expect(container.textContent).toContain('No rows.')
})

it('says it is opening the resource until the session arrives', async () => {
  await render(() => new Promise(() => {}))
  expect(container.querySelector('[aria-busy="true"]')?.textContent).toBe('Opening this resource…')
})
