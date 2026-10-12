import { EventType, type Event, type Interrupt } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { z } from "zod";
import type { AuthenticatedApi } from "@gadgets/workshop-shared/api";
import { encodeOperateEvent } from "./operate-agui-protocol";
import { validateApprovalRequest } from "./operate-approval";

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

/** Explicit approval adapter; reopen the workspace as the authenticated caller on every run. */
export async function handleOperateApproval(request: Request, api: AuthenticatedApi): Promise<Response> {
  let input: Awaited<ReturnType<typeof inputOf>>;
  try { input = await inputOf(request); }
  catch { return Response.json({error: "INVALID_APPROVAL_INPUT"}, {status: 400}); }
  try {
    using workspace = await api.openGadget(input.workspaceId);
    const snapshot = await workspace.operateApproval(input.input);
    const {threadId, runId} = input.input;
    const interrupt: Interrupt = {id: snapshot.interruptId, reason: "inferos.gatekeeper.approval.v1",
      message: "Approve this board transition?", expiresAt: snapshot.expiresAt,
      responseSchema: {type: "object", required: ["approved"], additionalProperties: false,
        properties: {approved: {type: "boolean"}, editedArgs: {type: "object", required: ["toStateId"],
          additionalProperties: false, properties: {toStateId: {type: "string", minLength: 1, maxLength: 128}}}}},
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
  } catch { return Response.json({error: "APPROVAL_REFUSED"}, {status: 403}); }
}
