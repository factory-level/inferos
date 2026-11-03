// Nested pages in the canvas store (FAC-81, ADR 0014): existing rows are read by conversion and
// never rewritten, nested pages sit beside them, and a deploy rolled back to the previous store
// still lists and edits every canvas. Over mock Durable Object storage.
import { describe, expect, it } from "vitest";
import { CanvasConflictError, parseCanvasDefinition } from "@gadgets/workshop-shared/canvas";
import { CanvasModelError, canvasDefinitionFromPage, canvasPageFromDefinition, parseCanvasTarget, resolveCanvasTarget, type CanvasPage } from "@gadgets/workshop-shared/canvas-model";
import rejected from "../../workshop-shared/src/canvas-model-fixtures/rejected.json";
import sectionMapping from "../../workshop-shared/src/canvas-model-fixtures/section-mapping.json";
import { WorkspaceCanvasStore } from "../src/canvas-store";
import { makeOverseerStorage } from "../src/overseer";
import { makeMockStorage } from "./mock-storage";
import { PreviousWorkspaceCanvasStore } from "./previous-canvas-store";

type Env = ConstructorParameters<typeof WorkspaceCanvasStore>[2];
const ENV = { COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true", CANVAS_CATALOG: undefined } as unknown as Env;
const BOARD = {
  kind: "inferops.project-board", version: 1, targetRef: "inferops://acme.operations/project/board/ENG",
  size: "wide", params: { workflow: "software", showCompleted: false },
};

function setUp() {
  const durable = makeMockStorage();
  const storage = makeOverseerStorage(durable);
  return { durable, storage, store: new WorkspaceCanvasStore(durable, storage, ENV), previous: new PreviousWorkspaceCanvasStore(durable, storage, ENV) };
}

const CONTENT = { title: "Operations", sections: [{ id: "work", title: "Work", columns: 2 as const, widgets: [{ id: "eng", ...BOARD } as never] }] };

/** The same page with its widget one object deeper, and an attachment: something version 1 can't hold. */
const nested = (page: CanvasPage): CanvasPage => ({
  ...page,
  nodes: [
    ...page.nodes.map(node => node.id === "work" && node.nodeType === "object" ? { ...node, children: ["inner"] } : node.id === "eng" && node.nodeType === "widget"
      ? { ...node, attachments: [{ id: "next", version: 1 as const, on: "action-completed", effect: { kind: "navigate" as const, page: page.id } }] } : node),
    { nodeType: "object", id: "inner", title: "Inner", columns: 1, children: ["eng"], attachments: [] },
  ],
});

describe("existing canvases", () => {
  it.each(sectionMapping)("$name converts to its documented page", ({ sections, page }) => {
    expect(canvasPageFromDefinition(sections)).toEqual(page);
    expect(canvasDefinitionFromPage(canvasPageFromDefinition(sections))).toEqual(parseCanvasDefinition(sections));
  });

  it("converting twice gives the same page, and reading writes nothing", () => {
    const { store, storage } = setUp();
    const created = store.create(CONTENT);
    const before = structuredClone(storage.canvases.get(created.id));
    const first = store.getPage(created.id);
    expect(store.getPage(created.id)).toEqual(first);
    expect(store.listPages()).toEqual([first]);
    expect(first?.revision).toBe(created.revision);
    expect(storage.canvases.get(created.id)).toEqual(before);
    expect(Array.from(storage.canvasPages.list())).toEqual([]);
  });

  it("a row that can't convert throws and stays as it was", () => {
    const { store, storage } = setUp();
    const created = store.create(CONTENT);
    const broken = { ...created, sections: [{ ...created.sections[0], columns: 9 }] };
    storage.canvases.put(broken as never);
    expect(() => store.getPage(created.id)).toThrow("Invalid canvas");
    expect(storage.canvases.get(created.id)).toEqual(broken);
  });

  it("a page version 1 can hold is saved to its row, at the next revision", () => {
    const { store, storage, previous } = setUp();
    const created = store.create(CONTENT);
    const page = store.getPage(created.id)!;
    const saved = store.savePage({ ...page, title: "Renamed" }, page.revision);
    expect(saved.revision).toBe("1");
    expect(storage.canvases.get(created.id)).toMatchObject({ schemaVersion: 1, title: "Renamed", revision: "1" });
    expect(Array.from(storage.canvasPages.list())).toEqual([]);
    expect(previous.get(created.id)?.title).toBe("Renamed");
  });
});

describe("nested pages", () => {
  it("keep their stable IDs across save and reload, and targets resolve", () => {
    const { store, durable, storage } = setUp();
    const created = store.create(CONTENT);
    const page = store.getPage(created.id)!;
    store.savePage(nested(page), page.revision);

    const reloaded = new WorkspaceCanvasStore(durable, makeOverseerStorage(durable), ENV).getPage(created.id)!;
    expect(reloaded.revision).toBe("1");
    expect(reloaded.nodes.map(node => node.id).toSorted()).toEqual(["eng", "inner", "work"]);
    expect(resolveCanvasTarget(reloaded, parseCanvasTarget(`page:${created.id}/node:inner`)!)?.kind).toBe("object");
    expect(resolveCanvasTarget(reloaded, parseCanvasTarget(`page:${created.id}/attachment:next`)!)).toMatchObject({ kind: "attachment", ownerId: "eng" });
    expect(storage.canvases.get(created.id)).toEqual(created);
  });

  it("two saves at one revision: one wins, and the other conflicts", () => {
    const { store } = setUp();
    const created = store.create(CONTENT);
    const page = store.getPage(created.id)!;
    store.savePage(nested(page), page.revision);
    expect(() => store.savePage(nested(page), page.revision)).toThrow(CanvasConflictError);
    expect(store.getPage(created.id)?.revision).toBe("1");
  });

  it("flattening back to what version 1 can hold returns to the row", () => {
    const { store, storage } = setUp();
    const created = store.create(CONTENT);
    const page = store.getPage(created.id)!;
    const deep = store.savePage(nested(page), page.revision);
    const flat = store.savePage({ ...page, revision: deep.revision }, deep.revision);
    expect(flat.revision).toBe("2");
    expect(storage.canvases.get(created.id)?.revision).toBe("2");
    expect(Array.from(storage.canvasPages.list())).toEqual([]);
  });

  it("the version 1 editor refuses one, and delete removes both records", () => {
    const { store, storage } = setUp();
    const created = store.create(CONTENT);
    const page = store.getPage(created.id)!;
    const deep = store.savePage(nested(page), page.revision);
    expect(() => store.edit(created.id, created.revision, [{ type: "rename", title: "X" }])).toThrow("nested objects");
    expect(() => store.delete(created.id, created.revision)).toThrow(CanvasConflictError);
    store.delete(created.id, deep.revision);
    expect(storage.canvases.get(created.id)).toBeUndefined();
    expect(Array.from(storage.canvasPages.list())).toEqual([]);
  });

  it("a page that doesn't exist, or navigation to one, is refused", () => {
    const { store } = setUp();
    const created = store.create(CONTENT);
    const page = store.getPage(created.id)!;
    expect(() => store.savePage({ ...page, id: "ghost" }, "0")).toThrow("Canvas not found");
    const away = nested(page);
    const widget = away.nodes.find(node => node.id === "eng")!;
    widget.attachments[0].effect = { kind: "navigate", page: "ghost" };
    expect(() => store.savePage(away, page.revision)).toThrow(CanvasModelError);
    expect(store.getPage(created.id)?.revision).toBe("0");
  });

  it("a newly added widget of a disabled kind is refused", () => {
    const durable = makeMockStorage();
    const storage = makeOverseerStorage(durable);
    const open = new WorkspaceCanvasStore(durable, storage, ENV);
    const created = open.create(CONTENT);
    const narrow = new WorkspaceCanvasStore(durable, storage, { ...ENV, CANVAS_CATALOG: JSON.stringify({ widgetKinds: ["inferops.project-board"], blueprints: [], screens: [] }) });
    const page = narrow.getPage(created.id)!;
    expect(narrow.savePage(nested(page), page.revision).revision).toBe("1");
    const current = narrow.getPage(created.id)!;
    const added = { ...current, children: [...current.children, "tool"], nodes: [...current.nodes,
      { nodeType: "widget", id: "tool", kind: "inferos.gadget", version: 1, targetRef: "gadget:1", size: "normal", params: {}, attachments: [] }] };
    expect(() => narrow.savePage(added, current.revision)).toThrow("not enabled");
  });

  it.each(rejected)("refuses $group: $name, with its code and location, and writes nothing", ({ page, expected }) => {
    const { store, storage } = setUp();
    store.create(CONTENT);
    let caught: unknown;
    try { store.savePage(page, "0"); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(CanvasModelError);
    expect(caught).toMatchObject(expected);
    expect(Array.from(storage.canvasPages.list())).toEqual([]);
  });
});

describe("rolled back to the previous store", () => {
  it("every canvas still lists, reads and edits, including one with a nested page", () => {
    const { store, previous, storage } = setUp();
    const plain = store.create(CONTENT);
    const other = store.create({ ...CONTENT, title: "Other" });
    const page = store.getPage(other.id)!;
    store.savePage(nested(page), page.revision);

    expect(previous.list().map(canvas => canvas.id).toSorted()).toEqual([plain.id, other.id].toSorted());
    expect(previous.get(other.id)).toEqual(other);
    expect(storage.canvases.get(other.id)?.schemaVersion).toBe(1);
    expect(previous.edit(plain.id, "0", [{ type: "rename", title: "Edited back" }]).revision).toBe("1");
  });

  it("rolling forward after an edit there keeps that edit, and the nested copy, until someone chooses", () => {
    const { store, previous, storage } = setUp();
    const created = store.create(CONTENT);
    const page = store.getPage(created.id)!;
    const deep = store.savePage(nested(page), page.revision);
    previous.edit(created.id, created.revision, [{ type: "rename", title: "Edited while rolled back" }]);

    const shown = store.getPage(created.id)!;
    expect(shown.title).toBe("Edited while rolled back");
    expect(shown.nodes.some(node => node.id === "inner")).toBe(false);
    expect(storage.canvasPages.get(created.id)?.page).toEqual(deep);
    expect(() => store.savePage(shown, shown.revision)).toThrow("nested copy is kept");
    expect(storage.canvasPages.get(created.id)?.page).toEqual(deep);
  });

  it("a page deleted there stays gone", () => {
    const { store, previous } = setUp();
    const created = store.create(CONTENT);
    const page = store.getPage(created.id)!;
    store.savePage(nested(page), page.revision);
    previous.delete(created.id, created.revision);
    expect(store.getPage(created.id)).toBeNull();
    expect(store.listPages()).toEqual([]);
  });
});
