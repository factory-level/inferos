// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// FAC-119: what one decision says, wherever it is decided. Each kind of failed apply is told in its
// own words, from the gatekeeper's structured kind and never from its message; a sign-in to renew
// says how to reconnect; one that can't be approved again says so; a block and a rejection without
// a person say why; an applied action shows what the provider reported; and every outcome is in
// FAC-97's words, with "Applied" only for an applied action.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACTION_FAILURE_KINDS } from '@gadgets/workshop-shared/gatekeeper'
import { GATEKEEPER_RECONNECT_NOT_YOURS, type ConnectFlowStart } from '@gadgets/workshop-shared/api'
import { RUN_DEFINITION_CHANGED } from '@gadgets/workshop-shared/action-outcome'
import {
  ACTION_FAILURE_KIND_TEXT, BLOCKED_UNKNOWN_TEXT, RECONNECT_GUIDANCE, RECONNECT_PROMPT, blockedText, contextText, decisionOf,
  type ActionEntry,
} from '../actionDecision'
import { ActionDecision } from './ActionDecision'
import { ActionReceiptLine } from './ActionReceipt'

const opened = vi.hoisted(() => [] as ConnectFlowStart[])
vi.mock('../connectHandoff', () => ({ openConnectWindow: (flow: ConnectFlowStart) => { opened.push(flow); return {} } }))

const entry = (patch: Partial<ActionEntry> = {}): ActionEntry => ({
  type: 'action', id: 7, gatekeeperId: 3, resourceTitle: 'ENG board', createdAt: new Date(0), state: 'pending',
  description: { title: 'Move ENG-1 to Done', description: 'Moves it.', implementsRevert: false },
  ...patch,
} as ActionEntry)
const attempt = (patch: Record<string, unknown>) =>
  ({ outcome: 'notApplied', message: 'Policy says no to the provider', at: new Date(0), retryable: false, ...patch }) as never

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })
const render = async (shown: ActionEntry) => { await act(async () => root.render(<ActionDecision entry={shown} />)) }

describe('a failed apply', () => {
  it('says each kind in its own words, from the kind and never the message', async () => {
    for (const kind of ACTION_FAILURE_KINDS) {
      await render(entry({ state: 'failed', lastAttempt: attempt({ kind, code: 'FORBIDDEN' }) }))
      expect(container.textContent).toContain(ACTION_FAILURE_KIND_TEXT[kind])
      expect(container.textContent).not.toContain('Policy says no to the provider')
    }
    // The words differ for every kind, so a policy refusal never reads as a missing permission.
    expect(new Set(Object.values(ACTION_FAILURE_KIND_TEXT)).size).toBe(ACTION_FAILURE_KINDS.length)
  })

  it('reads a kind it does not know, or none from an older record, as unavailable', () => {
    expect(decisionOf(entry({ state: 'failed', lastAttempt: attempt({ kind: 'because-reasons' }) })).failure?.kind).toBe('unavailable')
    expect(decisionOf(entry({ state: 'failed', lastAttempt: attempt({}) })).failure?.kind).toBe('unavailable')
  })

  it("says how to reconnect after an expired sign-in, while it can still be approved", async () => {
    await render(entry({ lastAttempt: attempt({ kind: 'sign-in', code: 'UNAUTHORIZED', retryable: true }) }))
    expect(container.textContent).toContain(ACTION_FAILURE_KIND_TEXT['sign-in'])
    expect(container.textContent).toContain(RECONNECT_GUIDANCE)
  })

  it('says a pending action that may not be sent again can only be denied', async () => {
    await render(entry({ lastAttempt: attempt({ kind: 'conflict', code: 'CONFLICT' }) }))
    expect(container.textContent).toContain('It cannot be approved again here: deny it.')
    expect(container.textContent).not.toContain(RECONNECT_GUIDANCE)
  })
})

describe('where it stands, in FAC-97 words', () => {
  it('says Applied only once applied, with what the provider reported', async () => {
    await render(entry({ state: 'approved', result: { issue: 'ENG-1', state: 'Done' } }))
    expect(container.textContent).toContain('Applied')
    expect(container.querySelector('dl[aria-label="What the provider reported"]')?.textContent).toBe('issue:ENG-1state:Done')
    await render(entry({ state: 'pending', applying: true }))
    expect(container.textContent).toContain('Approved, applying now, not done yet')
    expect(container.querySelector('dl')).toBeNull()
  })

  it('says nothing more for one simply waiting', async () => {
    await render(entry())
    expect(container.textContent).toBe('')
  })

  it('keeps an uncertain attempt uncertain after a rejection here', async () => {
    await render(entry({ state: 'rejected', lastAttempt: attempt({ outcome: 'unknown' }) }))
    expect(container.textContent).toContain('Outcome unknown: it may or may not have applied')
    expect(container.textContent).toContain('local approval is closed; check the service')
    expect(container.textContent).not.toContain('Rejected, not applied')
  })

  it('says why it is blocked, and why it was rejected without a person', async () => {
    await render(entry({ blocked: { reason: `Error: ${RUN_DEFINITION_CHANGED}`, at: new Date(0) } } as never))
    expect(container.textContent).toContain(`It can't be applied right now: ${RUN_DEFINITION_CHANGED}`)
    await render(entry({ state: 'rejected', rejectedBecause: 'expired' }))
    expect(container.textContent).toContain('It expired before it was decided')
  })
})

