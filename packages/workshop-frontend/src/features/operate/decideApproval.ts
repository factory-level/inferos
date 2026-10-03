import type { RpcStub } from 'capnweb'
import type { ActionLogEntry, Overseer } from '@gadgets/workshop-shared/api'
import type { OperateApprovalOutcome } from '@gadgets/workshop-shared/operate-session'

/** The person's decision on a pending action. */
export type ApprovalDecision = 'approve' | 'reject'

/**
 * How a decision ended, as the workspace's action log records it. `outcome` is null when there is
 * nothing true to report yet: the decision was refused before anything changed, or its result
 * could not be read back. `error` is the gatekeeper's or kernel's own message, shown as is.
 */
export type ApprovalDecisionResult =
  | { outcome: OperateApprovalOutcome; error?: string }
  | { outcome: null; error: string }

const messageOf = (caught: unknown): string =>
  caught instanceof Error && caught.message ? caught.message : String(caught)

const readAction = async (overseer: RpcStub<Overseer>, actionId: number): Promise<ActionLogEntry | undefined> => {
  // Pages run newest first and stop before `beforeId`, so the action leads the first page.
  const page = await overseer.listActions({ beforeId: actionId + 1 })
  return page.entries.find(entry => entry.id === actionId)
}

/**
 * Approves or rejects one action through its workspace, then reads the action back from the log
 * and reports what actually happened. A call that returns is not taken as success: only the log's
 * `approved` is reported as applied. An approval whose apply threw leaves the action pending and is
 * reported `failed` with the thrown message (a denied, expired or stale-revision refusal, say).
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
  if (refusal !== undefined) {
    return decision === 'approve' ? { outcome: 'failed', error: refusal } : { outcome: null, error: refusal }
  }
  return {
    outcome: null,
    error: unreadable !== undefined
      ? `The decision was sent, but its result could not be read: ${unreadable}`
      : 'The decision was sent, but the action still shows as pending.',
  }
}
