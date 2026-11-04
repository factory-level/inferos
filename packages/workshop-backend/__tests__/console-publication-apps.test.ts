// A published console fences each placed app at the commit it published (FAC-89 part 2): an app (a
// gadget that isn't a widget install) keeps its own storage and bindings, so it is never copied the
// way a widget is; the publication records the commit it read instead, in the same snapshot as its
// screens and widgets. An operator's console offers the app only while its current commit is that
// one, and says so honestly once a builder moves it; republishing moves the fence. Also the QA case
// left from part 1: a widget's install deleted from under a nested page before publishing. Over
// mock Durable Object storage with synthetic gadget records, and the real console and canvas stores.
import { describe, expect, it } from "vitest";
import type { CanvasPage } from "@gadgets/workshop-shared/canvas-model";
import type { ConsoleWidgetEntry, OperateConsoleContent } from "@gadgets/workshop-shared/operate-console";
import { WorkspaceCanvasStore } from "../src/canvas-store";
import { CONSOLE_CHANGED, WorkspaceConsoleStore, type FrozenInstalls } from "../src/console-store";
import { makeOverseerStorage, type GadgetRecord } from "../src/overseer";
import { makeMockStorage } from "./mock-storage";

type CanvasEnv = ConstructorParameters<typeof WorkspaceCanvasStore>[2];
type ConsoleEnv = ConstructorParameters<typeof WorkspaceConsoleStore>[2];
const ENV = { COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true", CANVAS_CATALOG: undefined } as unknown as CanvasEnv & ConsoleEnv;

const APP = 7;
const OTHER_APP = 8;
const WIDGET = 9;

function setUp() {
  const durable = makeMockStorage();
  const storage = makeOverseerStorage(durable);
  const gadget = (id: number, commitId: string | undefined, extra: Partial<GadgetRecord> = {}) => storage.gadgets.put({
    type: "gadget", id, title: `G${id}`, created: new Date(0), bindingName: `G${id}`, bindings: {},
    ...(commitId === undefined ? {} : { commitId }), ...extra } as GadgetRecord);
  let nextId = 1000;
  const frozen: FrozenInstalls = {
    create: (source, frozenFor) => {
      const record = { ...source, id: nextId++, bindingName: `F${nextId}`, frozenFor };
      storage.gadgets.put(record);
      return record;
    },
    remove: id => storage.gadgets.delete(id),
  };
  const canvases = new WorkspaceCanvasStore(durable, storage, ENV);
  const consoles = new WorkspaceConsoleStore(durable, storage, ENV, frozen);
  return { storage, gadget, canvases, consoles };
}

const placed = (id: number) => ({ id: `w${id}`, version: 1 as const, kind: "inferos.gadget" as const,
  targetRef: `gadget:${id}`, params: {}, size: "normal" as const });
const screenOf = (title: string, ...ids: number[]) =>
  ({ title, sections: [{ id: `${title.toLowerCase()}-main`, title: "Now", columns: 1 as const, widgets: ids.map(placed) as never[] }] });

/** `page` with every widget node moved one object deeper: something version 1 can't hold. */
const nested = (page: CanvasPage): CanvasPage => {
  const [work] = page.children;
  const widgets = page.nodes.filter(node => node.nodeType === "widget").map(node => node.id);
  return {
    ...page,
    nodes: [
      ...page.nodes.map(node => node.id === work && node.nodeType === "object" ? { ...node, children: [`${work}-inner`] } : node),
      { nodeType: "object", id: `${work}-inner`, title: "Inner", columns: 1, children: widgets, attachments: [] },
    ],
  };
};

const consoleOver = (screens: string[], widgets?: ConsoleWidgetEntry[]): OperateConsoleContent => ({
  title: "Floor", fullChat: "off", views: screens.map(screen => ({ id: `v-${screen}`, title: screen, type: "screen" as const, screen })),
  ...(widgets ? { widgets } : {}),
});

const publish = (consoles: WorkspaceConsoleStore, id: string, revision: string) =>
  consoles.publish(id, revision, consoles.capture(id, revision), new Map());

describe("a published console's placed apps", () => {
  it("records each placed app once, at the commit it read, nested pages included, and no widget among them", () => {
    const { gadget, canvases, consoles } = setUp();
    gadget(APP, "c-app-1");
    gadget(OTHER_APP, "c-other-1");
    const triage = canvases.create(screenOf("Triage", APP));
    const deeper = canvases.create(screenOf("Deeper", OTHER_APP, APP));
    canvases.savePage(nested(canvases.getPage(deeper.id)!), deeper.revision);
    const draft = consoles.create(consoleOver([triage.id, deeper.id]));

    const published = publish(consoles, draft.id, draft.revision);

    expect(published.published?.apps).toEqual([
      { gadgetId: APP, commitId: "c-app-1" },
      { gadgetId: OTHER_APP, commitId: "c-other-1" },
    ]);
    expect(consoles.offeredApp(draft.id, published.revision, APP)).toEqual({ gadgetId: APP, commitId: "c-app-1" });
  });

  it("refuses an operator the app once its mainline moves, saying a builder must publish the console again", () => {
    const { storage, gadget, canvases, consoles } = setUp();
    gadget(APP, "c-app-1");
    const triage = canvases.create(screenOf("Triage", APP));
    const draft = consoles.create(consoleOver([triage.id]));
    const published = publish(consoles, draft.id, draft.revision);

    // A builder merges a change: the same gadget, a new head. Its storage and bindings stay.
    storage.gadgets.put({ ...storage.gadgets.get(APP) as GadgetRecord, commitId: "c-app-2" });

    expect(() => consoles.offeredApp(draft.id, published.revision, APP)).toThrow(
      `App G${APP} has changed since console Floor was published; a builder must publish the console again before operators can open it.`);
  });

  it("moves the fence to the new commit on republish, and refuses the old revision", () => {
    const { storage, gadget, canvases, consoles } = setUp();
    gadget(APP, "c-app-1");
    const triage = canvases.create(screenOf("Triage", APP));
    const draft = consoles.create(consoleOver([triage.id]));
    const first = publish(consoles, draft.id, draft.revision);
    storage.gadgets.put({ ...storage.gadgets.get(APP) as GadgetRecord, commitId: "c-app-2" });

    // Republishing unchanged content is enough: a new revision, with the fence at the new commit.
    const second = publish(consoles, first.id, first.revision);

    expect(second.published?.apps).toEqual([{ gadgetId: APP, commitId: "c-app-2" }]);
    expect(consoles.offeredApp(draft.id, second.revision, APP)).toEqual({ gadgetId: APP, commitId: "c-app-2" });
    expect(() => consoles.offeredApp(draft.id, first.revision, APP)).toThrow(`Console ${draft.id} has changed since it was opened.`);
  });

  it("refuses a publication whose app moved after it was read, and publishes nothing", () => {
    const { storage, gadget, canvases, consoles } = setUp();
    gadget(APP, "c-app-1");
    const triage = canvases.create(screenOf("Triage", APP));
    const draft = consoles.create(consoleOver([triage.id]));
    const capture = consoles.capture(draft.id, draft.revision);

    storage.gadgets.put({ ...storage.gadgets.get(APP) as GadgetRecord, commitId: "c-app-2" });

    expect(() => consoles.publish(draft.id, draft.revision, capture, new Map())).toThrow(CONSOLE_CHANGED);
    expect(consoles.get(draft.id, "published")).toBeNull();
  });

  it("offers nothing it did not place, nor an app placed only in the draft", () => {
    const { gadget, canvases, consoles } = setUp();
    gadget(APP, "c-app-1");
    gadget(OTHER_APP, "c-other-1");
    const triage = canvases.create(screenOf("Triage", APP));
    const later = canvases.create(screenOf("Later", OTHER_APP));
    const draft = consoles.create(consoleOver([triage.id]));
    const published = publish(consoles, draft.id, draft.revision);
    consoles.replace(draft.id, published.revision, consoleOver([triage.id, later.id]));

    expect(() => consoles.offeredApp(draft.id, published.revision, OTHER_APP)).toThrow(
      `Console ${draft.id} does not offer app ${OTHER_APP}.`);
    expect(consoles.placedByPublishedConsole(APP)).toBe(true);
    expect(consoles.placedByPublishedConsole(OTHER_APP)).toBe(false);
  });

  it("offers no app that had no committed code when it was published", () => {
    const { gadget, canvases, consoles } = setUp();
    gadget(APP, undefined);
    const triage = canvases.create(screenOf("Triage", APP));
    const draft = consoles.create(consoleOver([triage.id]));

    const published = publish(consoles, draft.id, draft.revision);

    expect(published.published?.apps).toEqual([]);
    expect(() => consoles.offeredApp(draft.id, published.revision, APP)).toThrow(`Console ${draft.id} does not offer app ${APP}.`);
  });
});

describe("a widget nested in a page whose install was deleted before publishing (FAC-89 part 1 QA)", () => {
  it("refuses the publication, naming the widget, and publishes nothing", () => {
    const { storage, gadget, canvases, consoles } = setUp();
    gadget(WIDGET, "c-widget-1", { installedFrom: { blueprintId: "bp", version: 1, kind: "widget" } });
    const triage = canvases.create(screenOf("Triage", WIDGET));
    canvases.savePage(nested(canvases.getPage(triage.id)!), triage.revision);
    const entry: ConsoleWidgetEntry = { gadgetId: WIDGET, blueprintId: "bp", version: 1, label: "Status", state: "resettable" };
    const draft = consoles.create(consoleOver([triage.id], [entry]));

    storage.gadgets.delete(WIDGET);

    expect(() => publish(consoles, draft.id, draft.revision)).toThrow(
      `Console widget "Status": Gadget ${WIDGET} is not a gadget of this workspace.`);
    expect(consoles.get(draft.id, "published")).toBeNull();
  });
});
