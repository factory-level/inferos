// Canvases a newer InferOS saved, read after a rollback (FAC-9): a widget kind or version this
// InferOS doesn't know reads as an inert placeholder, in a version 1 row, a nested page and a
// published console page; a row that can't be read at all is left out of a listing rather than
// failing it; and every write is refused, so the stored widget is never replaced. Over mock Durable
// Object storage, with the real canvas and console stores.
import { describe, expect, it, vi } from "vitest";
import type { CanvasDefinition } from "@gadgets/workshop-shared/canvas";
import type { CanvasPage } from "@gadgets/workshop-shared/canvas-model";
import type { OperateConsoleContent } from "@gadgets/workshop-shared/operate-console";
import { WorkspaceCanvasStore } from "../src/canvas-store";
import { consoleScreenKey, WorkspaceConsoleStore } from "../src/console-store";
import { makeOverseerStorage } from "../src/overseer";
import { makeMockStorage } from "./mock-storage";

type CanvasEnv = ConstructorParameters<typeof WorkspaceCanvasStore>[2];
type ConsoleEnv = ConstructorParameters<typeof WorkspaceConsoleStore>[2];
const ENV = { COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true", CANVAS_CATALOG: undefined } as unknown as CanvasEnv & ConsoleEnv;
const BOARD = {
  kind: "inferops.project-board", version: 1, targetRef: "inferops://acme.operations/project/board/ENG",
  size: "wide", params: { workflow: "software", showCompleted: false },
};
// What a newer InferOS stores: a kind this one doesn't know, with fields it has never seen.
const NEWER = { id: "rows", kind: "inferos.governed-table", version: 1, targetRef: "tickets://support/queue/billing", size: "full",
  params: {}, dataBinding: { resource: "tickets/queue", ref: "tickets://support/queue/billing", schemaVersion: 1 } };
const PLACEHOLDER = { id: "rows", kind: "inferos.unsupported", version: 1, targetRef: "", size: "full", params: {}, storedKind: "inferos.governed-table" };
const REFUSED = "This canvas holds a widget from a newer InferOS, so it can't be changed here";

function setUp() {
  const durable = makeMockStorage();
  const storage = makeOverseerStorage(durable);
  return { storage, canvases: new WorkspaceCanvasStore(durable, storage, ENV), consoles: new WorkspaceConsoleStore(durable, storage, ENV) };
}

const content = (title: string) =>
  ({ title, sections: [{ id: `${title.toLowerCase()}-work`, title: "Work", columns: 2 as const, widgets: [{ id: `${title.toLowerCase()}-eng`, ...BOARD } as never] }] });

/** Save `row` as a newer InferOS would: its first section also holds the newer widget. */
function saveNewer(storage: ReturnType<typeof setUp>["storage"], row: CanvasDefinition) {
  const [first, ...rest] = row.sections;
  storage.canvases.put({ ...row, sections: [{ ...first!, widgets: [...first!.widgets, NEWER as never] }, ...rest] });
}

const consoleOver = (...screens: string[]): OperateConsoleContent =>
  ({ title: "Floor", fullChat: "off", views: screens.map(screen => ({ id: `v-${screen}`, title: screen, type: "screen" as const, screen })) });

describe("a canvas a newer InferOS saved (FAC-9)", () => {
  it("lists and reads with the newer widget as a placeholder, keeping its place, beside the other canvases", () => {
    const { storage, canvases } = setUp();
    const triage = canvases.create(content("Triage"));
    const other = canvases.create(content("Other"));
    saveNewer(storage, triage);
    expect(canvases.list().map(row => row.id).toSorted()).toEqual([triage.id, other.id].toSorted());
    expect(canvases.get(triage.id)!.sections[0]!.widgets).toEqual([triage.sections[0]!.widgets[0], PLACEHOLDER]);
    const page = canvases.getPage(triage.id)!;
    expect(page.nodes.find(node => node.id === "rows")).toEqual({ ...PLACEHOLDER, nodeType: "widget", attachments: [] });
    expect(page.nodes.find(node => node.id === "triage-work")).toMatchObject({ children: ["triage-eng", "rows"] });
    expect(canvases.listPages().map(item => item.id).toSorted()).toEqual([triage.id, other.id].toSorted());
  });

  it("leaves a row it can't read at all out of a listing, and says so, without failing the rest", () => {
    const { storage, canvases } = setUp();
    const triage = canvases.create(content("Triage"));
    storage.canvases.put({ id: "broken", schemaVersion: 7, revision: "0" } as unknown as CanvasDefinition);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(canvases.list().map(row => row.id)).toEqual([triage.id]);
      expect(canvases.listPages().map(row => row.id)).toEqual([triage.id]);
      expect(warn).toHaveBeenCalledWith("canvas_unreadable", expect.objectContaining({ id: "broken" }));
    } finally {
      warn.mockRestore();
    }
    // One canvas read by ID still says it can't be read.
    expect(() => canvases.get("broken")).toThrow(/./);
  });

  it("refuses every change to it, so the stored widget is never replaced by its placeholder", () => {
    const { storage, canvases } = setUp();
    const triage = canvases.create(content("Triage"));
    saveNewer(storage, triage);
    const stored = storage.canvases.get(triage.id);
    const page = canvases.getPage(triage.id)!;
    expect(() => canvases.edit(triage.id, "0", [{ type: "rename", title: "Renamed" }])).toThrow(REFUSED);
    expect(() => canvases.editPage(triage.id, "0", [{ type: "renamePage", title: "Renamed" }])).toThrow(REFUSED);
    expect(() => canvases.savePage({ ...page, title: "Renamed" }, "0")).toThrow(REFUSED);
    expect(() => canvases.delete(triage.id, "0")).toThrow(REFUSED);
    expect(storage.canvases.get(triage.id)).toEqual(stored);
  });

  it("reads a nested page a newer InferOS saved, dropping an action asked of the placeholder and keeping the rest", () => {
    const { storage, canvases } = setUp();
    const triage = canvases.create(content("Triage"));
    const page = canvases.getPage(triage.id)!;
    const newer = {
      ...page,
      nodes: [
        ...page.nodes.map(node => node.id === "triage-work" && node.nodeType === "object" ? { ...node, children: ["inner"] }
          : node.id === "triage-eng" ? { ...node, attachments: [{ id: "next", version: 1, on: "action-completed", effect: { kind: "navigate", page: triage.id } }] }
          : node),
        { nodeType: "object", id: "inner", title: "Inner", columns: 1, children: ["triage-eng", "rows"], attachments: [] },
        { ...NEWER, nodeType: "widget", attachments: [{ id: "next-rows", version: 1, on: "action-completed", effect: { kind: "navigate", page: triage.id } }] },
      ],
      attachments: [{ id: "ask", version: 1, on: "ping", effect: { kind: "request-action", target: "rows", action: "refresh" } }],
    };
    storage.canvasPages.put({ page: newer as unknown as CanvasPage, basedOnRevision: triage.revision });
    const read = canvases.getPage(triage.id)!;
    expect(read.nodes.find(node => node.id === "rows")).toEqual({ ...PLACEHOLDER, nodeType: "widget", attachments: [] });
    expect(read.nodes.find(node => node.id === "triage-eng")?.attachments.map(item => item.id)).toEqual(["next"]);
    expect(read.attachments).toEqual([]);
    expect(canvases.get(triage.id)!.sections.flatMap(section => section.widgets).map(widget => widget.kind)).toEqual(["inferops.project-board", "inferos.unsupported"]);
    expect(canvases.listPages().map(item => item.id)).toEqual([triage.id]);
    expect(() => canvases.savePage(read, read.revision)).toThrow(REFUSED);
  });

  it("shows a published console page holding a newer widget, and a draft screen, as placeholders", () => {
    const { storage, canvases, consoles } = setUp();
    const triage = canvases.create(content("Triage"));
    const draft = consoles.create(consoleOver(triage.id));
    const published = consoles.publish(draft.id, draft.revision, consoles.capture(draft.id, draft.revision), new Map());
    // A newer InferOS republished it with the newer widget on the page it froze.
    const key = consoleScreenKey(draft.id, triage.id);
    const snapshot = storage.consoleScreens.get(key)!;
    const frozen = canvases.getPage(triage.id)!;
    storage.consoleScreens.put({ ...snapshot,
      screen: { ...snapshot.screen, sections: [{ ...snapshot.screen.sections[0]!, widgets: [...snapshot.screen.sections[0]!.widgets, NEWER as never] }] },
      page: { ...frozen, nodes: [...frozen.nodes.map(node => node.id === "triage-work" && node.nodeType === "object" ? { ...node, children: [...node.children, "rows"] } : node),
        { ...NEWER, nodeType: "widget", attachments: [] } as never] } });
    expect(published).toBeTruthy();
    expect(consoles.page(draft.id, triage.id, "published")!.nodes.find(node => node.id === "rows")).toEqual({ ...PLACEHOLDER, nodeType: "widget", attachments: [] });
    expect(consoles.screen(draft.id, triage.id, "published")!.sections[0]!.widgets.at(-1)).toEqual(PLACEHOLDER);
    saveNewer(storage, storage.canvases.get(triage.id)!);
    expect(consoles.screen(draft.id, triage.id, "draft")!.sections[0]!.widgets.at(-1)).toEqual(PLACEHOLDER);
    expect(consoles.page(draft.id, triage.id, "draft")!.nodes.find(node => node.id === "rows")).toMatchObject({ kind: "inferos.unsupported" });
  });
});
