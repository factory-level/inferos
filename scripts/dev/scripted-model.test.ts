import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LIFECYCLE_DEFAULTS, LIFECYCLE_LABEL, LIFECYCLE_WRITE_MARKER, type LifecycleState, logLine, MOCK_LABEL, nextDelegateReply,
  nextLifecycleReply, nextOperateReadReply, nextReply, parseOptions, SCRIPTED_BOARD_URL, SCRIPTED_MODEL_ID, startServer,
  streamReply, UnscriptedRequest,
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
  assert.deepEqual(parseOptions([]), { port: 11434, scenario: "kanban", lifecycle: LIFECYCLE_DEFAULTS });
  assert.deepEqual(parseOptions(["--port", "11534", "--scenario", "operate-read"]),
    { port: 11534, scenario: "operate-read", lifecycle: LIFECYCLE_DEFAULTS });
  assert.throws(() => parseOptions(["--scenario", "operate-write"]),
    /Unknown scenario "operate-write"; choose one of kanban, operate-read, delegate, delegate-lifecycle\./);
  assert.throws(() => parseOptions(["--scenario"]), /Unknown scenario ""/);
  assert.throws(() => parseOptions(["--verbose"]), /Usage: scripted-model\.ts/);
  assert.throws(() => parseOptions(["--port", "x"]), /Usage: scripted-model\.ts/);
});

const operateTools = [{ type: "function", function: { name: "operatePage" } }, { type: "function", function: { name: "executeCode" } }];
const delegateTools = [{ type: "function", function: { name: "findWidgets" } }];
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

test("delegate uses only its offered findWidgets tool and bases the answer on the returned result", () => {
  const ask = question("Find the service workflow widget");
  assert.deepEqual(nextDelegateReply({ messages: [ask], tools: delegateTools }),
    { toolCall: { name: "findWidgets", arguments: { query: "service workflow" } } });
  assert.deepEqual(nextDelegateReply({ messages: [ask, ...step("findWidgets", {
    status: "searched", definitions: [{ id: "service.workflow" }],
  })], tools: delegateTools }),
  { text: "[mock delegate] I found a service widget available in this session." });
  assert.deepEqual(nextDelegateReply({ messages: [ask, ...step("findWidgets", {
    status: "searched", definitions: [],
  })], tools: delegateTools }),
  { text: "[mock delegate] I found no service widget available in this session." });
  assert.deepEqual(nextDelegateReply({ messages: [ask, ...step("findWidgets", { status: "unavailable" })], tools: delegateTools }),
    { text: "[mock delegate] The service widget search was unavailable." });
  assert.deepEqual(nextDelegateReply({ messages: [ask], tools: operateTools }),
    { text: "[mock delegate] Widget search is not available." });
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
  for (const scenario of ["kanban", "operate-read", "delegate"] as const) {
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
        : scenario === "operate-read"
          ? await complete(base, { messages: [question("What is on my page?"), ...step("operatePage", page("inferops://demo.local/project/board/DEMO"))], tools: operateTools })
          : await complete(base, { messages: [question("Find a service workflow")], tools: delegateTools });
      if (scenario === "kanban") assert.equal(delta.tool_calls[0].function.name, "listCanvases");
      else if (scenario === "operate-read") assert.equal(delta.content, `${MOCK_LABEL} Your page shows the DEMO board.`);
      else assert.equal(delta.tool_calls[0].function.name, "findWidgets");
      assert.equal((await fetch(`${base}/v1/chat/completions`, { method: "POST", body: "not json" })).status, 500);
      assert.equal(lines.length, 2);
      assert.match(lines[0], new RegExp(` ${scenario} (text reply|tool call (listCanvases|findWidgets))$`));
      assert.match(lines[1], new RegExp(` ${scenario} could not answer$`));
      assert.ok(lines.every(line => !line.includes("DEMO") && !line.includes("not json")));
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }
});

