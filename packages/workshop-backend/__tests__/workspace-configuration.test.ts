// The workspace's settings and a page's overrides (FAC-95), over mock Durable Object storage with
// the real canvas and console stores: a save is checked against its revision and the registry, and
// writes nothing when refused; a page's override persists nested (version 1 can't hold it) and
// through page edits; a console publication freezes both, so a later change reaches operators only
// through a republish. Who may save is shared-configuration.test.ts's.
import { describe, expect, it } from "vitest";
import { canvasPageFromDefinition } from "@gadgets/workshop-shared/canvas-model";
import type { OperateConsoleContent } from "@gadgets/workshop-shared/operate-console";
import { WorkspaceCanvasStore } from "../src/canvas-store";
import { WorkspaceConsoleStore } from "../src/console-store";
import { makeOverseerStorage } from "../src/overseer";
import { readWorkspaceConfiguration, saveWorkspaceConfiguration, WORKSPACE_CONFIGURATION_CHANGED } from "../src/workspace-configuration";
import { makeMockStorage } from "./mock-storage";

type CanvasEnv = ConstructorParameters<typeof WorkspaceCanvasStore>[2];
const ENV = { COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true", CANVAS_CATALOG: undefined } as unknown as CanvasEnv;

function setUp() {
  const durable = makeMockStorage();
  const storage = makeOverseerStorage(durable);
  return { durable, storage, canvases: new WorkspaceCanvasStore(durable, storage, ENV), consoles: new WorkspaceConsoleStore(durable, storage, ENV as never) };
}
const screen = { title: "Triage", sections: [{ id: "work", title: "Work", columns: 1 as const, widgets: [] }] };
const consoleOver = (screenId: string): OperateConsoleContent =>
  ({ title: "Floor", fullChat: "off", views: [{ id: "v", title: "V", type: "screen", screen: screenId }] });

describe("the workspace's settings", () => {
  it("start empty at revision 0, and save at the next revision", () => {
    const { storage } = setUp();
    expect(readWorkspaceConfiguration(storage)).toEqual({ revision: "0", settings: {} });
    const saved = saveWorkspaceConfiguration(storage, "0", { "baseUi.alerts": true, "chatPane.widgets": "none" });
    expect(saved).toEqual({ revision: "1", settings: { "baseUi.alerts": true, "chatPane.widgets": "none" } });
    expect(readWorkspaceConfiguration(storage)).toEqual(saved);
  });

  it.for([
    ["a stale revision", "0", { "baseUi.alerts": false }, WORKSPACE_CONFIGURATION_CHANGED],
    ["an unknown key", "1", { "baseUi.modals": true }, 'Unknown setting "baseUi.modals".'],
    ["a value the key doesn't take", "1", { "chatPane.widgets": "all" }, 'Setting "chatPane.widgets" must be one of'],
    ["something that isn't settings", "1", ["baseUi.alerts"], "Settings must be an object."],
    // r2 round 1 on #395: an object with no entries of its own must never clear every setting.
    ["a Date", "1", new Date(), "Settings must be an object."],
    ["a Map", "1", new Map([["baseUi.alerts", false]]), "Settings must be an object."],
  ] as const)("refuse %s, writing nothing", ([, revision, settings, refusal]) => {
    const { storage } = setUp();
    saveWorkspaceConfiguration(storage, "0", { "baseUi.alerts": true });
    expect(() => saveWorkspaceConfiguration(storage, revision, settings)).toThrow(refusal);
    expect(readWorkspaceConfiguration(storage)).toEqual({ revision: "1", settings: { "baseUi.alerts": true } });
  });
});

describe("a page's overrides", () => {
  it("persist nested, since version 1 can't hold them, and through later page edits", () => {
    const { storage, canvases } = setUp();
    const row = canvases.create(screen);
    const page = canvases.editPage(row.id, row.revision, [{ type: "setSettings", settings: { "baseUi.notifications": true } }]);
    expect(page.settings).toEqual({ "baseUi.notifications": true });
    expect(storage.canvasPages.get(row.id)?.settings).toEqual({ "baseUi.notifications": true });
    const renamed = canvases.editPage(row.id, page.revision, [{ type: "renamePage", title: "Renamed" }]);
    expect(renamed.settings).toEqual({ "baseUi.notifications": true });
    // Removing every override lets the page go back to its version 1 row.
    const cleared = canvases.editPage(row.id, renamed.revision, [{ type: "setSettings", settings: {} }]);
    expect(cleared.settings).toBeUndefined();
    expect(storage.canvasPages.get(row.id)).toBeUndefined();
  });

  // r2 round 1 on #395: the page write takes only a plain record too, leaving the page as it was.
  it("refuse a Date or a Map as the page's settings, changing nothing", () => {
    const { storage, canvases } = setUp();
    const row = canvases.create(screen);
    const page = canvases.editPage(row.id, row.revision, [{ type: "setSettings", settings: { "baseUi.alerts": true } }]);
    for (const settings of [new Date(), new Map([["baseUi.alerts", false]])]) {
      expect(() => canvases.editPage(row.id, page.revision, [{ type: "setSettings", settings } as never])).toThrow(/invalid-setting/);
      expect(() => canvases.savePage({ ...page, settings }, page.revision)).toThrow(/invalid-setting/);
    }
    expect(canvases.getPage(row.id)).toEqual(page);
    expect(storage.canvasPages.get(row.id)?.settings).toEqual({ "baseUi.alerts": true });
  });

  it("refuse an unknown key, and keep refusing every other override field", () => {
    const { canvases } = setUp();
    const row = canvases.create(screen);
    expect(() => canvases.editPage(row.id, row.revision, [{ type: "setSettings", settings: { "baseUi.modals": true } } as never]))
      .toThrow(/invalid-setting/);
    expect(() => canvases.savePage({ ...canvasPageFromDefinition(row), overrides: { "baseUi.alerts": true } }, row.revision))
      .toThrow(/undefined-inheritance/);
  });
});

describe("a console publication", () => {
  it("freezes the workspace's settings and each page's overrides; later changes stay draft", () => {
    const { storage, canvases, consoles } = setUp();
    const row = canvases.create(screen);
    canvases.editPage(row.id, row.revision, [{ type: "setSettings", settings: { "baseUi.alerts": false } }]);
    saveWorkspaceConfiguration(storage, "0", { "baseUi.alerts": true, "chatPane.widgets": "none" });
    const draft = consoles.create(consoleOver(row.id));
    const published = consoles.publish(draft.id, draft.revision, consoles.capture(draft.id, draft.revision), new Map());
    expect(published.published?.settings).toEqual({ "baseUi.alerts": true, "chatPane.widgets": "none" });
    expect(consoles.page(draft.id, row.id, "published")?.settings).toEqual({ "baseUi.alerts": false });

    saveWorkspaceConfiguration(storage, "1", {});
    const page = canvases.getPage(row.id)!;
    canvases.editPage(row.id, page.revision, [{ type: "setSettings", settings: {} }]);
    expect(storage.consoles.get(draft.id)?.published?.settings).toEqual({ "baseUi.alerts": true, "chatPane.widgets": "none" });
    expect(consoles.page(draft.id, row.id, "published")?.settings).toEqual({ "baseUi.alerts": false });
  });

  it("records no settings where the workspace set none", () => {
    const { canvases, consoles } = setUp();
    const row = canvases.create(screen);
    const draft = consoles.create(consoleOver(row.id));
    const published = consoles.publish(draft.id, draft.revision, consoles.capture(draft.id, draft.revision), new Map());
    expect(published.published).not.toHaveProperty("settings");
  });
});

// FAC-95 follow-up: a reader from before page settings (inferos f681e3a1) refuses a page with any
// field it doesn't know. So a page's overrides are stored beside the page, never inside it: the
// stored page has exactly the fields that reader takes, and the overrides stay inert there.
describe("a page's overrides on a rollback", () => {
  const OLD_PAGE_FIELDS = ["attachments", "children", "id", "nodes", "revision", "schemaVersion", "title"];

  it("are stored beside the nested page and its published copy, which keep only the fields an older reader takes", () => {
    const { storage, canvases, consoles } = setUp();
    const row = canvases.create(screen);
    const page = canvases.editPage(row.id, row.revision, [{ type: "setSettings", settings: { "baseUi.alerts": true } }]);
    expect(page.settings).toEqual({ "baseUi.alerts": true });
    const stored = storage.canvasPages.get(row.id)!;
    expect(Object.keys(stored.page).toSorted()).toEqual(OLD_PAGE_FIELDS);
    expect(stored.settings).toEqual({ "baseUi.alerts": true });
    // Read back, the page has them again.
    expect(canvases.getPage(row.id)?.settings).toEqual({ "baseUi.alerts": true });

    const draft = consoles.create(consoleOver(row.id));
    consoles.publish(draft.id, draft.revision, consoles.capture(draft.id, draft.revision), new Map());
    const snapshot = [...storage.consoleScreens.list()].find(item => item.screenId === row.id)!;
    expect(Object.keys(snapshot.page!).toSorted()).toEqual(OLD_PAGE_FIELDS);
    expect(snapshot.pageSettings).toEqual({ "baseUi.alerts": true });
    expect(consoles.page(draft.id, row.id, "published")?.settings).toEqual({ "baseUi.alerts": true });
  });
});
