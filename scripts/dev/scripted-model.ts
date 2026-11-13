// A scripted stand-in for an AI model, for exercising the InferOps Canvas locally with no model
// credentials. It speaks the OpenAI-compatible chat API under an Ollama-style base URL, so the
// Workshop reaches it as an "Ollama" model (`pnpm dev:setup --mock-model` adds one). It listens on
// 127.0.0.1 only and makes no request of its own.
//
// Four scripted scenarios, chosen with `--scenario`:
// - `kanban` (the default) plays the agent's part of "add an InferOps Kanban to this canvas": list
//   canvases, create the gadget from the `inferops.kanban` blueprint, request the DEMO board
//   connection, bind it into the gadget as `board`, and place the gadget on the canvas. Each reply is
//   chosen from what the conversation already holds, so a turn that pauses for the user's connection
//   approval resumes where it left off.
// - `operate-read` plays an Operate chat that reads the user's page: each question gets one
//   `operatePage` read, then a reply, labelled "[mock model]", naming the board that read returned.
// - `delegate` plays the restricted first turn of a FAC-147 delegate: it searches for a service
//   widget using the delegate's real `findWidgets` tool, then reports only after that tool returns.
// - `delegate-lifecycle` plays a FAC-147 delegate through its lifecycle: one protected write through
//   its InferOps connection (`createIssue`, queued for the person's approval), with an optional hold
//   point before it that the journey waits on (`--hold-before-write`, `GET /scenario/state`,
//   `POST /scenario/release`); then `--reads` held reads of its connection, the window in which a
//   grant can be revoked; then a finishing reply. A request it doesn't script is answered with an
//   error, never a guess.
// Everything it triggers runs through the real Workshop; only the model's decisions are scripted.
//
// Usage: node scripts/dev/scripted-model.ts [--port 11434] [--scenario kanban|operate-read|delegate|delegate-lifecycle]
//   delegate-lifecycle only: [--hold-before-write] [--reads 20] [--read-ms 1000] [--issue-title TITLE]

import { createServer, type Server } from "node:http";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The model id the server answers to; `dev:setup --mock-model` registers this id. */
export const SCRIPTED_MODEL_ID = "scripted-inferops";

/** The board the scripted agent connects. */
export const SCRIPTED_BOARD_URL = "inferops://demo.local/project/board/DEMO";

/** One model reply: plain text, or a single tool call. */
export type ScriptedReply = { text: string } | { toolCall: { name: string; arguments: Record<string, unknown> } };

type Message = {
  role: string;
  content?: unknown;
  tool_calls?: { id: string; function: { name: string; arguments?: string } }[];
  tool_call_id?: string;
};

const text = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map(part => (part as { text?: string }).text ?? "").join("") : "";

const parse = (value: string | undefined): Record<string, unknown> | undefined => {
  try { return value === undefined ? undefined : JSON.parse(value); } catch { return undefined; }
};

const call = (name: string, args: Record<string, unknown>): ScriptedReply => ({ toolCall: { name, arguments: args } });

type CanvasSummary = {
  id: string;
  title: string;
  revision: string;
  sections: { id: string; widgets: unknown[] }[];
};

