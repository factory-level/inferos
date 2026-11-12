// The Dot's streaming relay (FAC-133): reads InferOps' AG-UI run stream (server-sent events, as
// `streamAguiEvents` writes them: `data: <json>\n\n` frames and `: ping\n\n` heartbeats) and hands
// each event on only once `@ag-ui/core` 1.0.2's own schema accepts it. Nothing is invented and
// nothing is dropped silently: an event that isn't valid AG-UI, one over a cap, a stream that stops
// without ending the run, the run's deadline and a long silence each end the relay with a named
// reason, which the session turns into a visible error. Also the strict parsers of the Dot's JSON
// answers, so a field InferOps didn't send is never read as one it did.
import { EventSchema } from "@ag-ui/core/schemas";
import { DOT_PROPOSAL_STATUSES, type DotConversationWire, type DotEvent, type DotMessageWire, type DotProposalWire, type DotRunEnd } from "./inferops-client";

/** The relay's bounds: InferOps aborts a run at 125 s and sends a heartbeat every 15 s. */
export const DOT_RELAY_LIMITS = {
  /** The whole run, from the request to its last byte. */
  deadlineMs: 130_000,
  /** The longest gap between any two chunks (a heartbeat counts). */
  silenceMs: 35_000,
  /** One event's frame. */
  eventBytes: 256 * 1024,
  /** Every byte of one run. */
  runBytes: 4 * 1024 * 1024,
} as const;

export type DotRelayLimits = { [K in keyof typeof DOT_RELAY_LIMITS]: number };

/**
 * Relays one run's stream to `onEvent`, in order, and resolves with how it ended. `RUN_FINISHED`
 * and `RUN_ERROR` end it as the run's own; anything after them is not read. `signal` aborting
 * (the caller went away) ends it `cut`. The body is always cancelled once the relay ends.
 */
export async function relayDotStream(
  body: ReadableStream<Uint8Array>, onEvent: (event: DotEvent) => void,
  limits: DotRelayLimits = DOT_RELAY_LIMITS, signal?: AbortSignal,
): Promise<DotRunEnd> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const started = Date.now();
  let buffer = "";
  let total = 0;
  try {
    for (;;) {
      const left = limits.deadlineMs - (Date.now() - started);
      if (left <= 0) return { kind: "deadline" };
      const next = await readWithin(reader, Math.min(left, limits.silenceMs), signal);
      if (next === "timeout") return { kind: Date.now() - started >= limits.deadlineMs ? "deadline" : "silent" };
      if (next === "aborted" || next.done) return { kind: "cut" };
      total += next.value.byteLength;
      if (total > limits.runBytes) return { kind: "oversized" };
      buffer += decoder.decode(next.value, { stream: true });
      let end = frameEnd(buffer);
      while (end !== null) {
        const frame = buffer.slice(0, end.at);
        buffer = buffer.slice(end.at + end.length);
        const ended = deliver(frame, onEvent, limits);
        if (ended) return ended;
        end = frameEnd(buffer);
      }
      if (new TextEncoder().encode(buffer).byteLength > limits.eventBytes) return { kind: "oversized" };
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Where the first frame of `buffer` ends (a blank line, LF or CRLF), or null. */
function frameEnd(buffer: string): { at: number; length: number } | null {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf < 0 && crlf < 0) return null;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { at: crlf, length: 4 };
  return { at: lf, length: 2 };
}

/** Hand one frame's event on; a run's end, or why the relay must stop, is returned. */
function deliver(frame: string, onEvent: (event: DotEvent) => void, limits: DotRelayLimits): DotRunEnd | null {
  if (new TextEncoder().encode(frame).byteLength > limits.eventBytes) return { kind: "oversized" };
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    // A comment line (a heartbeat) and the fields the run doesn't use carry no event.
    if (line.startsWith("data:")) data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
  }
  if (data.length === 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(data.join("\n"));
  } catch {
    return { kind: "malformed" };
  }
  const parsed = EventSchema.safeParse(raw);
  if (!parsed.success) return { kind: "malformed" };
  const event = parsed.data as DotEvent;
  onEvent(event);
  if (event.type === "RUN_FINISHED") return { kind: "finished" };
  if (event.type === "RUN_ERROR") return { kind: "error", message: (event as { message: string }).message };
  return null;
}

