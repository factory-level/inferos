// A scripted stand-in for an AI model, for exercising the InferOps Canvas locally with no model
// credentials. It speaks the OpenAI-compatible chat API under an Ollama-style base URL, so the
// Workshop reaches it as an "Ollama" model (`pnpm dev:setup --mock-model` adds one). It listens on
// 127.0.0.1 only and makes no request of its own.
//
// Two scripted scenarios, chosen with `--scenario`:
// - `kanban` (the default) plays the agent's part of "add an InferOps Kanban to this canvas": list
//   canvases, create the gadget from the `inferops.kanban` blueprint, request the DEMO board
//   connection, bind it into the gadget as `board`, and place the gadget on the canvas. Each reply is
//   chosen from what the conversation already holds, so a turn that pauses for the user's connection
//   approval resumes where it left off.
// - `operate-read` plays an Operate chat that reads the user's page: each question gets one
//   `operatePage` read, then a reply, labelled "[mock model]", naming the board that read returned.
// Everything it triggers runs through the real Workshop; only the model's decisions are scripted.
//
// Usage: node scripts/dev/scripted-model.ts [--port 11434] [--scenario kanban|operate-read]

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
  tool_calls?: { id: string; function: { name: string } }[];
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

/** The scenarios `--scenario` selects; the first is the default. */
export const SCRIPTED_SCENARIOS = ["kanban", "operate-read"] as const;

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

/** Read `--port` and `--scenario`, refusing anything else. */
export function parseOptions(argv: readonly string[]): { port: number; scenario: ScriptedScenario } {
  let port = 11434;
  let scenario: ScriptedScenario = "kanban";
  for (let i = 0; i < argv.length; i += 2) {
    const [name, value] = [argv[i], argv[i + 1]];
    if (name === "--port") port = Number(value);
    else if (name === "--scenario") {
      if (!(SCRIPTED_SCENARIOS as readonly string[]).includes(value ?? "")) {
        throw new Error(`Unknown scenario "${value ?? ""}"; choose one of ${SCRIPTED_SCENARIOS.join(", ")}.`);
      }
      scenario = value as ScriptedScenario;
    } else throw new Error(`Usage: scripted-model.ts [--port PORT] [--scenario ${SCRIPTED_SCENARIOS.join("|")}]`);
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Usage: scripted-model.ts [--port PORT] [--scenario ${SCRIPTED_SCENARIOS.join("|")}]`);
  }
  return { port, scenario };
}

/** Serve `scenario` on 127.0.0.1:`port` (0 picks a free port); resolves once it listens. */
export function startServer(options: { port: number; scenario: ScriptedScenario; log?: (line: string) => void }): Promise<Server> {
  const log = options.log ?? (line => console.log(line));
  const next = options.scenario === "operate-read" ? nextOperateReadReply : nextReply;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && (url.pathname === "/api/tags" || url.pathname === "/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(url.pathname === "/api/tags"
        ? { models: [{ name: SCRIPTED_MODEL_ID, model: SCRIPTED_MODEL_ID }] }
        : { object: "list", data: [{ id: SCRIPTED_MODEL_ID, object: "model" }] }));
      return;
    }
    if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
      response.writeHead(404).end();
      return;
    }
    let raw = "";
    request.on("data", chunk => { raw += chunk; });
    request.on("end", () => {
      try {
        const reply = next(JSON.parse(raw));
        log(logLine(options.scenario, reply));
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(streamReply(reply));
      } catch {
        // The request body is not logged: it carries the conversation.
        log(`${new Date().toISOString()} ${options.scenario} could not answer`);
        response.writeHead(500).end();
      }
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
}
