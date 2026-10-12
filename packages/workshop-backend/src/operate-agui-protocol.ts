import { parseReadRunSelectors } from "@gadgets/workshop-shared/operate-read-run";
import { EventType, omitOptionalNulls, type Event, type Message } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { z } from "zod";
import type { AiChatMessage, OperateReadRun } from "@gadgets/workshop-shared/api";
import type { OperateSessionSnapshot } from "@gadgets/workshop-shared/operate-session";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const navigation = z.object({
  event: z.object({type: z.literal("openBoard"), board: z.object({
    workspaceId: z.string().min(1).max(128), boardRef: z.string().min(1).max(512),
  }).strict()}).strict(),
  expectedSeq: z.number().int().nonnegative(),
}).strict();
const policy = z.object({
  threadId: z.string().max(128), runId: z.string().max(128), protocolVersion: z.literal("1.0").optional(),
  messages: z.array(z.object({id, role: z.literal("user"),
    content: z.union([z.string(), z.array(z.object({type: z.literal("text"), text: z.string()}).strict())]),
  }).strict()).length(1),
  tools: z.array(z.never()).optional(), context: z.array(z.never()).optional(),
  state: z.object({}).strict().optional(),
  forwardedProps: z.object({operate: navigation.optional()}).strict().optional(),
}).strict();

/** Canonical envelope first, then the supported one-turn policy; unknown authority is refused. */
export function parseOperateReadRun(value: unknown): OperateReadRun {
  RunAgentInputSchema.parse(value);
  const input = policy.parse(value);
  parseReadRunSelectors(input.threadId, input.runId);
  const content = input.messages[0].content;
  const message = typeof content === "string" ? content : content.map(part => part.text).join("");
  if (!message.trim() || message.length > 16_384) throw new Error("Invalid message");
  return {threadId: input.threadId, runId: input.runId, message,
    ...(input.forwardedProps?.operate ? {navigation: input.forwardedProps.operate} : {})};
}

/** Explicit reference/layout projection shared by the read tool and the HTTP stream. */
export function projectOperatePage({seq, state}: OperateSessionSnapshot) {
  const ref = (r: NonNullable<typeof state.focus>) => r.type === "screen"
    ? {type: r.type, workspaceId: r.workspaceId, screenId: r.screenId}
    : {type: r.type, workspaceId: r.workspaceId};
  return {
    seq, workingSet: state.workingSet.map(ref), focus: state.focus ? ref(state.focus) : null,
    subject: state.subject, chatOpen: state.chatOpen, appPresentation: state.appPresentation,
    presentation: state.presentation,
    board: state.board ? {workspaceId: state.board.workspaceId, boardRef: state.board.boardRef,
      issueId: state.board.issueId} : null,
    console: state.console ? {workspaceId: state.console.workspaceId, consoleId: state.console.consoleId,
      source: state.console.source, revision: state.console.revision,
      viewId: state.console.viewId, screenId: state.console.screenId} : null,
    flow: state.flow ? {workspaceId: state.flow.workspaceId, flowId: state.flow.flowId,
      steps: [...state.flow.steps], index: state.flow.index} : null,
  };
}

/** Only durable caller-visible text and this seam's recorded read output become wire history. */
export function projectReadMessage(message: AiChatMessage): Message[] {
  if (message.type !== "message") return [];
  const id = `chat-${message.chatId}-${message.sequence}`;
  if (message.author.type !== "agent") return [{id, role: "user", content: message.message}];
  const calls = (message.toolCalls ?? []).filter(call => call.toolName === "operatePage");
  const result: Message[] = [];
  if (message.reasoning) result.push({id: `${id}-reasoning`, role: "reasoning", content: message.reasoning});
  result.push({id, role: "assistant", content: message.message,
    ...(calls.length ? {toolCalls: calls.map(call => ({id: call.toolCallId, type: "function" as const,
      function: {name: "operatePage", arguments: "{}"}}))} : {})});
  for (const call of calls) result.push({id: `${id}-${call.toolCallId}`, role: "tool",
    toolCallId: call.toolCallId, content: call.error ? "Read refused." : call.output ?? ""});
  return result;
}

/** SSE encoder; no optional null wire fields and no application data outside the typed event. */
export function encodeOperateEvent(event: Event): string {
  return `data: ${JSON.stringify(omitOptionalNulls(event, "Event"))}\n\n`;
}

/** Durable step translator: provisional tokens are withheld until the kernel commits the step. */
export class OperateReadTranslator {
  #ended = false;
  #started = false;
  #messages = new Map<string, Message>();
  #state?: string;
  constructor(private threadId: string, private runId: string, private emit: (event: Event) => void) {}
  start(): void {
    if (this.#started) throw new Error("Run already started");
    this.#started = true;
    this.emit({type: EventType.RUN_STARTED, threadId: this.threadId, runId: this.runId, protocolVersion: "1.0"});
  }
  state(snapshot: OperateSessionSnapshot): void {
    const operate = projectOperatePage(snapshot);
    const encoded = JSON.stringify(operate);
    if (encoded === this.#state) return;
    this.#send(this.#state === undefined
      ? {type: EventType.STATE_SNAPSHOT, snapshot: {operate}}
      : {type: EventType.STATE_DELTA, delta: [{op: "replace", path: "/operate", value: operate}]});
    this.#state = encoded;
  }
  message(record: AiChatMessage): void {
    if (this.#ended) return;
    if (record.type === "error") { this.finish(false); return; }
    for (const message of projectReadMessage(record)) {
      if (this.#messages.has(message.id)) continue;
      this.#messages.set(message.id, message);
      if (message.role === "assistant") {
        if (typeof message.content === "string") {
          this.#send({type: EventType.TEXT_MESSAGE_START, messageId: message.id, role: "assistant"});
          if (message.content) this.#send({type: EventType.TEXT_MESSAGE_CONTENT, messageId: message.id, delta: message.content});
          this.#send({type: EventType.TEXT_MESSAGE_END, messageId: message.id});
        }
        for (const call of message.toolCalls ?? []) {
          this.#send({type: EventType.TOOL_CALL_START, toolCallId: call.id, toolCallName: call.function.name,
            parentMessageId: message.id});
          this.#send({type: EventType.TOOL_CALL_ARGS, toolCallId: call.id, delta: call.function.arguments});
          this.#send({type: EventType.TOOL_CALL_END, toolCallId: call.id});
        }
      } else if (message.role === "tool") {
        this.#send({type: EventType.TOOL_CALL_RESULT, messageId: message.id, toolCallId: message.toolCallId,
          content: message.content});
      }
    }
    // Reasoning and tool-only parents are represented canonically by the authoritative snapshot.
    this.#send({type: EventType.MESSAGES_SNAPSHOT, messages: [...this.#messages.values()]});
  }
  finish(success: boolean): void {
    if (this.#ended) return;
    this.#send(success
      ? {type: EventType.RUN_FINISHED, threadId: this.threadId, runId: this.runId}
      : {type: EventType.RUN_ERROR, code: "OPERATE_READ_FAILED", message: "The read run did not complete."});
    this.#ended = true;
  }
  #send(event: Event): void {
    if (!this.#started) throw new Error("Run has not started");
    if (!this.#ended) this.emit(event);
  }
}