/** The reader's next chunk, or why none came: no byte within `ms`, or `signal` aborted. */
async function readWithin(
  reader: ReadableStreamDefaultReader<Uint8Array>, ms: number, signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array> | "timeout" | "aborted"> {
  if (signal?.aborted) return "aborted";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<"timeout">(resolve => (timer = setTimeout(() => resolve("timeout"), ms))),
      new Promise<"aborted">(resolve => {
        onAbort = () => resolve("aborted");
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

// ---------------------------------------------------------------------------
// The Dot's JSON answers, parsed strictly.

/** A Dot answer InferOps didn't send in its declared shape. */
export class DotMalformed extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROPOSAL_STATUSES: ReadonlySet<string> = new Set(DOT_PROPOSAL_STATUSES);
const MESSAGE_STATUSES = new Set(["running", "complete", "error", "interrupted"]);

function obj(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new DotMalformed(`${what} is not an object`);
  return value as Record<string, unknown>;
}

function str(value: unknown, what: string): string {
  if (typeof value !== "string") throw new DotMalformed(`${what} is not a string`);
  return value;
}

function id(value: unknown, what: string): string {
  const text = str(value, what);
  if (!UUID.test(text)) throw new DotMalformed(`${what} is not a UUID`);
  return text.toLowerCase();
}

function nullable<T>(value: unknown, parse: (v: unknown) => T): T | null {
  return value === null ? null : parse(value);
}

function arr(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new DotMalformed(`${what} is not a list`);
  return value;
}

const RUN_OUTCOMES = new Set(["succeeded", "failed", "uncertain"]);
const RUN_AUTHORITIES = new Set(["gadget_bindings", "service_account"]);
/** A run's fixed reason as InferOS names it (WorkflowRunFailure, WorkflowRunUncertainty): a slug, never prose. */
const RUN_REASON_CODE = /^[a-z][a-z-]{0,63}$/;

/**
 * A proposal's recorded run outcome (FAC-134), its fixed fields only; null when absent (an older
 * InferOps, or nothing recorded yet) or when it doesn't read as one, never a malformed proposal.
 */
function parseDotRun(raw: unknown): DotProposalWire["run"] {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.kind !== "workflow-run" || typeof r.runId !== "string" || r.runId.length === 0 || r.runId.length > 200 ||
      typeof r.outcome !== "string" || !RUN_OUTCOMES.has(r.outcome) ||
      typeof r.ranAs !== "string" || !RUN_AUTHORITIES.has(r.ranAs) ||
      (r.reasonCode !== undefined && (typeof r.reasonCode !== "string" || !RUN_REASON_CODE.test(r.reasonCode)))) {
    return null;
  }
  return {
    kind: "workflow-run", runId: r.runId, outcome: r.outcome as "succeeded" | "failed" | "uncertain",
    ranAs: r.ranAs as "gadget_bindings" | "service_account",
    ...(typeof r.reasonCode === "string" ? { reasonCode: r.reasonCode } : {}),
  };
}

/** One proposal as `chatbot.proposal_*` answers it. */
export function parseDotProposal(raw: unknown): DotProposalWire {
  const p = obj(raw, "proposal");
  const status = str(p.status, "proposal.status");
  if (!PROPOSAL_STATUSES.has(status)) throw new DotMalformed("proposal.status is not one InferOps names");
  return {
    id: id(p.id, "proposal.id"),
    tool: str(p.tool, "proposal.tool"),
    input: obj(p.input, "proposal.input"),
    status: status as DotProposalWire["status"],
    outcome: p.outcome ?? null,
    run: parseDotRun(p.run),
    createdAt: str(p.createdAt, "proposal.createdAt"),
    expiresAt: str(p.expiresAt, "proposal.expiresAt"),
    decidedAt: nullable(p.decidedAt, v => str(v, "proposal.decidedAt")),
  };
}

function parseDotMessage(raw: unknown): DotMessageWire {
  const m = obj(raw, "message");
  const role = str(m.role, "message.role");
  const status = str(m.status, "message.status");
  if (role !== "user" && role !== "assistant") throw new DotMalformed("message.role is not user or assistant");
  if (!MESSAGE_STATUSES.has(status)) throw new DotMalformed("message.status is not one InferOps names");
  return {
    id: id(m.id, "message.id"), role, content: str(m.content, "message.content"),
    status: status as DotMessageWire["status"], createdAt: str(m.createdAt, "message.createdAt"),
  };
}

/** One conversation as `chatbot.conversation_get` answers it. */
export function parseDotConversation(raw: unknown): DotConversationWire {
  const c = obj(raw, "conversation");
  return {
    id: id(c.id, "conversation.id"),
    title: str(c.title, "conversation.title"),
    messages: arr(c.messages, "conversation.messages").map(parseDotMessage),
    nextCursor: nullable(c.nextCursor, v => str(v, "conversation.nextCursor")),
    activeRunId: nullable(c.activeRunId, v => id(v, "conversation.activeRunId")),
    proposals: arr(c.proposals, "conversation.proposals").map(parseDotProposal),
  };
}

/**
 * The proposal a tool result carries, when the Dot's write was proposed: InferOps' broker answers
 * `{proposed: true, proposalId, message}` (FAC-132). Anything else is an ordinary tool result.
 */
export function proposedIdOf(content: unknown): string | null {
  let value: unknown = content;
  if (typeof content === "string") {
    try {
      value = JSON.parse(content);
    } catch {
      return null;
    }
  }
  if (value === null || typeof value !== "object") return null;
  const v = value as { proposed?: unknown; proposalId?: unknown };
  return v.proposed === true && typeof v.proposalId === "string" && UUID.test(v.proposalId)
    ? v.proposalId.toLowerCase() : null;
}
