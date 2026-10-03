import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCanvasOperations, CanvasConflictError, parseCanvasDefinition, type CanvasDefinition, type CanvasProjectBoardWidget, type CanvasWidget } from "../packages/workshop-shared/src/canvas.ts";

const board = (id = "board-a"): CanvasWidget => ({ id, kind: "inferops.project-board", version: 1,
  targetRef: "inferops://demo.local/project/board/DEMO", size: "full", params: { workflow: "software", showCompleted: false } });
const wiki = (page: string | null = null): CanvasWidget => ({ id: "wiki-a", kind: "inferops.wiki", version: 1,
  targetRef: "inferops://demo.local/knowledge/wiki", size: "full", params: { page } });
const gadget = (id = "gadget-a", targetRef = "gadget:7"): CanvasWidget => ({ id, kind: "inferos.gadget", version: 1,
  targetRef, size: "normal", params: {} });
const initial = (): CanvasDefinition => ({ schemaVersion: 1, id: "operations", revision: "0", title: "Operations",
  sections: [{ id: "work", title: "Work", columns: 2, widgets: [board(), board("board-b")] },
    { id: "other", title: "Other", columns: 1, widgets: [] }] });

test("snapshots are detached and accept only registered content, never authority or executable styling", () => {
  const input = initial();
  const parsed = parseCanvasDefinition(input);
  (parsed.sections[0].widgets[0] as CanvasProjectBoardWidget).params.showCompleted = true;
  assert.equal((input.sections[0].widgets[0] as CanvasProjectBoardWidget).params.showCompleted, false);
  for (const change of [
    { owner: "someone-else" }, { sharing: "public" }, { schemaVersion: 2 }, { revision: "01" }, { revision: 1 },
    { revision: "-1" }, { revision: "9".repeat(65) }, { title: " " }, { title: "x".repeat(121) },
  ]) assert.throws(() => parseCanvasDefinition({ ...input, ...change }), /Invalid canvas/);
  for (const change of [{ kind: "custom.script" }, { version: 2 }, { css: "display:none" }, { size: "1000px" },
    { targetRef: "https://example.com/private" }, { targetRef: "inferops://demo.local/project/board/DEMO?token=secret" },
    { params: { workflow: "software", showCompleted: false, script: "run()" } }]) {
    const invalid = initial(); Object.assign(invalid.sections[0].widgets[0], change);
    assert.throws(() => parseCanvasDefinition(invalid), /Invalid canvas/);
  }
});

test("ordered moves use post-removal indices and preserve stable instance identity", () => {
  const input = initial();
  const result = applyCanvasOperations(input, "0", [
    { type: "moveWidget", widgetId: "board-a", sectionId: "work", index: 1 },
    { type: "moveWidget", widgetId: "board-b", sectionId: "other", index: 0 },
    { type: "moveSection", sectionId: "other", index: 0 },
    { type: "configureWidget", widget: { ...board("board-a"), size: "wide", params: { workflow: "content", showCompleted: true } } },
    { type: "configureSection", sectionId: "work", title: "Queue", columns: 3 },
    { type: "rename", title: "New title" },
  ]);
  assert.equal(result.id, input.id);
  assert.equal(result.revision, "1");
  assert.equal(result.title, "New title");
  assert.deepEqual(result.sections.map(s => [s.id, s.widgets.map(w => w.id)]), [["other", ["board-b"]], ["work", ["board-a"]]]);
  assert.deepEqual(result.sections[1].widgets[0].params, { workflow: "content", showCompleted: true });
  assert.equal(result.sections[1].columns, 3);
  assert.deepEqual(input, initial());
});

test("failed batches are atomic and stale edits conflict without precision loss", () => {
  const input = initial(); input.revision = "9007199254740993";
  const result = applyCanvasOperations(input, input.revision, [{ type: "rename", title: "First editor" }]);
  assert.equal(result.revision, "9007199254740994");
  assert.throws(() => applyCanvasOperations(result, input.revision, [{ type: "rename", title: "Stale editor" }]),
    (error: unknown) => error instanceof CanvasConflictError && error.currentRevision === result.revision);
  assert.throws(() => applyCanvasOperations(input, input.revision, [
    { type: "rename", title: "Must not leak" }, { type: "moveWidget", widgetId: "board-a", sectionId: "missing", index: 0 },
  ]), /missing section/);
  assert.equal(input.title, "Operations");
  assert.equal(input.sections[0].widgets.length, 2);
  assert.throws(() => applyCanvasOperations({ ...input, revision: "9".repeat(64) }, "9".repeat(64), [{ type: "rename", title: "Overflow" }]), /revision/);
});

