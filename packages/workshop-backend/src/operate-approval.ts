import { z } from "zod";
import { actionFailureKind } from "@gadgets/workshop-shared/gatekeeper";
import { OPERATE_APPROVAL_ERROR_CODES, createOperateApprovalError } from "@gadgets/workshop-shared/operate-approval";
import type {
  ActionApprovalCorrelation, ActionApprovalProposal, OperateApprovalRequest, OperateApprovalSnapshot,
} from "@gadgets/workshop-shared/operate-approval";
import type { ActionRecord } from "./overseer";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const answer = z.object({approved: z.boolean(),
  editedArgs: z.object({toStateId: z.string().min(1).max(128)}).strict().optional(),
}).strict().refine(value => !value.editedArgs || value.approved);
const request = z.object({actionId: z.number().int().nonnegative(), threadId: id, runId: id,
  answer: z.object({interruptId: id, payload: answer}).strict().optional(),
}).strict();

/**
 * The interrupt's own window, or null for none (FAC-119, decided 2026-11-10): an approval waits as
 * long as its action is pending, and only a workflow run's write expires, by FAC-118's deadline. One
 * constant, so the earlier ten-minute window is one edit away.
 */
export const APPROVAL_INTERRUPT_WINDOW_MS: number | null = null;

/** Validate the complete answer before touching the action journal or invoking the provider. */
export function validateApprovalRequest(input: unknown): OperateApprovalRequest {
  return request.parse(input);
}

/** A new correlation of one pending action with a person's thread, with the window above, if any. */
export function approvalCorrelation(person: string, input: OperateApprovalRequest,
    proposal: ActionApprovalCorrelation["proposal"]): ActionApprovalCorrelation {
  // A permanent "can't decide it here", never an outage: the approvals list still decides it.
  if (JSON.stringify(proposal).length > 8192) {
    throw createOperateApprovalError(OPERATE_APPROVAL_ERROR_CODES.refused,
      "This action is too large to decide here; decide it in the approvals list.");
  }
  return {person, threadId: input.threadId, runId: input.runId, interruptId: crypto.randomUUID(),
    ...(APPROVAL_INTERRUPT_WINDOW_MS === null ? {} : {expiresAt: Date.now() + APPROVAL_INTERRUPT_WINDOW_MS}),
    proposal};
}

/** Whether a correlation's own deadline has passed; one with none never expires by itself. */
export function approvalExpired(correlation: ActionApprovalCorrelation): boolean {
  return correlation.expiresAt !== undefined && Date.now() >= correlation.expiresAt;
}

/** Longest description a derived proposal carries; the journal holds the whole. */
const PROPOSAL_DESCRIPTION_LIMIT = 4000;

/**
 * Any action's proposal as the kernel derives it from its journal record (FAC-119), for an action
 * whose gatekeeper projects none of its own, or that runs as an assigned service account: its
 * title, description and fields as its gatekeeper wrote them, and `scope`, the connection's
 * resource. Nothing is read from the provider, so it is the record's, exactly, every time.
 */
export function actionProposal(record: ActionRecord & {type: "action"}, scope: string): ActionApprovalProposal {
  let { title, description, fields, descriptionIsComplete } = record.description;
  return {kind: "action", scope, title, description: description.slice(0, PROPOSAL_DESCRIPTION_LIMIT),
    ...(fields ? {fields} : {}), descriptionIsComplete: descriptionIsComplete === true};
}

/** Project only this correlated action; never claim not-applied over a prior unknown outcome. */
export function approvalSnapshot(record: ActionRecord & {type: "action"}): OperateApprovalSnapshot {
  const correlation = record.aguiApproval!;
  const status = record.applyStartedAt || record.lastAttempt?.outcome === "unknown" ? "unknown"
    : record.state === "approved" ? "applied" : record.state === "pending"
      ? approvalExpired(correlation) ? "expired" : "pending"
      : record.state === "rejected" ? "rejected" : "failed";
  return {actionId: record.id, interruptId: correlation.interruptId,
    expiresAt: correlation.expiresAt === undefined ? null : new Date(correlation.expiresAt).toISOString(),
    proposal: correlation.proposal,
    // Only a gatekeeper's own board-transition projection can be edited, and never an assigned run's.
    editable: correlation.proposal.kind !== "action" && !record.executedAs,
    status,
    ...(record.lastAttempt ? {failure: {outcome: record.lastAttempt.outcome, message: record.lastAttempt.message.slice(0, 1024),
      ...(record.lastAttempt.code ? {code: record.lastAttempt.code} : {}),
      retryable: record.lastAttempt.retryable, kind: actionFailureKind(record.lastAttempt.kind)}} : {}),
    ...(record.blocked ? {blocked: {reason: record.blocked.reason.slice(0, 1024)}} : {}),
    ...(record.rejectedBecause ? {rejectedBecause: record.rejectedBecause} : {})};
}
