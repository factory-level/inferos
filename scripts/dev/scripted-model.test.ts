import { test } from "node:test";
import assert from "node:assert/strict";
import { nextReply, streamReply, SCRIPTED_BOARD_URL } from "./scripted-model.ts";

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
