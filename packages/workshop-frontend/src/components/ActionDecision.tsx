import { useState } from 'react'
import { Button } from '@cloudflare/kumo'
import { GATEKEEPER_RECONNECT_REFUSED, type ConnectFlowStart } from '@gadgets/workshop-shared/api'
import { canApproveAgain } from '../actionAttempt'
import {
  RECONNECT_GUIDANCE, RECONNECT_PROMPT, REJECTED_BECAUSE_TEXT, UNCERTAIN_REJECTION_TEXT, blockedText, contextText,
  decisionOf, type ActionEntry,
} from '../actionDecision'
import { openConnectWindow } from '../connectHandoff'
import { ActionResultList } from './ActionReceipt'
import { DeclaredRunNotice } from './DeclaredRunNotice'

/** A reconnect's refusal: the kernel's one refusal in its own words, anything else in a fixed sentence. */
const reconnectRefusal = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  return message.endsWith(GATEKEEPER_RECONNECT_REFUSED) ? GATEKEEPER_RECONNECT_REFUSED
    : "Couldn't start reconnecting just now. Try again, or reconnect it in the workspace's connections."
}

/**
 * Reconnect for a sign-in to renew (FAC-119 K2): the server finds the connection's account, and
 * only the person whose account it is can reconnect it; a refusal is the kernel's one sentence.
 */
const ReconnectAction = ({ onReconnect }: { onReconnect: () => Promise<ConnectFlowStart> }) => {
  const [state, setState] = useState<{ status: 'idle' | 'opening' } | { status: 'refused'; text: string }>({ status: 'idle' })
  const reconnect = async () => {
    setState({ status: 'opening' })
    try {
      openConnectWindow(await onReconnect())
      setState({ status: 'idle' })
    } catch (error) {
      setState({ status: 'refused', text: reconnectRefusal(error) })
    }
  }
  return <span className="inline-flex flex-wrap items-center gap-2">
    <Button size="sm" disabled={state.status === 'opening'} onClick={() => void reconnect()}>
      {state.status === 'opening' ? 'Opening…' : 'Reconnect'}
    </Button>
    {state.status === 'refused' && <span role="alert" className="text-kumo-danger">{state.text}</span>}
  </span>
}

/**
 * What one action's decision says (FAC-119), for every surface that decides or shows one, the
 * Operate page's "Needs your approval" and the operate chat alike: where it came from (a workflow
 * run's trigger, or an agent's turn); where it stands, in FAC-97's words; why the last attempt
 * didn't apply, by its kind (a workflow policy, a missing permission, a sign-in to renew, a
 * conflict, an invalid change, an unreachable service), with the receipt's fixed reason and never
 * the provider's own text, and for a sign-in to renew, Reconnect when the surface offers it; why it
 * is blocked (the kernel's known run refusals in their words, anything else in a fixed sentence) or
 * was rejected without a person (FAC-118); whether it can be approved again; and, once applied,
 * what the provider reported (FAC-10's receipt). Each surface keeps its own controls and layout
 * around it.
 */
export const ActionDecision = ({ entry, showOutcome = true, viewerProfileId, onReconnect, className = '' }: {
  entry: ActionEntry
  /**
   * Whether to say where it stands. Waiting is never said: a pending decision's own list or card
   * already shows it is waiting.
   */
  showOutcome?: boolean
  /** The viewer's profile id, so a run they asked for says so. */
  viewerProfileId?: string | null
  /** Starts reconnecting the action's connection (`Overseer.reconnectGatekeeper`); without it, guidance only. */
  onReconnect?: () => Promise<ConnectFlowStart>
  className?: string
}) => {
  const { outcome, outcomeText, failure } = decisionOf(entry)
  const pending = entry.state === 'pending'
  const closed = pending && !canApproveAgain(entry)
  const context = contextText(entry, viewerProfileId)
  const signIn = failure?.kind === 'sign-in' && pending && !closed
  return (
    <div className={`space-y-0.5 text-[11.5px] leading-4 ${className}`}>
      <DeclaredRunNotice context={entry.context} className="mb-1" />
      {context && <p className="m-0 text-kumo-inactive">{context}</p>}
      {showOutcome && outcome !== 'waiting' && (
        <p className={`m-0 ${outcome === 'failed' || outcome === 'rejected' ? 'text-kumo-danger' : outcome === 'unknown' ? 'text-kumo-warning' : 'text-kumo-inactive'}`}>
          {outcomeText}
        </p>
      )}
      {failure && (
        <p className={`m-0 ${failure.tone === 'warning' ? 'text-kumo-warning' : 'text-kumo-danger'}`}>
          {failure.text} {failure.reason}
          {signIn ? ` ${onReconnect ? RECONNECT_PROMPT : RECONNECT_GUIDANCE}` : ''}
          {closed ? outcome === 'unknown' ? ' It cannot be sent again: check it at the service, then deny it.' : ' It cannot be approved again here: deny it.' : ''}
          {entry.state === 'rejected' && entry.lastAttempt?.outcome === 'unknown' ? ` ${UNCERTAIN_REJECTION_TEXT}` : ''}
        </p>
      )}
      {signIn && onReconnect && <div className="mt-1"><ReconnectAction onReconnect={onReconnect} /></div>}
      {pending && entry.blocked && (
        <p className="m-0 text-kumo-warning">It can't be applied right now: {blockedText(entry.blocked.reason)}</p>
      )}
      {entry.state === 'rejected' && entry.rejectedBecause && (
        <p className="m-0 text-kumo-subtle">{REJECTED_BECAUSE_TEXT[entry.rejectedBecause]}</p>
      )}
      {entry.state === 'approved' && entry.result && Object.keys(entry.result).length > 0 && (
        <ActionResultList result={entry.result} className="mt-1" />
      )}
    </div>
  )
}
