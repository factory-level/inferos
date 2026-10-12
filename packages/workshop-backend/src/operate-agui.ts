import { RpcStub as NativeRpcStub, RpcTarget } from "cloudflare:workers";
import { EventType } from "@ag-ui/core";
import type { RpcStub } from "capnweb";
import {
  getOperateSessionErrorCode, OPERATE_SESSION_ERROR_CODES, type AuthenticatedApi, type AiChatSubscriber,
  type OperateReadRun, type OperateSession, type Overseer,
} from "@gadgets/workshop-shared/api";
import type { OperateSessionSnapshot } from "@gadgets/workshop-shared/operate-session";
import { encodeOperateEvent, OperateReadTranslator, parseOperateReadRun } from "./operate-agui-protocol.js";

const MAX_BODY_BYTES = 64 * 1024;

/** Bound bytes actually read, rather than trusting Content-Length. */
async function readInput(request: Request): Promise<OperateReadRun> {
  if (!request.body) throw new Error("Missing body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new Error("Body too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return parseOperateReadRun(JSON.parse(new TextDecoder().decode(bytes)));
}

/** Authenticated one-shot HTTP producer. Auth is injected by the existing Worker boundary. */
export async function handleOperateAgui(request: Request,
    authenticate: () => Promise<AuthenticatedApi>): Promise<Response> {
  const error = (status: number, code: string) => Response.json({error: code}, {status});
  if (request.method !== "POST") return error(405, "METHOD_NOT_ALLOWED");
  if (request.headers.has("Origin") && request.headers.get("Origin") !== new URL(request.url).origin) {
    return error(403, "ORIGIN_REFUSED");
  }
  let api: AuthenticatedApi;
  try { api = await authenticate(); } catch { return error(401, "AUTHENTICATION_REQUIRED"); }
  let input: OperateReadRun;
  try { input = await readInput(request); } catch { return error(400, "UNSUPPORTED_READ_INPUT"); }

  const owned: Disposable[] = [];
  let ended = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  let bytes = 0;
  const cleanup = () => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    clearInterval(heartbeat);
    request.signal.removeEventListener("abort", abort);
    for (const stub of owned.toReversed()) stub[Symbol.dispose]();
  };
  const abort = () => { cleanup(); try { controller.close(); } catch { /* Reader already gone. */ } };
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    cancel() { cleanup(); },
  });
  const translator = new OperateReadTranslator(input.threadId, input.runId, event => {
    if (ended) return;
    const wire = encoder.encode(encodeOperateEvent(event));
    bytes += wire.byteLength;
    if (bytes > 4 * 1024 * 1024) {
      controller.enqueue(encoder.encode(encodeOperateEvent({type: EventType.RUN_ERROR,
        code: "OPERATE_READ_LIMIT", message: "The read stream exceeded its output limit."})));
      abort();
      return;
    }
    controller.enqueue(wire);
    if (event.type === "RUN_FINISHED" || event.type === "RUN_ERROR") abort();
  });
  let selected: number | undefined;
  let latest: OperateSessionSnapshot | undefined;
  const waiting: (() => void)[] = [];
  let finishing = false;
  let session: RpcStub<OperateSession>;
  let workspace: RpcStub<Overseer>;
  const finish = async () => {
    if (finishing || ended || selected === undefined) return;
    finishing = true;
    try {
      const history = await workspace.getChatHistory(selected);
      for (const message of history.messages) translator.message(message);
      translator.finish(!history.compacted);
    } catch { translator.finish(false); }
  };
  const forChat = (chatId: number, callback: () => void) => {
    if (selected === undefined) waiting.push(() => { if (chatId === selected && !ended) callback(); });
    else if (chatId === selected && !ended) callback();
  };
  try {
    session = await api.getOperateSession();
    if (Symbol.dispose in session) owned.push(session);
    workspace = await session.getWorkspace(); owned.push(workspace);
    const updates = new NativeRpcStub((snapshot: OperateSessionSnapshot) => {
      latest = snapshot;
      if (selected !== undefined && !ended) translator.state(snapshot);
    });
    owned.push(updates);
    // Native and Cap'n Web stubs share the runtime protocol (as in server.ts).
    owned.push(await session.subscribe(updates));
    const callbacks = new class extends RpcTarget implements AiChatSubscriber {
      streamGeneration() {}
      metadata(meta: Parameters<AiChatSubscriber["metadata"]>[0]) { forChat(meta.id, () => { if (!meta.activeAgent) void finish(); }); }
      deleted(chatId: number) { forChat(chatId, () => translator.finish(false)); }
      message(message: Parameters<AiChatSubscriber["message"]>[0]) { forChat(message.chatId, () => translator.message(message)); }
      changeApplied(chatId: number) { forChat(chatId, () => translator.finish(false)); }
      // Provisional events are intentionally withheld until their durable step commits.
      stream() {}
    };
    const subscriber = new NativeRpcStub(callbacks); owned.push(subscriber);
    const subscription = await workspace.subscribeToChat(subscriber);
    owned.push(subscription);
    selected = await session.startReadRun(input);
    translator.start();
    if (latest) translator.state(latest);
    for (const callback of waiting) callback();
    waiting.length = 0;
    if (!ended) {
      request.signal.addEventListener("abort", abort, {once: true});
      if (request.signal.aborted) abort();
      else {
        // Native subscription leases have no onRpcBroken method; silent loss fails at the deadline.
        timer = setTimeout(() => translator.finish(false), 60_000);
        heartbeat = setInterval(() => {
          if (!ended) controller.enqueue(encoder.encode(": ping\n\n"));
        }, 15_000);
      }
    }
    return new Response(body, {headers: {
      "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    }});
  } catch (cause) {
    cleanup();
    const code = getOperateSessionErrorCode(cause);
    if (code === OPERATE_SESSION_ERROR_CODES.conflict) return error(409, "OPERATE_SEQUENCE_CONFLICT");
    if (cause instanceof Error && cause.message === "OPERATE_READ_DUPLICATE") return error(409, "RUN_ALREADY_RESERVED");
    return error(403, "READ_RUN_REFUSED");
  }
}
