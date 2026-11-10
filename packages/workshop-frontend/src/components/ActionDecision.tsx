import { canApproveAgain } from '../actionAttempt'
import {
  RECONNECT_GUIDANCE, REJECTED_BECAUSE_TEXT, UNCERTAIN_REJECTION_TEXT, decisionOf, type ActionEntry,
} from '../actionDecision'
import { ActionResultList } from './ActionReceipt'

/**
 * What one action's decision says (FAC-119), for every surface that decides or shows one, the
 * Operate page's "Needs your approval" and the operate chat alike: where it stands, in FAC-97's
 * words; why the last attempt didn't apply, by its kind (a workflow policy, a missing permission,
 * a sign-in to renew, a conflict, an invalid change, an unreachable service), with the receipt's
 * fixed reason and never the provider's own text; why it is blocked or was rejected without a
 * person (FAC-118); whether it can be approved again; and, once applied, what the provider
 * reported (FAC-10's receipt). Each surface keeps its own controls and layout around it.
 */
export const ActionDecision = ({ entry, showOutcome = true, className = '' }: {
  entry: ActionEntry
  /**
   * Whether to say where it stands. Waiting is never said: a pending decision's own list or card
   * already shows it is waiting.
   */
  showOutcome?: boolean
  className?: string
}) => {
  const { outcome, outcomeText, failure } = decisionOf(entry)
  const pending = entry.state === 'pending'
  const closed = pending && !canApproveAgain(entry)
  return (
    <div className={`space-y-0.5 text-[11.5px] leading-4 ${className}`}>
      {showOutcome && outcome !== 'waiting' && (
        <p className={`m-0 ${outcome === 'failed' || outcome === 'rejected' ? 'text-kumo-danger' : outcome === 'unknown' ? 'text-kumo-warning' : 'text-kumo-inactive'}`}>
          {outcomeText}
        </p>
      )}
      {failure && (
        <p className={`m-0 ${failure.tone === 'warning' ? 'text-kumo-warning' : 'text-kumo-danger'}`}>
          {failure.text} {failure.reason}
          {failure.kind === 'sign-in' && pending && !closed ? ` ${RECONNECT_GUIDANCE}` : ''}
          {closed ? outcome === 'unknown' ? ' It cannot be sent again: check it at the service, then deny it.' : ' It cannot be approved again here: deny it.' : ''}
          {entry.state === 'rejected' && entry.lastAttempt?.outcome === 'unknown'
            ? ` ${UNCERTAIN_REJECTION_TEXT}` : ''}
        </p>
      )}
      {pending && entry.blocked && (
        <p className="m-0 text-kumo-warning">It can't be applied right now: {entry.blocked.reason}</p>
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
