// A page's configuration, traced (FAC-95): each setting, page hook and workspace hook with its owner
// and its permitted effect, none of which grants anything.
import { describe, expect, test } from "vitest";
import { parseCanvasPage } from "./canvas-model";
import { traceConfiguration } from "./configuration-trace";

const page = parseCanvasPage({
  schemaVersion: 2, id: "p", revision: "3", title: "P", children: ["a"], settings: { "baseUi.alerts": false },
  attachments: [{ id: "go", version: 1, on: "all-done", effect: { kind: "navigate", page: "q" } }],
  nodes: [
    { nodeType: "object", id: "a", title: "A", columns: 1, children: ["g"],
      attachments: [{ id: "up", version: 1, on: "section-done", effect: { kind: "raise-event", target: "p", event: "all-done" } }] },
    { nodeType: "widget", id: "g", kind: "inferos.gadget", version: 1, targetRef: "gadget:7", size: "normal", params: {},
      attachments: [{ id: "done", version: 1, on: "finish", effect: { kind: "raise-event", target: "a", event: "section-done" } }] },
  ],
});

describe("a configuration trace", () => {
  test("names each setting's owner: the page's override, the workspace's value, or the default", () => {
    const settings = traceConfiguration({ "baseUi.alerts": true, "chatPane.widgets": "none" }, page)
      .filter(entry => entry.kind === "setting");
    expect(settings.map(entry => [entry.key, entry.value, entry.owner])).toEqual([
      ["baseUi.alerts", false, "page"],
      ["baseUi.notifications", false, "default"],
      ["chatPane.widgets", "none", "workspace"],
    ]);
  });

  test("traces each page hook to the page or node that holds it, with its permitted effect", () => {
    const hooks = traceConfiguration({}, page).filter(entry => entry.kind === "page-hook");
    expect(hooks).toEqual([
      { kind: "page-hook", owner: "page:p", target: "page:p/attachment:go", on: "all-done", effect: "navigate",
        permits: "Moves the person's own page to q. It grants nothing." },
      { kind: "page-hook", owner: "page:p/node:a", target: "page:p/attachment:up", on: "section-done", effect: "raise-event",
        permits: 'Raises "all-done" on p, within this page. It grants nothing.' },
      { kind: "page-hook", owner: "page:p/node:g", target: "page:p/attachment:done", on: "finish", effect: "raise-event",
        permits: 'Raises "section-done" on a, within this page. It grants nothing.' },
    ]);
  });

  test("lists the workspace's hooks read-only, owned by their gatekeeper and gadget, with what they start", () => {
    const hooks = traceConfiguration({}, null, [
      { hookId: 3, title: "Issue moved", enabled: true, gatekeeperId: 7, gadgetId: 1, pinned: { definitionId: "wf", revision: 2 } },
      { hookId: 4, title: "Comment", enabled: false, gatekeeperId: 7, gadgetId: 1, pinned: null },
    ]).filter(entry => entry.kind === "workspace-hook");
    expect(hooks.map(hook => [hook.hookId, hook.owner, hook.pinned])).toEqual([
      [3, { gatekeeperId: 7, gadgetId: 1 }, { definitionId: "wf", revision: 2 }],
      [4, { gatekeeperId: 7, gadgetId: 1 }, null],
    ]);
    for (const hook of hooks) expect(hook.permits).toContain("Read-only here.");
  });

  test("says a prompt goes only to the person's own chat, as a draft (FAC-98)", () => {
    const prompted = parseCanvasPage({
      schemaVersion: 2, id: "p", revision: "0", title: "P", children: ["a"], attachments: [], nodes: [
        { nodeType: "object", id: "a", title: "A", columns: 1, children: ["g"], attachments: [] },
        { nodeType: "widget", id: "g", kind: "inferos.gadget", version: 1, targetRef: "gadget:7", size: "normal", params: {}, attachments: [
          { id: "ask", version: 1, on: "finish", effect: { kind: "insert-prompt", text: "Summarise" } }] },
      ],
    });
    const hooks = traceConfiguration({}, prompted).filter(entry => entry.kind === "page-hook");
    expect(hooks.map(hook => [hook.target, hook.effect, hook.permits])).toEqual([
      ["page:p/attachment:ask", "insert-prompt", "Puts a prompt in the person's own chat as a draft; nothing is sent until they send it. It grants nothing."],
    ]);
  });

  test("traces only the workspace's settings with no page", () => {
    expect(traceConfiguration({ "baseUi.alerts": true }, null).map(entry => entry.kind)).toEqual(["setting", "setting", "setting"]);
  });
});
