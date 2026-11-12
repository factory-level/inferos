import { useState } from 'react'
import { Button } from '@cloudflare/kumo'
import { GATEKEEPER_RECONNECT_REFUSED, type ConnectFlowStart } from '@gadgets/workshop-shared/api'
import { canApproveAgain } from '../actionAttempt'
import {
  RECONNECT_GUIDANCE, RECONNECT_PROMPT, REJECTED_BECAUSE_TEXT, SETTLE_QUESTION, SETTLE_WARNING, UNCERTAIN_REJECTION_TEXT,
  blockedText, contextText, decisionOf, isSettleableRunWrite, settledText, type ActionEntry,
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

/** A person's answer to whether an unknown write happened (FAC-117 K2). */
type SettleAnswer = 'applied' | 'not-applied'

const SETTLE_LABEL: Record<SettleAnswer, string> = { applied: 'It happened', 'not-applied': "It didn't happen" }

/**
 * Settle a workflow run's write whose outcome is unknown (FAC-117 K2): the person deciding it says
 * whether it happened, after checking at the service, and confirms. Nothing here says it applied:
 * the action reads as settled only once the journal does, and a refusal is the server's words.
 */
const SettleRunWrite = ({ onSettle }: { onSettle: (answer: SettleAnswer) => Promise<void> }) => {
  const [state, setState] = useState<
    { status: 'idle' } | { status: 'confirming' | 'sending'; answer: SettleAnswer } | { status: 'refused'; text: string }
  >({ status: 'idle' })
  const settle = async (answer: SettleAnswer) => {
    setState({ status: 'sending', answer })
    try {
      await onSettle(answer)
    } catch (error) {
      const text = error instanceof Error && error.message ? error.message.replace(/^(?:\w*Error: )?/, '') : "Couldn't record your answer."
      setState({ status: 'refused', text })
    }
  }
  return <div role="group" aria-label={SETTLE_QUESTION} className="mt-1 space-y-1">
    <p className="m-0 text-kumo-default">{SETTLE_QUESTION}</p>
    <p className="m-0 text-kumo-warning">{SETTLE_WARNING}</p>
    {state.status === 'confirming' || state.status === 'sending' ? (
      <span className="inline-flex flex-wrap items-center gap-2">
        <span>Record that {state.answer === 'applied' ? 'this change happened' : "this change didn't happen"}?</span>
        <Button size="sm" disabled={state.status === 'sending'} onClick={() => void settle(state.answer)}>
          {state.status === 'sending' ? 'Recording…' : 'Record it'}
        </Button>
        <Button size="sm" variant="secondary" disabled={state.status === 'sending'} onClick={() => setState({ status: 'idle' })}>
          Back
        </Button>
      </span>
    ) : (
      <span className="inline-flex flex-wrap items-center gap-2">
        {(['applied', 'not-applied'] as const).map(answer => (
          <Button key={answer} size="sm" variant="secondary" onClick={() => setState({ status: 'confirming', answer })}>
            {SETTLE_LABEL[answer]}
          </Button>
        ))}
        {state.status === 'refused' && <span role="alert" className="text-kumo-danger">{state.text}</span>}
      </span>
    )}
  </div>
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
export const ActionDecision = ({ entry, showOutcome = true, viewerProfileId, onReconnect, onSettle, className = '' }: {
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
  /**
   * Settles a workflow run's write whose outcome is unknown (`Overseer.resolveWorkflowRunWrite`,
   * FAC-117 K2): passed only by a surface for the people who decide it; without it, none is offered.
   */
  onSettle?: (answer: SettleAnswer) => Promise<void>
  className?: string
}) => {
  const { outcome, outcomeText, failure } = decisionOf(entry)
  const pending = entry.state === 'pending'
  const closed = pending && !canApproveAgain(entry)
  const context = contextText(entry, viewerProfileId)
  const signIn = failure?.kind === 'sign-in' && pending && !closed
  const settle = onSettle !== undefined && isSettleableRunWrite(entry)
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
          {closed ? outcome === 'unknown'
            ? settle ? ' It cannot be sent again: check it at the service, then say below whether it happened.'
              : ' It cannot be sent again: check it at the service, then deny it.'
            : ' It cannot be approved again here: deny it.' : ''}
          {entry.state === 'rejected' && entry.lastAttempt?.outcome === 'unknown' ? ` ${UNCERTAIN_REJECTION_TEXT}` : ''}
        </p>
      )}
      {signIn && onReconnect && <div className="mt-1"><ReconnectAction onReconnect={onReconnect} /></div>}
      {settle && onSettle && <SettleRunWrite onSettle={onSettle} />}
      {entry.settled && <p className="m-0 text-kumo-subtle">{settledText(entry.settled)}</p>}
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
