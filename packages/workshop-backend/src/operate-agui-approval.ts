import { EventType, type Event, type Interrupt } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { z } from "zod";
import type { AuthenticatedApi } from "@gadgets/workshop-shared/api";
import { encodeOperateEvent } from "./operate-agui-protocol";
import { validateApprovalRequest } from "./operate-approval";
import {
  OPERATE_APPROVAL_ERROR_CODES, createOperateApprovalError, operateApprovalErrorCode, type OperateApprovalErrorCode,
} from "@gadgets/workshop-shared/operate-approval";

const selection = z.object({workspaceId: z.string().regex(/^[a-f0-9]{64}$/),
  actionId: z.number().int().nonnegative()}).strict();
const policy = z.object({
  threadId: z.string(), runId: z.string(), protocolVersion: z.literal("1.0").optional(),
  messages: z.array(z.unknown()).max(64), state: z.unknown().optional(),
  tools: z.array(z.never()).optional(), context: z.array(z.never()).optional(),
  forwardedProps: z.object({approval: selection}).strict(),
  resume: z.array(z.object({interruptId: z.string(), status: z.literal("resolved"),
    payload: z.unknown()}).strict()).length(1).optional(),
}).strict();

/** Read a bounded canonical request. Neither history/state nor claimed identity confers authority. */
async function inputOf(request: Request) {
  if (!request.body) throw new Error("Missing body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 64 * 1024) throw new Error("Body exceeds limit");
      chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const raw = JSON.parse(new TextDecoder().decode(bytes));
  RunAgentInputSchema.parse(raw);
  const parsed = policy.parse(raw);
  const entry = parsed.resume?.[0];
  const input = validateApprovalRequest({actionId: parsed.forwardedProps.approval.actionId,
    threadId: parsed.threadId, runId: parsed.runId,
    ...(entry ? {answer: {interruptId: entry.interruptId,
      payload: entry.payload}} : {}),
  });
  return {input, workspaceId: parsed.forwardedProps.approval.workspaceId};
}

/**
 * The HTTP status of each refusal (FAC-119), so a client tells them apart by code, never by words:
 * may not decide, nothing left to decide, a conflicting answer, or couldn't decide now. A decision
 * that reached the provider and failed is not among them: it answers with its snapshot, whose
 * `failure.kind` says what kind of reason (policy, permission, sign-in and the rest).
 */
const REFUSAL_STATUS: Record<OperateApprovalErrorCode, number> = {
  APPROVAL_REFUSED: 403, APPROVAL_NOT_PENDING: 409, APPROVAL_CONFLICT: 409, APPROVAL_UNAVAILABLE: 503,
};

/** Approve, reject or (a board transition only) edit, as the snapshot allows. */
function responseSchemaOf(editable: boolean) {
  return {type: "object", required: ["approved"], additionalProperties: false,
    properties: {approved: {type: "boolean"}, ...(editable ? {editedArgs: {type: "object", required: ["toStateId"],
      additionalProperties: false, properties: {toStateId: {type: "string", minLength: 1, maxLength: 128}}}} : {})}};
}

/** Explicit approval adapter; reopen the workspace as the authenticated caller on every run. */
export async function handleOperateApproval(request: Request, api: AuthenticatedApi): Promise<Response> {
  let input: Awaited<ReturnType<typeof inputOf>>;
  try { input = await inputOf(request); }
  catch { return Response.json({error: "INVALID_APPROVAL_INPUT"}, {status: 400}); }
  try {
    using workspace = await openFor(api, input.workspaceId);
    const snapshot = await workspace.operateApproval(input.input);
    const {threadId, runId} = input.input;
    const title = snapshot.proposal.kind === "action" ? snapshot.proposal.title : "Move this issue to another state";
    const interrupt: Interrupt = {id: snapshot.interruptId, reason: "inferos.gatekeeper.approval.v1",
      message: `Approve: ${title}?`, ...(snapshot.expiresAt === null ? {} : {expiresAt: snapshot.expiresAt}),
      responseSchema: responseSchemaOf(snapshot.editable),
      metadata: {actionId: snapshot.actionId, ...snapshot.proposal}};
    const events: Event[] = [
      {type: EventType.RUN_STARTED, threadId, runId, protocolVersion: "1.0"},
      {type: EventType.STATE_SNAPSHOT, snapshot: {approval: snapshot}},
      {type: EventType.MESSAGES_SNAPSHOT, messages: [{id: `approval-${snapshot.actionId}`,
        role: "activity", activityType: "inferos.approval.v1", content: snapshot}]},
      {type: EventType.RUN_FINISHED, threadId, runId,
        outcome: snapshot.status === "pending" || (snapshot.status === "unknown" && snapshot.failure?.retryable)
          ? {type: "interrupt", interrupts: [interrupt]} : {type: "success"}},
    ];
    return new Response(events.map(encodeOperateEvent).join(""), {headers: {
      "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store",
    }});
  } catch (error) {
    // A refusal the kernel typed answers in kind; anything untyped is the workspace's or provider's
    // failure, never presented as a refusal (FAC-119).
    const code = operateApprovalErrorCode(error) ?? "APPROVAL_UNAVAILABLE";
    return Response.json({error: code}, {status: REFUSAL_STATUS[code]});
  }
}

// The caller's own workspace, or a typed refusal: one they can't open is refused, never unavailable,
// so no metadata of a workspace they may not reach is implied.
async function openFor(api: AuthenticatedApi, workspaceId: string) {
  try {
    return await api.openGadget(workspaceId);
  } catch {
    throw createOperateApprovalError(OPERATE_APPROVAL_ERROR_CODES.refused, "Approval refused");
  }
}
