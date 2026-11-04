// One published console snapshot over nested pages (FAC-89): publishing copies each screen's page as
// the store reads it (a nested page whole, or its version 1 row by conversion), lists the page
// revisions it froze, refuses a page saved while it was being published, and refuses behavior that
// would send an operator to a page the console doesn't show. Later saves stay draft. Over mock
// Durable Object storage, with the real console and canvas stores.
import { describe, expect, it } from "vitest";
import { canvasPageFromDefinition, type CanvasPage } from "@gadgets/workshop-shared/canvas-model";
import type { OperateConsoleContent } from "@gadgets/workshop-shared/operate-console";
import { WorkspaceCanvasStore } from "../src/canvas-store";
import { CONSOLE_CHANGED, WorkspaceConsoleStore } from "../src/console-store";
import { makeOverseerStorage } from "../src/overseer";
import { makeMockStorage } from "./mock-storage";

type CanvasEnv = ConstructorParameters<typeof WorkspaceCanvasStore>[2];
type ConsoleEnv = ConstructorParameters<typeof WorkspaceConsoleStore>[2];
const ENV = { COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true", CANVAS_CATALOG: undefined } as unknown as CanvasEnv & ConsoleEnv;
const BOARD = {
  kind: "inferops.project-board", version: 1, targetRef: "inferops://acme.operations/project/board/ENG",
  size: "wide", params: { workflow: "software", showCompleted: false },
};

function setUp() {
  const durable = makeMockStorage();
  const storage = makeOverseerStorage(durable);
  return { storage, canvases: new WorkspaceCanvasStore(durable, storage, ENV), consoles: new WorkspaceConsoleStore(durable, storage, ENV) };
}

const screenContent = (title: string) =>
  ({ title, sections: [{ id: `${title.toLowerCase()}-work`, title: "Work", columns: 2 as const, widgets: [{ id: `${title.toLowerCase()}-eng`, ...BOARD } as never] }] });

/** `page` with its widget one object deeper and an attachment on it navigating to `to`: something version 1 can't hold. */
const nested = (page: CanvasPage, to: string): CanvasPage => {
  const [work] = page.children;
  const widget = page.nodes.find(node => node.nodeType === "widget")!;
  return {
    ...page,
    nodes: [
      ...page.nodes.map(node => node.id === work && node.nodeType === "object" ? { ...node, children: [`${work}-inner`] }
        : node.id === widget.id ? { ...node, attachments: [{ id: `${widget.id}-next`, version: 1 as const, on: "action-completed", effect: { kind: "navigate" as const, page: to } }] }
        : node),
      { nodeType: "object", id: `${work}-inner`, title: "Inner", columns: 1, children: [widget.id], attachments: [] },
    ],
  };
};

const consoleOver = (...screens: string[]): OperateConsoleContent =>
  ({ title: "Floor", fullChat: "off", views: screens.map(screen => ({ id: `v-${screen}`, title: screen, type: "screen" as const, screen })) });

function publish(consoles: WorkspaceConsoleStore, id: string, revision: string) {
  const capture = consoles.capture(id, revision);
  return consoles.publish(id, revision, capture, new Map());
}

describe("a published console's pages", () => {
  it("publishes a screen's nested page whole, and lists the page revisions it froze", async () => {
    const { canvases, consoles } = setUp();
    const triage = canvases.create(screenContent("Triage"));
    const page = nested(canvases.getPage(triage.id)!, triage.id);
    const saved = canvases.savePage(page, page.revision);
    const draft = consoles.create(consoleOver(triage.id));

    const published = publish(consoles, draft.id, draft.revision);

    expect(consoles.page(draft.id, triage.id, "published")).toEqual(saved);
    expect(published.published?.screens).toEqual([{ id: triage.id, revision: saved.revision }]);
  });

  it("publishes a version 1 screen as its page by conversion, and keeps its version 1 copy", async () => {
    const { canvases, consoles } = setUp();
    const plain = canvases.create(screenContent("Plain"));
    const draft = consoles.create(consoleOver(plain.id));

    publish(consoles, draft.id, draft.revision);

    expect(consoles.page(draft.id, plain.id, "published")).toEqual(canvasPageFromDefinition(plain));
    expect(consoles.screen(draft.id, plain.id, "published")).toEqual(plain);
  });

  it("keeps a nested save made after publishing out of the published console", async () => {
    const { canvases, consoles } = setUp();
    const triage = canvases.create(screenContent("Triage"));
    const first = canvases.savePage(nested(canvases.getPage(triage.id)!, triage.id), triage.revision);
    const draft = consoles.create(consoleOver(triage.id));
    publish(consoles, draft.id, draft.revision);

    const later = canvases.savePage({ ...first, title: "Triage, edited" }, first.revision);

    expect(consoles.page(draft.id, triage.id, "published")).toEqual(first);
    expect(consoles.page(draft.id, triage.id, "draft")).toEqual(later);
  });

  it("refuses a page saved while the console was being published, and publishes nothing", async () => {
    const { canvases, consoles } = setUp();
    const triage = canvases.create(screenContent("Triage"));
    const draft = consoles.create(consoleOver(triage.id));
    const capture = consoles.capture(draft.id, draft.revision);

    canvases.savePage(nested(canvases.getPage(triage.id)!, triage.id), triage.revision);

    expect(() => consoles.publish(draft.id, draft.revision, capture, new Map())).toThrow(CONSOLE_CHANGED);
    expect(consoles.get(draft.id, "published")).toBeNull();
  });

  it("refuses behavior that would send an operator to a page the console doesn't show", async () => {
    const { canvases, consoles } = setUp();
    const triage = canvases.create(screenContent("Triage"));
    const elsewhere = canvases.create(screenContent("Elsewhere"));
    canvases.savePage(nested(canvases.getPage(triage.id)!, elsewhere.id), triage.revision);
    const draft = consoles.create(consoleOver(triage.id));

    expect(() => publish(consoles, draft.id, draft.revision)).toThrow(
      `Screen ${triage.id} navigates to page ${elsewhere.id}, which the console does not show.`);
    expect(consoles.get(draft.id, "published")).toBeNull();

    // Showing the destination too makes the same behavior publishable.
    const both = consoles.replace(draft.id, draft.revision, consoleOver(triage.id, elsewhere.id));
    expect(publish(consoles, both.id, both.revision).published?.screens?.map(screen => screen.id)).toEqual([triage.id, elsewhere.id]);
  });

  it("reads no page for a screen the published revision doesn't show", async () => {
    const { canvases, consoles } = setUp();
    const triage = canvases.create(screenContent("Triage"));
    const other = canvases.create(screenContent("Other"));
    const draft = consoles.create(consoleOver(triage.id));
    publish(consoles, draft.id, draft.revision);

    expect(consoles.page(draft.id, other.id, "published")).toBeNull();
  });
});
