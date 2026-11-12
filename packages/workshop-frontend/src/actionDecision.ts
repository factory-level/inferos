import type { ActionFailureKind } from '@gadgets/workshop-shared/gatekeeper'
import { actionFailureKind } from '@gadgets/workshop-shared/gatekeeper'
import type { ActionLogEntry } from '@gadgets/workshop-shared/api'
import {
  ACTION_OUTCOME_TEXT, ACTION_RECEIPT_REASON, ACTION_RECEIPT_UNKNOWN_REASON, RUN_DEFINITION_CHANGED, RUN_REQUESTER_REVOKED,
  RUN_WRITE_EXPIRED, actionOutcome, actionReceiptCode, type ActionOutcome,
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

/** What a person can do about a sign-in to renew when the page can't reconnect it for them. */
export const RECONNECT_GUIDANCE =
  "Reconnect this connection's account in the workspace's connections, then approve it again."

/** What a sign-in to renew says beside its Reconnect button (FAC-119 K2: the server finds the account). */
export const RECONNECT_PROMPT = 'Reconnect its account, then approve it again.'

/** A block whose reason isn't one of the kernel's known run refusals: never shown in its own words. */
export const BLOCKED_UNKNOWN_TEXT = 'A check before applying it refused it.'

const KNOWN_BLOCKS = [RUN_REQUESTER_REVOKED, RUN_DEFINITION_CHANGED, RUN_WRITE_EXPIRED]

/**
 * Why a pending action is blocked (FAC-118), in words: one of the kernel's own run refusals as it
 * wrote them, which may arrive with an error's name before it; anything else in a fixed sentence,
 * since it may carry words that aren't the kernel's.
 */
export const blockedText = (reason: string): string =>
  KNOWN_BLOCKS.find(known => reason === known || reason.endsWith(`: ${known}`)) ?? BLOCKED_UNKNOWN_TEXT

/**
 * Where a decision came from (FAC-119 K2, `ActionLogEntry.context`), in a person's words: which
 * workflow trigger's run, whether it runs as the trigger's assigned account, and who asked for it
 * (you, or another person, never named here), or an agent's turn: for the operate agent's request
 * (FAC-14), the person it asked for, by name. Null when the entry says nothing more than who asked.
 */
export const contextText = (entry: ActionEntry, viewerProfileId?: string | null): string | null => {
  const context = entry.context
  if (!context) return null
  if (context.kind === 'agent-turn') {
    // FAC-14: the operate agent's request runs on the connection's own account once approved, so
    // the decider is told whose request it is. The name is the person's profile name, never authority.
    if (context.onBehalfOf) {
      return context.onBehalfOf.profileId === viewerProfileId ? 'Requested by the operate agent for you'
        : `Requested by the operate agent for ${context.onBehalfOf.name}`
    }
    return "From the agent's turn in a chat"
  }
  // A declared run alone (FAC-120 round 6, `context.declaredRun`) names no origin here; the UI PR shows the run.
  if (context.kind === 'declared-run') return null
  // Likewise a declared temporary canvas alone (FAC-137, `context.declaredCanvas`); its UI PR shows it.
  if (context.kind === 'declared-canvas') return null
  const trigger = context.triggerLabel ? `the workflow trigger “${context.triggerLabel}”` : 'a workflow trigger'
  const asker = context.requestedBy === null ? ', which fired by itself'
    : context.requestedBy === undefined ? ''
      : context.requestedBy === viewerProfileId ? ', which you asked for' : ', which another person asked for'
  return `From a run of ${trigger}${asker}${context.assigned ? "; it runs as the trigger's assigned account" : ''}`
}

/** A rejection after an attempt that may have reached the service: rejecting it undid nothing there. */
export const UNCERTAIN_REJECTION_TEXT =
  'It was denied here, so local approval is closed; check the service for whether it took effect.'

/**
 * Whether `entry` is a workflow run's write whose outcome is unknown, which a person deciding it may
 * settle (FAC-117 K2, `Overseer.resolveWorkflowRunWrite`): pending, of a run, its last attempt
 * unknown, with no apply in flight. The server checks this again, and who may settle it.
 */
export const isSettleableRunWrite = (entry: ActionEntry): boolean =>
  entry.state === 'pending' && entry.context?.kind === 'workflow-run' &&
  entry.lastAttempt?.outcome === 'unknown' && entry.applying !== true && entry.settled === undefined

/** The question a person settling an unknown write answers (FAC-117 K2). */
export const SETTLE_QUESTION = 'Did this change happen?'

/**
 * What settling does and doesn't do: the kernel records the person's answer and the run reads it,
 * and nothing is sent, applied or undone at the service.
 */
export const SETTLE_WARNING =
  "InferOS records your answer, nothing more: it doesn't make or undo the change at the service. Check there first."

/** How a settled write reads afterwards (FAC-117 K2): the person's answer, never a fact InferOS checked. */
export const settledText = (settled: NonNullable<ActionEntry['settled']>): string =>
  `${settled.by.name} said ${settled.outcome === 'applied' ? 'this change happened' : "this change didn't happen"}; nothing was sent again.`

/** Why a pending action was blocked, or a rejected one was rejected without a person (FAC-118). */
export const REJECTED_BECAUSE_TEXT: Record<NonNullable<ActionEntry['rejectedBecause']>, string> = {
  expired: "It expired before it was decided, so it was rejected. Ask for it again if it's still wanted.",
  'definition-changed': 'The workflow it came from changed before it was decided, so it was rejected.',
  cancelled: 'The run that proposed it was cancelled before it was decided, so it was rejected.',
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
