import { z } from "zod";
import type { ActionApprovalCorrelation, OperateApprovalRequest, OperateApprovalSnapshot } from "@gadgets/workshop-shared/operate-approval";
import type { ActionRecord } from "./overseer";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const answer = z.object({approved: z.boolean(),
  editedArgs: z.object({toStateId: z.string().min(1).max(128)}).strict().optional(),
}).strict().refine(value => !value.editedArgs || value.approved);
const request = z.object({actionId: z.number().int().nonnegative(), threadId: id, runId: id,
  answer: z.object({interruptId: id, payload: answer}).strict().optional(),
}).strict();

/** Validate the complete answer before touching the action journal or invoking the provider. */
export function validateApprovalRequest(input: unknown): OperateApprovalRequest {
  return request.parse(input);
}

/** New proposals have one short, non-renewable approval window. */
export function approvalCorrelation(person: string, input: OperateApprovalRequest,
    proposal: ActionApprovalCorrelation["proposal"]): ActionApprovalCorrelation {
  if (JSON.stringify(proposal).length > 8192) throw new Error("Proposal exceeds approval limit");
  return {person, threadId: input.threadId, runId: input.runId, interruptId: crypto.randomUUID(),
    expiresAt: Date.now() + 10 * 60_000, proposal};
}

/** Project only this correlated action; never claim not-applied over a prior unknown outcome. */
export function approvalSnapshot(record: ActionRecord & {type: "action"}): OperateApprovalSnapshot {
  const correlation = record.aguiApproval!;
  const status = record.applyStartedAt || record.lastAttempt?.outcome === "unknown" ? "unknown"
    : record.state === "approved" ? "applied" : record.state === "pending"
      ? Date.now() >= correlation.expiresAt ? "expired" : "pending"
      : record.state === "rejected" ? "rejected" : "failed";
  return {actionId: record.id, interruptId: correlation.interruptId,
    expiresAt: new Date(correlation.expiresAt).toISOString(), proposal: correlation.proposal, status,
    ...(record.lastAttempt ? {failure: {outcome: record.lastAttempt.outcome, message: record.lastAttempt.message.slice(0, 1024),
      ...(record.lastAttempt.code ? {code: record.lastAttempt.code} : {}),
      retryable: record.lastAttempt.retryable}} : {})};
}
