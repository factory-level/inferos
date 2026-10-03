import { describe, expect, it } from "vitest";
import {
  applyCanvasOperations,
  DEFAULT_CANVAS_CATALOG,
  parseCanvasCatalog,
  type CanvasDefinition,
  type CanvasWidget,
} from "@gadgets/workshop-shared/canvas";
import { readCanvasCatalog } from "../src/canvas-catalog.js";

const board: CanvasWidget = {
  id: "eng", kind: "inferops.project-board", version: 1, targetRef: "inferops://demo.local/project/board/ENG",
  size: "wide", params: { workflow: "software", showCompleted: false },
};
const gadget: CanvasWidget = { id: "kanban", kind: "inferos.gadget", version: 1, targetRef: "gadget:7", size: "normal", params: {} };
const canvas = (widgets: CanvasWidget[] = []): CanvasDefinition => ({
  schemaVersion: 1, id: "ops", revision: "3", title: "Operations",
  sections: [{ id: "main", title: "Main", columns: 2, widgets }],
});

const catalog = {
  widgetKinds: ["inferos.gadget"],
  blueprints: [{ blueprintId: "inferops.kanban", label: "InferOps Kanban", description: "A project board." }],
  screens: [{ id: "operations", content: { title: "Operations", sections: [{ id: "boards", title: "Boards", columns: 1, widgets: [board] }] } }],
};

describe("parseCanvasCatalog", () => {
  it("accepts a catalog of registered kinds, blueprints and board-only templates", () => {
    expect(parseCanvasCatalog(catalog)).toEqual(catalog);
  });

  it("rejects unknown widget kinds instead of ignoring them", () => {
    expect(() => parseCanvasCatalog({ ...catalog, widgetKinds: ["inferos.gadget", "custom.chart"] })).toThrow("widget kind");
  });

  it("rejects templates that name a workspace-local gadget", () => {
    const screens = [{ id: "bad", content: { title: "Bad", sections: [{ id: "s", title: "S", columns: 1, widgets: [gadget] }] } }];
    expect(() => parseCanvasCatalog({ ...catalog, screens })).toThrow("screen template widget");
  });

  it("accepts a template with a Wiki, which, like a board, is a reference rather than a workspace-local ID", () => {
    const wiki: CanvasWidget = { id: "sops", kind: "inferops.wiki", version: 1, targetRef: "inferops://demo.local/knowledge/wiki", size: "full", params: { page: "handbook" } };
    const screens = [{ id: "knowledge", content: { title: "Knowledge", sections: [{ id: "s", title: "S", columns: 1, widgets: [board, wiki] }] } }];
    expect(parseCanvasCatalog({ ...catalog, screens }).screens[0].content.sections[0].widgets).toEqual([board, wiki]);
  });

  it("rejects duplicate blueprint and template IDs", () => {
    expect(() => parseCanvasCatalog({ ...catalog, blueprints: [catalog.blueprints[0], catalog.blueprints[0]] })).toThrow("duplicate blueprint");
    expect(() => parseCanvasCatalog({ ...catalog, screens: [catalog.screens[0], catalog.screens[0]] })).toThrow("duplicate screen template");
  });
});

describe("readCanvasCatalog", () => {
  it("offers every kind when the deployment configures no catalog", () => {
    expect(readCanvasCatalog({})).toEqual(DEFAULT_CANVAS_CATALOG);
  });

  it("fails closed on a malformed catalog", () => {
    expect(readCanvasCatalog({ CANVAS_CATALOG: "{not json" })).toEqual({ widgetKinds: [], blueprints: [], screens: [] });
  });
});

describe("applyCanvasOperations with a catalog", () => {
  const onlyGadgets = ["inferos.gadget"] as const;

  it("refuses to add a widget kind the catalog does not enable", () => {
    expect(() => applyCanvasOperations(canvas(), "3", [{ type: "addWidget", sectionId: "main", index: 0, widget: board }], onlyGadgets))
      .toThrow("not enabled");
  });

  it("refuses a section or restore that brings in a disabled kind", () => {
    const section = { id: "more", title: "More", columns: 1, widgets: [board] };
    expect(() => applyCanvasOperations(canvas(), "3", [{ type: "addSection", index: 1, section }], onlyGadgets)).toThrow("not enabled");
    expect(() => applyCanvasOperations(canvas(), "3", [{ type: "restore", content: { title: "X", sections: [section] } }], onlyGadgets))
      .toThrow("not enabled");
  });

  it("adds enabled kinds and leaves widgets already on the canvas alone", () => {
    const updated = applyCanvasOperations(canvas([board]), "3", [
      { type: "addWidget", sectionId: "main", index: 1, widget: gadget },
      { type: "moveWidget", widgetId: "eng", sectionId: "main", index: 1 },
    ], onlyGadgets);
    expect(updated.revision).toBe("4");
    expect(updated.sections[0].widgets.map(widget => widget.id)).toEqual(["kanban", "eng"]);
  });
});