/** Choose the next reply for a chat-completions request body. */
export function nextReply(body: { messages?: Message[]; tools?: unknown[] }): ScriptedReply {
  const messages = body.messages ?? [];
  // Quick-model requests (chat titles, binding names) carry no tools.
  if (!body.tools?.length) {
    return { text: /JavaScript identifier/.test(text(messages.at(-1)?.content)) ? "DEMO_KANBAN" : "InferOps Kanban" };
  }
  const calls: { id: string; name: string; result?: string }[] = [];
  for (const message of messages) {
    for (const toolCall of message.tool_calls ?? []) calls.push({ id: toolCall.id, name: toolCall.function.name });
    if (message.role === "tool") {
      const match = calls.find(entry => entry.id === message.tool_call_id);
      if (match) match.result = text(message.content);
    }
  }
  const last = (name: string) => calls.filter(entry => entry.name === name).at(-1);

  if (!last("listCanvases")) return call("listCanvases", {});
  if (!last("createGadget")) {
    return call("createGadget", { title: "DEMO Kanban", bindingName: "DEMO_KANBAN", blueprintId: "inferops.kanban" });
  }
  if (!last("requestConnection")) {
    return call("requestConnection", { vendorId: "inferops", resourceUrl: SCRIPTED_BOARD_URL,
      reason: "Show the DEMO project board in the Kanban widget.", bindingName: "DEMO_BOARD" });
  }
  if (!last("setGadgetBinding")) return call("setGadgetBinding", { gadget: "DEMO_KANBAN", source: "DEMO_BOARD", name: "board" });

  const edit = last("editCanvas");
  if (edit && parse(edit.result)?.success === true) {
    return { text: "Added a DEMO Kanban board to your canvas. Accept this chat's changes to show it there." };
  }
  const listed = last("listCanvases")!;
  // After a rejected edit, re-read the canvases so the retry targets the current revision.
  if (edit && calls.indexOf(listed) < calls.indexOf(edit)) return call("listCanvases", {});
  const canvases = (parse(listed.result)?.canvases ?? []) as CanvasSummary[];
  const request = messages.filter(message => message.role === "user").map(message => text(message.content)).join("\n");
  const canvas = canvases.find(entry => request.includes(`"${entry.title}" canvas`)) ?? canvases[0];
  const gadgetId = parse(last("createGadget")!.result)?.gadgetId;
  if (!canvas || gadgetId === undefined) {
    return { text: "I couldn't find a canvas to place the Kanban on. Create a screen first, then ask again." };
  }
  const widget = { id: `kanban-${gadgetId}`, kind: "inferos.gadget", version: 1, targetRef: `gadget:${gadgetId}`, size: "full", params: {} };
  const [section] = canvas.sections;
  const operations = section
    ? [{ type: "addWidget", sectionId: section.id, index: section.widgets.length, widget }]
    : [{ type: "addSection", index: 0, section: { id: "boards", title: "Boards", columns: 1, widgets: [widget] } }];
  return call("editCanvas", { canvasId: canvas.id, expectedRevision: canvas.revision, operations });
}

let sequence = 0;