describe("a write receipt", () => {
  it("shows what the provider reported only once applied", async () => {
    await act(async () => root.render(<ActionReceiptLine outcome="succeeded" result={{ id: 'r-1' }} />))
    expect(container.textContent).toBe('Appliedid:r-1')
    await act(async () => root.render(<ActionReceiptLine outcome="failed" reason="This change isn't permitted." result={{ id: 'r-1' }} />))
    expect(container.textContent).toBe("Failed, not applied: This change isn't permitted.")
  })
})

const run = (context: ActionEntry['context']) => entry({ context })
const signIn = () => entry({ lastAttempt: attempt({ kind: 'sign-in', code: 'UNAUTHORIZED', retryable: true }) })
const reconnectButton = () => [...container.querySelectorAll('button')].find(b => b.textContent === 'Reconnect')

describe('where a decision came from (FAC-119 K2)', () => {
  it("names a workflow run's trigger, whether it runs as the trigger's account, and who asked, never by name", () => {
    expect(contextText(run({ kind: 'workflow-run', hookId: 7, assigned: true, runId: 'r', requestedBy: 'ada', triggerLabel: 'Refund' }), 'ada'))
      .toBe("From a run of the workflow trigger “Refund”, which you asked for; it runs as the trigger's assigned account")
    expect(contextText(run({ kind: 'workflow-run', hookId: 7, assigned: false, requestedBy: 'ben' }), 'ada'))
      .toBe('From a run of a workflow trigger, which another person asked for')
    expect(contextText(run({ kind: 'workflow-run', hookId: 7, assigned: true, requestedBy: null }), 'ada'))
      .toBe("From a run of a workflow trigger, which fired by itself; it runs as the trigger's assigned account")
    expect(contextText(run({ kind: 'agent-turn' }))).toBe("From the agent's turn in a chat")
    expect(contextText(entry())).toBeNull()
  })

  it("says a known run refusal in the kernel's words, and anything else in a fixed sentence", () => {
    expect(blockedText(RUN_DEFINITION_CHANGED)).toBe(RUN_DEFINITION_CHANGED)
    expect(blockedText(`Error: ${RUN_DEFINITION_CHANGED}`)).toBe(RUN_DEFINITION_CHANGED)
    expect(blockedText('token expired for acme-bot')).toBe(BLOCKED_UNKNOWN_TEXT)
  })
})

describe('Reconnect (FAC-119 K2)', () => {

  it('reconnects the connection through the server, and opens its sign-in', async () => {
    opened.length = 0
    const onReconnect = vi.fn<() => Promise<ConnectFlowStart>>(async () => ({ url: 'https://connect.example/again', nonce: 'n' }))
    await act(async () => root.render(<ActionDecision entry={signIn()} onReconnect={onReconnect} />))
    expect(container.textContent).toContain(RECONNECT_PROMPT)
    await act(async () => reconnectButton()!.click())
    expect(onReconnect).toHaveBeenCalledOnce()
    expect(opened).toEqual([{ url: 'https://connect.example/again', nonce: 'n' }])
  })

  it("says why it can't, in the kernel's words, and offers nothing for another failure kind", async () => {
    const onReconnect = vi.fn<() => Promise<ConnectFlowStart>>(async () => { throw new Error(`Error: ${GATEKEEPER_RECONNECT_NOT_YOURS}`) })
    await act(async () => root.render(<ActionDecision entry={signIn()} onReconnect={onReconnect} />))
    await act(async () => reconnectButton()!.click())
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(GATEKEEPER_RECONNECT_NOT_YOURS)
    await act(async () => root.render(<ActionDecision entry={entry({ lastAttempt: attempt({ kind: 'permission', retryable: true }) })} onReconnect={onReconnect} />))
    expect(reconnectButton()).toBeUndefined()
    // Without a way to reconnect here, the guidance says where.
    await act(async () => root.render(<ActionDecision entry={signIn()} />))
    expect(reconnectButton()).toBeUndefined()
    expect(container.textContent).toContain(RECONNECT_GUIDANCE)
  })
})