// FAC-147: the delegate's lifecycle. Its prompt names its InferOps binding; it writes once, reads, finishes.
const lifecycleTools = ["executeCode", "describeBinding", "grep"].map(name => ({ type: "function", function: { name } }));
const delegatePrompt = { role: "system", content: "Your bindings: env.INFEROPS_7 (the DEMO board)." };
const task = { role: "user", content: "Make the agreed change, then check the board." };
/** The assistant's `name` call with `args`, then the Workshop's result for it. */
const called = (name: string, args: Record<string, unknown>, result: unknown) => {
  const callId = `call_${++id}`;
  return [
    { role: "assistant", tool_calls: [{ id: callId, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
    { role: "tool", tool_call_id: callId, content: typeof result === "string" ? result : JSON.stringify(result) },
  ];
};
const lifecycle = (messages: unknown[], options = { ...LIFECYCLE_DEFAULTS, reads: 2 }) =>
  nextLifecycleReply({ messages: [delegatePrompt, task, ...messages] as never, tools: lifecycleTools }, options);
const writeCall = () => {
  const { reply } = lifecycle([]);
  assert.ok("toolCall" in reply);
  return reply.toolCall.arguments;
};

test("delegate-lifecycle writes once through its own InferOps binding, then reads, then finishes", () => {
  const first = lifecycle([]);
  assert.equal(first.step, "write");
  assert.ok("toolCall" in first.reply && first.reply.toolCall.name === "executeCode");
  const code = String(writeCall().code);
  assert.match(code, /^export default async function\(self, env\) \{/);
  assert.ok(code.includes(LIFECYCLE_WRITE_MARKER));
  assert.ok(code.includes(`env.INFEROPS_7.createIssue({ title: ${JSON.stringify(LIFECYCLE_DEFAULTS.issueTitle)} })`));
  // After the write answers (a receipt, queued for the person's approval): reads, then the end.
  const wrote = called("executeCode", writeCall(), { receipt: { status: "pending" } });
  assert.deepEqual(lifecycle(wrote), { reply: { toolCall: { name: "describeBinding", arguments: { name: "INFEROPS_7" } } }, step: "read" });
  const read = () => called("describeBinding", { name: "INFEROPS_7" }, "createIssue(issue): Promise<WriteReceipt | null>");
  assert.equal(lifecycle([...wrote, ...read()]).step, "read");
  const done = lifecycle([...wrote, ...read(), ...read()]);
  assert.equal(done.step, "finished");
  assert.deepEqual(done.reply, { text: `${LIFECYCLE_LABEL} Proposed "${LIFECYCLE_DEFAULTS.issueTitle}" and finished.` });
});

test("delegate-lifecycle never writes twice: a written conversation only reads, and a refusal ends it", () => {
  const wrote = called("executeCode", writeCall(), { receipt: { status: "pending" } });
  for (let reads = 0; reads <= 2; reads++) {
    const messages = [...wrote, ...Array.from({ length: reads }, () => called("describeBinding", { name: "INFEROPS_7" }, "ok")).flat()];
    const { reply } = lifecycle(messages);
    assert.ok(!("toolCall" in reply) || reply.toolCall.name !== "executeCode", `after ${reads} reads`);
  }
  // A write that answered an error, or a read refused after it (a revoked grant): ended, in words.
  assert.deepEqual(lifecycle(called("executeCode", writeCall(), { error: "FORBIDDEN" })),
    { reply: { text: `${LIFECYCLE_LABEL} The change was not proposed.` }, step: "finished" });
  assert.deepEqual(lifecycle([...wrote, ...called("describeBinding", { name: "INFEROPS_7" }, "Error: A delegate may not call this.")]),
    { reply: { text: `${LIFECYCLE_LABEL} Stopped: a read after the change was refused.` }, step: "finished" });
  // A write still unanswered (its turn cut off before a result) is asked for again: one call, one proposal.
  const cut = [{ role: "assistant", tool_calls: [{ id: "call_cut", type: "function", function: { name: "executeCode", arguments: JSON.stringify(writeCall()) } }] }];
  assert.equal(lifecycle(cut).step, "write");
});

test("delegate-lifecycle refuses what it doesn't script, loudly", () => {
  assert.throws(() => nextLifecycleReply({ messages: [task] as never, tools: lifecycleTools }), UnscriptedRequest);
  assert.throws(() => nextLifecycleReply({ messages: [delegatePrompt, task] as never, tools: delegateTools }),
    /isn't offered executeCode/);
  assert.deepEqual(nextLifecycleReply({ messages: [task] as never }), { reply: { text: "Delegate run" }, step: "finished" });
});

test("delegate-lifecycle's options parse only with it, and are bounded", () => {
  assert.deepEqual(parseOptions(["--scenario", "delegate-lifecycle", "--hold-before-write", "--reads", "5", "--read-ms", "0", "--issue-title", "Count me"]),
    { port: 11434, scenario: "delegate-lifecycle", lifecycle: { holdBeforeWrite: true, reads: 5, readMs: 0, issueTitle: "Count me" } });
  assert.throws(() => parseOptions(["--hold-before-write"]), /delegate-lifecycle's only/);
  assert.throws(() => parseOptions(["--scenario", "delegate-lifecycle", "--reads", "-1"]), /Usage: scripted-model\.ts/);
  assert.throws(() => parseOptions(["--scenario", "delegate-lifecycle", "--issue-title", " "]), /Usage: scripted-model\.ts/);
  assert.throws(() => parseOptions(["--scenario", "delegate-lifecycle", "--reads"]), /Usage: scripted-model\.ts/);
});

test("delegate-lifecycle holds its write until released, says so at /scenario/state, and answers an unscripted request with an error", async () => {
  const lines: string[] = [];
  const server = await startServer({ port: 0, scenario: "delegate-lifecycle", log: line => lines.push(line),
    lifecycle: { ...LIFECYCLE_DEFAULTS, holdBeforeWrite: true, reads: 1, readMs: 0 } });
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const state = async () => await (await fetch(`${base}/scenario/state`)).json() as LifecycleState;
    assert.deepEqual(await state(), { scenario: "delegate-lifecycle", holdArmed: true, waitingAtHold: 0, replies: { write: 0, read: 0, finished: 0 } });
    let answered = false;
    const held = complete(base, { messages: [delegatePrompt, task], tools: lifecycleTools }).then(delta => { answered = true; return delta; });
    for (let i = 0; i < 100 && (await state()).waitingAtHold === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await state()).waitingAtHold, 1);
    assert.equal(answered, false);
    assert.equal((await fetch(`${base}/scenario/release`, { method: "POST" })).status, 204);
    const delta = await held;
    assert.equal(delta.tool_calls[0].function.name, "executeCode");
    assert.deepEqual(await state(), { scenario: "delegate-lifecycle", holdArmed: false, waitingAtHold: 0, replies: { write: 1, read: 0, finished: 0 } });
    // Released for good: a write asked for again (after a restart) isn't held.
    assert.equal((await complete(base, { messages: [delegatePrompt, task], tools: lifecycleTools })).tool_calls[0].function.name, "executeCode");
    const unscripted = await fetch(`${base}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ messages: [task], tools: lifecycleTools }) });
    assert.equal(unscripted.status, 500);
    assert.match(((await unscripted.json()) as { error: { message: string } }).error.message, /unscripted request, the delegate holds no InferOps binding/);
    assert.ok(lines.some(line => line.endsWith(" delegate-lifecycle held before the write")));
    assert.ok(lines.some(line => line.endsWith(" delegate-lifecycle could not answer: unscripted request, the delegate holds no InferOps binding")));
    assert.ok(lines.every(line => !line.includes("INFEROPS_7") && !line.includes("agreed change")));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
