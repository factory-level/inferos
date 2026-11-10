import type { ActionFailureKind } from '@gadgets/workshop-shared/gatekeeper'
import { actionFailureKind } from '@gadgets/workshop-shared/gatekeeper'
import type { ActionLogEntry } from '@gadgets/workshop-shared/api'
import {
  ACTION_OUTCOME_TEXT, ACTION_RECEIPT_REASON, ACTION_RECEIPT_UNKNOWN_REASON, actionOutcome, actionReceiptCode,
  type ActionOutcome,
} from '@gadgets/workshop-shared/action-outcome'

/** An action of the journal, as a decision card shows it. */
export type ActionEntry = Extract<ActionLogEntry, { type: 'action' }>

/**
 * What kind of reason an unsuccessful apply was, in a person's words (FAC-119), from the
 * gatekeeper's structured answer (`ActionAttempt.kind`), never from its message. A workflow policy
 * and a missing permission are told apart, and so is a sign-in to renew, which approving again
 * after reconnecting may fix. An older record, or a kind this page doesn't know, reads as
 * unavailable.
 */
export const ACTION_FAILURE_KIND_TEXT: Record<ActionFailureKind, string> = {
  policy: "A workflow policy in the service doesn't allow this change.",
  permission: "The account this connection uses doesn't have permission for this change.",
  'sign-in': "This connection's sign-in has expired.",
  conflict: 'Something else changed it first. Look at it again before deciding.',
  invalid: "The service didn't accept this change as it was made.",
  unavailable: "The service couldn't be reached, or didn't say why.",
}

/** What a person can do about a sign-in to renew, until the page can reconnect it itself. */
export const RECONNECT_GUIDANCE =
  "Reconnect this connection's account in the workspace's connections, then approve it again."

/** A rejection after an attempt that may have reached the service: rejecting it undid nothing there. */
export const UNCERTAIN_REJECTION_TEXT =
  'It was denied here, so local approval is closed; check the service for whether it took effect.'

/** Why a pending action was blocked, or a rejected one was rejected without a person (FAC-118). */
export const REJECTED_BECAUSE_TEXT: Record<NonNullable<ActionEntry['rejectedBecause']>, string> = {
  expired: "It expired before it was decided, so it was rejected. Ask for it again if it's still wanted.",
  'definition-changed': 'The workflow it came from changed before it was decided, so it was rejected.',
}

/** Who asked for an action, from what reaches the page today (`requestedBy`). */
export const REQUESTED_BY_TEXT: Record<NonNullable<ActionEntry['requestedBy']>, string> = {
  agent: 'Requested by the agent',
  person: 'Requested by a person',
  gadget: 'Requested by a gadget',
  hook: 'Requested by a hook',
}

/**
 * Everything a decision card says about an action's outcome (FAC-119), in FAC-97's words: where it
 * stands, why an attempt didn't apply (its kind, and the receipt's fixed reason for its code), and
 * whether it can be approved again. One vocabulary for every surface that shows a decision.
 */
export const decisionOf = (entry: ActionEntry): {
  outcome: ActionOutcome
  outcomeText: string
  failure: { kind: ActionFailureKind; text: string; reason: string; tone: 'danger' | 'warning' } | null
} => {
  const outcome = actionOutcome(entry)
  const attempt = entry.lastAttempt
  const failure = attempt
    ? attempt.outcome === 'unknown'
      ? { kind: 'unavailable' as const, text: 'Its last attempt may have reached the service.', reason: ACTION_RECEIPT_UNKNOWN_REASON, tone: 'warning' as const }
      : (() => {
          const kind = actionFailureKind(attempt.kind)
          return { kind, text: ACTION_FAILURE_KIND_TEXT[kind], reason: ACTION_RECEIPT_REASON[actionReceiptCode(attempt.code)], tone: 'danger' as const }
        })()
    : null
  return { outcome, outcomeText: ACTION_OUTCOME_TEXT[outcome], failure }
}
