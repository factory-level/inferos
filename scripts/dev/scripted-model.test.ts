import { test } from "node:test";
import assert from "node:assert/strict";
import {
  logLine, MOCK_LABEL, nextOperateReadReply, nextReply, parseOptions, SCRIPTED_BOARD_URL, SCRIPTED_MODEL_ID,
  startServer, streamReply,
} from "./scripted-model.ts";

const tools = [{ type: "function", function: { name: "listCanvases" } }];
const user = { role: "user", content: 'Add a InferOps Kanban widget to the "Main" section of the "Operations" canvas.' };
let id = 0;
/** The assistant's call to `name` followed by the Workshop's result for it. */
const step = (name: string, result: unknown) => {
  const callId = `c${++id}`;
  return [
    { role: "assistant", tool_calls: [{ id: callId, function: { name } }] },
    { role: "tool", tool_call_id: callId, content: JSON.stringify(result) },
  ];
};
const toolName = (reply: ReturnType<typeof nextReply>) => "toolCall" in reply ? reply.toolCall.name : null;

const canvases = (revision: string) => ({ canvases: [
  { id: "other", title: "Other", revision: "0", sections: [] },
  { id: "ops", title: "Operations", revision, sections: [{ id: "main", widgets: [{}] }] },
] });

test("answers quick-model prompts with plain text", () => {
  assert.deepEqual(nextReply({ messages: [{ role: "user", content: "Choose a short, meaningful JavaScript identifier" }] }),
    { text: "DEMO_KANBAN" });
});

test("walks the Kanban flow one tool call at a time, resuming after the connection approval", () => {
  const messages: unknown[] = [user];
  const reply = () => nextReply({ messages: messages as never, tools });
  assert.equal(toolName(reply()), "listCanvases");
  messages.push(...step("listCanvases", canvases("2")));
  assert.equal(toolName(reply()), "createGadget");
  messages.push(...step("createGadget", { gadgetId: 7, changeId: 1 }));
  const connect = reply();
  assert.deepEqual("toolCall" in connect && connect.toolCall.arguments.resourceUrl, SCRIPTED_BOARD_URL);
  messages.push(...step("requestConnection", "Requested"));
  assert.equal(toolName(reply()), "setGadgetBinding");
  messages.push(...step("setGadgetBinding", { success: true }));

  const place = reply();
  assert.ok("toolCall" in place);
  assert.equal(place.toolCall.name, "editCanvas");
  // The canvas the request names, at the revision last listed, appended to its first section.
  assert.equal(place.toolCall.arguments.canvasId, "ops");
  assert.equal(place.toolCall.arguments.expectedRevision, "2");
  assert.deepEqual((place.toolCall.arguments.operations as { index: number; widget: { targetRef: string } }[])
    .map(op => [op.index, op.widget.targetRef]), [[1, "gadget:7"]]);

  messages.push(...step("editCanvas", { success: true }));
  assert.ok("text" in reply());
});

test("re-lists and retries against the new revision after a rejected edit", () => {
  const messages: unknown[] = [user, ...step("listCanvases", canvases("2")), ...step("createGadget", { gadgetId: 7 }),
    ...step("requestConnection", "ok"), ...step("setGadgetBinding", { success: true }),
    ...step("editCanvas", "Canvas changed; reload before applying this edit")];
  const reply = () => nextReply({ messages: messages as never, tools });
  assert.equal(toolName(reply()), "listCanvases");
  messages.push(...step("listCanvases", canvases("5")));
  const retry = reply();
  assert.ok("toolCall" in retry && retry.toolCall.arguments.expectedRevision === "5");
});

test("streams a tool call as an OpenAI-compatible event stream", () => {
  const body = streamReply({ toolCall: { name: "listCanvases", arguments: {} } });
  const events = body.split("\n\n").filter(Boolean);
  assert.equal(events.at(-1), "data: [DONE]");
  const first = JSON.parse(events[0].slice("data: ".length));
  assert.equal(first.choices[0].delta.tool_calls[0].function.name, "listCanvases");
  assert.equal(JSON.parse(events[1].slice("data: ".length)).choices[0].finish_reason, "tool_calls");
});

test("keeps the Kanban flow as the default scenario and refuses an unknown one", () => {
  assert.deepEqual(parseOptions([]), { port: 11434, scenario: "kanban" });
  assert.deepEqual(parseOptions(["--port", "11534", "--scenario", "operate-read"]), { port: 11534, scenario: "operate-read" });
  assert.throws(() => parseOptions(["--scenario", "operate-write"]), /Unknown scenario "operate-write"; choose one of kanban, operate-read\./);
  assert.throws(() => parseOptions(["--scenario"]), /Unknown scenario ""/);
  assert.throws(() => parseOptions(["--verbose"]), /Usage: scripted-model\.ts/);
  assert.throws(() => parseOptions(["--port", "x"]), /Usage: scripted-model\.ts/);
});

const operateTools = [{ type: "function", function: { name: "operatePage" } }, { type: "function", function: { name: "executeCode" } }];
const page = (boardRef: string | null) => ({ chatOpen: true, console: null, board: boardRef ? { workspaceId: "w", boardRef } : null });
const question = (content: string) => ({ role: "user", content });