test("add/remove and restore affect composition only and never rewind revision or identity", () => {
  const input = initial();
  const edited = applyCanvasOperations(input, "0", [
    { type: "removeWidget", widgetId: "board-b" },
    { type: "addSection", index: 1, section: { id: "new-section", title: "New", columns: 1, widgets: [] } },
    { type: "addWidget", sectionId: "new-section", index: 0, widget: board("new-board") },
    { type: "removeSection", sectionId: "work" },
  ]);
  assert.deepEqual(edited.sections.map(s => s.id), ["new-section", "other"]);
  const restored = applyCanvasOperations(edited, "1", [{ type: "restore", content: { title: input.title, sections: input.sections } }]);
  assert.deepEqual(restored, { ...input, revision: "2" });
  assert.throws(() => applyCanvasOperations(edited, "1", [{ type: "restore", content: { ...input } }]), /content/);
});

test("bounded layout and exact operation schemas reject ambiguous edits", () => {
  const input = initial();
  for (const operations of [[], Array.from({ length: 33 }, () => ({ type: "rename", title: "Too many" })),
    [{ type: "rename", title: "Allowed", grant: true }], [{ type: "setOwner", owner: "other" }],
    [{ type: "moveSection", sectionId: "work", index: 2 }], [{ type: "moveSection", sectionId: "work", index: 0.5 }],
    [{ type: "configureSection", sectionId: "work", title: "Work", columns: 4 }],
    [{ type: "addWidget", sectionId: "other", index: 0, widget: board() }],
    [{ type: "addWidget", sectionId: "other", index: 0, widget: board("operations") }],
    [{ type: "configureWidget", widget: board("not-present") }],
  ]) assert.throws(() => applyCanvasOperations(input, "0", operations), /Invalid canvas/);
  assert.throws(() => parseCanvasDefinition({ ...input, sections: Array.from({ length: 13 }, (_, i) => ({ id: `s-${i}`, title: "Section", columns: 1, widgets: [] })) }), /sections/);
  assert.throws(() => parseCanvasDefinition({ ...input, sections: [{ ...input.sections[0], widgets: Array.from({ length: 49 }, (_, i) => board(`board-${i}`)) }] }), /widgets/);
  assert.throws(() => parseCanvasDefinition({ ...input, sections: input.sections.map((s, i) => ({ ...s, widgets: Array.from({ length: 25 }, (_, j) => board(`board-${i}-${j}`)) })) }), /widget count/);
});

test("gadget widgets carry only a workspace-local reference and no parameters", () => {
  const input = initial();
  const added = applyCanvasOperations(input, "0", [{ type: "addWidget", sectionId: "other", index: 0, widget: gadget() }]);
  assert.deepEqual(added.sections[1].widgets, [gadget()]);
  for (const change of [{ targetRef: "gadget:" }, { targetRef: "gadget:07" }, { targetRef: "gadget:-1" }, { targetRef: "gadget:1.5" },
    { targetRef: "inferops://demo.local/project/board/DEMO" }, { params: { title: "x" } }, { params: null }, { version: 2 }]) {
    assert.throws(() => applyCanvasOperations(input, "0", [{ type: "addWidget", sectionId: "other", index: 0, widget: { ...gadget(), ...change } }]), /Invalid canvas/);
  }
  assert.throws(() => applyCanvasOperations(added, "1", [{ type: "configureWidget", widget: { ...board("gadget-a"), targetRef: "gadget:7" } }]), /target reference/);
});

test("wiki widgets name one workspace's Wiki and, optionally, the page opened first", () => {
  const input = initial();
  const added = applyCanvasOperations(input, "0", [{ type: "addWidget", sectionId: "other", index: 0, widget: wiki("release-process") }]);
  assert.deepEqual(added.sections[1].widgets, [wiki("release-process")]);
  assert.deepEqual(applyCanvasOperations(added, "1", [{ type: "configureWidget", widget: wiki() }]).sections[1].widgets, [wiki()]);
  for (const change of [{ targetRef: "inferops://demo.local/knowledge/document/handbook" }, { targetRef: "inferops://demo.local/knowledge/wiki?token=x" },
    { targetRef: "inferops://demo/knowledge/wiki" }, { targetRef: "inferops://demo.local/project/board/DEMO" },
    { params: {} }, { params: { page: "" } }, { params: { page: "../secret" } }, { params: { page: "a/b" } }, { params: { page: 1 } },
    { params: { page: null, extra: true } }, { version: 2 }]) {
    assert.throws(() => applyCanvasOperations(input, "0", [{ type: "addWidget", sectionId: "other", index: 0, widget: { ...wiki(), ...change } }]), /Invalid canvas/);
  }
  assert.throws(() => applyCanvasOperations(input, "0", [{ type: "addWidget", sectionId: "other", index: 0, widget: wiki() }], ["inferops.project-board"]),
    /inferops.wiki is not enabled/);
});
