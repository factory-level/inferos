// Typed edits to nested pages (FAC-83, ADR 0014): create, move, reorder and configure nested parts
// keep their stable IDs across a reload; a stale revision is reported and writes nothing; removing a
// part removes only its reference; and version 1 readers are shown the current layout. Over mock
// Durable Object storage.
import { describe, expect, it } from "vitest";
import { CanvasConflictError } from "@gadgets/workshop-shared/canvas";
import { CanvasModelError, type CanvasPage, type CanvasPageOperation } from "@gadgets/workshop-shared/canvas-model";
import { WorkspaceCanvasStore } from "../src/canvas-store";
import { makeOverseerStorage } from "../src/overseer";
import { makeMockStorage } from "./mock-storage";
import { PreviousWorkspaceCanvasStore } from "./previous-canvas-store";

type Env = ConstructorParameters<typeof WorkspaceCanvasStore>[2];
const ENV = { COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true", CANVAS_CATALOG: undefined } as unknown as Env;
const BOARD = {
  kind: "inferops.project-board", version: 1, targetRef: "inferops://acme.operations/project/board/ENG",
  size: "wide", params: { workflow: "software", showCompleted: false },
} as const;

function setUp() {
  const durable = makeMockStorage();
  const storage = makeOverseerStorage(durable);
  const store = new WorkspaceCanvasStore(durable, storage, ENV);
  const created = store.create({ title: "Operations", sections: [{ id: "work", title: "Work", columns: 2, widgets: [{ id: "eng", ...BOARD } as never] }] });
  // A fresh store over the same storage is what a reload, or another session, reads.
  const reload = () => new WorkspaceCanvasStore(durable, storage, ENV);
  return { durable, storage, store, created, reload, previous: new PreviousWorkspaceCanvasStore(durable, storage, ENV) };
}

const NESTING: CanvasPageOperation[] = [
  { type: "addObject", parent: "work", index: 0, object: { id: "inner", title: "Inner", columns: 1 } },
  { type: "moveNode", nodeId: "eng", parent: "inner", index: 0 },
  { type: "addObject", parent: "PAGE", index: 1, object: { id: "later", title: "Later", columns: 3 } },
];
const nesting = (pageId: string): CanvasPageOperation[] =>
  NESTING.map(op => op.type === "addObject" && op.parent === "PAGE" ? { ...op, parent: pageId } : op);

const shape = (page: CanvasPage) => ({
  children: page.children,
  nodes: Object.fromEntries(page.nodes.map(node => [node.id, node.nodeType === "object"
    ? { title: node.title, columns: node.columns, children: node.children, attachments: node.attachments.map(a => a.id) }
    : { kind: node.kind, targetRef: node.targetRef, attachments: node.attachments.map(a => a.id) }])),
});

describe("editing a nested page", () => {
  it("creates, moves, reorders and configures nested parts, and all of it survives a reload with the same IDs", () => {
    const { store, created, reload } = setUp();
    const nested = store.editPage(created.id, created.revision, nesting(created.id));
    expect(nested.revision).toBe("1");
    const reordered = store.editPage(created.id, nested.revision, [
      { type: "moveNode", nodeId: "later", parent: created.id, index: 0 },
      { type: "configureObject", nodeId: "inner", title: "Inner board", columns: 3 },
      { type: "setAttachments", target: "eng", attachments: [{ id: "go", version: 1, on: "action-completed", effect: { kind: "navigate", page: created.id } }] },
    ]);
    expect(reordered.revision).toBe("2");

    const read = reload().getPage(created.id)!;
    expect(read).toEqual(reordered);
    expect(shape(read)).toEqual({
      children: ["later", "work"],
      nodes: {
        work: { title: "Work", columns: 2, children: ["inner"], attachments: [] },
        inner: { title: "Inner board", columns: 3, children: ["eng"], attachments: [] },
        later: { title: "Later", columns: 3, children: [], attachments: [] },
        eng: { kind: BOARD.kind, targetRef: BOARD.targetRef, attachments: ["go"] },
      },
    });
  });

  it("reports a stale revision with the current one, and the newer work stays", () => {
    const { store, created, reload } = setUp();
    const first = store.editPage(created.id, created.revision, nesting(created.id));
    let conflict: unknown;
    try {
      store.editPage(created.id, created.revision, [{ type: "configureObject", nodeId: "work", title: "Older edit", columns: 1 }]);
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(CanvasConflictError);
    expect((conflict as CanvasConflictError).currentRevision).toBe(first.revision);
    expect(reload().getPage(created.id)).toEqual(first);
  });

  it("applies a batch all or nothing", () => {
    const { store, created, reload } = setUp();
    const before = store.getPage(created.id);
    expect(() => store.editPage(created.id, created.revision, [
      { type: "configureObject", nodeId: "work", title: "Changed", columns: 1 },
      { type: "moveNode", nodeId: "work", parent: "work", index: 0 },
    ])).toThrow(CanvasModelError);
    expect(reload().getPage(created.id)).toEqual(before);
  });

  it("removing a part removes only its reference on the page, and touches nothing else stored", () => {
    const { store, created, durable, reload } = setUp();
    const page = store.editPage(created.id, created.revision, nesting(created.id));
    const others = () => new Map([...durable.kv.list<unknown>()].filter(([key]) => !/canvas/i.test(key)));
    const before = others();
    const removed = store.editPage(created.id, page.revision, [{ type: "removeNode", nodeId: "inner" }]);
    expect(shape(removed).children).toEqual(["work", "later"]);
    expect(removed.nodes.map(node => node.id).toSorted()).toEqual(["later", "work"]);
    expect(others()).toEqual(before);
    expect(reload().getPage(created.id)).toEqual(removed);
  });

  it("refuses a widget directly under the page, a 13th top-level object, and an unknown target", () => {
    const { store, created } = setUp();
    const code = (operations: CanvasPageOperation[]) => {
      try {
        store.editPage(created.id, created.revision, operations);
      } catch (error) {
        return error instanceof CanvasModelError ? error.code : String(error);
      }
      return "applied";
    };
    expect(code([{ type: "addWidget", parent: created.id, index: 0, widget: { id: "loose", ...BOARD } as never }])).toBe("invalid-nesting");
    expect(code([{ type: "moveNode", nodeId: "eng", parent: created.id, index: 0 }])).toBe("invalid-nesting");
    expect(code(Array.from({ length: 12 }, (_, i) => ({ type: "addObject" as const, parent: created.id, index: 0, object: { id: `o${i}`, title: `O${i}`, columns: 1 as const } })))).toBe("limit-exceeded");
    expect(code([{ type: "configureObject", nodeId: "nope", title: "X", columns: 1 }])).toBe("invalid-target");
    expect(code([{ type: "addObject", parent: created.id, index: 0, object: { id: "eng", title: "Clash", columns: 1 } }])).toBe("duplicate-id");
  });
});

describe("version 1 readers of a nested page", () => {
  it("are shown its current layout, flattened, with the widget IDs kept", () => {
    const { store, created } = setUp();
    const page = store.editPage(created.id, created.revision, nesting(created.id));
    const shown = store.get(created.id)!;
    expect(shown.revision).toBe(page.revision);
    expect(shown.sections.map(s => ({ id: s.id, widgets: s.widgets.map(w => w.id) }))).toEqual([
      { id: "work", widgets: ["eng"] },
      { id: "later", widgets: [] },
    ]);
    expect(store.list()).toEqual([shown]);
  });

  it("the version 1 editor still refuses it, and the previous release keeps its own row", () => {
    const { store, created, previous } = setUp();
    store.editPage(created.id, created.revision, nesting(created.id));
    expect(() => store.edit(created.id, "1", [{ type: "rename", title: "X" }])).toThrow("nested objects");
    expect(previous.list().map(c => c.id)).toEqual([created.id]);
  });
});