test("operate-read reads the page once per question and names the board that read returned", () => {
  const ask = question("What is on my page?");
  assert.deepEqual(nextOperateReadReply({ messages: [ask], tools: operateTools }), { toolCall: { name: "operatePage", arguments: {} } });
  assert.deepEqual(nextOperateReadReply({ messages: [ask, ...step("operatePage", page("inferops://demo.local/project/board/DEMO"))], tools: operateTools }),
    { text: `${MOCK_LABEL} Your page shows the DEMO board.` });
  assert.deepEqual(nextOperateReadReply({ messages: [ask, ...step("operatePage", page(null))], tools: operateTools }),
    { text: `${MOCK_LABEL} Your page shows no board.` });
});

test("operate-read never answers a new question from an earlier turn's read", () => {
  const earlier = [question("What is on my page?"), ...step("operatePage", page("inferops://demo.local/project/board/DEMO")),
    { role: "assistant", content: `${MOCK_LABEL} Your page shows the DEMO board.` }];
  // The board was closed since: the new question must read the page again, not reuse the old result.
  const again = [...earlier, question("And now?")];
  assert.deepEqual(nextOperateReadReply({ messages: again, tools: operateTools }), { toolCall: { name: "operatePage", arguments: {} } });
  assert.deepEqual(nextOperateReadReply({ messages: [...again, ...step("operatePage", page(null))], tools: operateTools }),
    { text: `${MOCK_LABEL} Your page shows no board.` });
});

test("operate-read reports an unreadable or failed page read instead of guessing", () => {
  const ask = question("What is on my page?");
  const failed = [{ role: "assistant", tool_calls: [{ id: "f1", function: { name: "operatePage" } }] },
    { role: "tool", tool_call_id: "f1", content: "Error: the page could not be read" }];
  assert.deepEqual(nextOperateReadReply({ messages: [ask, ...failed], tools: operateTools }),
    { text: `${MOCK_LABEL} I could not read your page.` });
  // Another tool's result is not a page read.
  assert.deepEqual(nextOperateReadReply({ messages: [ask, ...step("executeCode", page("inferops://demo.local/project/board/DEMO"))], tools: operateTools }),
    { toolCall: { name: "operatePage", arguments: {} } });
});

test("operate-read answers outside an Operate chat and quick-model prompts with plain labelled text", () => {
  assert.deepEqual(nextOperateReadReply({ messages: [question("Build me a gadget")], tools }),
    { text: `${MOCK_LABEL} This scenario only reads an Operate page.` });
  assert.deepEqual(nextOperateReadReply({ messages: [question("Generate a brief, descriptive title")] }), { text: "Page read" });
});

test("logs only the scenario and the reply's kind, never its text or arguments", () => {
  const at = new Date("2026-10-12T00:00:00.000Z");
  assert.equal(logLine("operate-read", { text: `${MOCK_LABEL} secret-board-name` }, at), "2026-10-12T00:00:00.000Z operate-read text reply");
  assert.equal(logLine("kanban", { toolCall: { name: "requestConnection", arguments: { resourceUrl: "inferops://x/secret" } } }, at),
    "2026-10-12T00:00:00.000Z kanban tool call requestConnection");
});

/** POST one chat-completions request to a running scripted model; its streamed first delta. */
async function complete(base: string, body: unknown) {
  const response = await fetch(`${base}/v1/chat/completions`, { method: "POST", body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  const events = (await response.text()).split("\n\n").filter(Boolean);
  assert.equal(events.at(-1), "data: [DONE]");
  return JSON.parse(events[0].slice("data: ".length)).choices[0].delta;
}

test("serves each scenario over loopback HTTP with the same model id, logging bounded lines", async () => {
  for (const scenario of ["kanban", "operate-read"] as const) {
    const lines: string[] = [];
    const server = await startServer({ port: 0, scenario, log: line => lines.push(line) });
    try {
      const address = server.address() as { address: string; port: number };
      assert.equal(address.address, "127.0.0.1");
      const base = `http://127.0.0.1:${address.port}`;
      const tags = await (await fetch(`${base}/api/tags`)).json() as { models: { name: string }[] };
      assert.deepEqual(tags.models.map(model => model.name), [SCRIPTED_MODEL_ID]);
      const delta = scenario === "kanban"
        ? await complete(base, { messages: [user], tools })
        : await complete(base, { messages: [question("What is on my page?"), ...step("operatePage", page("inferops://demo.local/project/board/DEMO"))], tools: operateTools });
      if (scenario === "kanban") assert.equal(delta.tool_calls[0].function.name, "listCanvases");
      else assert.equal(delta.content, `${MOCK_LABEL} Your page shows the DEMO board.`);
      assert.equal((await fetch(`${base}/v1/chat/completions`, { method: "POST", body: "not json" })).status, 500);
      assert.equal(lines.length, 2);
      assert.match(lines[0], new RegExp(` ${scenario} (text reply|tool call listCanvases)$`));
      assert.match(lines[1], new RegExp(` ${scenario} could not answer$`));
      assert.ok(lines.every(line => !line.includes("DEMO") && !line.includes("not json")));
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }
});