/** Render a reply as the OpenAI-compatible event stream the Workshop's model client reads. */
export function streamReply(reply: ScriptedReply): string {
  const base = { id: `scripted-${++sequence}`, object: "chat.completion.chunk", created: 0, model: SCRIPTED_MODEL_ID };
  const delta = "text" in reply
    ? { role: "assistant", content: reply.text }
    : { role: "assistant", tool_calls: [{ index: 0, id: `call_${sequence}`, type: "function",
      function: { name: reply.toolCall.name, arguments: JSON.stringify(reply.toolCall.arguments) } }] };
  const event = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
  return event({ ...base, choices: [{ index: 0, delta, finish_reason: null }] }) +
    event({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "text" in reply ? "stop" : "tool_calls" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) +
    "data: [DONE]\n\n";
}

/**
 * A bounded scripted delegate turn for the FAC-147 lifecycle proof. It uses only `findWidgets`, a
 * tool in the delegate's fixed read-only ceiling, and bases its final reply on that tool's result.
 * No second tool call or provider fallback is possible in this scenario.
 */
export function nextDelegateReply(body: { messages?: Message[]; tools?: unknown[] }): ScriptedReply {
  const messages = body.messages ?? [];
  if (!body.tools?.length) return { text: "Delegate task received." };
  const offered = (body.tools as { function?: { name?: string } }[]).map(tool => tool.function?.name);
  if (!offered.includes("findWidgets")) return { text: "[mock delegate] Widget search is not available." };

  const searches = new Set<string>();
  messages.forEach(message => {
    for (const toolCall of message.tool_calls ?? []) {
      if (toolCall.function.name === "findWidgets") searches.add(toolCall.id);
    }
  });
  const result = messages.findLast(message => message.role === "tool" && searches.has(message.tool_call_id ?? ""));
  if (!result) return call("findWidgets", { query: "service workflow" });

  const found = parse(text(result.content));
  if (found?.status !== "searched") return { text: "[mock delegate] The service widget search was unavailable." };
  const definitions = Array.isArray(found.definitions) ? found.definitions : [];
  return definitions.length > 0
    ? { text: "[mock delegate] I found a service widget available in this session." }
    : { text: "[mock delegate] I found no service widget available in this session." };
}

/** How a `delegate-lifecycle` run is shaped (`--hold-before-write`, `--reads`, `--read-ms`, `--issue-title`). */
export type LifecycleOptions = {
  /** Hold the reply that makes the write until `POST /scenario/release`: the journey's kill point. */
  holdBeforeWrite: boolean;
  /** Read calls made after the write: the window in which a grant can be revoked mid-run. */
  reads: number;
  /** How long each of those reads' replies is held, in milliseconds. */
  readMs: number;
  /** The title of the one issue the delegate proposes: the protected effect the journey counts. */
  issueTitle: string;
};

/** The defaults: no hold, 20 reads of a second each (about 20 s to revoke in), a fixed title. */
export const LIFECYCLE_DEFAULTS: LifecycleOptions = {
  holdBeforeWrite: false, reads: 20, readMs: 1000, issueTitle: "FAC-147 delegate effect",
};

/** Marks the one `executeCode` call that makes the write, so a later request finds its result. */
export const LIFECYCLE_WRITE_MARKER = "// fac147:write";

/** Every `delegate-lifecycle` text reply starts with this. */
export const LIFECYCLE_LABEL = "[mock delegate]";

/** A request the `delegate-lifecycle` script doesn't cover: answered with an error, never a guess. */
export class UnscriptedRequest extends Error {}

/** Where a `delegate-lifecycle` reply is in the script: what the journey can wait on. */
export type LifecycleStep = "write" | "read" | "finished";

/**
 * Choose the next `delegate-lifecycle` reply, from what the conversation already holds, and the
 * step it is at. The delegate's InferOps binding (`env.INFEROPS_…`, named in its prompt) is asked
 * for one write, `createIssue` with `options.issueTitle`, through `executeCode` (marked
 * {@link LIFECYCLE_WRITE_MARKER}). Then it reads that binding `options.reads` times
 * (`describeBinding`): the window for a revoke. Then it finishes. A write that answered an error,
 * or a read after it that was refused, ends with words saying so. Anything else (no InferOps
 * binding, `executeCode` or `describeBinding` not offered) throws {@link UnscriptedRequest}.
 */
export function nextLifecycleReply(
  body: { messages?: Message[]; tools?: unknown[] },
  options: LifecycleOptions = LIFECYCLE_DEFAULTS,
): { reply: ScriptedReply; step: LifecycleStep } {
  const messages = body.messages ?? [];
  // Quick-model requests (chat titles) carry no tools.
  if (!body.tools?.length) return { reply: { text: "Delegate run" }, step: "finished" };
  const offered = (body.tools as { function?: { name?: string } }[]).map(tool => tool.function?.name);
  for (const needed of ["executeCode", "describeBinding"]) {
    if (!offered.includes(needed)) throw new UnscriptedRequest(`the delegate isn't offered ${needed}`);
  }
  const binding = messages.map(message => text(message.content)).join("\n")
    .match(/\benv\.(INFEROPS_[A-Za-z0-9_]+)/)?.[1];
  if (!binding) throw new UnscriptedRequest("the delegate holds no InferOps binding");

  const calls: { name: string; args: string; id: string; result?: string }[] = [];
  for (const message of messages) {
    for (const toolCall of message.tool_calls ?? []) {
      calls.push({ id: toolCall.id, name: toolCall.function.name, args: toolCall.function.arguments ?? "" });
    }
    if (message.role === "tool") {
      const match = calls.find(entry => entry.id === message.tool_call_id);
      if (match) match.result = text(message.content);
    }
  }
  const write = calls.find(entry => entry.name === "executeCode" && entry.args.includes(LIFECYCLE_WRITE_MARKER));
  if (!write || write.result === undefined) {
    const code = `export default async function(self, env) {\n  ${LIFECYCLE_WRITE_MARKER}\n` +
      `  return await env.${binding}.createIssue({ title: ${JSON.stringify(options.issueTitle)} });\n}\n`;
    return { reply: call("executeCode", { code }), step: "write" };
  }
  if (/\berror\b/i.test(write.result)) {
    return { reply: { text: `${LIFECYCLE_LABEL} The change was not proposed.` }, step: "finished" };
  }
  const reads = calls.slice(calls.indexOf(write) + 1).filter(entry => entry.name === "describeBinding");
  if (reads.some(entry => entry.result !== undefined && /\berror\b/i.test(entry.result))) {
    return { reply: { text: `${LIFECYCLE_LABEL} Stopped: a read after the change was refused.` }, step: "finished" };
  }
  if (reads.length < options.reads) return { reply: call("describeBinding", { name: binding }), step: "read" };
  return { reply: { text: `${LIFECYCLE_LABEL} Proposed "${options.issueTitle}" and finished.` }, step: "finished" };
}

/** The scenarios `--scenario` selects; the first is the default. */
export const SCRIPTED_SCENARIOS = ["kanban", "operate-read", "delegate", "delegate-lifecycle"] as const;

/** One of {@link SCRIPTED_SCENARIOS}. */
export type ScriptedScenario = typeof SCRIPTED_SCENARIOS[number];

/** Every `operate-read` text reply starts with this, so a transcript shows it came from the script. */
export const MOCK_LABEL = "[mock model]";

/**
 * Choose the next `operate-read` reply. It reads the page once per question and answers only from
 * the `operatePage` result that followed the latest user message, never from an earlier turn's.
 * The answer names the board the page shows, its `board.boardRef`; a widget shown full-page is not
 * the page's board, so it is not reported as one.
 */
export function nextOperateReadReply(body: { messages?: Message[]; tools?: unknown[] }): ScriptedReply {
  const messages = body.messages ?? [];
  if (!body.tools?.length) return { text: "Page read" };
  const offered = (body.tools as { function?: { name?: string } }[]).map(tool => tool.function?.name);
  if (!offered.includes("operatePage")) return { text: `${MOCK_LABEL} This scenario only reads an Operate page.` };
  const latestUser = messages.map(message => message.role).lastIndexOf("user");
  const reads = new Set<string>();
  messages.forEach((message, index) => {
    if (index < latestUser) return;
    for (const toolCall of message.tool_calls ?? []) if (toolCall.function.name === "operatePage") reads.add(toolCall.id);
  });
  const result = messages.findLast((message, index) =>
    index > latestUser && message.role === "tool" && reads.has(message.tool_call_id ?? ""));
  if (!result) return call("operatePage", {});
  const page = parse(text(result.content));
  if (page === undefined) return { text: `${MOCK_LABEL} I could not read your page.` };
  const board = page.board as { boardRef?: unknown } | null | undefined;
  return typeof board?.boardRef === "string"
    ? { text: `${MOCK_LABEL} Your page shows the ${board.boardRef.split("/").at(-1)} board.` }
    : { text: `${MOCK_LABEL} Your page shows no board.` };
}

/** One server log line: the time, the scenario and the reply's kind, never its text or arguments. */
export function logLine(scenario: ScriptedScenario, reply: ScriptedReply, at = new Date()): string {
  return `${at.toISOString()} ${scenario} ${"text" in reply ? "text reply" : `tool call ${reply.toolCall.name}`}`;
}

const USAGE = `Usage: scripted-model.ts [--port PORT] [--scenario ${SCRIPTED_SCENARIOS.join("|")}]` +
  " (delegate-lifecycle: [--hold-before-write] [--reads N] [--read-ms MS] [--issue-title TITLE])";

/** Read `--port`, `--scenario` and `delegate-lifecycle`'s own options, refusing anything else. */
export function parseOptions(argv: readonly string[]): {
  port: number; scenario: ScriptedScenario; lifecycle: LifecycleOptions;
} {
  let port = 11434;
  let scenario: ScriptedScenario = "kanban";
  const lifecycle = { ...LIFECYCLE_DEFAULTS };
  let lifecycleOptionGiven = false;
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    if (name === "--hold-before-write") {
      lifecycle.holdBeforeWrite = true;
      lifecycleOptionGiven = true;
      continue;
    }
    const value = argv[++i];
    if (name === "--scenario") {
      if (!(SCRIPTED_SCENARIOS as readonly string[]).includes(value ?? "")) {
        throw new Error(`Unknown scenario "${value ?? ""}"; choose one of ${SCRIPTED_SCENARIOS.join(", ")}.`);
      }
      scenario = value as ScriptedScenario;
    } else if (value === undefined) throw new Error(USAGE);
    else if (name === "--port") port = Number(value);
    else if (name === "--reads" || name === "--read-ms") {
      const number = Number(value);
      if (!Number.isInteger(number) || number < 0 || number > (name === "--reads" ? 1000 : 600000)) throw new Error(USAGE);
      if (name === "--reads") lifecycle.reads = number;
      else lifecycle.readMs = number;
      lifecycleOptionGiven = true;
    } else if (name === "--issue-title") {
      if (!value.trim() || value.length > 500) throw new Error(USAGE);
      lifecycle.issueTitle = value;
      lifecycleOptionGiven = true;
    } else throw new Error(USAGE);
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(USAGE);
  if (lifecycleOptionGiven && scenario !== "delegate-lifecycle") {
    throw new Error("--hold-before-write, --reads, --read-ms and --issue-title are delegate-lifecycle's only.");
  }
  return { port, scenario, lifecycle };
}

/**
 * What a `delegate-lifecycle` server has seen, for the journey (`GET /scenario/state`): whether its
 * hold before the write is still armed, how many requests wait on it now, and how many replies of
 * each step it has sent. Counts only, never the conversation.
 */
export type LifecycleState = {
  scenario: "delegate-lifecycle";
  holdArmed: boolean;
  waitingAtHold: number;
  replies: Record<LifecycleStep, number>;
};

/**
 * Serve `scenario` on 127.0.0.1:`port` (0 picks a free port); resolves once it listens. A
 * `delegate-lifecycle` server also answers `GET /scenario/state` ({@link LifecycleState}) and
 * `POST /scenario/release`, which lets every request held before the write go on, and disarms the
 * hold for good.
 */
export function startServer(options: {
  port: number; scenario: ScriptedScenario; lifecycle?: LifecycleOptions; log?: (line: string) => void;
}): Promise<Server> {
  const log = options.log ?? (line => console.log(line));
  const lifecycle = options.lifecycle ?? LIFECYCLE_DEFAULTS;
  const state: LifecycleState = {
    scenario: "delegate-lifecycle", holdArmed: lifecycle.holdBeforeWrite, waitingAtHold: 0,
    replies: { write: 0, read: 0, finished: 0 },
  };
  let release = () => {};
  const released = new Promise<void>(resolve => { release = resolve; });
  if (!lifecycle.holdBeforeWrite) release();
  const next = async (body: { messages?: Message[]; tools?: unknown[] }): Promise<ScriptedReply> => {
    if (options.scenario === "operate-read") return nextOperateReadReply(body);
    if (options.scenario === "delegate") return nextDelegateReply(body);
    if (options.scenario === "kanban") return nextReply(body);
    const { reply, step } = nextLifecycleReply(body, lifecycle);
    if (step === "write" && state.holdArmed) {
      state.waitingAtHold += 1;
      log(`${new Date().toISOString()} delegate-lifecycle held before the write`);
      try {
        await released;
      } finally {
        state.waitingAtHold -= 1;
      }
    }
    if (step === "read" && lifecycle.readMs > 0) await new Promise(resolve => setTimeout(resolve, lifecycle.readMs));
    state.replies[step] += 1;
    return reply;
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && (url.pathname === "/api/tags" || url.pathname === "/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(url.pathname === "/api/tags"
        ? { models: [{ name: SCRIPTED_MODEL_ID, model: SCRIPTED_MODEL_ID }] }
        : { object: "list", data: [{ id: SCRIPTED_MODEL_ID, object: "model" }] }));
      return;
    }
    if (options.scenario === "delegate-lifecycle" && url.pathname.startsWith("/scenario/")) {
      if (request.method === "GET" && url.pathname === "/scenario/state") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(state));
      } else if (request.method === "POST" && url.pathname === "/scenario/release") {
        state.holdArmed = false;
        release();
        log(`${new Date().toISOString()} delegate-lifecycle released the hold`);
        response.writeHead(204).end();
      } else {
        response.writeHead(404).end();
      }
      return;
    }
    if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
      response.writeHead(404).end();
      return;
    }
    let raw = "";
    request.on("data", chunk => { raw += chunk; });
    request.on("end", () => {
      void (async () => {
        try {
          const reply = await next(JSON.parse(raw));
          log(logLine(options.scenario, reply));
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(streamReply(reply));
        } catch (error) {
          // The request body is not logged: it carries the conversation. An unscripted request's
          // reason names only what it lacked.
          const why = error instanceof UnscriptedRequest ? `: unscripted request, ${error.message}` : "";
          log(`${new Date().toISOString()} ${options.scenario} could not answer${why}`);
          response.writeHead(500, { "content-type": "application/json" });
          const message = error instanceof UnscriptedRequest ? `unscripted request, ${error.message}` : "could not answer";
          response.end(JSON.stringify({ error: { message: `scripted model: ${message}` } }));
        }
      })();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => resolve(server));
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options: ReturnType<typeof parseOptions>;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  const server = await startServer(options);
  const { port } = server.address() as { port: number };
  console.log(`Scripted model "${SCRIPTED_MODEL_ID}" (${options.scenario}) listening on http://localhost:${port}`);
  if (options.scenario === "delegate-lifecycle" && options.lifecycle.holdBeforeWrite) {
    console.log(`Holding before the write: GET http://localhost:${port}/scenario/state, POST http://localhost:${port}/scenario/release`);
  }
}
