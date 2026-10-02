// A scripted stand-in for an AI model, for exercising the InferOps Canvas locally with no model
// credentials. It speaks the OpenAI-compatible chat API under an Ollama-style base URL, so the
// Workshop reaches it as an "Ollama" model (`pnpm dev:setup --mock-model` adds one).
//
// It plays the agent's part of "add an InferOps Kanban to this canvas": list canvases, create the
// gadget from the `inferops.kanban` blueprint, request the DEMO board connection, bind it into the
// gadget as `board`, and place the gadget on the canvas. Each reply is chosen from what the
// conversation already holds, so a turn that pauses for the user's connection approval resumes
// where it left off. Everything it triggers runs through the real Workshop; only the model's
// decisions are scripted.
//
// Usage: node scripts/dev/scripted-model.ts [--port 11434]

import { createServer } from "node:http";
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

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const portFlag = process.argv.indexOf("--port");
  const port = portFlag >= 0 ? Number(process.argv[portFlag + 1]) : 11434;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Usage: scripted-model.ts [--port PORT]");
  createServer((request, response) => {
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
        const reply = nextReply(JSON.parse(raw));
        console.log(new Date().toISOString(), "text" in reply ? "text reply" : `tool call ${reply.toolCall.name}`);
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(streamReply(reply));
      } catch (error) {
        console.error("scripted model failed to answer", error);
        response.writeHead(500).end();
      }
    });
  }).listen(port, "127.0.0.1", () => {
    console.log(`Scripted model "${SCRIPTED_MODEL_ID}" listening on http://localhost:${port}`);
  });
}
