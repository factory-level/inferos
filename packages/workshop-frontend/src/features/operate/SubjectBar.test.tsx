// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import {
  createOperateSessionError, OPERATE_SESSION_ERROR_CODES, type OperateSession, type OperateSubjectAuditPage,
  type OperateSubjectParticipant, type PresenceSubscriber,
} from '@gadgets/workshop-shared/api'
import type { OperateBoardView } from '@gadgets/workshop-shared/operate-session'

vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ currentUser: { type: 'user', id: 'me', name: 'Me' } }) }))
vi.mock('@cloudflare/kumo', async importOriginal =>
  (await import('../canvas/kumoPopupDoubles')).withKumoPopupDoubles(await importOriginal<object>()))

import { SubjectBar } from './SubjectBar'
import { dialogField, setFieldValue } from '../canvas/kumoPopupDoubles'

const ENG: OperateBoardView = { workspaceId: 'session', boardRef: 'inferops://acme.operations/project/board/ENG', issueId: null }
const WEB: OperateBoardView = { workspaceId: 'session', boardRef: 'inferops://acme.operations/project/board/WEB', issueId: null }
const person = (id: string, issueId: string | null = null, key = id): OperateSubjectParticipant =>
  ({ key, user: { type: 'user', id, name: id.toUpperCase() }, issueId })

/** Each subject's roster and audit, as the kernel would serve them. */
let rosters: Record<string, OperateSubjectParticipant[]>
let audits: Record<string, OperateSubjectAuditPage>
let joined: string[]
let left: string[]
let shown: OperateBoardView
const handOver = vi.fn<(recipient: string, note: string) => Promise<unknown>>()
const listSubjectAudit = vi.fn<(board: { boardRef: string }) => Promise<OperateSubjectAuditPage>>()
const session = {
  stub: {
    // The kernel joins the board the session shows, never one the client names.
    subscribeToSubjectPresence: (roster: PresenceSubscriber<OperateSubjectParticipant>) => {
      const ref = shown.boardRef
      joined.push(ref)
      roster.init(rosters[ref] ?? [])
      return Promise.resolve({ [Symbol.dispose]: () => { left.push(ref) } })
    },
    listSubjectAudit,
    handOver,
  } as unknown as RpcStub<OperateSession>,
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  rosters = {}; audits = {}; joined = []; left = []; handOver.mockReset()
  listSubjectAudit.mockReset().mockImplementation(board => Promise.resolve(audits[board.boardRef] ?? { events: [], actions: [] }))
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

const render = (board: OperateBoardView) => {
  shown = board
  return act(async () => root.render(<SubjectBar board={board} session={session} />))
}
const button = (text: string) => [...container.querySelectorAll('button')].find(b => b.textContent === text)!
const presence = () => container.querySelector('[role="status"]')?.textContent

it('shows the others on the board and what each has open, never the viewer', async () => {
  rosters[ENG.boardRef] = [person('me'), person('bob', 'issue-1'), person('carol')]
  await render({ ...ENG, issueId: 'issue-1' })
  expect(presence()).toBe('Also here: BOB (on this issue), CAROL (on the board)')
  rosters[WEB.boardRef] = [person('me')]
  await render(WEB)
  expect(presence()).toBe('No one else has this board open.')
})

it('switching subject leaves the old roster and carries nothing of its audit over', async () => {
  rosters[ENG.boardRef] = [person('me'), person('bob')]
  audits[ENG.boardRef] = {
    events: [{ seq: 4, event: { type: 'openBoard', board: ENG }, actor: 'person', at: new Date(), subject: ENG.boardRef }],
    actions: [{
      id: 9, type: 'observation', resourceTitle: 'ENG', resourceUrl: ENG.boardRef, createdAt: new Date(), state: 'approved',
      requestedBy: 'agent', description: { title: 'Read the ENG board' },
    } as never],
  }
  await render(ENG)
  await act(async () => button('Audit').click())
  const audit = container.querySelector('[aria-label="Board audit"]')!
  expect(audit.textContent).toContain('You opened board ENG')
  expect(audit.textContent).toContain('Agent read: Read the ENG board')

  await render(WEB)
  expect(left).toEqual([ENG.boardRef])
  expect(joined).toEqual([ENG.boardRef, WEB.boardRef])
  expect(container.textContent).not.toContain('ENG')
  expect(container.textContent).not.toContain('BOB')
  expect(container.querySelector('[aria-label="Board audit"]')).toBeNull()
})

it('says when the audit is refused because the board is out of reach', async () => {
  listSubjectAudit.mockRejectedValue(createOperateSessionError(OPERATE_SESSION_ERROR_CODES.boardUnavailable))
  await render(ENG)
  await act(async () => button('Audit').click())
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('can no longer reach this board')
})

it('hands the board over with a note, and says who is unknown', async () => {
  await render(ENG)
  await act(async () => button('Hand over').click())
  setFieldValue(dialogField(container, 'Person'), 'nobody')
  setFieldValue(dialogField(container, 'Note'), 'Yours now')
  handOver.mockRejectedValueOnce(createOperateSessionError(OPERATE_SESSION_ERROR_CODES.recipientUnavailable))
  await act(async () => container.querySelector('form')!.requestSubmit())
  expect(handOver).toHaveBeenLastCalledWith('nobody', 'Yours now')
  expect(container.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe('There is no other person with that id here.')

  setFieldValue(dialogField(container, 'Person'), ' bob ')
  handOver.mockResolvedValueOnce({ to: { id: 'bob', name: 'Bob' } })
  await act(async () => container.querySelector('form')!.requestSubmit())
  expect(handOver).toHaveBeenLastCalledWith('bob', 'Yours now')
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain('Handed over to Bob.')
})
