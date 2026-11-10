import type { RpcStub } from 'capnweb'
import { decisionOf } from '../../actionDecision'
import type { ActionLogEntry, Overseer } from '@gadgets/workshop-shared/api'
import type { OperateApprovalOutcome } from '@gadgets/workshop-shared/operate-session'

/** An approve that threw when its result couldn't be read back either. */
export const APPROVE_UNREADABLE_TEXT = "The approval didn't go through, and why couldn't be read. Reload to see the action."

/** The person's decision on a pending action. */
export type ApprovalDecision = 'approve' | 'reject'

/**
 * How a decision ended, as the workspace's action log records it. `outcome` is null when there is
 * nothing true to report yet: the decision was refused before anything changed, or its result
 * could not be read back. `error` is the kernel's own refusal, or for an attempt the provider
 * answered, its kind and the receipt's reason (FAC-119); never the provider's own words.
 */
export type ApprovalDecisionResult =
  | { outcome: OperateApprovalOutcome; error?: string }
  | { outcome: null; error: string }

const messageOf = (caught: unknown): string =>
  caught instanceof Error && caught.message ? caught.message : String(caught)

/** One action's current record in the workspace's log, or undefined when the log holds no such action. */
export const readAction = async (overseer: RpcStub<Overseer>, actionId: number): Promise<ActionLogEntry | undefined> => {
  // Pages run newest first and stop before `beforeId`, so the action leads the first page.
  const page = await overseer.listActions({ beforeId: actionId + 1 })
  return page.entries.find(entry => entry.id === actionId)
}

/**
 * Approves or rejects one action through its workspace, then reads the action back from the log
 * and reports what actually happened. A call that returns is not taken as success: only the log's
 * `approved` is reported as applied. An approval whose apply threw leaves the action pending and is
 * reported `failed` with its recorded words, or the kernel's refusal when nothing was recorded.
 */
export const decideApproval = async (
  overseer: RpcStub<Overseer>,
  actionId: number,
  decision: ApprovalDecision,
): Promise<ApprovalDecisionResult> => {
  let refusal: string | undefined
  try {
    if (decision === 'approve') await overseer.approveAction(actionId)
    else await overseer.rejectAction(actionId)
  } catch (caught) {
    refusal = messageOf(caught)
  }

  let entry: ActionLogEntry | undefined
  let unreadable: string | undefined
  try {
    entry = await readAction(overseer, actionId)
  } catch (caught) {
    unreadable = messageOf(caught)
  }

  // Someone else may have decided it first; the log is the truth either way.
  if (entry?.state === 'approved') return { outcome: 'applied' }
  if (entry?.state === 'rejected') return { outcome: 'rejected' }
  // An attempt that reached the provider is told by its kind and the receipt's reason (FAC-119),
  // never in the provider's own words.
  const attempted = entry?.type === 'action' ? decisionOf(entry).failure : null
  const said = attempted ? `${attempted.text} ${attempted.reason}` : undefined
  if (entry?.type === 'action' && entry.state === 'failed') return { outcome: 'failed', ...(said ?? refusal ? { error: said ?? refusal } : {}) }
  // Possibly applied: neither applied nor failed, so no outcome is reported, only the warning.
  if (entry?.type === 'action' && entry.lastAttempt?.outcome === 'unknown') return { outcome: null, error: said! }
  if (refusal !== undefined) {
    // An approve whose apply was refused and recorded: the record's words. Any other refusal is the
    // kernel's own (may not decide, already decided), never provider text.
    // An approve that threw and whose record couldn't be read: its thrown message may be the
    // provider's, so a fixed sentence says only that the reason couldn't be read.
    const error = decision === 'approve'
      ? said ?? (unreadable !== undefined ? APPROVE_UNREADABLE_TEXT : refusal)
      : refusal
    return decision === 'approve' ? { outcome: 'failed', error } : { outcome: null, error }
  }
  return {
    outcome: null,
    error: unreadable !== undefined
      ? `The decision was sent, but its result could not be read: ${unreadable}`
      : 'The decision was sent, but the action still shows as pending.',
  }
}
